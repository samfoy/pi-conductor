/**
 * Spawn integration test — exercises the real subprocess machinery without
 * involving a parent LLM. We spawn the `inspector` persona on a trivial task
 * and assert the run reaches a terminal status with a transcript on disk.
 *
 * Long-running (uses an actual pi subprocess); skipped in CI by default.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolvePersonas } from "../src/personas.ts";
import { RunRegistry, runDir } from "../src/runs.ts";
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
