import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import syncFs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate as nextTurn } from "node:timers/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { HerdrRuntime } from "../src/herdr/runtime.ts";
import { createHerdrCli } from "../src/herdr/cli.ts";
import { createRunPipeline } from "../src/run-pipeline.ts";
import { git } from "./helpers/effort-integration.ts";
import { openEffort } from "../src/effort/open.ts";
import { addEffortMember, readEffort } from "../src/effort/store.ts";
import { recoverEffort } from "../src/effort/reconcile.ts";
import { createWorktree } from "../src/worktree.ts";
import { RunRegistry, runsRoot } from "../src/runs.ts";
import { buildOrphanRun, readProcessStartTime } from "../src/reconcile-startup.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { emptyUsage, type Run } from "../src/types.ts";
sandboxPi();
const barrier = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const wait = async (path: string) => { const end = Date.now() + 20000; while (!existsSync(path)) { if (Date.now() > end) throw new Error(`barrier expired: ${path}`); await delay(10); } };

test("H10 real native child plus executable fake herdr: live reload, settled while down, partial settle", { timeout: 120000 }, async t => {
  t.after(() => stop());
  const root = tmpDir("h10-native-");
  const nativeRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT!;
  assert.ok(nativeRoot, "approved native harness path must be explicit");
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? nativeRoot : join(nativeRoot, "node_modules", specifier);
    const meta = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")); assert.equal(meta.version, "0.87.1");
    const path = resolve(packageRoot, meta.exports?.["."]?.import ?? meta.main); t.diagnostic(`${specifier}: ${pathToFileURL(path).href}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const output = join(root, "child.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("./helpers/herdr-recovery-native-child.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  for (const phase of ["live", "down", "partial", "effort", "final-write", "dispatch-intent", "hook", "integrating"]) await t.test(phase, { timeout: 35000 }, async childTest => {
    const home = join(root, phase), dir = join(runsRoot(), `oracle-${phase}`); mkdirSync(dir, { recursive: true }); mkdirSync(home);
    const previousMemory = process.env.CONDUCTOR_MEMORY_PATH, memoryPath = join(home, "outcomes.jsonl");
    process.env.CONDUCTOR_MEMORY_PATH = memoryPath;
    childTest.after(() => { if (previousMemory === undefined) delete process.env.CONDUCTOR_MEMORY_PATH; else process.env.CONDUCTOR_MEMORY_PATH = previousMemory; });
    const manifest = join(home, "manifest.json"), statePath = join(home, "fake.json"), socketPath = `${statePath}.socket`;
    const child = spawn(process.execPath, [output, manifest], { env: { HOME: home, TMPDIR: home, PATH: process.env.PATH, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: join(home, "agent"), CONDUCTOR_MEMORY_PATH: join(home, "memory.jsonl") }, stdio: ["ignore", "pipe", "pipe"] });
    let exited = false; const exit = once(child, "exit").then(() => { exited = true; });
    const startTime = readProcessStartTime(child.pid!); assert.ok(startTime);
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
    let current: Run | undefined, releaseIO = () => {};
    childTest.after(async () => {
      releaseIO();
      writeFileSync(`${manifest}.release`, "release"); writeFileSync(`${manifest}.exit`, "exit"); writeFileSync(`${manifest}.hook-release`, "release");
      if (!exited && child.signalCode === null && readProcessStartTime(child.pid!) === startTime) child.kill("SIGKILL");
      await exit;
      if (current) await handleSessionShutdown({ reason: "reload" }, { runs: [current], resetSanitizer() {} });
    });
    writeFileSync(statePath, JSON.stringify({ calls: [], childPid: child.pid, manifest, mode: phase,
      pane: { pane_id: "pane-owned", terminal_id: "terminal-owned", workspace_id: "workspace-owned", tab_id: "tab-owned", agent: null, agent_session: null } }));
    const env = { HOME: home, PATH: process.env.PATH, FAKE_HERDR_STATE: statePath, CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url)) };
    const runtime = new HerdrRuntime({ cli: createHerdrCli({ env, socketPath }), env, workspaceId: "workspace-owned", trustArgs: () => [], piVersion: "0.87.1" });
    const run: Run = { id: `oracle-${phase}`, runtime: "herdr", persona: "oracle", task: "offline native recovery", mode: "background", status: "running", cwd: dir,
      startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
    let effort: ReturnType<typeof openEffort> | undefined;
    if (phase === "effort" || phase === "integrating") {
      const repo = join(home, "repo"); mkdirSync(repo);
      git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test");
      writeFileSync(join(repo, "base"), "base"); writeFileSync(join(repo, ".gitignore"), ".worktrees/\n"); git(repo, "add", "base", ".gitignore"); git(repo, "commit", "-m", "base");
      effort = openEffort(repo, "native-h10", "same-session", { verify: "test -f base" });
      const path = join(repo, ".worktrees", "conductor-wt", run.id);
      createWorktree({ gitRoot: repo, worktreePath: path, branch: "writer" }, { from: effort.baseOid });
      writeFileSync(join(path, "change"), "source change"); git(path, "add", "change"); git(path, "commit", "-m", "change");
      Object.assign(run, { cwd: path, parentSessionId: "same-session", worktreePath: path, worktreeBranch: "writer", worktreeBaseBranch: "main",
        effort: { owner: effort.owner, name: effort.name, gitRoot: repo, role: "writer", spawnBase: effort.baseOid, touches: ["change"] } });
      addEffortMember(effort, run.id);
    }
    if (phase === "hook") {
      const repo = join(home, "repo"); mkdirSync(repo);
      git(repo, "init", "-b", "main"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test");
      writeFileSync(join(repo, "base"), "base"); writeFileSync(join(repo, ".gitignore"), ".worktrees/\n"); git(repo, "add", "base", ".gitignore"); git(repo, "commit", "-m", "base");
      const path = join(repo, ".worktrees", "conductor-wt", run.id);
      createWorktree({ gitRoot: repo, worktreePath: path, branch: "writer" });
      writeFileSync(join(path, "change"), "kept source"); git(path, "add", "change"); git(path, "commit", "-m", "change");
      Object.assign(run, { cwd: path, worktreePath: path, worktreeBranch: "writer", worktreeBaseBranch: "main", mergeStrategy: "merge" });
    }
    current = run;
    const registry = new RunRegistry(); registry.register(run); let oldCalls = 0, newCalls = 0;
    const reached = barrier(), release = barrier(); let held = false; releaseIO = release.resolve;
    const shutdowns: Promise<void>[] = [], returned: boolean[] = [];
    const beginShutdown = () => {
      const index = returned.length; returned.push(false);
      const done = handleSessionShutdown({ reason: "reload" }, { runs: [current!], resetSanitizer() {} }).then(() => { returned[index] = true; });
      shutdowns.push(done); return done;
    };
    const mkdir = fs.mkdir, fsync = syncFs.fsyncSync;
    const durable = () => current && existsSync(current.recordPath) ? JSON.parse(readFileSync(current.recordPath, "utf8")) : undefined;
    if (phase === "final-write" || phase === "dispatch-intent") {
      childTest.mock.method(fs, "mkdir", async (...args: Parameters<typeof fs.mkdir>) => {
        const saved = durable();
        const boundary = phase === "final-write" ? saved?.status === "completed" && !saved.herdr?.settlement : saved?.herdr?.settlement?.delivery === "intent" && newCalls === 1;
        if (!held && boundary && args[0] === dirname(run.finalPath)) { held = true; reached.resolve(); await release.promise; }
        return mkdir(...args);
      });
      childTest.mock.method(syncFs, "fsyncSync", (fd: number) => {
        fsync(fd);
        if (phase === "dispatch-intent" && !shutdowns.length && durable()?.herdr?.settlement?.delivery === "intent") {
          assert.equal(newCalls, 0, "intent must precede all external dispatch"); void beginShutdown(); void beginShutdown();
        }
      });
      syncBuiltinESMExports();
    }
    if (phase === "integrating") {
      const rename = syncFs.renameSync;
      childTest.mock.method(syncFs, "renameSync", (from: syncFs.PathLike, to: syncFs.PathLike) => {
        rename(from, to);
        if (!held && current && String(to) === current.recordPath && durable()?.integration?.state === "accepted") {
          held = true; reached.resolve(); void beginShutdown(); void beginShutdown();
        }
      }); syncBuiltinESMExports();
    }
    childTest.after(() => { release.resolve(); childTest.mock.restoreAll(); syncBuiltinESMExports(); });
    const opts = { registry, runtime, cwd: run.cwd, timeoutMs: 30000, steerable: false, ...(phase === "hook" ? { resolvedHook: { command: `touch "${manifest}.hook"; while ! test -f "${manifest}.hook-release"; do sleep 0.01; done`, timeoutSeconds: 10, source: "per-call" as const } } : {}), ...(effort ? { resolvedHook: { command: "test -f change", timeoutSeconds: 5, source: "per-call" as const } } : {}) };
    void createRunPipeline(run, [], { ...opts, core: { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "Offline probe" }, initialPrompt: "Recover this exact assignment", onComplete: () => oldCalls++ });
    assert.equal(run.transport?.kind, "herdr"); if (run.transport?.kind !== "herdr") throw new Error("transport");
    await run.transport.ready; await wait(`${manifest}.entered`);
    if (phase === "hook") {
      writeFileSync(`${manifest}.release`, "release"); await wait(`${manifest}.settled`); writeFileSync(`${manifest}.exit`, "exit"); await exit;
      await wait(`${manifest}.hook`); void beginShutdown(); void beginShutdown();
      await nextTurn(); assert.deepEqual(returned, [false, false], "reload must await the old hook pipeline");
      writeFileSync(`${manifest}.hook-release`, "release"); await Promise.all(shutdowns);
    } else {
      await Promise.all([1, 2].map(() => handleSessionShutdown({ reason: "reload" }, { runs: [run], resetSanitizer() {} })));
      assert.equal(exited, false, stderr); assert.equal(readProcessStartTime(child.pid!), startTime);
    }
    assert.equal(oldCalls, 0);
    const restore = () => {
      const replacement = buildOrphanRun(JSON.parse(readFileSync(run.recordPath, "utf8")), "running"); current = replacement;
      const registry = new RunRegistry(); registry.register(replacement);
      return { registry, replacement, done: createRunPipeline(replacement, [], { ...opts, registry, resolvedHook: undefined, reattach: true, onComplete: () => newCalls++ }) };
    };
    const live = phase === "live" ? restore() : undefined;
    if (live?.replacement.transport?.kind === "herdr") await live.replacement.transport.ready;
    if (phase !== "hook") {
      writeFileSync(`${manifest}.release`, "release"); await wait(`${manifest}.settled`);
      assert.equal(exited, false); assert.equal(existsSync(run.finalPath), false, "native settle is not child exit");
      writeFileSync(`${manifest}.exit`, "exit"); await exit;
    }
    assert.equal(child.exitCode, 0, stderr);
    let first = live ?? restore();
    if (effort) {
      if (first.replacement.transport?.kind !== "herdr") throw new Error("transport");
      await first.replacement.transport.ready;
      assert.equal(first.replacement.herdrEffortAuthorized, false);
      assert.equal(newCalls, 0); assert.equal(git(effort.gitRoot, "rev-parse", effort.intRef), effort.baseOid, "stream claim alone is not effort authority");
      const recovered = await recoverEffort(readEffort(effort.gitRoot, effort.name)!, { registry: first.registry, sessionId: "same-session" }); await recovered.done;
      assert.equal(first.registry.get(run.id), first.replacement, "proc-less writer must not be replaced");
      if (phase === "integrating") {
        await reached.promise; await Promise.all(shutdowns);
        assert.equal(newCalls, 0, "handoff has not dispatched before M5 recovery");
        const registry = new RunRegistry();
        const recovered = await recoverEffort(readEffort(effort.gitRoot, effort.name)!, { registry, sessionId: "same-session", onComplete: () => newCalls++ }); await recovered.done;
        const replacement = registry.get(run.id)!; first = { registry, replacement, done: Promise.resolve(replacement) }; current = replacement;
      }
    }
    if (phase === "final-write" || phase === "dispatch-intent") {
      await reached.promise;
      if (phase === "final-write") { void beginShutdown(); void beginShutdown(); }
      await nextTurn(); assert.deepEqual(returned, [false, false], "all shutdowns wait for held terminal I/O");
      release.resolve(); await Promise.all(shutdowns);
    }
    await first.done;
    assert.equal(first.replacement.status, phase === "partial" ? "failed" : phase === "hook" ? "merge_conflict" : "completed", first.replacement.errorMessage);
    assert.equal(oldCalls, 0); assert.equal(newCalls, 1);
    if (phase === "hook") {
      assert.match(first.replacement.errorMessage!, /gate.*could not be rebuilt/);
      assert.equal(existsSync(run.worktreePath!), true);
      assert.equal(git(join(home, "repo"), "rev-list", "--count", "main..writer"), "1", "unknown original gate cannot auto-merge source");
    }
    const usage = { ...first.replacement.usage };
    await handleSessionShutdown({ reason: "reload" }, { runs: [first.replacement], resetSanitizer() {} });
    if (effort) {
      for (let i = 0; i < 2; i++) {
        const recovered = await recoverEffort(readEffort(effort.gitRoot, effort.name)!, { registry: new RunRegistry(), sessionId: "same-session", onComplete: () => newCalls++ }); await recovered.done;
      }
      assert.equal(newCalls, 1); assert.equal(first.replacement.herdr?.settlement, undefined, "efforts use only integration.delivery");
      assert.equal(first.replacement.integration?.delivery, "attempted");
      assert.equal(git(effort.gitRoot, "rev-list", "--count", `${effort.baseOid}..${effort.intRef}`), "1");
      assert.equal(readFileSync(memoryPath, "utf8").trim().split("\n").length, 1);
      childTest.diagnostic(JSON.stringify({ phase, commits: 1, newCalls, delivery: first.replacement.integration?.delivery }));
      current = undefined; return;
    }
    const again = restore(); await again.done;
    assert.equal(newCalls, 1, "twice restarted native run must not replay external completion"); assert.deepEqual(again.replacement.usage, usage);
    assert.equal(readFileSync(memoryPath, "utf8").trim().split("\n").length, 1, "local memory outcome cannot repeat");
    const calls = JSON.parse(readFileSync(statePath, "utf8")).calls;
    assert.equal(calls.filter((call: { args: string[] }) => call.args[0] === "agent" && call.args[1] === "start").length, 1);
    if (phase !== "partial") assert.match(readFileSync(run.finalPath, "utf8"), /Native H10/);
    childTest.diagnostic(JSON.stringify({ phase, pid: child.pid, startTime, status: again.replacement.status, oldCalls, newCalls, delivery: again.replacement.herdr?.settlement?.delivery }));
  });
});
