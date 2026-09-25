/**
 * Smoke: ensemble_spawn's `cwd` picks the git root for `worktree: true`
 * isolation. A builder spawned with a cwd inside a temp repo runs in a
 * conductor worktree of THAT repo and squash-merges back; spawned outside
 * a repo it runs in the cwd itself with no worktree.
 *
 * Forks real subprocesses, but not pi: `PI_BIN` points at a stub that logs
 * its cwd and, inside a git checkout, commits one file. HOME is sandboxed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { gitTestEnv } from "./helpers/git-env.ts";
import { awaitTerminal, registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { tmpDir } from "./helpers/tmp.ts";

const STUB = (log: string) => `import { appendFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
appendFileSync(${JSON.stringify(log)}, process.cwd() + "\\n");
try {
  execSync("git rev-parse --show-toplevel", { env, stdio: "pipe" });
  writeFileSync("from-child.txt", "child\\n");
  execSync("git add from-child.txt && git commit -qm child", { env, stdio: "pipe" });
} catch {}
`;

async function withSmoke(
  fn: (s: { conductorCwd: string; repo: string; plain: string; cwdLog: () => string[]; spawn: (cwd: string) => Promise<any> }) => Promise<void>,
): Promise<void> {
  const root = realpathSync(tmpDir("conductor-spawn-cwd-smoke-"));
  const log = join(root, "cwd.log");
  const stub = join(root, "pi-stub.mjs");
  writeFileSync(stub, STUB(log));
  const conductorCwd = join(root, "conductor");
  const plain = join(root, "plain");
  const repo = join(root, "repo");
  for (const d of [join(root, "home"), conductorCwd, plain, repo]) mkdirSync(d, { recursive: true });
  const git = { cwd: repo, stdio: "pipe" as const, env: gitTestEnv() };
  execSync("git init -q", git);
  execSync("git config user.email t@t.com && git config user.name T", git);
  writeFileSync(join(repo, "README.md"), "init\n");
  execSync("git add README.md && git commit -qm init", git);

  const keys = ["HOME", "PI_BIN", "CONDUCTOR_SUBAGENT", "PI_CONDUCTOR_WORKTREE_MODE"] as const;
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.HOME = join(root, "home");
  process.env.PI_BIN = stub;
  delete process.env.CONDUCTOR_SUBAGENT;
  delete process.env.PI_CONDUCTOR_WORKTREE_MODE;

  const reg = new RunRegistry();
  const tools = new Map<string, any>();
  registerTools({ registerTool: (t: any) => void tools.set(t.name, t) } as any, {
    getCwd: () => conductorCwd,
    getRegistry: () => reg,
    getQueue: () => new SpawnQueue(reg, 4, 1),
    getModel: () => new FocusedStreamModel(reg),
    getParentMessages: () => [],
    openFocusedOverlay: () => {},
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
    pushCompletionNotification: () => {},
  });
  const spawn = async (cwd: string) => {
    const r = await tools.get("ensemble_spawn").execute("s", {
      persona: "builder",
      task: "probe",
      foreground: false,
      chain: false,
      cwd,
    });
    const id = r.details.agent_id;
    assert.ok(id, `spawn started: ${r.content[0].text}`);
    return awaitTerminal(reg, id).promise;
  };
  const cwdLog = () => readFileSync(log, "utf8").trim().split("\n");
  try {
    await fn({ conductorCwd, repo, plain, cwdLog, spawn });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("ensemble_spawn cwd inside a git repo: builder runs in a conductor worktree of that repo and squash-merges back", { timeout: 20_000 }, () =>
  withSmoke(async ({ repo, cwdLog, spawn }) => {
    const run = await spawn(repo);
    assert.equal(run.status, "completed", run.errorMessage);
    const worktree = join(repo, ".worktrees", "conductor-wt", run.id);
    assert.deepEqual(cwdLog(), [worktree], "child ran inside the repo's conductor worktree");
    assert.equal(run.cwd, repo);
    assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).cwd, repo, "record.json carries the spawn cwd");
    assert.equal(run.mergeResult?.success, true, JSON.stringify(run.mergeResult));
    assert.ok(existsSync(join(repo, "from-child.txt")), "child's commit squash-merged into the repo");
  }));

test("ensemble_spawn cwd outside a git repo: builder runs in the cwd with no worktree", { timeout: 20_000 }, () =>
  withSmoke(async ({ plain, cwdLog, spawn }) => {
    const run = await spawn(plain);
    assert.equal(run.status, "completed", run.errorMessage);
    assert.deepEqual(cwdLog(), [plain]);
    assert.equal(run.worktreePath, undefined);
    assert.equal(run.cwd, plain);
    assert.equal(existsSync(join(plain, ".worktrees")), false);
  }));
