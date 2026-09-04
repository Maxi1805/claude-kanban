/**
 * Caveman — the per-task token-saving switch.
 *
 * `caveman` is a third-party Claude Code plugin/skill (github.com/JuliusBrussee/
 * caveman) that compresses the agent's PROSE while leaving code, commands and
 * error output byte-for-byte intact. This module is the whole integration; the
 * board owns two decisions per task and nothing else:
 *
 *   • ON/OFF  → `enabledPlugins` in the task's `--settings` file (agent-hooks).
 *     This is the only switch that truly costs nothing when off: a plugin that
 *     is not enabled is never loaded, so its skill description never reaches the
 *     context window. Takes effect at (re)spawn, since `--settings` is read once.
 *
 *   • LEVEL   → the plugin's own `/caveman <level>` slash command, TYPED into the
 *     live pty. There is no settings key for the level, so the only way to set it
 *     is to speak to the session — which is also why a level change never needs a
 *     restart.
 *
 * TURNING IT OFF MID-SESSION is asymmetric with turning it on: the plugin has no
 * `/caveman off`; its README documents saying "normal mode". So an un-check on a
 * LIVE task types that phrase, and the (already persisted) flag keeps the plugin
 * out of the next spawn entirely.
 *
 * NOTHING here installs the plugin. If it is absent the slash command is simply
 * an unknown command in that session — noisy, but harmless and self-explanatory
 * in the terminal the user is already looking at.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PtyService } from "../../shared/interfaces.js";
import type { CavemanLevel, Task } from "../../shared/types.js";
import { CAVEMAN_DEFAULT_LEVEL } from "../../shared/types.js";

/** Plugin/skill name as published by its author. */
const PLUGIN_NAME = "caveman";

/**
 * The skill inside the plugin that switches level. Same word as the plugin, but
 * a distinct concept: Claude Code addresses a plugin skill as `plugin:skill`.
 */
const LEVEL_SKILL = "caveman";

/**
 * The phrase that disables caveman-speak mid-session. The plugin exposes no
 * `/caveman off`; its README says to ask for "normal mode".
 */
export const CAVEMAN_OFF_INPUT = "normal mode";

/**
 * The slash command that switches the session to `level`.
 *
 * NAMESPACED, `/caveman:caveman <level>` — not the bare `/caveman <level>` the
 * plugin's README documents. The plugin ships SKILLS (no `commands/` directory),
 * and Claude Code 2.x addresses a plugin skill as `plugin:skill`. The bare form
 * is answered with `Unknown command: /caveman` even when the plugin is loaded,
 * which is exactly what the terminal showed before this was fixed.
 */
export function cavemanLevelCommand(level: CavemanLevel): string {
  return `/${PLUGIN_NAME}:${LEVEL_SKILL} ${level}`;
}

/** The level a task effectively runs at (its stored level, or the default). */
export function effectiveLevel(task: {
  cavemanLevel?: CavemanLevel | null;
}): CavemanLevel {
  return task.cavemanLevel ?? CAVEMAN_DEFAULT_LEVEL;
}

/**
 * The `plugin@marketplace` id `enabledPlugins` keys on. It depends on HOW the
 * user installed caveman, which we cannot control, so it is resolved rather than
 * hardcoded:
 *
 *   1. `CK_CAVEMAN_PLUGIN_ID` — explicit override, always wins.
 *   2. `~/.claude/skills/caveman/` — the universal `install.sh` drops the skill
 *      here, and Claude Code auto-loads that directory as `<name>@skills-dir`.
 *   3. `~/.claude/plugins/marketplaces/<mp>/plugins/caveman/` — installed from a
 *      marketplace, so the id carries that marketplace's name.
 *   4. `caveman@caveman` — the shape of `/plugin marketplace add JuliusBrussee/
 *      caveman`, used as the last resort so the key is never empty.
 *
 * An id that resolves to a plugin the user does not have is harmless: Claude Code
 * ignores `enabledPlugins` entries that match nothing.
 */
