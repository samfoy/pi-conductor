/**
 * M7 R1 native smoke: a real Pi 0.87.1 SDK child (bundled from CONDUCTOR_NATIVE_PI_ROOT with four explicit
 * aliases, never the repository devDependency) behind the executable fake herdr CLI runs as an effort finalizer
 * reader on the herdr runtime: it asks, the owner's answer resumes it in its detached view, the validation hook
 * runs in the view after the child's proven exit, and the verdict is pinned to the viewed OID. No real herdr,
 * paid model or terminal; routing reaches only the fake CLI through explicit per-run env.
 */
// First import: throws on an inherited herdr scope before any repository module evaluates.
import "./helpers/no-live-scope.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { git } from "./helpers/effort-integration.ts";
import { land } from "./helpers/effort-merger.ts";
import { createRunPipeline } from "../src/run-pipeline.ts";
import { RunRegistry, sendToRun } from "../src/runs.ts";
import { runtimeFor } from "../src/runtime.ts";
import { openEffort } from "../src/effort/open.ts";
import { addEffortMember, effortDir, readEffort } from "../src/effort/store.ts";
import { createReaderView } from "../src/effort/reader.ts";
import { emptyUsage, type Run } from "../src/types.ts";

sandboxPi();
assert.equal(process.env.HERDR_SOCKET_PATH, undefined); assert.equal(process.env.HERDR_ENV, undefined);

