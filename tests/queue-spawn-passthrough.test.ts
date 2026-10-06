/**
 * v0.20 M0a, bug B1: every spawn path keeps its merge strategy.
 *
 * A queued builder used to be drained without `mergeStrategy`, so
 * finalize skipped the merge-back and removeWorktree deleted its branch:
 * the builder's commits were left dangling. ensemble_auto worktree steps
 * and classified retries never passed `mergeStrategy` at all.
 *
 *   (a) The design's section 17 experiment: real git, a PI_BIN stub that
 *       commits in its worktree, write cap 1, two builders, the second
 *       queued. Both slices must land on master.
 *   (b) An ensemble_auto worktree step and a classified retry resolve
 *       mergeStrategy through the same cascade as ensemble_spawn.
 *   (c) Drift: every SpawnOptions key survives the queue round-trip, so a
 *       future field can't be dropped the way mergeStrategy was.
 *
 * Every git call goes through gitTestEnv(); the stub scrubs GIT_* too.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunRegistry, type SpawnOptions } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { buildOnRetryCallback, registerTools } from "../src/tools.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { ConductorEventEmitter } from "../src/conductor-events.ts";
import { DEFAULT_CONFIG, emptyUsage, type Persona, type Run } from "../src/types.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { sandboxPi } from "./helpers/tmp.ts";

// SpawnQueue.enqueueOrSpawn pre-creates runDir(id) under $HOME, so without
// this the drift test leaves an empty builder-* dir in the real runs dir.
sandboxPi();

function git(cwd: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd, env: gitTestEnv(), stdio: "pipe" }).toString();
}

function builderPersona(): Persona {
  return {
    name: "builder",
    description: "probe",
    inheritContext: "none",
    inheritSkills: false,
    defaultReads: [],
    worktree: true,
    timeoutMinutes: 1,
    systemPrompt: "You are builder.",
    source: "builtin",
    sourcePath: "/fake/builder.md",
    readOnly: false,
  };
}

function withEnv<T>(over: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(over).map((k) => [k, process.env[k]]));
  Object.assign(process.env, over);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

// ── (a) section 17: the queued builder's work reaches master ──────────

test("a queued builder is drained with its merge strategy: both slices land on master", { timeout: 30_000 }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conductor-queue-b1-")));
  try {
    const repo = join(root, "repo");
    mkdirSync(repo);
    git(repo, "init -b master");
    git(repo, "config user.email t@t");
    git(repo, "config user.name T");
    writeFileSync(join(repo, "README.md"), "init\n");
    git(repo, "add README.md");
    git(repo, "commit -m init");

    // The "sub-agent": commit one file in its cwd (the worktree), then end.
    const stub = join(root, "fake-pi.mjs");
    writeFileSync(
      stub,
      `import { execFileSync } from "node:child_process";\n` +
        `import { writeFileSync } from "node:fs";\n` +
        `const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));\n` +
        `const name = "work-" + process.pid + ".txt";\n` +
        `writeFileSync(name, "x\\n");\n` +
        `const g = (...a) => execFileSync("git", ["-c", "user.name=fake", "-c", "user.email=f@f", ...a], { env, stdio: "pipe" });\n` +
        `g("add", name); g("commit", "-qm", "fake builder " + process.pid);\n` +
        `process.stdout.write(JSON.stringify({ type: "agent_end" }) + "\\n");\n`,
    );

    await withEnv({ HOME: join(root, "home"), PI_BIN: stub }, async () => {
      const reg = new RunRegistry();
      const queue = new SpawnQueue(reg, 4, 1);
      const settled = new Map<string, Run>();
      let bothSettled!: () => void;
      const allDone = new Promise<void>((resolve) => (bothSettled = resolve));
      const base = {
        persona: builderPersona(),
        mode: "background" as const,
        cwd: repo,
        timeoutMs: 20_000,
        worktree: true,
        mergeStrategy: "squash" as const,
        onComplete: (run: Run) => {
          settled.set(run.id, run);
          if (settled.size === 2) bothSettled();
        },
      };
      const r1 = queue.enqueueOrSpawn({ ...base, task: "slice one" });
      const r2 = queue.enqueueOrSpawn({ ...base, task: "slice two" });
      assert.equal(r1.kind, "spawned");
      assert.equal(r2.kind, "queued", "precondition: the write cap queues the second builder");

      await allDone;

      const onMaster = git(repo, "ls-tree --name-only master").split("\n").filter((f) => f.startsWith("work-"));
      assert.equal(onMaster.length, 2, `both slices' files are on master: ${onMaster.join(", ")}`);
      const second = reg.get(r2.kind === "queued" ? r2.pending.id : "")!;
      assert.equal(second.mergeStrategy, "squash", "the drained run kept its merge strategy");
      for (const run of settled.values()) {
        assert.equal(run.status, "completed", `${run.id}: ${run.errorMessage}`);
        assert.equal(run.mergeResult?.success, true, `${run.id} merged back`);
      }
      assert.equal(git(repo, "branch --list conductor-wt/*").trim(), "", "no worktree branch left behind");
      for (const run of settled.values()) {
        assert.equal(existsSync(join(repo, ".worktrees", "conductor-wt", run.id)), false, `${run.id} worktree removed`);
      }
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) ensemble_auto steps and classified retries ────────────────────

function makeRun(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    persona: "builder",
    task: "t",
    mode: "background",
    status: "running",
    startTime: 1,
    lastEventAt: 1,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
    ...over,
  };
}

/** Registers the conductor tools over a queue that records each spawn and completes it at once. */
function harness(cwd: string) {
  const reg = new RunRegistry();
  const calls: any[] = [];
  const queue = {
    enqueueOrSpawn(o: any) {
      calls.push(o);
      const run = makeRun(`${o.persona.name}-${calls.length}`, { cwd: o.cwd, status: "completed" });
      reg.register(run);
      return { kind: "spawned" as const, run, done: Promise.resolve(run) };
    },
  };
  const tools = new Map<string, { execute: (id: string, p: unknown) => Promise<any> }>();
  registerTools({ registerTool: (t: any) => void tools.set(t.name, t) } as any, {
    getCwd: () => cwd,
    getRegistry: () => reg,
    getQueue: () => queue as any,
    getModel: () => new FocusedStreamModel(reg),
    getParentMessages: () => [],
    openFocusedOverlay: () => {},
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
    pushCompletionNotification: () => {},
  });
  return { calls, spawn: tools.get("ensemble_spawn")!, auto: tools.get("ensemble_auto")! };
}

