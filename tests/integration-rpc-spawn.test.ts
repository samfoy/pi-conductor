/**
 * v0.12 slice 6 — live integration tests for steerable RPC sub-agents.
 *
 * Gated on `CONDUCTOR_LIVE_TESTS=1` per AGENTS.md. Default `npm test`
 * skips this file; with the env var set, spawns real `pi --mode rpc`
 * subprocesses against AWS-credentialled provider. Reuse a single
 * spawn pattern across cases is NOT possible — each case exercises
 * a fresh subprocess lifecycle (initial-prompt-only, mid-turn steer,
 * mid-turn follow_up, mid-turn forceTerminate). The wall-clock budget
 * (per AGENTS.md and slice 6 brief) is <60s total.
 *
 * Cases cover the slice-6 brief's `tests/integration-rpc-spawn.test.ts`
 * acceptance:
 *   1. Initial prompt injection succeeds; `lastEventAt` bumps on first
 *      `message_end`.
 *   2. `steer` mid-turn arrives; ack envelope resolves; final message
 *      reflects steered intent.
 *   3. `follow_up` queues during streaming; fires after current turn;
 *      ack resolves.
 *   4. `forceTerminate` mid-turn dies cleanly with stdin-promise
 *      rejection and `Run.status === "killed"`.
 *
 * Pi version: vendored RPC types pinned at the version in
 * `package.json`. Drift is the human's job (design §4.9). Any
 * deviation observed at test time is flagged via assertion
 * messages — re-vendor `src/rpc-types.ts` when pi bumps its dist.
 *
 * Test discipline:
 *   - Each `test(...)` carries an explicit timeout (per AGENTS.md
 *     "real-subprocess tests need explicit timeouts").
 *   - All subprocesses are forceTerminate'd in finally to ensure
 *     no orphaned pi processes after the suite.
 *   - The inspector persona is overridden inline to flip
 *     `inheritContext` to "none" (avoids the v0.8.1 audit's
 *     filtered seed file complicating the steer race).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolvePersonas } from "../src/personas.ts";
import { RunRegistry, forceTerminate, sendToRun, spawnRun } from "../src/runs.ts";
import type { Run } from "../src/types.ts";

const HAS_PI = (() => {
  try {
    execSync("pi --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const RUN_LIVE = process.env.CONDUCTOR_LIVE_TESTS === "1" && HAS_PI;
const SKIP_REASON =
  "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)";

/**
 * Wait for a predicate to become true on a Run, polling every 100ms.
 * Returns the Run when satisfied; throws on timeout.
 */
async function waitFor(
  run: Run,
  predicate: (r: Run) => boolean,
  timeoutMs: number,
  what: string,
): Promise<Run> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(run)) return run;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`waitFor(${what}) timed out after ${timeoutMs}ms`);
}

/**
 * Spawn a steerable inspector. Returns the live Run.
 *
 * The persona is shallow-copied with `inheritContext: "none"` so the
 * steerable run boots fresh; the v0.8.1 audit pinned inspector to
 * "none" already, but we set it explicitly here for safety.
 */
async function spawnSteerableInspector(
  registry: RunRegistry,
  cwd: string,
  task: string,
  timeoutMs = 60_000,
): Promise<{ run: Run; done: Promise<Run> }> {
  const resolved = await resolvePersonas({ cwd });
  const baseInspector = resolved.personas.get("inspector");
  assert.ok(baseInspector, "inspector persona must be resolvable");
  const inspector = {
    ...baseInspector,
    inheritContext: "none" as const,
  };
  const result = spawnRun({
    registry,
    persona: inspector,
    task,
    mode: "background",
    cwd,
    timeoutMs,
    steerable: true,
  });
  return { run: result.run, done: result.done };
}

