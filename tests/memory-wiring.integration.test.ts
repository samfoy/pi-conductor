/**
 * v0.18-S4 — live wiring test: a real spawned run's outcome is recorded to
 * the memory store on terminal (finalize path).
 *
 * Gated behind CONDUCTOR_LIVE_TESTS=1 (uses a real pi subprocess + AWS
 * creds), matching tests/spawn.integration.test.ts. The finalize→record
 * wiring cannot be exercised without a real subprocess lifecycle (the
 * recording fires in the finalize closure on terminal), so this is the
 * home for its end-to-end witness — the pure/IO units are covered in
 * tests/memory.test.ts.
 *
 * Redirects CONDUCTOR_MEMORY_PATH to a temp file so it never touches the
 * real user store.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { resolvePersonas } from "../src/personas.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { loadOutcomes, normalizeTaskShape } from "../src/memory.ts";

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
  "memory wiring: a completed run records an outcome to the store",
  {
    skip: !RUN_LIVE
      ? "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)"
      : false,
    timeout: 180_000,
  },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "conductor-mem-wire-"));
    const memPath = join(dir, "outcomes.jsonl");
    const prev = process.env.CONDUCTOR_MEMORY_PATH;
    process.env.CONDUCTOR_MEMORY_PATH = memPath;
    const task = "Use bash to run `echo HELLO_MEM` and report what you saw. Do not call any other tools.";
    try {
      const resolved = await resolvePersonas({ cwd: dir });
      const inspector = resolved.personas.get("inspector");
      assert.ok(inspector, "inspector persona must resolve");

      const registry = new RunRegistry();
      const queue = new SpawnQueue(registry, 4);
      const { done } = queue.enqueueOrSpawn({
        persona: inspector,
        task,
        mode: "background",
        cwd: dir,
        timeoutMs: 120_000,
      }) as { done: Promise<unknown> };
      await done;

      const recs = loadOutcomes(memPath);
      assert.equal(recs.length, 1, "exactly one outcome recorded");
      assert.equal(recs[0].persona, "inspector");
      assert.equal(recs[0].taskShape, normalizeTaskShape(task));
      assert.ok(recs[0].ts > 0);
      assert.ok(typeof recs[0].durationMs === "number");
    } finally {
      if (prev === undefined) delete process.env.CONDUCTOR_MEMORY_PATH;
      else process.env.CONDUCTOR_MEMORY_PATH = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
