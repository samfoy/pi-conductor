/**
 * v0.9.x post-startup reconcile — slice 3: end-to-end resume regression.
 *
 * Pins the user-facing contract that motivated v0.9.x:
 *
 *   "After a hard restart of the conductor, an orphaned `running`
 *    sub-agent should be reclassified to `killed`, registered in the
 *    in-memory registry, and *resumable* via `ensemble_send` →
 *    `sendToRun` → `pi --session <path>`."
 *
 * This test composes the slice 1 + 2 + 3 surface end-to-end:
 *   1. Plant an orphan `record.json` on disk (status=running, dead pid,
 *      valid sessionPath file).
 *   2. Run `reconcileOrphansAtStartup` (mirroring what session_start
 *      will invoke after slice 3's wiring).
 *   3. Verify the orphan was reclassified on disk AND registered.
 *   4. Verify `validateSendable` accepts the registered Run.
 *   5. Verify `buildResumePiArgs(run, msg)` includes `--session <path>`.
 *   6. Verify `sendToRun` returns `kind: "started"` and flips status
 *      back to `running` (mirroring tests/runs-send.test.ts:128).
 *
 * No real pi subprocess is required; `sendToRun` swallows spawn errors
 * inside `runPiSubprocess`, so the test asserts the synchronous
 * return shape and pi-args composition without depending on a working
 * `pi` binary on PATH.
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
import {
  buildResumePiArgs,
  RunRegistry,
  sendToRun,
  validateSendable,
} from "../src/runs.ts";
import { emptyUsage, type Run, type RunRecord } from "../src/types.ts";

interface OrphanFixture {
  runsRoot: string;
  id: string;
  recordPath: string;
  sessionPath: string;
  cleanup: () => void;
}

/**
 * Plant a single orphan: status=running, pid=999999 (sentinel dead pid),
 * with a valid sessionFile on disk so `unresumable` does not fire.
 */
function plantOrphan(opts: { id?: string; sessionPresent?: boolean } = {}): OrphanFixture {
  const id = opts.id ?? "builder-orphan";
  const runsRoot = mkdtempSync(join(tmpdir(), "reconcile-resume-"));
  const dir = join(runsRoot, id);
  mkdirSync(dir, { recursive: true });

  let sessionPath: string;
  if (opts.sessionPresent !== false) {
    const sessionDir = join(dir, "session");
    mkdirSync(sessionDir, { recursive: true });
    sessionPath = join(sessionDir, "seeded.jsonl");
    writeFileSync(sessionPath, '{"type":"session"}\n');
  } else {
    sessionPath = join(dir, "session", "missing.jsonl"); // never created
  }

  const record: RunRecord = {
    id,
    persona: "builder",
    task: "fixture orphan",
    mode: "background",
    status: "running",
    startTime: 1_000,
    pid: 999_999,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    sessionPath,
  };
  writeFileSync(record.recordPath, JSON.stringify(record, null, 2));

  return {
    runsRoot,
    id,
    recordPath: record.recordPath,
    sessionPath,
    cleanup: () => rmSync(runsRoot, { recursive: true, force: true }),
  };
}

function makeDeps(fx: OrphanFixture, registry: RegistryLike): PostStartupReconcileDeps {
  return {
    runsRoot: fx.runsRoot,
    registry,
    // Sentinel "dead": every probe returns false. Mirrors a hard-restart
    // scenario where every running record's process is gone.
    isAlive: () => false,
    now: 2_000,
  };
}

// ── End-to-end resume contract ────────────────────────────────────────