export function resolveCavemanPluginId(homeDir: string = os.homedir()): string {
  const override = process.env.CK_CAVEMAN_PLUGIN_ID;
  if (override && override.trim().length > 0) return override.trim();

  const claudeDir = path.join(homeDir, ".claude");
  if (isDirectory(path.join(claudeDir, "skills", PLUGIN_NAME))) {
    return `${PLUGIN_NAME}@skills-dir`;
  }

  const marketplacesDir = path.join(claudeDir, "plugins", "marketplaces");
  for (const marketplace of listDirectories(marketplacesDir)) {
    const candidate = path.join(
      marketplacesDir,
      marketplace,
      "plugins",
      PLUGIN_NAME,
    );
    if (isDirectory(candidate)) return `${PLUGIN_NAME}@${marketplace}`;
  }

  return `${PLUGIN_NAME}@${PLUGIN_NAME}`;
}

/** True when the path exists and is a directory. Never throws. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Immediate subdirectory names of `dir`, or [] when unreadable. */
function listDirectories(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Typing into a live session
 * ──────────────────────────────────────────────────────────────────────── */

/** Tunables for {@link submitToSession}; overridable in tests to keep them fast. */
export interface SubmitTiming {
  /**
   * How long the pty output must stay QUIET before we type. A freshly spawned
   * claude paints its TUI in a burst; typing into that burst can be swallowed by
   * whatever is still initializing.
   */
  quietMs: number;
  /** Hard cap on waiting for quiet. Past it we type anyway. */
  timeoutMs: number;
  /**
   * Gap between the text and the Enter that submits it. The TUI parses paste-like
   * bursts; a separate, slightly later Return is read as a deliberate submit.
   */
  submitDelayMs: number;
}

export const DEFAULT_SUBMIT_TIMING: SubmitTiming = {
  quietMs: 1200,
  timeoutMs: 20000,
  submitDelayMs: 150,
};

/**
 * How long the user must have stopped typing before we type. Longer than
 * `quietMs`: output going quiet only means the agent finished talking, while a
 * half-typed prompt sits in the input box for as long as the human takes.
 * Injecting into that box fuses the two texts — the terminal showed
 * `Args from unknown skill: litenormal mode`, which is this injection's `lite`
 * welded onto a `normal mode` the user was in the middle of typing.
 */
const INPUT_QUIET_MS = 2500;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolve once the task's terminal is quiet in BOTH directions — the agent has
 * stopped producing output for `quietMs` AND the user has stopped typing for
 * {@link INPUT_QUIET_MS} — or when `timeoutMs` elapses, whichever comes first.
 * Resolves immediately when the task has no live pty (nothing to wait for).
 */
export async function waitForQuiet(
  pty: PtyService | undefined,
  taskId: string,
  timing: SubmitTiming = DEFAULT_SUBMIT_TIMING,
): Promise<void> {
  if (!pty || !pty.has(taskId)) return;

  const deadline = Date.now() + timing.timeoutMs;
  await waitForOutputQuiet(pty, taskId, timing);

  // Then hold while the user is mid-keystroke. Re-checked in a loop because a
  // person can start typing during the wait; bounded by the same deadline so a
  // continuously-typing user delays the injection but never hangs it forever.
  const inputQuietMs = Math.min(INPUT_QUIET_MS, timing.timeoutMs);
  while (Date.now() < deadline) {
    const lastInput = pty.getLastInputAt?.(taskId);
    if (lastInput === undefined) return;
    const since = Date.now() - lastInput;
    if (since >= inputQuietMs) return;
    await sleep(Math.min(inputQuietMs - since, deadline - Date.now()));
  }
}

/** The output half of {@link waitForQuiet}. */
async function waitForOutputQuiet(
  pty: PtyService,
  taskId: string,
  timing: SubmitTiming,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      unsubscribe();
      resolve();
    };

    let quietTimer = setTimeout(finish, timing.quietMs);
    const hardTimer = setTimeout(finish, timing.timeoutMs);
    // Every output chunk restarts the quiet window: we are waiting for the burst
    // to STOP, not merely for one to happen.
    const unsubscribe = pty.onData(taskId, () => {
      if (settled) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, timing.quietMs);
    });
  });
}

