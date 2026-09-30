import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { HerdrRuntime } from "../src/herdr/runtime.ts";
import { createHerdrCli } from "../src/herdr/cli.ts";
import { createRunPipeline } from "../src/run-pipeline.ts";
import { RunRegistry, forceTerminate, runsRoot } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import { createWorktree } from "../src/worktree.ts";
import { resultRef, appendFileEvidence } from "../src/file-evidence.ts";
import { buildCompletionMessage } from "../src/notifications.ts";
import { buildOrphanRun } from "../src/reconcile-startup.ts";
sandboxPi();
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe" }).trim();

// Reproduces critic-hgv8 with the existing owned-child executable and fake CLI.
for (const [outcome, previous] of [["unknown", false], ["unknown", true], ["timeout", true], ["killed", false], ["exited", false]] as const) {
  test(`H7 exit proof controls final publication: ${outcome}, previous=${previous}`, { timeout: 25000 }, async t => {
    const root = tmpDir("h7-exit-publication-"), id = `oracle-${randomUUID()}`, dir = join(runsRoot(), id); mkdirSync(dir, { recursive: true });
    const manifest = join(dir, "manifest.json"), statePath = join(dir, "state.json");
    const run: Run = { id, runtime: "herdr", persona: "oracle", task: "exit proof", cwd: root, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(),
      recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
    const child = spawn(process.execPath, ["--import", "tsx", new URL("fixtures/herdr-pipeline-child.mjs", import.meta.url).pathname, manifest], { env: gitTestEnv(), stdio: ["ignore", "ignore", "pipe"] });
    let exited = false; child.once("exit", () => { exited = true; }); const closed = once(child, "close");
    t.after(async () => { if (!exited && child.signalCode === null) child.kill("SIGKILL"); await closed; clearTimeout(run.timeoutTimer); });
    writeFileSync(statePath, JSON.stringify({ calls: [], childPid: child.pid, manifest, mode: outcome === "exited" ? "healthy" : "held", pane: { pane_id: "owned", terminal_id: "terminal", tab_id: "tab", workspace_id: "workspace", agent: null, agent_session: null } }));
    const env = { ...gitTestEnv(), HERDR_ENV: "1", HERDR_SOCKET_PATH: `${statePath}.socket`, HERDR_PANE_ID: "parent", HERDR_WORKSPACE_ID: "workspace", FAKE_HERDR_STATE: statePath, CONDUCTOR_HERDR_BIN: new URL("fixtures/fake-herdr.mjs", import.meta.url).pathname };
    const cli = createHerdrCli({ env, socketPath: env.HERDR_SOCKET_PATH });
    // "exited": the healthy child settles and exits on its own once its published task is accepted.
    const runtime = new HerdrRuntime({ env, workspaceId: "workspace", trustArgs: () => [], cli });
    git(root, "init", "-b", "main"); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "fixture@example.test");
    mkdirSync(join(root, ".githooks")); writeFileSync(join(root, ".githooks", "pre-commit"), `#!/bin/sh\nprintf 'policy\\n' >> '${dir}/policy.log'\n`, { mode: 0o755 }); git(root, "config", "core.hooksPath", ".githooks");
    writeFileSync(join(root, ".gitignore"), ".worktrees/\n"); writeFileSync(join(root, "base"), "base"); git(root, "add", ".gitignore", "base", ".githooks"); git(root, "commit", "-m", "base");
    const base = git(root, "rev-parse", "HEAD"), path = join(root, ".worktrees", "conductor-wt", id);
    createWorktree({ gitRoot: root, worktreePath: path, branch: "writer" }, { from: base }); writeFileSync(join(path, "change"), "change"); git(path, "add", "change"); git(path, "commit", "-m", "writer");
    Object.assign(run, { worktreePath: path, worktreeBranch: "writer", worktreeBaseBranch: "main", mergeStrategy: "squash" });
    const historical = "Previous completed invocation — retained historical evidence.";
    if (previous) writeFileSync(run.finalPath, historical);
    const registry = new RunRegistry(); registry.register(run);
    const notifications: string[] = [], refs: (string | undefined)[] = [];
    const complete = () => { notifications.push(JSON.stringify(buildCompletionMessage(run))); refs.push(resultRef(run)); };
    const done = createRunPipeline(run, [], { registry, runtime, cwd: path, timeoutMs: 20000, steerable: false, initialPrompt: "probe", core: { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "probe" },
      resolvedHook: { command: "test -f change", timeoutSeconds: 5, source: "per-call" }, onComplete: complete });
    t.after(async () => { writeFileSync(`${manifest}.exit`, "exit"); await closed; await done; });
    assert.ok(run.transport?.kind === "herdr"); await run.transport.ready;
    if (outcome !== "exited") {
      const state = JSON.parse(readFileSync(statePath, "utf8")); state.pane.terminal_id = "foreign"; writeFileSync(statePath, JSON.stringify(state));
      if (outcome === "timeout" || outcome === "killed") forceTerminate(run, outcome, registry, complete);
    }
    await done; await run.recordWrite;
    assert.equal(notifications.length, 1, "one truthful diagnostic/completion callback");
    if (outcome === "exited") {
      assert.equal(exited, true); assert.equal(run.transport.childExited, true); assert.equal(run.status, "completed", run.errorMessage);
      assert.match(readFileSync(run.finalPath, "utf8"), /Full Unicode final evidence 漢🙂/); assert.equal(resultRef(run), `run:${id}`);
      assert.equal(run.hookResult?.passed, true); assert.notEqual(git(root, "rev-parse", "HEAD"), base); return;
    }
    assert.equal(exited, false); assert.equal(run.transport.childExited, false);
    assert.equal(run.status, outcome === "unknown" ? "failed" : outcome); assert.match(run.errorMessage!, /exit unconfirmed/);
    assert.equal(run.hookResult, undefined); assert.equal(git(root, "rev-parse", "HEAD"), base); assert.equal(existsSync(path), true); assert.equal(run.worktreeBranch, "writer");
    assert.match(readFileSync(run.transcriptPath, "utf8"), /Full Unicode final evidence/);
    if (previous) assert.equal(readFileSync(run.finalPath, "utf8"), historical, "SAFETY: previous final must not be replaced by unproven output");
    else assert.equal(existsSync(run.finalPath), false, "SAFETY: assistant final published without proven child exit");
    assert.deepEqual(refs, [undefined]); assert.equal(resultRef(run), undefined);
    assert.doesNotMatch(notifications[0], /Full Unicode final evidence|Previous completed invocation|result-ref/, "SAFETY: unproven assistant result advertised in notification");
    assert.match(notifications[0], /exit unconfirmed/);
    const restored = buildOrphanRun(JSON.parse(readFileSync(run.recordPath, "utf8")), run.status);
    assert.equal(resultRef(restored), undefined, "uncertain result stays unavailable after reload");
    for (const source of [registry, new RunRegistry()]) assert.throws(() => appendFileEvidence("task", [`run:${id}`], { cwd: root, registry: source }), /no usable final result|ENOENT/, "no reusable live or persisted run reference");
  });
}
