/**
 * Chain successors get the same worktree decision as ensemble_spawn
 * (builder-xzz1 open issue 3). A write-capable successor chained after a
 * merged parent branches its own worktree from the current HEAD, which holds
 * the parent's work, and merges back. When the parent's branch was kept
 * unmerged (mergeStrategy none), a write-capable successor must not start
 * from a base that lacks that work: it fails with the kept-branch hint. A
 * read-only successor still starts, with the branch template variables.
 *
 * Real git in temp repos (gitTestEnv), a real SpawnQueue, and a PI_BIN stub
 * standing in for pi: it commits in its cwd and records where it ran.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { SpawnQueue } from "../src/queue.ts";
import { RunRegistry, spawnRun } from "../src/runs.ts";
import { resolvePersonas } from "../src/personas.ts";
import { buildOnChainCallback } from "../src/tools.ts";
import { DEFAULT_CONFIG, type MergeStrategy, type Run } from "../src/types.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { tmpDir } from "./helpers/tmp.ts";

const git = (cwd: string, cmd: string): string =>
  execSync(`git ${cmd}`, { cwd, env: gitTestEnv(), stdio: "pipe" }).toString();

const TERMINAL = new Set(["completed", "failed", "killed", "timeout", "hook_failed", "merge_conflict", "aborted"]);

/**
 * The parent (task BUILD) commits work.ts. A successor records its cwd in
 * ran-<persona>.txt; a write-capable one exits 4 unless it sees work.ts,
 * then commits <persona>.ts.
 */
function writeStub(root: string): string {
  const stub = join(root, "pi-stub.mjs");
  writeFileSync(
    stub,
    `import { execSync } from "node:child_process";\n` +
      `import { existsSync, writeFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `const args = process.argv.slice(2);\n` +
      `const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));\n` +
      `const commit = (file) => { writeFileSync(file, "x\\n"); execSync(\`git add \${file} && git -c user.email=t@t -c user.name=T commit -m \${file}\`, { env, stdio: "pipe" }); };\n` +
      `const prompt = args.at(-1);\n` +
      `if (prompt.endsWith("## Task\\n\\nBUILD")) { commit("work.ts"); process.exit(0); }\n` +
      `const persona = (args[args.indexOf("--append-system-prompt") + 1].match(/You are the (\\w+)/) ?? [])[1];\n` +
      `writeFileSync(join(${JSON.stringify(root)}, "ran-" + persona + ".txt"), process.cwd());\n` +
      `if (persona === "builder" || persona === "simplifier") { if (!existsSync("work.ts")) process.exit(4); commit(persona + ".ts"); }\n`,
  );
  return stub;
}

interface Chained {
  repo: string;
  root: string;
  parent: Run;
  successor: Run | undefined;
  cards: Run[];
  baseBefore: string;
}

