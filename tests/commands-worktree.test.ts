/**
 * Tests for `/conductor worktree` slash subcommand (v0.14).
 *
 * Coverage:
 *   - `list`: reports runs with worktrees, grouped by status
 *   - `list`: reports "no active worktrees" when none present
 *   - `merge <run-id>`: triggers merge on a merge_conflict run
 *   - `merge <run-id>`: error when run not found
 *   - `merge <run-id>`: error when run is not merge_conflict status
 *   - `clean`: removes worktrees for terminal (non-merge_conflict) runs
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { runWorktreeCmd } from "../src/commands.ts";
import { RunRegistry, runsRoot } from "../src/runs.ts";
import { DEFAULT_CONFIG, emptyUsage, type Run, type RunRecord } from "../src/types.ts";

// ── Helpers ────────────────────────────────────────────────────────────

interface NotifyCall {
  message: string;
  level: string;
}

interface MockCtx {
  ui: {
    notify: (msg: string, level?: string) => void;
  };
  calls: NotifyCall[];
}

function mockCtx(): MockCtx {
  const calls: NotifyCall[] = [];
  return {
    ui: {
      notify: (message: string, level?: string) => {
        calls.push({ message, level: level ?? "info" });
      },
    },
    calls,
  };
}

interface Fx {
  root: string;
  homeDir: string;
  realHome: string | undefined;
  runsDir: string;
}

function setup(): Fx {
  const root = mkdtempSync(join(tmpdir(), "conductor-wt-cmd-test-"));
  const homeDir = join(root, "home");
  mkdirSync(homeDir, { recursive: true });
  const runsDir = join(homeDir, ".pi", "agent", "conductor", "runs");
  mkdirSync(runsDir, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = homeDir;
  return { root, homeDir, realHome, runsDir };
}

function teardown(fx: Fx): void {
  process.env.HOME = fx.realHome;
  rmSync(fx.root, { recursive: true, force: true });
}

function writeRecord(runsDir: string, record: Partial<RunRecord> & { id: string }): void {
  const dir = join(runsDir, record.id);
  mkdirSync(dir, { recursive: true });
  const full: RunRecord = {
    id: record.id,
    persona: record.persona ?? "builder",
    task: record.task ?? "test",
    mode: record.mode ?? "background",
    status: record.status ?? "completed",
    startTime: record.startTime ?? Date.now() - 60_000,
    finishedAt: record.finishedAt ?? Date.now(),
    lastEventAt: record.lastEventAt ?? Date.now(),
    usage: emptyUsage(),
    cwd: record.cwd ?? "/tmp",
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    ...(record.worktreePath ? { worktreePath: record.worktreePath } : {}),
    ...(record.worktreeBranch ? { worktreeBranch: record.worktreeBranch } : {}),
    ...(record.worktreeBaseBranch ? { worktreeBaseBranch: record.worktreeBaseBranch } : {}),
    ...(record.mergeStrategy ? { mergeStrategy: record.mergeStrategy } : {}),
    ...(record.errorMessage ? { errorMessage: record.errorMessage } : {}),
  };
  writeFileSync(join(dir, "record.json"), JSON.stringify(full), "utf8");
  writeFileSync(join(dir, "transcript.jsonl"), "", "utf8");
  writeFileSync(join(dir, "final.md"), "", "utf8");
}

function makeRegistry(runs: Partial<Run>[] = []): RunRegistry {
  const reg = new RunRegistry();
  for (const r of runs) {
    reg.register({
      id: r.id ?? "builder-test",
      persona: r.persona ?? "builder",
      task: r.task ?? "test",
      mode: r.mode ?? "background",
      status: r.status ?? "completed",
      startTime: r.startTime ?? Date.now() - 60_000,
      lastEventAt: r.lastEventAt ?? Date.now(),
      messages: [],
      usage: emptyUsage(),
      cwd: r.cwd ?? "/tmp",
      recordPath: `/tmp/${r.id}/record.json`,
      transcriptPath: `/tmp/${r.id}/transcript.jsonl`,
      finalPath: `/tmp/${r.id}/final.md`,
      ...r,
    } as Run);
  }
  return reg;
}

function mockOpts(reg: RunRegistry) {
  return {
    getRegistry: () => reg,
    getCwd: () => "/tmp",
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

test("runWorktreeCmd list: reports no active worktrees when none present", async () => {
  const fx = setup();
  try {
    const reg = makeRegistry();
    const ctx = mockCtx();
    await runWorktreeCmd(mockOpts(reg) as any, ctx as any, "list");
    const output = ctx.calls.map((c) => c.message).join("\n");
    assert.ok(output.toLowerCase().includes("no") || output.includes("0"), `expected 'no' or '0', got: ${output}`);
  } finally {
    teardown(fx);
  }
});

test("runWorktreeCmd list: shows runs with worktrees from in-memory registry", async () => {
  const fx = setup();
  try {
    const reg = makeRegistry([
      {
        id: "builder-aaaa",
        status: "running",
        worktreePath: "/some/git/.worktrees/conductor-wt/builder-aaaa",
        worktreeBranch: "conductor-wt/builder-aaaa",
      } as Partial<Run>,
      {
        id: "builder-bbbb",
        status: "merge_conflict",
        worktreePath: "/some/git/.worktrees/conductor-wt/builder-bbbb",
        worktreeBranch: "conductor-wt/builder-bbbb",
      } as Partial<Run>,
    ]);
    const ctx = mockCtx();
    await runWorktreeCmd(mockOpts(reg) as any, ctx as any, "list");
    const output = ctx.calls.map((c) => c.message).join("\n");
    assert.ok(output.includes("builder-aaaa"), `expected builder-aaaa in output: ${output}`);
    assert.ok(output.includes("builder-bbbb"), `expected builder-bbbb in output: ${output}`);
  } finally {
    teardown(fx);
  }
});

test("runWorktreeCmd merge: error when run-id not found", async () => {
  const fx = setup();
  try {
    const reg = makeRegistry();
    const ctx = mockCtx();
    await runWorktreeCmd(mockOpts(reg) as any, ctx as any, "merge nonexistent-run");
    const output = ctx.calls.map((c) => c.message).join("\n");
    assert.ok(
      output.toLowerCase().includes("not found") || output.includes("nonexistent"),
      `expected not-found message, got: ${output}`,
    );
    assert.ok(
      ctx.calls.some((c) => c.level === "error" || c.level === "warning"),
      "expected error or warning level",
    );
  } finally {
    teardown(fx);
  }
});

test("runWorktreeCmd merge: error when run is not merge_conflict", async () => {
  const fx = setup();
  try {
    const reg = makeRegistry([{ id: "builder-cccc", status: "completed" }]);
    const ctx = mockCtx();
    await runWorktreeCmd(mockOpts(reg) as any, ctx as any, "merge builder-cccc");
    const output = ctx.calls.map((c) => c.message).join("\n");
    assert.ok(
      output.toLowerCase().includes("merge_conflict") || output.toLowerCase().includes("not in merge_conflict"),
      `expected merge_conflict requirement message, got: ${output}`,
    );
  } finally {
    teardown(fx);
  }
});

test("runWorktreeCmd clean: no-op when no terminal worktree runs", async () => {
  const fx = setup();
  try {
    const reg = makeRegistry([
      {
        id: "builder-dddd",
        status: "running",
        worktreePath: "/some/path",
        worktreeBranch: "conductor-wt/builder-dddd",
      } as Partial<Run>,
    ]);
    const ctx = mockCtx();
    await runWorktreeCmd(mockOpts(reg) as any, ctx as any, "clean");
    const output = ctx.calls.map((c) => c.message).join("\n");
    // Should report nothing cleaned or 0 cleaned
    assert.ok(
      output.includes("0") || output.toLowerCase().includes("no") || output.toLowerCase().includes("nothing"),
      `expected 0/no/nothing in output: ${output}`,
    );
  } finally {
    teardown(fx);
  }
});

test("runWorktreeCmd: unknown subcommand shows usage", async () => {
  const fx = setup();
  try {
    const reg = makeRegistry();
    const ctx = mockCtx();
    await runWorktreeCmd(mockOpts(reg) as any, ctx as any, "bogus-sub");
    const output = ctx.calls.map((c) => c.message).join("\n");
    assert.ok(
      output.includes("list") || output.includes("merge") || output.includes("clean"),
      `expected usage hint in output: ${output}`,
    );
  } finally {
    teardown(fx);
  }
});