/** A conductor cwd whose project config sets builder's merge strategy to `merge`. */
function withProject<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "conductor-merge-cascade-"));
  const cwd = join(root, "proj");
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  mkdirSync(join(root, "home"));
  writeFileSync(
    join(cwd, ".pi", "conductor.json"),
    JSON.stringify({ personaOverrides: { builder: { mergeStrategy: "merge" } } }),
  );
  const saved = process.env.CONDUCTOR_SUBAGENT;
  delete process.env.CONDUCTOR_SUBAGENT;
  return withEnv({ HOME: join(root, "home") }, () => fn(cwd)).finally(() => {
    if (saved !== undefined) process.env.CONDUCTOR_SUBAGENT = saved;
    rmSync(root, { recursive: true, force: true });
  });
}

test("ensemble_auto: a worktree step resolves mergeStrategy through the spawn cascade", () =>
  withProject(async (cwd) => {
    const h = harness(cwd);
    const r = await h.auto.execute("a1", { goal: "g", max_steps: 2, steps: [{ persona: "builder", task: "one" }] });
    assert.equal(r.details.status, "done", r.content[0].text);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].worktree, true);
    assert.equal(h.calls[0].mergeStrategy, "merge", "the project layer of the cascade applies");
  }));

test("ensemble_spawn: its classified retry re-spawns with the same resolved mergeStrategy", () =>
  withProject(async (cwd) => {
    const h = harness(cwd);
    await h.spawn.execute("s1", { persona: "builder", task: "t", foreground: false, chain: false, merge_strategy: "squash" });
    assert.equal(h.calls[0].mergeStrategy, "squash", "precondition: the per-call layer wins at spawn");

    h.calls[0].onRetry(
      makeRun("builder-1", {
        status: "failed",
        failureClass: "environment",
        retryAttempt: 0,
        retryPolicy: { maxAttempts: 2, retryableClasses: ["environment"] },
      }),
    );
    assert.equal(h.calls.length, 2, "the retry re-spawned");
    assert.equal(h.calls[1].worktree, true);
    assert.equal(h.calls[1].mergeStrategy, "squash", "the per-call layer carries into the retry");
  }));