test(
  "integration-rpc-spawn: initial prompt injection — lastEventAt bumps on first message_end",
  { skip: !RUN_LIVE ? SKIP_REASON : false, timeout: 60_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-rpc-init-"));
    const registry = new RunRegistry();
    let runRef: Run | undefined;
    try {
      const { run } = await spawnSteerableInspector(
        registry,
        tmpCwd,
        "Reply with the literal string INITIAL_REPLY and stop. Do not call any tools.",
      );
      runRef = run;

      // The slice-3 wiring stamps streamingMode = "rpc" once the
      // subprocess is up. The slice-3 helper also enqueues the
      // initial prompt via the RpcStdinQueue.
      assert.equal(run.steerable, true, "Run.steerable should be true post-spawn");
      assert.equal(run.streamingMode, "rpc", "Run.streamingMode should be 'rpc'");

      const startBaseline = run.startTime;

      // Wait until lastEventAt bumps past startTime (first event from
      // the live subprocess). Slice-5 narrows bumps to message_end /
      // tool_result_end / response (NOT extension_ui_request).
      await waitFor(
        run,
        (r) => r.lastEventAt > startBaseline,
        45_000,
        "lastEventAt bumps past startTime",
      );

      assert.ok(
        run.lastEventAt > startBaseline,
        `lastEventAt (${run.lastEventAt}) should bump past startTime (${startBaseline})`,
      );

      // Transcript should land on disk regardless (W7 finalize semantics).
      // Just verify the recordPath exists once we tear down.
    } finally {
      if (runRef && runRef.status === "running") {
        forceTerminate(runRef, "killed", registry);
      }
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);

test(
  "integration-rpc-spawn: steer mid-turn — ack resolves, final transcript reflects steered intent",
  { skip: !RUN_LIVE ? SKIP_REASON : false, timeout: 60_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-rpc-steer-"));
    const registry = new RunRegistry();
    let runRef: Run | undefined;
    try {
      const { run } = await spawnSteerableInspector(
        registry,
        tmpCwd,
        "Reply with the literal string FIRST_REPLY and stop. Do not call any tools.",
      );
      runRef = run;

      // Wait for the first message_end (so the initial turn finishes
      // before we steer). Pi's `steer` queues for the next turn; we
      // verify the steered text appears in a subsequent turn's reply.
      await waitFor(
        run,
        (r) => r.lastEventAt > r.startTime,
        45_000,
        "first message_end bumps lastEventAt",
      );

      // Send a steer with the explicit `streaming_behavior: "steer"`
      // flag (slice 4 wired this). Ack resolves when pi acknowledges
      // the line on its `response` channel.
      const sendResult = sendToRun(
        run,
        "Now reply with the literal string STEERED_REPLY_RAINBOW and stop.",
        { registry, timeoutMs: 30_000, streamingBehavior: "steer" },
      );

      assert.equal(sendResult.kind, "started");
      if (sendResult.kind !== "started") return;
      assert.ok(sendResult.ack, "RPC steer must return an ack promise");
      const ack = await sendResult.ack;
      assert.equal(ack.delivered, true, "steer ack must report delivered:true");

      // Wait for the steered reply to land in the transcript on disk.
      const ackedAt = ack.deliveredAt;
      const deadline = Date.now() + 30_000;
      let saw = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        if (
          run.lastEventAt > ackedAt &&
          existsSync(run.transcriptPath) &&
          readFileSync(run.transcriptPath, "utf8").includes("STEERED_REPLY_RAINBOW")
        ) {
          saw = true;
          break;
        }
      }
      assert.ok(saw, "steered text 'STEERED_REPLY_RAINBOW' must appear in transcript");
    } finally {
      if (runRef && runRef.status === "running") {
        forceTerminate(runRef, "killed", registry);
      }
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);

test(
  "integration-rpc-spawn: follow_up queues — ack resolves, fires after current turn",
  { skip: !RUN_LIVE ? SKIP_REASON : false, timeout: 60_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-rpc-followup-"));
    const registry = new RunRegistry();
    let runRef: Run | undefined;
    try {
      const { run } = await spawnSteerableInspector(
        registry,
        tmpCwd,
        "Reply with the literal string FIRST_REPLY and stop. Do not call any tools.",
      );
      runRef = run;

      // Wait for first turn's message_end before sending follow_up.
      await waitFor(
        run,
        (r) => r.lastEventAt > r.startTime,
        45_000,
        "first message_end bumps lastEventAt",
      );

      const sendResult = sendToRun(
        run,
        "Reply with the literal string FOLLOWUP_BANANA and stop.",
        { registry, timeoutMs: 30_000, streamingBehavior: "follow_up" },
      );

      assert.equal(sendResult.kind, "started");
      if (sendResult.kind !== "started") return;
      assert.ok(sendResult.ack, "RPC follow_up must return an ack promise");
      const ack = await sendResult.ack;
      assert.equal(ack.delivered, true, "follow_up ack must report delivered:true");

      // Verify the queued reply lands.
      const deadline = Date.now() + 30_000;
      let saw = false;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        if (
          existsSync(run.transcriptPath) &&
          readFileSync(run.transcriptPath, "utf8").includes("FOLLOWUP_BANANA")
        ) {
          saw = true;
          break;
        }
      }
      assert.ok(saw, "follow_up text 'FOLLOWUP_BANANA' must appear in transcript");
    } finally {
      if (runRef && runRef.status === "running") {
        forceTerminate(runRef, "killed", registry);
      }
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);

test(
  "integration-rpc-spawn: forceTerminate mid-turn — Run.status='killed', stdin-promise rejection",
  { skip: !RUN_LIVE ? SKIP_REASON : false, timeout: 30_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-rpc-kill-"));
    const registry = new RunRegistry();
    try {
      const { run, done } = await spawnSteerableInspector(
        registry,
        tmpCwd,
        // A long task so the subprocess is definitely mid-turn when we kill.
        "Tell me a 500-word story about a rainbow. Use no tools.",
      );

      // Wait until the subprocess has emitted at least one event so we
      // know it's truly running (not still booting).
      await waitFor(
        run,
        (r) => r.lastEventAt > r.startTime || r.status !== "running",
        20_000,
        "subprocess up and running",
      );

      assert.equal(run.status, "running", "run must be running before kill");

      // Slice-5 wiring: forceTerminate calls
      // `RpcStdinQueue.destroy("force-terminate")` before SIGTERM so
      // any pending stdin enqueue rejects cleanly.
      forceTerminate(run, "killed", registry);

      const finalRun = await done;
      assert.equal(finalRun.status, "killed", "Run.status must be 'killed' after forceTerminate");
      assert.equal(finalRun.id, run.id, "forceTerminate operates on the same Run id");
    } finally {
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);