test(
  "resume regression: orphan reconciled → validateSendable ok → buildResumePiArgs carries --session <path>",
  async () => {
    const fx = plantOrphan();
    try {
      const reg = new RunRegistry();
      const result = await reconcileOrphansAtStartup(makeDeps(fx, reg));

      // 1. Reclassified on disk.
      assert.deepEqual(result.reclassified, [fx.id], "orphan should land in reclassified");
      assert.deepEqual(result.unresumable, [], "valid sessionFile → not unresumable");
      const persisted: RunRecord = JSON.parse(readFileSync(fx.recordPath, "utf-8"));
      assert.equal(persisted.status, "killed", "on-disk record.json status flipped to killed");
      assert.match(
        persisted.errorMessage ?? "",
        /^orphaned:/,
        "errorMessage carries orphaned: prefix per design §5",
      );

      // 2. Registered in registry.
      const run = reg.get(fx.id);
      assert.ok(run, "registry has the re-adopted run");
      assert.equal(run!.status, "killed", "in-memory Run carries killed status");
      assert.equal(run!.sessionPath, fx.sessionPath, "sessionPath plumbed through");
      assert.equal(run!.proc, undefined, "no proc handle on re-adopted run");

      // 3. validateSendable accepts: this is the load-bearing claim from
      //    design Q5 — a re-adopted killed run with a valid sessionPath
      //    is sendable WITHOUT any change to validateSendable.
      const check = validateSendable(run!);
      assert.equal(
        check.ok,
        true,
        `validateSendable should accept re-adopted killed run; got: ${check.ok ? "" : check.reason}`,
      );

      // 4. buildResumePiArgs threads --session through to the resumed pi.
      //    Pure function; deterministic; doesn't require a pi binary.
      const args = buildResumePiArgs(run!, "follow-up message");
      const sessionFlagIdx = args.indexOf("--session");
      assert.notEqual(sessionFlagIdx, -1, "resumed args contain --session");
      assert.equal(
        args[sessionFlagIdx + 1],
        fx.sessionPath,
        "--session value matches the original sessionPath on disk",
      );
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "resume regression: sendToRun on a re-adopted orphan returns started and flips status → running",
  async () => {
    const fx = plantOrphan({ id: "builder-resume" });
    try {
      const reg = new RunRegistry();
      await reconcileOrphansAtStartup(makeDeps(fx, reg));
      const run = reg.get(fx.id)!;
      assert.equal(run.status, "killed", "precondition: reconciled to killed");

      const result = sendToRun(run, "another question", {
        registry: reg,
        timeoutMs: 60_000,
      });
      assert.equal(
        result.kind,
        "started",
        `sendToRun should accept the re-adopted orphan; got: ${result.kind === "rejected" ? result.reason : ""}`,
      );
      // Mirrors the pattern in tests/runs-send.test.ts:128 — assert the
      // synchronous flip and clean up the proc immediately rather than
      // waiting on the (possibly broken) pi binary to exit.
      assert.equal(run.status, "running", "sendToRun flips status back to running");
      assert.equal(run.finishedAt, undefined, "terminal fields cleared");
      assert.equal(run.exitCode, undefined, "exit code cleared");
      try {
        run.proc?.kill("SIGKILL");
      } catch {
        // already gone (e.g. pi binary missing)
      }
    } finally {
      fx.cleanup();
    }
  },
);

test(
  "resume regression: orphan with missing sessionFile lands in unresumable AND validateSendable rejects",
  async () => {
    const fx = plantOrphan({ id: "builder-no-session", sessionPresent: false });
    try {
      const reg = new RunRegistry();
      const result = await reconcileOrphansAtStartup(makeDeps(fx, reg));

      assert.deepEqual(result.reclassified, [fx.id], "still reclassified");
      assert.deepEqual(result.unresumable, [fx.id], "and flagged as unresumable");

      const run = reg.get(fx.id);
      assert.ok(run, "still registered so /conductor history surfaces it");

      // The downstream rejection: validateSendable refuses to send to a
      // run whose sessionPath file is gone. This is what `unresumable`
      // exists to predict — the doctor surface (slice 4) reads the
      // unresumable list so the user knows resume will fail BEFORE
      // they try.
      const check = validateSendable(run!);
      assert.equal(check.ok, false, "validateSendable rejects when session file is gone");
    } finally {
      fx.cleanup();
    }
  },
);
