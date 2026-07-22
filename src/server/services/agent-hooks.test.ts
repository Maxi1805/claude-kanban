/**
 * Agent-hooks generator tests.
 *
 * Verify the kanban hooks settings object:
 *   • is valid JSON matching the Claude Code `--settings` hooks schema,
 *   • subscribes to exactly the events we detect on,
 *   • each hook is a `command` hook that curls the agent-events URL on the
 *     configured port with a short timeout and reads stdin (`--data-binary @-`),
 *   • ensureAgentHooksFile writes the file and returns its path.
 *
 * The config module is mocked so dataDir points at a per-run temp dir.
 */
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const configHolder = {
  port: 8787,
  dataDir: path.join(os.tmpdir(), "ck-agent-hooks-fallback"),
};

vi.mock("../config.js", () => ({
  get config() {
    return {
      port: configHolder.port,
      dataDir: configHolder.dataDir,
    };
  },
  projectRoot: process.cwd(),
}));

import {
  agentEventsUrl,
  agentHooksFilePath,
  buildAgentHooksSettings,
  ensureAgentHooksFile,
} from "./agent-hooks.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "ck-agent-hooks-"));
  configHolder.dataDir = tmp;
  configHolder.port = 8787;
});

afterEach(async () => {
  await fsp.rm(tmp, { recursive: true, force: true });
});

const EXPECTED_EVENTS = [
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "Notification",
];

describe("buildAgentHooksSettings", () => {
  it("emits valid JSON with the right events and curl command", () => {
    const settings = buildAgentHooksSettings();

    // Round-trips through JSON (no functions / cycles).
    const json = JSON.stringify(settings);
    expect(JSON.parse(json)).toEqual(settings);

    // Subscribes to exactly the detected events.
    expect(Object.keys(settings.hooks).sort()).toEqual(
      [...EXPECTED_EVENTS].sort(),
    );

    for (const event of EXPECTED_EVENTS) {
      const groups = settings.hooks[event];
      expect(Array.isArray(groups)).toBe(true);
      const hook = groups[0].hooks[0];
      expect(hook.type).toBe("command");
      // Curls the agent-events URL on the configured port…
      expect(hook.command).toContain("curl");
      expect(hook.command).toContain("http://127.0.0.1:8787/api/agent-events");
      // …with a POST, a short timeout + one retry, and reads the event JSON from stdin.
      expect(hook.command).toContain("-X POST");
      expect(hook.command).toMatch(/-m\s*5/);
      expect(hook.command).toContain("--retry");
      expect(hook.command).toContain("--data-binary @-");
    }
  });

  it("uses the configured port in the URL", () => {
    configHolder.port = 9999;
    expect(agentEventsUrl()).toBe("http://127.0.0.1:9999/api/agent-events");
    const settings = buildAgentHooksSettings();
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(
      "http://127.0.0.1:9999/api/agent-events",
    );
  });

  it("accepts an explicit port override", () => {
    const settings = buildAgentHooksSettings(1234);
    expect(settings.hooks.Stop[0].hooks[0].command).toContain(
      "http://127.0.0.1:1234/api/agent-events",
    );
  });
});

describe("ensureAgentHooksFile", () => {
  it("writes the settings file and returns its path", async () => {
    const filePath = await ensureAgentHooksFile();
    expect(filePath).toBe(agentHooksFilePath());
    expect(filePath).toBe(path.join(tmp, "claude-kanban-hooks.json"));

    const onDisk = JSON.parse(await fsp.readFile(filePath, "utf8"));
    expect(onDisk).toEqual(buildAgentHooksSettings());
  });

  it("creates the data dir if missing and is idempotent", async () => {
    const nested = path.join(tmp, "deep", "nested");
    configHolder.dataDir = nested;

    const first = await ensureAgentHooksFile();
    const second = await ensureAgentHooksFile();
    expect(first).toBe(second);
    // The file is present and parseable after repeated calls.
    const onDisk = JSON.parse(await fsp.readFile(first, "utf8"));
    expect(Object.keys(onDisk.hooks).sort()).toEqual(
      [...EXPECTED_EVENTS].sort(),
    );
  });
});