/**
 * Type `text` into the task's live session and submit it. Waits for the terminal
 * to settle first (see {@link waitForQuiet}). Returns false — having done
 * nothing — when the task has no live pty, so callers can treat "will apply on
 * next spawn" as the normal, silent outcome.
 */
export async function submitToSession(
  pty: PtyService | undefined,
  taskId: string,
  text: string,
  timing: SubmitTiming = DEFAULT_SUBMIT_TIMING,
): Promise<boolean> {
  if (!pty || !pty.has(taskId)) return false;
  await waitForQuiet(pty, taskId, timing);
  // The pty can die while we wait for quiet.
  if (!pty.has(taskId)) return false;

  pty.write(taskId, text);
  await sleep(timing.submitDelayMs);
  if (!pty.has(taskId)) return false;
  pty.write(taskId, "\r");
  return true;
}

/* ────────────────────────────────────────────────────────────────────────
 * The two application paths
 * ──────────────────────────────────────────────────────────────────────── */

/**
 * Whether the task's live session actually has the plugin loaded — the only
 * state in which talking to it means anything.
 *
 * `enabledPlugins` is read ONCE, when the session starts. A session spawned
 * without caveman does not know the command exists: typing `/caveman full` at it
 * answers `Unknown command: /caveman`, which is noise in the user's terminal and
 * changes nothing. So every live action is gated on what the session was ACTUALLY
 * spawned with, never on what the checkbox says now.
 */
export function sessionHasPlugin(
  task: Pick<Task, "cavemanSession">,
): boolean {
  return task.cavemanSession === true;
}

/**
 * Apply a task's caveman settings to its LIVE session, after the board changed
 * them. Switching level types the slash command; switching off types the "normal
 * mode" phrase. Returns whether anything was typed.
 *
 * Returns false — having typed NOTHING — when the live session has no plugin
 * loaded ({@link sessionHasPlugin}). That covers the case that looks most like it
 * should work: ticking the checkbox on a running agent. It cannot take effect
 * until the agent respawns with a settings file that loads the plugin, so the
 * board reports it as pending rather than typing a command the session would
 * reject.
 *
 * Note the asymmetry with {@link applyCavemanOnSpawn}: here we type even for the
 * default level, because the running session is already past the point where
 * `enabledPlugins` could have decided anything.
 */
export async function applyCavemanToLiveSession(
  pty: PtyService | undefined,
  task: Pick<Task, "id" | "cavemanEnabled" | "cavemanLevel" | "cavemanSession">,
  timing: SubmitTiming = DEFAULT_SUBMIT_TIMING,
): Promise<boolean> {
  if (!sessionHasPlugin(task)) return false;
  const input = task.cavemanEnabled
    ? cavemanLevelCommand(effectiveLevel(task))
    : CAVEMAN_OFF_INPUT;
  return submitToSession(pty, task.id, input, timing);
}

/**
 * Apply a task's caveman level to a session that has just spawned.
 *
 * Deliberately does NOTHING for the plugin's own default level: at spawn the
 * plugin was already loaded (or not) by `enabledPlugins`, and it compresses from
 * message one at its default. Typing a redundant `/caveman full` would cost a
 * turn — the exact thing this feature exists to avoid. Only a non-default level
 * has to be spoken.
 *
 * Returns whether the level command was typed.
 */
export async function applyCavemanOnSpawn(
  pty: PtyService | undefined,
  task: Pick<Task, "id" | "cavemanEnabled" | "cavemanLevel">,
  timing: SubmitTiming = DEFAULT_SUBMIT_TIMING,
): Promise<boolean> {
  if (!task.cavemanEnabled) return false;
  const level = effectiveLevel(task);
  if (level === CAVEMAN_DEFAULT_LEVEL) return false;
  return submitToSession(pty, task.id, cavemanLevelCommand(level), timing);
}