test("M7 native 0.87.1 herdr reader: ask, answer in its view, hook after the proven exit, verdict pinned, pane then view released", { timeout: 60000 }, async t => {
  t.after(() => stop());
  const root = tmpDir("m7-herdr-native-"), output = join(root, "child.mjs");
  const nativeRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT!;
  assert.ok(nativeRoot, "explicit approved native installation required");
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? nativeRoot : join(nativeRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")); assert.equal(metadata.version, "0.87.1", specifier);
    const path = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main); t.diagnostic(`${specifier}@${metadata.version}: ${path}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  await build({ entryPoints: [fileURLToPath(new URL("fixtures/herdr-send-native.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", alias, external: Object.values(alias), logLevel: "silent" });

  const repo = tmpDir("m7-herdr-native-repo-"); git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "T"); git(repo, "config", "user.email", "t@t");
  writeFileSync(join(repo, "base"), "base\n"); writeFileSync(join(repo, ".gitignore"), ".worktrees/\n");
  git(repo, "add", "base", ".gitignore"); git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD"), index = readFileSync(join(repo, ".git", "index"));
  const effort = openEffort(repo, "probe", "owner", { verify: "true" });
  const landed = land(repo, effort.intRef, { landed: "landed\n" });
  const id = "finalizer-native-herdr", dir = join(root, id); mkdirSync(dir);
  addEffortMember(effort, id);
  const view = createReaderView(repo, id, landed);
  const marker = join(root, "close-hook"), effortJson = join(effortDir(repo, "probe"), "effort.json");
  const hook = `if grep -q '"finalizer"' '${effortJson}'; then exit 3; fi; printf '%s %s\\n' "$(pwd)" "$(git rev-parse HEAD)" >> '${marker}'`;
  const run: Run = { id, runtime: "herdr", persona: "finalizer", task: "Judge the integrated tip.", cwd: repo, status: "running", mode: "background", messages: [], usage: emptyUsage(),
    startTime: Date.now(), lastEventAt: Date.now(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
    systemPrompt: "Judge completeness; report a verdict.", parentSessionId: "owner", parentPid: effort.owner.pid, parentStartTime: effort.owner.startTime, onCompleteHook: hook,
    effort: { owner: effort.owner, name: "probe", gitRoot: repo, role: "reader", spawnBase: landed, cwd: view }, worktreePath: view };
  const registry = new RunRegistry(); registry.register(run);
  const statePath = join(root, "fake.json"), cards: string[] = [];
  let generation = 0;
  const env = { HOME: root, TMPDIR: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: join(root, "agent"), CONDUCTOR_MEMORY_PATH: join(root, "memory.jsonl") };
  async function child(mode: string) {
    const manifest = join(root, `launch-${++generation}.json`);
    const proc = spawn(process.execPath, [output, manifest], { env, stdio: ["ignore", "ignore", "pipe"] });
    let exited = false, stderr = ""; proc.once("exit", () => { exited = true; }); proc.stderr.on("data", b => { stderr += b; });
    const closed = once(proc, "close");
    t.after(async () => { if (!exited && proc.signalCode === null) proc.kill("SIGKILL"); await closed; });
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { calls: [], pane: { pane_id: "pane", terminal_id: "terminal", workspace_id: "workspace", tab_id: "tab", agent: null, agent_session: null } };
    state.pane.agent = null; state.pane.agent_session = null;
    writeFileSync(statePath, JSON.stringify({ ...state, childPid: proc.pid, manifest, mode }));
    return { manifest, closed, stderr: () => stderr };
  }
  const routing = { ...env, HERDR_ENV: "1", HERDR_SOCKET_PATH: `${statePath}.socket`, HERDR_PANE_ID: "parent", HERDR_WORKSPACE_ID: "workspace", FAKE_HERDR_STATE: statePath,
    CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("fixtures/fake-herdr.mjs", import.meta.url)) };
  const onComplete = (r: Run) => { cards.push(`${r.id}:${r.status}`); };

  const asking = await child("ask");
  await createRunPipeline(run, [], { registry, runtime: runtimeFor(run, routing), cwd: view, timeoutMs: 20000, steerable: false, initialPrompt: run.task,
    core: { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: run.systemPrompt! }, resolvedHook: { command: hook, timeoutSeconds: 30, source: "per-call" }, onComplete });
  await asking.closed;
  assert.equal(run.status, "blocked", `${run.errorMessage}\n${asking.stderr()}`);
  assert.equal(run.pendingAsk?.askId, "native-question");
  assert.equal(JSON.parse(readFileSync(join(dir, "launch", `${run.herdr!.launchNonce}.json`), "utf8")).piVersion, "0.87.1", "the pane child is the native 0.87.1 SDK");
  assert.equal(existsSync(view), true, "a blocked reader keeps its view"); assert.equal(existsSync(marker), false, "no hook on a blocked question");
  assert.equal(JSON.parse(readFileSync(run.sessionPath!, "utf8").split("\n")[0]!).cwd, view, "the session header names the view");
  assert.deepEqual(cards, [`${id}:blocked`]);

  const answering = await child("verdict");
  const sent = sendToRun(run, "Review only the integrated tip.", { registry, timeoutMs: 20000, sessionId: "owner", onComplete });
  assert.equal(sent.kind, "started", sent.kind === "rejected" ? sent.reason : ""); if (sent.kind !== "started") return;
  await sent.done; await answering.closed;
  assert.equal(run.status, "completed", `${run.errorMessage}\n${answering.stderr()}\n${run.transport?.stderr ?? ""}`);
  const input = JSON.parse(readFileSync(`${answering.manifest}.inputs`, "utf8"))[0];
  assert.ok(input.includes('ask-id="native-question"') && input.includes("Review only the integrated tip."), "the owner's answer reached the native child once");
  assert.equal(run.effort?.role, "reader"); assert.equal(run.hookResult?.passed, true, run.hookResult?.tailText);
  assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n"), [`${view} ${landed}`], "the hook ran once, in the view at the viewed OID, before the verdict");
  const evidence = readEffort(repo, "probe")!.finalizer;
  assert.deepEqual(evidence && { runId: evidence.runId, tip: evidence.tip, verdict: evidence.verdict }, { runId: id, tip: landed, verdict: "complete" });
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.closed, true, "the proven-empty owned pane closed"); assert.equal(existsSync(view), false, "then the clean view was removed");
  assert.equal(run.herdr?.settlement?.delivery, "attempted"); assert.deepEqual(cards, [`${id}:blocked`, `${id}:completed`]);
  assert.equal(run.integration, undefined); assert.equal(git(repo, "rev-parse", effort.intRef), landed, "nothing integrated");
  assert.equal(git(repo, "rev-parse", "HEAD"), base); assert.deepEqual(readFileSync(join(repo, ".git", "index")), index);
  assert.equal(git(repo, "status", "--porcelain"), ""); assert.equal(git(repo, "symbolic-ref", "HEAD"), "refs/heads/main");
});
