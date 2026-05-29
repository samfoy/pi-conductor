/**
 * pi-conductor — GC executor tests.
 *
 * mkdtempSync integration tests for `executeReclaim`. Each test builds a
 * temporary runs root, runs the executor, and asserts on-disk state.
 *
 * Spec: docs/v0.9-gc-design.md §D3 (cold-archive → delete tier ladder),
 * §D7 (post-archive resume), §D8 (two-gate invariant), oracle review A2.
 * docs/v0.9-gc-plan.md "Slice 3".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, statSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executeReclaim } from "../src/gc/executor.ts";
import type { ReclaimAction } from "../src/gc/policy.ts";
import type { RunRecord } from "../src/types.ts";

const NOW = 1_750_000_000_000;

function makeTempRunsRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-conductor-gc-exec-"));
}

interface RunDirOpts {
  status?: RunRecord["status"];
  withSession?: boolean;
  withFinal?: boolean;
  withTranscript?: boolean | string;
  withPinned?: boolean;
  withArchived?: boolean;
}

function makeRunDir(runsRoot: string, id: string, opts: RunDirOpts = {}): string {
  const runDir = join(runsRoot, id);
  mkdirSync(runDir, { recursive: true });

  const record: RunRecord = {
    id,
    persona: "inspector",
    task: "test task",
    mode: "background",
    status: opts.status ?? "completed",
    startTime: NOW - 60_000,
    finishedAt: opts.status === "running" ? undefined : NOW - 30_000,
    usage: { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    cwd: "/tmp",
    recordPath: join(runDir, "record.json"),
    transcriptPath: join(runDir, "transcript.jsonl"),
    finalPath: join(runDir, "final.md"),
  };
  writeFileSync(record.recordPath, JSON.stringify(record, null, 2));

  if (opts.withTranscript !== false) {
    const body = typeof opts.withTranscript === "string" ? opts.withTranscript : "{\"type\":\"event\"}\n".repeat(50);
    writeFileSync(record.transcriptPath, body);
  }
  if (opts.withFinal !== false) {
    writeFileSync(record.finalPath, "# Final\n\nbody");
  }
  if (opts.withSession ?? true) {
    const sessionDir = join(runDir, "session");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "2026-05-19_abc.jsonl"), "{}\n");
  }
  if (opts.withPinned) writeFileSync(join(runDir, ".pinned"), "");
  if (opts.withArchived) writeFileSync(join(runDir, ".archived"), "");

  return runDir;
}

function archiveAction(id: string, bytes = 0): ReclaimAction {
  return { kind: "cold-archive", id, reason: "transcript-cap exceeded", bytesReclaimed: bytes };
}

function deleteAction(id: string, bytes = 0, losesResume = false): ReclaimAction {
  return { kind: "delete", id, reason: "archived past TTL", bytesReclaimed: bytes, losesResume };
}

// ── Tests ────────────────────────────────────────────────────────────

test("executeReclaim: empty action list → no syscalls, empty result", async () => {
  const runsRoot = makeTempRunsRoot();
  const result = await executeReclaim([], runsRoot, new Set(), NOW);
  assert.deepEqual(result.archived, []);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.failed, []);
});

test("executeReclaim: cold-archive removes transcript, preserves session+record+final, creates .archived sidecar", async () => {
  const runsRoot = makeTempRunsRoot();
  const runDir = makeRunDir(runsRoot, "inspector-aaaa");
  const before = statSync(join(runDir, "transcript.jsonl")).size;

  const result = await executeReclaim([archiveAction("inspector-aaaa")], runsRoot, new Set(), NOW);

  assert.equal(result.archived.length, 1);
  assert.equal(result.archived[0]?.agentId, "inspector-aaaa");
  assert.equal(result.archived[0]?.bytesReclaimed, before);
  assert.equal(result.failed.length, 0);

  // Transcript gone.
  assert.equal(existsSync(join(runDir, "transcript.jsonl")), false);
  // Preserved.
  assert.equal(existsSync(join(runDir, "record.json")), true);
  assert.equal(existsSync(join(runDir, "final.md")), true);
  assert.equal(existsSync(join(runDir, "session")), true);
  assert.equal(existsSync(join(runDir, "session", "2026-05-19_abc.jsonl")), true);
  // Sidecar present with mtime ~ NOW.
  assert.equal(existsSync(join(runDir, ".archived")), true);
  const sidecarMtime = statSync(join(runDir, ".archived")).mtimeMs;
  assert.ok(Math.abs(sidecarMtime - NOW) < 5_000, `sidecar mtime ${sidecarMtime} not near NOW ${NOW}`);
});

test("executeReclaim: delete removes the entire runDir", async () => {
  const runsRoot = makeTempRunsRoot();
  const runDir = makeRunDir(runsRoot, "inspector-bbbb");

  const result = await executeReclaim([deleteAction("inspector-bbbb")], runsRoot, new Set(), NOW);

  assert.equal(result.deleted.length, 1);
  assert.equal(result.deleted[0]?.agentId, "inspector-bbbb");
  assert.ok(result.deleted[0]!.bytesReclaimed > 0, "bytesReclaimed should be sum of all files");
  assert.equal(existsSync(runDir), false);
});

test("executeReclaim: skips active runs (re-checks registry) — LOAD-BEARING witness target", async () => {
  const runsRoot = makeTempRunsRoot();
  const runDir = makeRunDir(runsRoot, "inspector-cccc");
  const active = new Set(["inspector-cccc"]);

  const result = await executeReclaim(
    [archiveAction("inspector-cccc"), deleteAction("inspector-cccc")],
    runsRoot,
    active,
    NOW,
  );

  // Both actions must be in failed[], not archived/deleted.
  assert.equal(result.archived.length, 0);
  assert.equal(result.deleted.length, 0);
  assert.equal(result.failed.length, 2);
  for (const f of result.failed) {
    assert.equal(f.agentId, "inspector-cccc");
    assert.match(f.error, /active during reclaim/i);
  }
  // On-disk state must NOT have been mutated.
  assert.equal(existsSync(join(runDir, "transcript.jsonl")), true);
  assert.equal(existsSync(runDir), true);
});

test("executeReclaim: skips runs whose status changed to non-terminal since plan", async () => {
  const runsRoot = makeTempRunsRoot();
  const runDir = makeRunDir(runsRoot, "inspector-dddd", { status: "running" });

  const result = await executeReclaim([archiveAction("inspector-dddd")], runsRoot, new Set(), NOW);

  assert.equal(result.archived.length, 0);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0]!.error, /non-terminal|status changed|running/i);
  assert.equal(existsSync(join(runDir, "transcript.jsonl")), true);
});

test("executeReclaim: missing transcript.jsonl during cold-archive → not an error, sidecar still created (idempotent)", async () => {
  const runsRoot = makeTempRunsRoot();
  const runDir = makeRunDir(runsRoot, "inspector-eeee", { withTranscript: false });

  const result = await executeReclaim([archiveAction("inspector-eeee")], runsRoot, new Set(), NOW);

  assert.equal(result.archived.length, 1);
  assert.equal(result.archived[0]?.bytesReclaimed, 0);
  assert.equal(result.failed.length, 0);
  assert.equal(existsSync(join(runDir, ".archived")), true);
});

test("executeReclaim: re-archiving an already-archived run is idempotent (touches sidecar mtime)", async () => {
  const runsRoot = makeTempRunsRoot();
  const runDir = makeRunDir(runsRoot, "inspector-ffff", {
    withTranscript: false,
    withArchived: true,
  });

  const oldMtime = NOW - 600_000;
  // pre-set old mtime
  const fs = await import("node:fs");
  fs.utimesSync(join(runDir, ".archived"), oldMtime / 1000, oldMtime / 1000);

  const result = await executeReclaim([archiveAction("inspector-ffff")], runsRoot, new Set(), NOW);

  assert.equal(result.archived.length, 1);
  assert.equal(result.failed.length, 0);
  const newMtime = statSync(join(runDir, ".archived")).mtimeMs;
  assert.ok(Math.abs(newMtime - NOW) < 5_000, "sidecar mtime refreshed to NOW");
});

test("executeReclaim: missing runDir during delete → not an error", async () => {
  const runsRoot = makeTempRunsRoot();
  // Don't create the dir.

  const result = await executeReclaim([deleteAction("inspector-gggg")], runsRoot, new Set(), NOW);

  assert.equal(result.deleted.length, 1);
  assert.equal(result.deleted[0]?.bytesReclaimed, 0);
  assert.equal(result.failed.length, 0);
});

test("executeReclaim: bytesReclaimed correctly summed for delete (walks all files)", async () => {
  const runsRoot = makeTempRunsRoot();
  const runDir = makeRunDir(runsRoot, "inspector-hhhh", {
    withTranscript: "x".repeat(1000),
  });
  const fileSizes =
    statSync(join(runDir, "transcript.jsonl")).size +
    statSync(join(runDir, "record.json")).size +
    statSync(join(runDir, "final.md")).size +
    statSync(join(runDir, "session", "2026-05-19_abc.jsonl")).size;

  const result = await executeReclaim([deleteAction("inspector-hhhh")], runsRoot, new Set(), NOW);

  assert.equal(result.deleted[0]?.bytesReclaimed, fileSizes);
});

test("executeReclaim: post-archive new transcript write succeeds (A2 resume UX)", async () => {
  const runsRoot = makeTempRunsRoot();
  const runDir = makeRunDir(runsRoot, "inspector-iiii");

  // Step 1: cold-archive.
  await executeReclaim([archiveAction("inspector-iiii")], runsRoot, new Set(), NOW);
  assert.equal(existsSync(join(runDir, "transcript.jsonl")), false, "transcript gone after archive");
  assert.equal(existsSync(join(runDir, "session", "2026-05-19_abc.jsonl")), true, "session preserved");

  // Step 2: simulate event-handler appending a fresh line post-resume.
  const newEvent = '{"type":"message_update","resumed":true}';
  await appendFile(join(runDir, "transcript.jsonl"), newEvent + "\n");

  // Step 3: assert new transcript has only the resumed content.
  const fresh = readFileSync(join(runDir, "transcript.jsonl"), "utf-8");
  assert.equal(fresh, newEvent + "\n");
  // Sidecar still present (it's an advisory marker, not exclusive with new data).
  assert.equal(existsSync(join(runDir, ".archived")), true);
});

test("executeReclaim: failed actions are isolated, don't block subsequent actions", async () => {
  const runsRoot = makeTempRunsRoot();
  // First action: missing dir → succeeds (no-op).
  // Second action: active run → fails.
  // Third action: real archive → succeeds.
  makeRunDir(runsRoot, "inspector-jjjj"); // active
  makeRunDir(runsRoot, "inspector-kkkk"); // archives ok

  const result = await executeReclaim(
    [
      deleteAction("missing-id"),
      archiveAction("inspector-jjjj"),
      archiveAction("inspector-kkkk"),
    ],
    runsRoot,
    new Set(["inspector-jjjj"]),
    NOW,
  );

  assert.equal(result.deleted.length, 1, "missing-id delete is a no-op success");
  assert.equal(result.deleted[0]?.agentId, "missing-id");
  assert.equal(result.failed.length, 1, "jjjj is failed (active)");
  assert.equal(result.failed[0]?.agentId, "inspector-jjjj");
  assert.equal(result.archived.length, 1, "kkkk archived after the failure");
  assert.equal(result.archived[0]?.agentId, "inspector-kkkk");
});

test("executeReclaim: keep and reconcile-orphan actions are passed through unchanged", async () => {
  const runsRoot = makeTempRunsRoot();
  const runDir = makeRunDir(runsRoot, "inspector-llll");

  const actions: ReclaimAction[] = [
    { kind: "keep", id: "inspector-llll", reason: "within thresholds" },
    { kind: "reconcile-orphan", id: "inspector-mmmm", reason: "stale running" },
  ];

  const result = await executeReclaim(actions, runsRoot, new Set(), NOW);

  assert.deepEqual(result.archived, []);
  assert.deepEqual(result.deleted, []);
  assert.deepEqual(result.failed, []);
  // On-disk runs untouched.
  assert.equal(existsSync(join(runDir, "transcript.jsonl")), true);
});

test("executeReclaim: cold-archive preserves .pinned sidecar if present", async () => {
  const runsRoot = makeTempRunsRoot();
  const runDir = makeRunDir(runsRoot, "inspector-nnnn", { withPinned: true });

  await executeReclaim([archiveAction("inspector-nnnn")], runsRoot, new Set(), NOW);

  assert.equal(existsSync(join(runDir, ".pinned")), true, ".pinned must survive cold-archive");
  assert.equal(existsSync(join(runDir, ".archived")), true);
});

// F-S3.3 followup from docs/v0.9-gc-slice3-critic.md §F-S3.3 —
// `executor.ts:101-114` cold-archive on missing record/runDir branch
// is reachable (race between plan and execute) but was not covered
// by Slice 3's tests. Slice 4 adds the witness here.
test("executeReclaim: cold-archive on missing runDir collects to failed[] (F-S3.3)", async () => {
  const runsRoot = makeTempRunsRoot();
  // Don't create any run dir — cold-archive against a vanished run.

  const result = await executeReclaim(
    [archiveAction("inspector-oooo")],
    runsRoot,
    new Set(),
    NOW,
  );

  assert.equal(result.archived.length, 0);
  assert.equal(result.deleted.length, 0);
  assert.equal(result.failed.length, 1, "vanished cold-archive target → failed");
  assert.equal(result.failed[0]?.agentId, "inspector-oooo");
  assert.equal(result.failed[0]?.action, "cold-archive");
  assert.match(
    result.failed[0]?.error ?? "",
    /runDir missing during cold-archive/,
    "error message identifies the vanished-run cause",
  );
});

// ── v0.13 worktree-per-persona: GC delete cleans up orphaned worktree ─

import { execSync } from "node:child_process";

function cleanGitEnvForTest(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) { if (k.startsWith("GIT_") && k !== "GIT_EDITOR") delete env[k]; }
  return env;
}

function tmpGitRepoForGC(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-gc-wt-"));
  const gitOpts = { cwd: dir, stdio: "pipe" as const, env: cleanGitEnvForTest() };
  execSync("git init", gitOpts);
  execSync("git config user.email test@test.com", gitOpts);
  execSync("git config user.name Test", gitOpts);
  writeFileSync(join(dir, "README.md"), "init\n");
  execSync("git add README.md", gitOpts);
  execSync("git commit -m init", gitOpts);
  return dir;
}

test(
  "executeReclaim: delete action removes orphaned worktree when worktreePath set in record",
  { timeout: 15_000 },
  async () => {
    const runsRoot = makeTempRunsRoot();
    const gitRoot = tmpGitRepoForGC();
    try {
      // Create a real worktree that simulates a crash-orphaned one
      const runId = "builder-orphan1";
      const worktreePath = join(gitRoot, ".worktrees", "conductor-wt", runId);
      const branch = `conductor-wt/${runId}`;

      mkdirSync(join(gitRoot, ".worktrees", "conductor-wt"), { recursive: true });
      execSync(`git worktree add ${JSON.stringify(worktreePath)} -b ${JSON.stringify(branch)} HEAD`, {
        cwd: gitRoot,
        stdio: "pipe",
        env: cleanGitEnvForTest(),
      });
      assert.ok(existsSync(worktreePath), "orphaned worktree exists before GC");

      // Make a run dir with a record that has worktreePath + worktreeBranch set
      const runDir = join(runsRoot, runId);
      mkdirSync(runDir, { recursive: true });
      const record = {
        id: runId,
        persona: "builder",
        task: "test",
        mode: "background",
        status: "completed",
        startTime: Date.now() - 60_000,
        finishedAt: Date.now() - 30_000,
        usage: { turns: 1, input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0 },
        cwd: gitRoot,
        recordPath: join(runDir, "record.json"),
        transcriptPath: join(runDir, "transcript.jsonl"),
        finalPath: join(runDir, "final.md"),
        worktreePath,
        worktreeBranch: branch,
      };
      writeFileSync(record.recordPath, JSON.stringify(record, null, 2));
      writeFileSync(record.transcriptPath, "{}\n");
      writeFileSync(record.finalPath, "# Final\n");

      // Run GC delete
      const result = await executeReclaim(
        [deleteAction(runId, 1000)],
        runsRoot,
        new Set(),
        Date.now(),
      );
      assert.equal(result.failed.length, 0, "no GC failures");
      assert.equal(result.deleted.length, 1, "one run deleted");

      // Worktree should be removed
      assert.ok(!existsSync(worktreePath), "orphaned worktree removed by GC delete");

      // Run dir should also be gone
      assert.ok(!existsSync(runDir), "run dir removed by GC delete");
    } finally {
      execSync(`git worktree prune`, { cwd: gitRoot, stdio: "pipe", env: cleanGitEnvForTest() }).toString();
      rmSync(runsRoot, { recursive: true, force: true });
      rmSync(gitRoot, { recursive: true, force: true });
    }
  },
);

test(
  "executeReclaim: delete action succeeds when worktreePath in record but path already gone",
  { timeout: 10_000 },
  async () => {
    // Simulates a run where finalize already cleaned up the worktree
    // but worktreePath was NOT cleared (e.g. record written before clear).
    const runsRoot = makeTempRunsRoot();
    const runId = "builder-already-cleaned";
    const runDir = join(runsRoot, runId);
    mkdirSync(runDir, { recursive: true });
    const record = {
      id: runId,
      persona: "builder",
      task: "test",
      mode: "background",
      status: "completed",
      startTime: Date.now() - 60_000,
      finishedAt: Date.now() - 30_000,
      usage: { turns: 1, input: 10, output: 100, cacheRead: 0, cacheWrite: 0, cost: 0 },
      cwd: "/tmp",
      recordPath: join(runDir, "record.json"),
      transcriptPath: join(runDir, "transcript.jsonl"),
      finalPath: join(runDir, "final.md"),
      // Path that does NOT exist — simulates already-cleaned worktree
      worktreePath: "/tmp/nonexistent-wt-abc123/tree",
      worktreeBranch: "conductor-wt/builder-already-cleaned",
    };
    writeFileSync(record.recordPath, JSON.stringify(record, null, 2));
    writeFileSync(record.transcriptPath, "{}\n");
    writeFileSync(record.finalPath, "# Final\n");

    try {
      const result = await executeReclaim([deleteAction(runId, 500)], runsRoot, new Set(), Date.now());
      // Should succeed even though worktreePath is set but missing
      assert.equal(result.failed.length, 0, "no failures when worktree path already gone");
      assert.equal(result.deleted.length, 1, "run deleted successfully");
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  },
);
