/**
 * v0.12 slice 4 — `ensemble_spawn` per-call `steerable` arg.
 *
 * Pins that a successful background spawn with `steerable: true` flips
 * the registered Run's `steerable` flag to true (and `streamingMode`
 * stamping is delegated to slice-3 `stampSpawnStreamingMode`, which
 * fires once the subprocess is up — out of scope here).
 *
 * Cascade plumbing: per-call > project > user > built-in default.
 * The 4-input collapse is unit-tested in
 * `tests/steerable-spawn-cascade.test.ts`. This test pins the
 * end-to-end thread from LLM tool arg to `Run.steerable`.
 *
 * Test discipline: drives the real `ensemble_spawn` tool but only
 * inspects the registered Run's pre-subprocess state. The actual
 * `pi --mode rpc` spawn is slice 6's live integration coverage; here
 * the subprocess will fail to exec under a test runner without a real
 * `pi` binary on PATH, which is harmless because we read the Run
 * synchronously before that error surfaces.
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
import type { Run } from "../src/types.ts";

interface RegisteredTool {
  name: string;
  execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>;
}

function captureTools() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    pi: { registerTool: (tool: RegisteredTool) => tools.push(tool) },
  };
}

function setup(cwd: string) {
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
  const spawnTool = cap.tools.find((t) => t.name === "ensemble_spawn");
  return { reg, spawnTool };
}

test("ensemble_spawn: per-call steerable=true stamps Run.steerable=true on the registered run", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "conductor-spawn-steer-"));
  try {
    const { reg, spawnTool } = setup(cwd);
    assert.ok(spawnTool);

    // Use a built-in persona (`oracle`) so the test doesn't depend on
    // project-persona discovery quirks. Background mode so the tool
    // returns synchronously after dispatch and we can read the
    // registered Run before its subprocess fails to exec.
    const promise = spawnTool.execute("call-1", {
      persona: "oracle",
      task: "test the steerable arg",
      foreground: false,
      steerable: true,
    });

    // Don't fail the test if the spawned subprocess errors (pi binary
    // missing under the test runner is expected in this scope —
    // slice 6 covers the live exec).
    const result = await promise.catch(() => null);
    assert.ok(result !== null, "ensemble_spawn returned without throwing the tool layer");

    // Find the (only) oracle run in the registry. It was registered
    // synchronously by spawnRun before the subprocess errored.
    const runs: Run[] = reg.list().filter((r) => r.persona === "oracle");
    assert.equal(runs.length, 1, "exactly one oracle run is registered");
    const run = runs[0]!;
    assert.equal(
      run.steerable,
      true,
      "per-call steerable=true threads through the cascade and stamps run.steerable=true",
    );

    // Cleanup any pending subprocess.
    try {
      run.proc?.kill("SIGKILL");
    } catch {
      // already gone
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── v0.12 slice 5 — carry-forward from slice-4 critic Note 2 ─────────
//
// Closes the gap surfaced by slice-4 critic: the production cascade
// path `cfg.defaultSteerable ?? false` at `src/tools.ts:291` was
// untested. Slice-4's cascade test only proved the resolver shape
// (per-call > project > user > default) at the unit level; it did
// NOT exercise the actual loadConfig → collapseSteerableCascade chain
// in the LLM tool entrypoint.
//
// Test discipline: drop a `.pi/conductor.json` in the cwd with
// `defaultSteerable: true`, omit the per-call arg, assert
// run.steerable === true. Mutation-red when `cfg.defaultSteerable`
// is dropped from `src/tools.ts:291`.

test(
  "ensemble_spawn: per-call steerable=undefined + config.defaultSteerable=true → run.steerable=true (production cascade path)",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "conductor-spawn-cfg-default-"));
    try {
      // Plant a project-config file that flips defaultSteerable on.
      // loadConfig() reads `<cwd>/.pi/conductor.json` (project layer).
      // Cascade order: per-call > project > user > built-in. With no
      // per-call arg, the project value wins.
      const cfgDir = join(cwd, ".pi");
      const fs = await import("node:fs");
      fs.mkdirSync(cfgDir, { recursive: true });
      fs.writeFileSync(
        join(cfgDir, "conductor.json"),
        JSON.stringify({ defaultSteerable: true }),
      );

      const { reg, spawnTool } = setup(cwd);
      assert.ok(spawnTool);

      const promise = spawnTool.execute("call-1", {
        persona: "oracle",
        task: "production cascade test",
        foreground: false,
        // NOTE: no per-call `steerable` field — the project default
        // must thread through to run.steerable.
      });
      await promise.catch(() => null);

      const run = reg.list().find((r) => r.persona === "oracle");
      assert.ok(run, "oracle run registered");
      assert.equal(
        run.steerable,
        true,
        "production cascade: cfg.defaultSteerable=true threads through to run.steerable=true even without a per-call arg (closes slice-4 critic Note 2)",
      );

      try {
        run.proc?.kill("SIGKILL");
      } catch {
        // already gone
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test("ensemble_spawn: omitting steerable yields run.steerable=false (cascade falls through to built-in default)", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "conductor-spawn-default-"));
  try {
    const { reg, spawnTool } = setup(cwd);
    assert.ok(spawnTool);

    const promise = spawnTool.execute("call-1", {
      persona: "oracle",
      task: "no steerable arg",
      foreground: false,
    });
    await promise.catch(() => null);

    const run = reg.list().find((r) => r.persona === "oracle");
    assert.ok(run, "oracle run registered");
    assert.equal(
      run.steerable,
      false,
      "no per-call arg + default config → run.steerable defaults to false",
    );

    try {
      run.proc?.kill("SIGKILL");
    } catch {
      // already gone
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
