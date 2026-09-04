/**
 * Agent hooks settings generator.
 *
 * Produces a Claude Code *settings* object whose `hooks` arrays POST every
 * relevant hook event back to this server's `/api/agent-events` endpoint, so the
 * board can detect — live — whether a task's claude is working, finished, or
 * blocking on the user (a permission prompt).
 *
 * The settings file is passed to the spawned agent via `claude --settings <file>`
 * (see pty-service). Claude Code MERGES `--settings` with the user/project
 * settings — hook arrays are CONCATENATED — so OUR hooks run ALONGSIDE the user's
 * own hooks, never replacing them. That is how we inject detection without ever
 * touching the user's symlinked `.claude`.
 *
 * Each hook is a `command` hook that reads the raw hook-event JSON from STDIN and
 * `curl`s it to the endpoint. Hooks BLOCK the session until the command returns,
 * so the curl is `-s -m 5 --retry 1 --retry-connrefused` (silent, 5s hard cap, one
 * retry on a refused connection) and — crucially — the server answers 200 BEFORE
 * doing any work, so a busy event loop can never push the response past the curl
 * timeout and silently drop the state update. A hung POST can never stall claude.
 */
import fsp from "node:fs/promises";
import path from "node:path";

import type { Task } from "../../shared/types.js";
import { config } from "../config.js";
import { resolveCavemanPluginId } from "./caveman.js";

/** The Claude Code hook events we subscribe to. */
const HOOK_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Notification",
] as const;

/** A single Claude Code command hook (reads event JSON on stdin). */
interface CommandHook {
  type: "command";
  command: string;
}

/** One matcher group of hooks under an event. */
interface HookMatcherGroup {
  hooks: CommandHook[];
}

/** The settings shape understood by `claude --settings`. */
export interface AgentHooksSettings {
  hooks: Record<string, HookMatcherGroup[]>;
  /**
   * Per-plugin load switch, keyed `plugin@marketplace`. Present only in the
   * PER-TASK settings file, where it carries the task's caveman checkbox. Both
   * values matter: `true` loads the plugin into this session, and `false`
   * actively keeps it out even when the user enabled it globally in their own
   * settings.json — which is what makes the checkbox authoritative per task.
   */
  enabledPlugins?: Record<string, boolean>;
}

/** Default basename of the on-disk hooks settings file under the data dir. */
const HOOKS_FILE_NAME = "claude-kanban-hooks.json";

/** Subdirectory (under the data dir) holding one settings file per task. */
const TASK_SETTINGS_DIR = "task-settings";

/** Absolute URL the hooks POST each event to. Uses the configured server port. */
export function agentEventsUrl(port: number = config.port): string {
  return `http://127.0.0.1:${port}/api/agent-events`;
}

/**
 * The curl command a hook runs: POST the raw hook-event JSON (read from stdin via
 * `--data-binary @-`) to the agent-events endpoint, silently, with a hard 5s
 * timeout and one retry on a refused connection so a transient blip doesn't drop
 * the update — yet a slow/unreachable server can still never block the claude
 * session for long. The `|| true` keeps a curl failure (server down, timeout)
 * from surfacing as a hook error that could disrupt the turn.
 */
function curlCommand(url: string): string {
  return (
    `curl -s -m 5 --retry 1 --retry-connrefused -X POST ${url} ` +
    `-H "Content-Type: application/json" --data-binary @- >/dev/null 2>&1 || true`
  );
}

/**
 * Build the kanban hooks settings object: one `command` hook per subscribed
 * event, each curling the raw event JSON to `/api/agent-events`. Pass a `port`
 * to override the configured one (tests). The matcher is omitted so the hook
 * fires for every tool/event of that kind.
 */
export function buildAgentHooksSettings(
  port: number = config.port,
): AgentHooksSettings {
  const command = curlCommand(agentEventsUrl(port));
  const hooks: Record<string, HookMatcherGroup[]> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ hooks: [{ type: "command", command }] }];
  }
  return { hooks };
}

/** Absolute path to the hooks settings file under the data dir. */
export function agentHooksFilePath(dataDir: string = config.dataDir): string {
  return path.join(dataDir, HOOKS_FILE_NAME);
}

/**
 * Ensure the hooks settings file exists on disk (idempotently overwriting it so
 * it always reflects the current port/schema), and return its absolute path. The
 * containing data dir is created if missing. Called on boot and used by the pty
 * service when spawning the configured `claude`.
 */
export async function ensureAgentHooksFile(
  dataDir: string = config.dataDir,
  port: number = config.port,
): Promise<string> {
  const filePath = agentHooksFilePath(dataDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(buildAgentHooksSettings(port), null, 2);
  await fsp.writeFile(filePath, json, "utf8");
  return filePath;
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-task settings
 *
 * The hooks are identical for every task, but the caveman checkbox is not — and
 * `--settings` takes exactly one file. So each spawn gets its OWN file: the same
 * hooks plus that task's `enabledPlugins`. The file is rewritten on every spawn,
 * which is also how a checkbox toggled while the agent was down takes effect.
 * ──────────────────────────────────────────────────────────────────────── */

/** The hooks settings plus the per-task plugin switches. */
export function buildTaskAgentSettings(
  task: Pick<Task, "cavemanEnabled">,
  port: number = config.port,
  pluginId: string = resolveCavemanPluginId(),
): AgentHooksSettings {
  return {
    ...buildAgentHooksSettings(port),
    enabledPlugins: { [pluginId]: task.cavemanEnabled === true },
  };
}

/** Absolute path to a task's settings file under the data dir. */
export function taskSettingsFilePath(
  taskId: string,
  dataDir: string = config.dataDir,
): string {
  return path.join(dataDir, TASK_SETTINGS_DIR, `${taskId}.json`);
}

/**
 * Write the task's settings file (creating its directory) and return the path,
 * for `claude --settings <file>`. Overwrites unconditionally so the file always
 * reflects the task's CURRENT checkbox and the current port.
 */
export async function ensureTaskSettingsFile(
  task: Pick<Task, "id" | "cavemanEnabled">,
  dataDir: string = config.dataDir,
  port: number = config.port,
): Promise<string> {
  const filePath = taskSettingsFilePath(task.id, dataDir);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const json = JSON.stringify(buildTaskAgentSettings(task, port), null, 2);
  await fsp.writeFile(filePath, json, "utf8");
  return filePath;
}

/**
 * Delete a task's settings file. Best-effort: a missing file is success, since
 * the caller (task teardown) must never fail over a leftover.
 */
export async function removeTaskSettingsFile(
  taskId: string,
  dataDir: string = config.dataDir,
): Promise<void> {
  await fsp.rm(taskSettingsFilePath(taskId, dataDir), { force: true });
}
