/**
 * v0.11 slice 3 — per-call `on_complete_hook` wiring.
 *
 * These tests pin the contract for the per-call layer of the
 * `on_complete_hook` cascade introduced by slice 1b:
 *
 *   1. {@link resolveCloseHook} (the spawn/resume call site) honors a
 *      per-call `HookSpec` as the highest-priority layer, beating
 *      a project-config personaOverride.
 *   2. Per-call empty-string is the explicit-disable sentinel and
 *      short-circuits the cascade even when project config sets a
 *      non-empty hook.
 *   3. `sendToRun`'s spawn-resume re-fire path reads the per-call hook
 *      from `Run.onCompleteHook` (stamped at spawn time by
 *      `spawnRun`) so the same per-call winner re-applies on the
 *      resumed terminal — design §4.6 ("each terminal is a fresh
 *      gate"). A `ensemble_send` per-call override replaces the
 *      stored value before the spawn-resume call to
 *      `resolveCloseHook` reads it.
 *
 * Schema-side coverage (LLM tool argument propagation through the
 * queue) lives in `tests/timeout-override.test.ts`. The pure cascade
 * resolver (4-layer arithmetic) lives in `tests/hook-cascade.test.ts`.
 * This file specifically pins the production wiring at the spawn /
 * resume seams.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  resolveCloseHook,
  RunRegistry,
  sendToRun,
  type SendToRunOptions,
} from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function tmpProjectCwd(personaOverride?: {
  onCompleteHook?: string;
  onCompleteHookTimeoutSeconds?: number;
}): string {
  const cwd = mkdtempSync(join(tmpdir(), "conductor-slice3-hook-"));
  if (personaOverride !== undefined) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "conductor.json"),
      JSON.stringify({
        personaOverrides: {
          inspector: personaOverride,
        },
      }),
    );
  }
  return cwd;
}

function tmpSessionFile(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "conductor-slice3-session-"));
  const path = join(dir, "abc.jsonl");
  writeFileSync(path, "{}\n");
  return { dir, path };
}

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status: "completed",
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/r.json",
    transcriptPath: "/tmp/t.jsonl",
    finalPath: "/tmp/f.md",
    finishedAt: Date.now(),
    exitCode: 0,
    ...overrides,
  };
}

// ── 1. Per-call wins above project config ────────────────────────────

test("spawnRun: per-call on_complete_hook flows to SpawnOptions and resolves as top layer", () => {
  // Project config sets a hook that would lose to the per-call layer.
  // resolveCloseHook is the seam spawnRun calls with the per-call HookSpec
  // as its 3rd arg (slice 3 widening); we test the seam directly because
  // forking a real `pi` subprocess in unit tests is too heavy and
  // covered separately by the integration suite.
  const cwd = tmpProjectCwd({
    onCompleteHook: "project-hook --quality-gate",
    onCompleteHookTimeoutSeconds: 60,
  });
  try {
    const resolved = resolveCloseHook(cwd, "inspector", {
      command: "per-call-hook --inline",
      timeoutSeconds: 15,
    });
    assert.ok(resolved, "per-call layer wins, returns a ResolvedHook");
    assert.equal(resolved!.command, "per-call-hook --inline");
    assert.equal(resolved!.timeoutSeconds, 15);
    assert.equal(resolved!.source, "per-call");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 2. Per-call empty-string disables despite project hook ────────────

test('spawnRun: on_complete_hook="" disables despite project config setting one', () => {
  // Slice 1b's empty-string sentinel: per-call `""` short-circuits the
  // cascade and returns undefined — disables the hook for THIS spawn
  // even though project config has a non-empty value. Documented
  // design risk R7 (does NOT persist; next spawn without per-call
  // empty-string would cascade normally to project's hook).
  const cwd = tmpProjectCwd({
    onCompleteHook: "project-hook --runs-by-default",
    onCompleteHookTimeoutSeconds: 90,
  });
  try {
    const resolved = resolveCloseHook(cwd, "inspector", {
      command: "",
    });
    assert.equal(
      resolved,
      undefined,
      "per-call empty-string short-circuits the cascade",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// Sanity-check the cascade still falls through to project when per-call
// is omitted entirely (undefined). Without this, test #1 above could
// pass against a buggy resolver that hard-codes the per-call layer.
test("spawnRun: omitting per-call falls through to project config (cascade sanity check)", () => {
  const cwd = tmpProjectCwd({
    onCompleteHook: "project-hook --gate",
    onCompleteHookTimeoutSeconds: 45,
  });
  try {
    const resolved = resolveCloseHook(cwd, "inspector", undefined);
    assert.ok(resolved, "project layer wins when per-call is omitted");
    assert.equal(resolved!.command, "project-hook --gate");
    assert.equal(resolved!.source, "project");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── 3. Resume preserves per-call hook on Run state ─────────────────────

test(
  "resumeFinishedRun: per-call on_complete_hook from original spawn re-applies on resumed terminal",
  () => {
    // Setup: a terminal Run whose original spawn carried a per-call
    // hook (stamped onto Run.onCompleteHook by spawnRun's slice 3
    // widening). When `sendToRun` re-fires the run via spawn-resume,
    // it must read run.onCompleteHook and feed it back into
    // resolveCloseHook so the second-pass terminal honors the same
    // per-call winner — design §4.6.
    //
    // We exercise this by checking two invariants:
    //
    //   (a) Run.onCompleteHook survives untouched when sendToRun is
    //       called WITHOUT a per-send override. The pre-existing
    //       per-call layer must persist (slice 3 acceptance).
    //
    //   (b) Run.onCompleteHook is REPLACED in place when sendToRun is
    //       called WITH a per-send override. The replacement happens
    //       BEFORE the resume subprocess fires, so subsequent calls
    //       to resolveCloseHook(run.cwd, run.persona, hookSpecFromOpts(
    //         run.onCompleteHook, ...))
    //       observe the new value.
    //
    // We probe by aborting the sendToRun before it forks (missing
    // sessionPath → rejected). The per-send override merge for
    // spawn-resume happens only on the success path, so for invariant
    // (b) we exercise the RPC code path (which applies the override
    // synchronously before the rpc enqueue).

    // ── (a) no per-send override — Run.onCompleteHook persists ──────
    const reg1 = new RunRegistry();
    const original = makeRun("inspector-resume1", {
      onCompleteHook: "spawn-time-hook --gate",
      onCompleteHookTimeoutSeconds: 30,
      sessionPath: undefined, // force rejection without per-send merge
    });
    reg1.register(original);
    const opts: SendToRunOptions = {
      registry: reg1,
      timeoutMs: 60_000,
    };
    sendToRun(original, "follow up", opts);
    assert.equal(
      original.onCompleteHook,
      "spawn-time-hook --gate",
      "spawn-time per-call hook persists across send when no override",
    );
    assert.equal(original.onCompleteHookTimeoutSeconds, 30);

    // ── (b) per-send override replaces Run.onCompleteHook in place ─
    // RPC path: needs steerable + streamingMode "rpc" + a fake stdin
    // queue so the override merge runs before enqueueRpcSendWithAck
    // returns epipe.
    const reg2 = new RunRegistry();
    const liveRun = makeRun("inspector-resume2", {
      status: "running",
      finishedAt: undefined,
      exitCode: undefined,
      onCompleteHook: "spawn-time-hook --gate",
      onCompleteHookTimeoutSeconds: 30,
      steerable: true,
      streamingMode: "rpc",
    });
    reg2.register(liveRun);
    sendToRun(liveRun, "steer the agent", {
      registry: reg2,
      timeoutMs: 60_000,
      onCompleteHook: "send-time-hook --replaced",
      onCompleteHookTimeoutSeconds: 90,
      streamingBehavior: "follow_up",
    });
    assert.equal(
      liveRun.onCompleteHook,
      "send-time-hook --replaced",
      "per-send override replaces stored per-call hook",
    );
    assert.equal(liveRun.onCompleteHookTimeoutSeconds, 90);
  },
);
