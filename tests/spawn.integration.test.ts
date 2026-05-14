/**
 * Spawn integration test — exercises the real subprocess machinery without
 * involving a parent LLM. We spawn the `inspector` persona on a trivial task
 * and assert the run reaches a terminal status with a transcript on disk.
 *
 * Long-running (uses an actual pi subprocess); skipped in CI by default.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolvePersonas } from "../src/personas.ts";
import { RunRegistry, runDir, sendToRun } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";

const HAS_PI = (() => {
  try {
    execSync("pi --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const RUN_LIVE = process.env.CONDUCTOR_LIVE_TESTS === "1" && HAS_PI;

test(
  "spawn integration: inspector persona spawns and reaches a terminal status",
  { skip: !RUN_LIVE ? "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)" : false, timeout: 180_000 },
  async () => {
    // Keep the real HOME so AWS credentials work; use a tmp cwd.
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-live-cwd-"));

    try {
      const resolved = await resolvePersonas({ cwd: tmpCwd });
      const inspector = resolved.personas.get("inspector");
      assert.ok(inspector, "inspector persona must be resolvable");

      const registry = new RunRegistry();
      const queue = new SpawnQueue(registry, 4);

      const result = queue.enqueueOrSpawn({
        persona: inspector,
        task:
          "Use bash to run `echo HELLO_FROM_INSPECTOR` and report what you saw. Do not call any other tools.",
        mode: "background",
        cwd: tmpCwd,
        timeoutMs: 120_000,
      });

      assert.equal(result.kind, "spawned", "should spawn immediately (slot available)");
      if (result.kind !== "spawned") return;

      const finished = await result.done;

      assert.equal(finished.id, result.run.id);
      assert.ok(
        finished.status === "completed" || finished.status === "failed",
        `unexpected terminal status: ${finished.status}`,
      );

      // Record should be on disk regardless of whether pi emitted any events
      // before exit.
      assert.ok(existsSync(finished.recordPath), "record.json should be written");

      // Final.md should exist (may contain '(no output)' if pi exited early).
      assert.ok(existsSync(finished.finalPath), "final.md should be written");

      // runDir should resolve under the real $HOME's conductor runs root.
      assert.equal(
        runDir(finished.id),
        join(homedir(), ".pi", "agent", "conductor", "runs", finished.id),
      );
    } finally {
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);

test(
  "spawn integration: ensemble_send resumes a finished sub-agent's session",
  { skip: !RUN_LIVE ? "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)" : false, timeout: 240_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-live-cwd-"));
    try {
      const resolved = await resolvePersonas({ cwd: tmpCwd });
      const inspector = resolved.personas.get("inspector");
      assert.ok(inspector, "inspector persona must be resolvable");

      const registry = new RunRegistry();
      const queue = new SpawnQueue(registry, 4);

      const result = queue.enqueueOrSpawn({
        persona: inspector,
        task:
          "Reply only with the literal string FIRST_REPLY and stop. Do not call any tools.",
        mode: "background",
        cwd: tmpCwd,
        timeoutMs: 120_000,
      });
      assert.equal(result.kind, "spawned");
      if (result.kind !== "spawned") return;

      const after1 = await result.done;
      assert.ok(
        after1.status === "completed" || after1.status === "failed",
        `unexpected terminal status after spawn: ${after1.status}`,
      );
      const turnsAfter1 = after1.usage.turns;
      assert.ok(after1.sessionPath, "sessionPath must be discovered after spawn");
      if (!after1.sessionPath) return;
      assert.ok(existsSync(after1.sessionPath), "sessionPath must exist on disk");

      // Send a follow-up. The sub-agent should resume from the same session
      // and produce a second assistant turn.
      const sendResult = sendToRun(
        after1,
        "Reply only with the literal string SECOND_REPLY and stop. Do not call any tools.",
        { registry, timeoutMs: 120_000 },
      );
      assert.equal(sendResult.kind, "started");
      if (sendResult.kind !== "started") return;

      const after2 = await sendResult.done;
      assert.ok(
        after2.status === "completed" || after2.status === "failed",
        `unexpected terminal status after send: ${after2.status}`,
      );
      assert.equal(after2.id, after1.id, "send reuses the same Run");
      assert.ok(
        after2.usage.turns > turnsAfter1,
        `expected at least one new assistant turn after send (was ${turnsAfter1}, now ${after2.usage.turns})`,
      );

      // Transcript on disk should contain both turns' assistant text.
      const transcript = readFileSync(after2.transcriptPath, "utf8");
      assert.match(transcript, /FIRST_REPLY|SECOND_REPLY/, "transcript should contain at least one of the two reply markers");
    } finally {
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);