test("buildOnRetryCallback: without a per-call strategy the retry takes the class default", () => {
  const captured: any[] = [];
  const cb = buildOnRetryCallback({
    originalTask: "T",
    persona: builderPersona(),
    cfg: DEFAULT_CONFIG,
    queue: { enqueueOrSpawn: (o: any) => captured.push(o) } as any,
    cwd: "/tmp",
    pushNotification: () => {},
    getParentMessages: () => [],
  });
  cb(makeRun("builder-x", { status: "failed", failureClass: "environment", retryAttempt: 0 }));
  assert.equal(captured[0].worktree, true);
  assert.equal(captured[0].mergeStrategy, "squash");
});

// ── (c) drift: the queue passes spawn options through unchanged ───────

type QueuedOptions = Omit<SpawnOptions, "registry" | "preAllocatedId">;

/**
 * Every SpawnOptions key, each set to a distinct value. `Required<>` makes
 * tsc (`npm run typecheck` covers tests/) reject this fixture the day a
 * new SpawnOptions key lands without a value here.
 */
// Effort values need a real owned repository; their nonempty round-trip is in effort-spawn.test.ts.
// A set `delegation` deliberately replaces the leaf's privileges (tests/delegation-broker.test.ts).
// A set `mergerFor` needs a writer's durable claim; its queue round-trip is in effort-merger.test.ts.
function everyOption(): Required<Omit<QueuedOptions, "effort" | "touches" | "delegation" | "mergerFor">> & { effort: string | undefined; touches: string[] | undefined; delegation: undefined; mergerFor: undefined } {
  return {
    persona: builderPersona(),
    task: "drift",
    runtime: "subprocess",
    runtimeEnv: {},
    effort: undefined,
    touches: undefined,
    delegation: undefined,
    mergerFor: undefined,
    files: [],
    mode: "foreground",
    cwd: "/drift/cwd",
    model: "prov/drift-model",
    thinking: "high",
    timeoutMs: 123_456,
    parentMessages: [{ role: "user", content: "drift", timestamp: 0 }],
    onUpdate: () => {},
    onComplete: () => {},
    killOnStall: true,
    softStallSeconds: 77,
    steerable: true,
    inheritContextOverride: "filtered",
    onCompleteHook: "echo drift",
    onCompleteHookTimeoutSeconds: 9,
    parentSessionId: "session-drift",
    worktree: true,
    mergeStrategy: "merge",
    onChain: () => {},
    events: new ConductorEventEmitter({ emit: () => {} } as any),
    maxTurns: 40,
    graceTurns: 4,
    retryMaxAttempts: 3,
    retryAttempt: 2,
    onRetry: () => {},
  };
}

test("SpawnQueue: every SpawnOptions key survives the queue round-trip to the spawner", () => {
  const reg = new RunRegistry();
  const blocker = makeRun("builder-busy", { status: "running" });
  reg.register(blocker);
  const spawned: SpawnOptions[] = [];
  const spy = (o: SpawnOptions) => {
    spawned.push(o);
    const run = makeRun(o.preAllocatedId ?? "builder-now", { status: "running" });
    return { run, done: Promise.resolve(run) };
  };
  const queue = new SpawnQueue(reg, 4, 1, spy);
  const opts = everyOption();

  const r = queue.enqueueOrSpawn(opts);
  assert.equal(r.kind, "queued", "precondition: the write cap queues the builder");
  blocker.status = "completed";
  reg.notify(blocker);

  assert.equal(spawned.length, 1, "the drain spawned the queued builder");
  const got = spawned[0]!;
  const keys = Object.keys(opts) as Array<keyof QueuedOptions>;
  // Evidence is consumed at acceptance, not forwarded for a second read at drain.
  assert.equal(got.files, undefined);
  const lost = keys.filter((k) => k !== "mode" && k !== "files" && got[k] !== opts[k]);
  assert.deepEqual(lost, [], "every option reaches the spawner by identity");
  assert.equal(got.mode, "background", "a queued spawn starts in the background");
  assert.equal(got.preAllocatedId, r.kind === "queued" ? r.pending.id : "", "the pre-allocated id is used");
  assert.equal(got.registry, reg);
});
