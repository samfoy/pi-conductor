/**
 * v0.12 slice 5 — RPC orphan reclassify executor (oracle fix #3).
 *
 * Pins the executor's behaviour for the new branch:
 *
 *   record.streamingMode === "rpc" AND alive pid →
 *     • on-disk record.json: status=killed, errorMessage="orphaned: rpc-stream-detached"
 *     • registry: orphan registered with status=killed, same errorMessage
 *     • SIGTERM the orphaned child (best-effort; ESRCH benign)
 *     • NO new RunStatus enum value (PRD :524 D1)
 *
 * The classifier-level test (`tests/reconcile-startup-classifier.test.ts:
 *   classifyRecord: rpc orphan...`) pins the verdict; this file pins the
 * full executor flow (errorMessage prefix character-exact, registry
 * mutation, SIGTERM injection seam).
 *
 * Anti-goal: NO live SIGTERMs. The injectable `signal` seam is exercised
 * with a spy.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  reconcileOrphansAtStartup,
  type PostStartupReconcileDeps,
  type RegistryLike,
} from "../src/reconcile-startup.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type RunRecord } from "../src/types.ts";

interface RpcOrphanFixture {
  runsRoot: string;
  id: string;
  recordPath: string;
  cleanup: () => void;
}

function plantRpcOrphan(opts: {
  id?: string;
  pid?: number;
  streamingMode?: "print" | "rpc";
  steerable?: boolean;
} = {}): RpcOrphanFixture {
  const id = opts.id ?? "builder-rpc-orphan";
  const runsRoot = mkdtempSync(join(tmpdir(), "reconcile-rpc-orphan-"));
  const dir = join(runsRoot, id);
  mkdirSync(dir, { recursive: true });
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  const sessionPath = join(sessionDir, "seeded.jsonl");
  writeFileSync(sessionPath, '{"type":"session"}\n');

  const record: RunRecord = {
    id,
    persona: "builder",
    task: "rpc orphan fixture",
    mode: "background",
    status: "running",
    startTime: 1_000,
    pid: opts.pid ?? 999_999,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    sessionPath,
    streamingMode: opts.streamingMode,
    steerable: opts.steerable,
  };
  writeFileSync(record.recordPath, JSON.stringify(record, null, 2));

  return {
    runsRoot,
    id,
    recordPath: record.recordPath,
    cleanup: () => rmSync(runsRoot, { recursive: true, force: true }),
  };
}

interface SignalSpyCall {
  pid: number;
  signal: NodeJS.Signals | number;
}

function makeDeps(
  fx: RpcOrphanFixture,
  registry: RegistryLike,
  isAlive: (pid: number) => boolean,
  signalCalls: SignalSpyCall[],
): PostStartupReconcileDeps {
  return {
    runsRoot: fx.runsRoot,
    registry,
    isAlive,
    now: 2_000,
    signal: (pid, signal) => {
      signalCalls.push({ pid, signal });
    },
  };
}

// ── Executor: full path tests ─────────────────────────────────────────

test(
  "executor: rpc orphan + alive pid → SIGTERMs the pid AND writes errorMessage 'orphaned: rpc-stream-detached'",
  async () => {
    const fx = plantRpcOrphan({ streamingMode: "rpc", steerable: true, pid: 12345 });
    try {
      const reg = new RunRegistry();
      const signalCalls: SignalSpyCall[] = [];
      const result = await reconcileOrphansAtStartup(
        makeDeps(fx, reg, () => true, signalCalls),
      );

      // 1. Verdict: reclassified.
      assert.deepEqual(result.reclassified, [fx.id]);

      // 2. errorMessage prefix is character-exact (oracle fix #3 +
      //    plan §5 critic gate 2). NOT regex-matched — byte-for-byte
      //    equality so a typo in the prefix surfaces here.
      const persisted: RunRecord = JSON.parse(readFileSync(fx.recordPath, "utf-8"));
      assert.equal(persisted.status, "killed");
      assert.equal(
        persisted.errorMessage,
        "orphaned: rpc-stream-detached",
        "errorMessage MUST be exactly 'orphaned: rpc-stream-detached' (character-pin per plan §5 critic gate 2)",
      );

      // 3. SIGTERM was sent to the orphaned pid exactly once.
      assert.equal(signalCalls.length, 1, "exactly one SIGTERM");
      assert.equal(signalCalls[0]!.pid, 12345);
      assert.equal(signalCalls[0]!.signal, "SIGTERM");

      // 4. Registry sees the orphan as killed with the matching
      //    errorMessage — `ensemble_status` will surface it.
      const orphan = reg.get(fx.id);
      assert.ok(orphan, "orphan registered");
      assert.equal(orphan.status, "killed");
      assert.equal(orphan.errorMessage, "orphaned: rpc-stream-detached");
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "executor: rpc orphan + dead pid → reclassify with 'orphaned: process gone' (NO SIGTERM, no double-message)",
  async () => {
    // Dead-pid path: classifier already returns reclassify-killed, but
    // the executor must NOT use the rpc-stream-detached prefix
    // (the rpc-detach is meaningful only when the child is still alive
    // holding a stranded pipe). Print-mode-style "process gone" prefix
    // applies. SIGTERM is skipped because the pid is gone.
    const fx = plantRpcOrphan({ streamingMode: "rpc", steerable: true, pid: 12345 });
    try {
      const reg = new RunRegistry();
      const signalCalls: SignalSpyCall[] = [];
      const result = await reconcileOrphansAtStartup(
        makeDeps(fx, reg, () => false, signalCalls),
      );
      assert.deepEqual(result.reclassified, [fx.id]);
      const persisted: RunRecord = JSON.parse(readFileSync(fx.recordPath, "utf-8"));
      assert.equal(persisted.status, "killed");
      assert.equal(
        persisted.errorMessage,
        "orphaned: process gone (post-startup reconcile)",
        "dead-pid path uses the v0.9.x 'process gone' prefix, NOT rpc-stream-detached",
      );
      assert.equal(
        signalCalls.length,
        0,
        "dead pid path must NOT call signal() (no point, ESRCH would be benign but is wasted work)",
      );
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "executor: print-mode orphan + dead pid → unchanged from v0.9.x (regression pin)",
  async () => {
    // The v0.12 changes must NOT regress the v0.9.x print-mode
    // reclassify behaviour: 'orphaned: process gone' prefix, no
    // SIGTERM, registry shows status=killed.
    const fx = plantRpcOrphan({ streamingMode: "print" });
    try {
      const reg = new RunRegistry();
      const signalCalls: SignalSpyCall[] = [];
      const result = await reconcileOrphansAtStartup(
        makeDeps(fx, reg, () => false, signalCalls),
      );
      assert.deepEqual(result.reclassified, [fx.id]);
      const persisted: RunRecord = JSON.parse(readFileSync(fx.recordPath, "utf-8"));
      assert.equal(
        persisted.errorMessage,
        "orphaned: process gone (post-startup reconcile)",
      );
      assert.equal(signalCalls.length, 0);
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "executor: SIGTERM injection swallows ESRCH (race: pid died between classify and signal)",
  async () => {
    // Edge case: between classifier's isAlive(pid) and executor's
    // signal(pid, SIGTERM), the child exits. signal() throws ESRCH.
    // The executor must NOT crash the entire reconcile pass.
    const fx = plantRpcOrphan({ streamingMode: "rpc", steerable: true, pid: 12345 });
    try {
      const reg = new RunRegistry();
      const signalCalls: SignalSpyCall[] = [];
      const deps: PostStartupReconcileDeps = {
        runsRoot: fx.runsRoot,
        registry: reg,
        isAlive: () => true,
        now: 2_000,
        signal: (pid, signal) => {
          signalCalls.push({ pid, signal });
          // Simulate the race: pid is gone between probe and signal.
          const e = new Error("kill ESRCH") as NodeJS.ErrnoException;
          e.code = "ESRCH";
          throw e;
        },
      };
      const result = await reconcileOrphansAtStartup(deps);
      assert.deepEqual(result.reclassified, [fx.id]);
      assert.equal(result.errors.length, 0, "ESRCH must be swallowed (race is benign)");
      const persisted: RunRecord = JSON.parse(readFileSync(fx.recordPath, "utf-8"));
      assert.equal(persisted.errorMessage, "orphaned: rpc-stream-detached");
      assert.equal(signalCalls.length, 1, "we still ATTEMPTED the signal");
    } finally {
      fx.cleanup();
    }
  },
);

// ── No new RunStatus enum value (critic gate 2) ───────────────────────

test(
  "RunStatus enum has no new variants (critic gate 2: reuse 'killed', NO 'rpc_orphaned' or similar)",
  () => {
    // Defensive lock: this test reads src/types.ts and asserts the
    // RunStatus type definition string is the v0.10 expected shape.
    // If a future refactor adds a new RunStatus variant the test
    // fires. PRD :524 D1 lock; oracle fix #3.
    const src = readFileSync(
      new URL("../src/types.ts", import.meta.url),
      "utf-8",
    );
    const m = src.match(/export type RunStatus =[^;]+;/);
    assert.ok(m, "RunStatus type definition must be present in src/types.ts");
    const def = m![0];
    // Allowed members: queued, running, paused, completed, failed,
    // killed, timeout (v0.10), hook_failed (v0.11). v0.12 fix #3 forbids
    // any further additions for the steering milestone.
    const allowed = [
      "queued",
      "running",
      "paused",
      "completed",
      "failed",
      "killed",
      "timeout",
      "hook_failed",
    ];
    for (const s of allowed) {
      assert.match(def, new RegExp(`"${s}"`), `RunStatus must include "${s}"`);
    }
    // Forbid any NEW string-literal members.
    const literals = def.match(/"[a-zA-Z_]+"/g) ?? [];
    for (const lit of literals) {
      const v = lit.slice(1, -1);
      assert.ok(
        allowed.includes(v),
        `RunStatus added new variant "${v}" — forbidden by PRD :524 D1 + v0.12 fix #3`,
      );
    }
  },
);