/** Run a builder parent with `mergeStrategy`, chained to `then`, until the successor settles. */
async function chainAfterBuilder(then: string, mergeStrategy: MergeStrategy, check: (c: Chained) => void): Promise<void> {
  const root = realpathSync(tmpDir("conductor-chain-wt-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init -b mainline");
  git(repo, "config user.email t@t");
  git(repo, "config user.name T");
  writeFileSync(join(repo, "README.md"), "init\n");
  git(repo, "add README.md");
  git(repo, "commit -m init");
  const baseBefore = git(repo, "rev-parse mainline").trim();
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN };
  process.env.HOME = join(root, "home");
  process.env.PI_BIN = writeStub(root);
  try {
    const registry = new RunRegistry();
    const queue = new SpawnQueue(registry, 4, 1);
    const cards: Run[] = [];
    const builder = (await resolvePersonas({ cwd: repo })).personas.get("builder")!;
    const onChain = buildOnChainCallback({
      chainEnabled: true,
      personaName: "builder",
      cfg: { ...DEFAULT_CONFIG, chains: { builder: { then } } },
      queue,
      registry,
      cwd: repo,
      pushNotification: (r) => void cards.push(r),
      getParentMessages: () => [],
    });
    const { run: parent, done } = spawnRun({
      registry, persona: builder, task: "BUILD", mode: "background", cwd: repo,
      timeoutMs: 15_000, worktree: true, mergeStrategy, onChain,
    });
    await done;
    assert.equal(parent.status, "completed", parent.errorMessage);
    const deadline = Date.now() + 10_000;
    const settled = () => registry.list().find((r) => r.persona === then && TERMINAL.has(r.status));
    while (!settled()) {
      assert.ok(Date.now() < deadline, `timed out waiting for the ${then} successor`);
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 50)); // the successor's own settle and card
    check({ repo, root, parent, successor: settled(), cards, baseBefore });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("chain: a simplifier after a merged builder works in its own worktree from HEAD, then merges back", { timeout: 30_000 }, async () => {
  await chainAfterBuilder("simplifier", "squash", ({ repo, root, successor, baseBefore }) => {
    assert.equal(successor!.status, "completed", successor!.errorMessage);
    const ran = readFileSync(join(root, "ran-simplifier.txt"), "utf8");
    assert.equal(ran, join(repo, ".worktrees", "conductor-wt", successor!.id), "not the main checkout");
    const subjects = git(repo, `log --format=%s ${baseBefore}..mainline`).trim().split("\n");
    assert.equal(subjects.length, 2, `a squash commit per run, nothing direct: ${subjects}`);
    assert.ok(!subjects.includes("simplifier.ts"), "the simplifier's own commit never landed on base");
    assert.match(git(repo, "show --stat --oneline mainline"), /simplifier\.ts/, "its work merged back");
    assert.equal(successor!.worktreePath, undefined, "its worktree was released");
  });
});

test("chain: a simplifier after a builder whose branch was kept unmerged fails with the kept-branch hint", { timeout: 30_000 }, async () => {
  await chainAfterBuilder("simplifier", "none", ({ repo, root, parent, successor, cards, baseBefore }) => {
    const branch = parent.worktreeBranch!;
    assert.ok(branch, "precondition: the parent's branch was kept");
    assert.equal(existsSync(join(root, "ran-simplifier.txt")), false, "the simplifier never started");
    assert.equal(successor!.status, "failed");
    assert.match(successor!.errorMessage ?? "", new RegExp(`${parent.id}`));
    assert.ok(successor!.errorMessage!.includes(`cd ${repo} && git merge ${branch}`), successor!.errorMessage);
    assert.deepEqual(cards.map((c) => c.id), [successor!.id], "the refusal posts the successor's card");
    assert.equal(git(repo, "rev-parse mainline").trim(), baseBefore, "base untouched");
    assert.equal(existsSync(join(repo, ".worktrees", "conductor-wt", successor!.id)), false, "no worktree made");
  });
});

test("chain: a critic after a kept builder branch still starts, unisolated, with the branch template", { timeout: 30_000 }, async () => {
  await chainAfterBuilder("critic", "none", ({ repo, root, parent, successor }) => {
    assert.equal(readFileSync(join(root, "ran-critic.txt"), "utf8"), repo, "read-only: the requested cwd");
    assert.equal(successor!.worktreePath, undefined);
    assert.ok(successor!.task.includes(`git diff mainline...${parent.worktreeBranch}`), successor!.task);
  });
});

/** Call the chain callback for a synthetic `parent`, with a queue spy, under a temp HOME. */
async function chainSpy(then: string, parent: Partial<Run>): Promise<{ spawned: any[]; cards: Run[]; registry: RunRegistry }> {
  const root = realpathSync(tmpDir("conductor-chain-spy-"));
  const saved = process.env.HOME;
  process.env.HOME = join(root, "home");
  try {
    const spawned: any[] = [];
    const cards: Run[] = [];
    const registry = new RunRegistry();
    const onChain = buildOnChainCallback({
      chainEnabled: true,
      personaName: "builder",
      cfg: { ...DEFAULT_CONFIG, chains: { builder: { then } } },
      queue: { enqueueOrSpawn: (o: any) => void spawned.push(o) } as any,
      registry,
      cwd: root,
      pushNotification: (r) => void cards.push(r),
      getParentMessages: () => [],
    });
    await onChain!({
      id: "builder-p1", persona: "builder", task: "t", mode: "background", status: "completed",
      startTime: 0, lastEventAt: 0, messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } as any,
      cwd: root, recordPath: join(root, "r.json"), transcriptPath: join(root, "t.jsonl"), finalPath: join(root, "final.md"),
      ...parent,
    } as Run);
    return { spawned, cards, registry };
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
    rmSync(root, { recursive: true, force: true });
  }
}

test("chain: a builder successor spawns with ensemble_spawn's worktree decision", async () => {
  const { spawned } = await chainSpy("builder", {});
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].worktree, true);
  assert.equal(spawned[0].mergeStrategy, "squash");
  const critic = await chainSpy("critic", {});
  assert.equal(critic.spawned[0].worktree, false, "a read-only successor stays unisolated");
});

test("chain: a builder successor after a merge_conflict parent is refused with the parent's own kept hint", async () => {
  const kept = "worktree kept with any partial work: /r/.worktrees/conductor-wt/builder-p1 (branch conductor-wt/builder-p1); keep it with cd /r && git merge conductor-wt/builder-p1";
  const { spawned, cards, registry } = await chainSpy("builder", {
    status: "merge_conflict",
    worktreePath: "/r/.worktrees/conductor-wt/builder-p1",
    worktreeBranch: "conductor-wt/builder-p1",
    worktreeBaseBranch: "mainline",
    mergeResult: { success: false, conflicts: ["a.ts"] } as any,
    worktreeKept: kept,
  });
  assert.deepEqual(spawned, [], "never enqueued");
  const refused = registry.list().find((r) => r.persona === "builder")!;
  assert.equal(refused.status, "failed");
  assert.ok(refused.errorMessage!.includes(kept), refused.errorMessage);
  assert.match(refused.errorMessage!, /not merged into mainline/);
  assert.deepEqual(cards.map((c) => c.id), [refused.id]);
});
