/**
 * Item 14 (`docs/backlog.md`) — env-var gate on `ensemble_*` tool
 * registration.
 *
 * Pi-conductor is loaded as a system-wide pi extension. Every pi
 * subprocess (including sub-agents spawned by the conductor itself)
 * loads the extension at startup, and without a gate, every sub-agent
 * gets the full `ensemble_*` LLM tool surface — letting it fan out
 * via `ensemble_spawn` and orphan the parent's registry.
 *
 * Witnessed: `builder-k6dc → builder-55a4` chain, 2026-05-28. The
 * outer builder called `ensemble_spawn` instead of executing its
 * brief; completion notifications routed back to the dead session.
 *
 * This test pins the registration-side gate:
 *   - When `process.env.CONDUCTOR_SUBAGENT === "1"`: zero
 *     `ensemble_*` tools are registered.
 *   - When unset: all 8 are registered.
 *
 * The spawn-side complement (`buildSubagentEnv` setting the env var
 * on every spawned subprocess) is already pinned by
 * `tests/runs-helpers.test.ts`.
 *
 * Test discipline: each test snapshots `process.env.CONDUCTOR_SUBAGENT`
 * up front, mutates it, and restores in a finally block so a
 * mid-test crash doesn't bleed into adjacent tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";

interface RegisteredTool {
  name: string;
}

function captureTools() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    pi: { registerTool: (tool: RegisteredTool) => tools.push(tool) },
  };
}

function callRegisterTools(cwd: string): RegisteredTool[] {
  const reg = new RunRegistry();
  const queue = new SpawnQueue(reg, 4);
  const model = new FocusedStreamModel(reg);
  const cap = captureTools();
  registerTools(cap.pi as any, {
    getCwd: () => cwd,
    getRegistry: () => reg,
    getQueue: () => queue,
    getModel: () => model,
    getParentMessages: () => [],
    openFocusedOverlay: () => {},
    registerForegroundDetach: () => ({
      detachSignal: new Promise<void>(() => {}),
      unregister: () => {},
    }),
    pushCompletionNotification: () => {},
  });
  return cap.tools;
}

test("registerTools: parent context (CONDUCTOR_SUBAGENT unset) registers all 8 ensemble_* tools", () => {
  const cwd = mkdtempSync(join(tmpdir(), "conductor-tools-parent-"));
  const prev = process.env.CONDUCTOR_SUBAGENT;
  delete process.env.CONDUCTOR_SUBAGENT;
  try {
    const tools = callRegisterTools(cwd);
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "ensemble_focus",
      "ensemble_kill",
      "ensemble_list",
      "ensemble_pause",
      "ensemble_resume",
      "ensemble_send",
      "ensemble_spawn",
      "ensemble_status",
    ]);
  } finally {
    if (prev === undefined) delete process.env.CONDUCTOR_SUBAGENT;
    else process.env.CONDUCTOR_SUBAGENT = prev;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("registerTools: sub-agent context (CONDUCTOR_SUBAGENT=1) suppresses all ensemble_* tools", () => {
  const cwd = mkdtempSync(join(tmpdir(), "conductor-tools-subagent-"));
  const prev = process.env.CONDUCTOR_SUBAGENT;
  process.env.CONDUCTOR_SUBAGENT = "1";
  try {
    const tools = callRegisterTools(cwd);
    const ensembleTools = tools.filter((t) => t.name.startsWith("ensemble_"));
    assert.equal(
      ensembleTools.length,
      0,
      `expected zero ensemble_* tools when CONDUCTOR_SUBAGENT=1, got: ${ensembleTools.map((t) => t.name).join(", ")}`,
    );
    // Defensive: assert no tools at all — there's nothing else
    // `registerTools` ships today, and a future addition of a
    // non-ensemble tool to `registerTools` should force this test
    // to be reconsidered (gate scope).
    assert.equal(tools.length, 0, `unexpected non-ensemble tool registered: ${tools.map((t) => t.name).join(", ")}`);
  } finally {
    if (prev === undefined) delete process.env.CONDUCTOR_SUBAGENT;
    else process.env.CONDUCTOR_SUBAGENT = prev;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("registerTools: empty CONDUCTOR_SUBAGENT='' does NOT suppress (only literal '1' gates)", () => {
  // Defensive — gate must be strict-equality on "1", not truthy. An
  // accidentally-empty CONDUCTOR_SUBAGENT="" set by some shell
  // convention should NOT silently disable the conductor's tools in
  // the parent process.
  const cwd = mkdtempSync(join(tmpdir(), "conductor-tools-empty-"));
  const prev = process.env.CONDUCTOR_SUBAGENT;
  process.env.CONDUCTOR_SUBAGENT = "";
  try {
    const tools = callRegisterTools(cwd);
    assert.equal(tools.length, 8, `expected 8 tools when CONDUCTOR_SUBAGENT='', got ${tools.length}`);
  } finally {
    if (prev === undefined) delete process.env.CONDUCTOR_SUBAGENT;
    else process.env.CONDUCTOR_SUBAGENT = prev;
    rmSync(cwd, { recursive: true, force: true });
  }
});
