import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { createRunPipeline } from "../src/run-pipeline.ts";
import { RunRegistry, sendToRun, availableActions, checkTurnLimit } from "../src/runs.ts";
import { runtimeFor } from "../src/runtime.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import { readInbox, readInboxAck } from "../src/herdr/inbox.ts";
import { resultRef } from "../src/file-evidence.ts";
sandboxPi();
const wait = async (condition: () => boolean) => { const end = Date.now() + 10000; while (!condition()) { assert.ok(Date.now() < end, "fixture barrier timed out"); await delay(10); } };

test("H8 fake CLI with native 0.87.1 child: live controls, ask/reply acceptance and repeated relaunch", { timeout: 60000 }, async t => {
  t.after(() => stop());
  const root = tmpDir("h8-native-"), output = join(root, "child.mjs");
  const nativeRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT!;
  assert.ok(nativeRoot, "explicit approved native installation required");
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? nativeRoot : join(nativeRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")); assert.equal(metadata.version, "0.87.1");
    const path = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main); t.diagnostic(`${specifier}: ${path}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  await build({ entryPoints: [fileURLToPath(new URL("fixtures/herdr-send-native.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  const id = "oracle-h8", dir = join(root, id); mkdirSync(dir);
  const run: Run = { id, runtime: "herdr", persona: "oracle", task: "Original native assignment", cwd: root, status: "running", mode: "background", messages: [], usage: emptyUsage(), startTime: Date.now(), lastEventAt: Date.now(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"), systemPrompt: "A byte-safe system prompt 漢🙂".repeat(4000) };
  const registry = new RunRegistry(); registry.register(run);
  const statePath = join(root, "fake.json");
  let generation = 0, completions = 0;
  const env = { HOME: root, TMPDIR: root, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: join(root, "agent"), CONDUCTOR_MEMORY_PATH: join(root, "memory.jsonl") };
  async function child(mode: string, unavailable = false) {
    const manifest = join(root, `launch-${++generation}.json`);
    t.diagnostic(`native generation ${generation}: ${mode}`);
    const proc = spawn(process.execPath, [output, manifest], { env, stdio: ["ignore", "ignore", "pipe"] });
    let exited = false, stderr = ""; proc.once("exit", () => { exited = true; }); proc.stderr.on("data", b => { stderr += b; });
    const closed = once(proc, "close");
    t.after(async () => { if (!exited && proc.signalCode === null) proc.kill("SIGKILL"); await closed; });
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { calls: [], pane: { pane_id: "pane", terminal_id: "terminal", workspace_id: "workspace", tab_id: "tab", agent: null, agent_session: null } };
    if (state.childPid) assert.throws(() => process.kill(state.childPid, 0), { code: "ESRCH" }, "prior fixture child is gone before pane integration clears");
    state.pane.agent = unavailable ? "manually-started" : null; state.pane.agent_session = null;
    if (unavailable) state.allowNewTabs = true;
    writeFileSync(statePath, JSON.stringify({ ...state, childPid: proc.pid, manifest, mode }));
    return { manifest, closed, stderr: () => stderr };
  }
  const options = { registry, timeoutMs: 15000, onComplete: () => { completions++; } };
  const first = await child("live");
  const done = createRunPipeline(run, [], { ...options, runtime: runtimeFor(run, { ...env, HERDR_ENV: "1", HERDR_SOCKET_PATH: `${statePath}.socket`, HERDR_PANE_ID: "parent", HERDR_WORKSPACE_ID: "workspace", FAKE_HERDR_STATE: statePath, CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("fixtures/fake-herdr.mjs", import.meta.url)) }), cwd: root, steerable: false, initialPrompt: run.task, core: { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: run.systemPrompt! } });
  assert.ok(run.transport?.kind === "herdr"); await run.transport.ready;
  await wait(() => existsSync(`${first.manifest}.streaming`));
  assert.deepEqual(availableActions(run), ["steer", "follow_up", "kill"]);
  for (const behavior of ["steer"] as const) {
    const sent = sendToRun(run, `Live ${behavior} 漢🙂`, { ...options, streamingBehavior: behavior });
    assert.equal(sent.kind, "started"); if (sent.kind !== "started") throw new Error("send rejected");
    assert.equal((await sent.ack)?.delivered, true, first.stderr());
  }
  writeFileSync(`${first.manifest}.release`, "release"); await done; await first.closed;
  t.diagnostic(`first child settled: ${run.status}`);
  assert.equal(run.status, "completed", run.errorMessage); assert.equal(completions, 1);
  const sourceSession = run.sessionPath!, firstNonce = run.herdr!.launchNonce;
  assert.equal(JSON.parse(readFileSync(`${first.manifest}.inputs`, "utf8")).length, 2);
  assert.ok(resultRef(run));
  for (const kind of ["follow_up", "grace"] as const) {
    const current = await child("live"), resumed = sendToRun(run, "Live again", options);
    assert.equal(resumed.kind, "started"); if (resumed.kind !== "started") throw new Error("send rejected");
    assert.ok(run.transport?.kind === "herdr"); await run.transport.ready;
    await wait(() => existsSync(`${current.manifest}.streaming`));
    if (kind === "grace") {
      run.maxTurns = run.usage.turns;
      checkTurnLimit(run, registry, () => assert.fail("grace must not abort live herdr"));
      await wait(() => readInbox(dir, run.herdr!.launchNonce).some(({ request }) => request.kind === "grace" && readInboxAck(dir, request)?.accepted));
      run.maxTurns = undefined;
    } else {
      const live = sendToRun(run, "Native live follow-up", { ...options, streamingBehavior: kind });
      assert.equal(live.kind, "started"); if (live.kind !== "started") throw new Error("send rejected");
      assert.equal((await live.ack)?.delivered, true);
    }
    writeFileSync(`${current.manifest}.release`, "release"); await resumed.done; await current.closed;
    assert.equal(run.status, "completed", run.errorMessage);
  }

  const asking = await child("ask"), askSend = sendToRun(run, "Ask the owner next", options);
  assert.equal(askSend.kind, "started"); if (askSend.kind !== "started") throw new Error("send rejected");
  await askSend.done; await asking.closed;
  assert.equal(run.status, "blocked", `${run.errorMessage}\n${asking.stderr()}`);
  const ask = { ...run.pendingAsk! }; assert.equal(ask.askId, "native-question");
  assert.notEqual(run.herdr!.launchNonce, firstNonce); assert.equal(run.sessionPath, sourceSession);
  const askNonce = run.herdr!.launchNonce;

  // Input ack without native agent_start must not answer the source question.
  const intercepted = await child("intercept"), reply = sendToRun(run, "First unexecuted choice", options);
  assert.equal(reply.kind, "started"); if (reply.kind !== "started") throw new Error("send rejected");
  await wait(() => run.herdr!.launchNonce !== askNonce && readInbox(dir, run.herdr!.launchNonce).some(({ request }) => readInboxAck(dir, request)?.accepted));
  assert.ok(run.transport?.kind === "herdr");
  assert.equal(await Promise.race([run.transport.ready.then(() => "ready", () => "failed"), delay(750).then(() => "pending")]), "pending", "native input ack without correlated agent_start cannot make reply ready");
  assert.equal(run.pendingAsk?.askId, ask.askId, "native ack alone cannot clear a pending answer");
  run.rejectAnswerDelivery!("native input was intercepted");
  const replyState = await Promise.race([reply.done.then(() => "done"), delay(5000).then(() => "waiting")]);
  assert.equal(replyState, "done", JSON.stringify({ status: run.status, stderr: run.transport?.stderr, error: run.errorMessage, state: JSON.parse(readFileSync(statePath, "utf8")), transcript: readFileSync(run.transcriptPath, "utf8").slice(-2000) }));
  await intercepted.closed;
  assert.equal(run.status, "blocked"); assert.deepEqual(run.pendingAsk, ask); assert.equal(resultRef(run), undefined);
  assert.notEqual(run.herdr!.launchNonce, askNonce);
  assert.deepEqual(JSON.parse(readFileSync(run.recordPath, "utf8")).pendingAsk, ask);

  const answered = await child("healthy", true), accepted = sendToRun(run, "Use the native route 漢🙂", options);
  assert.equal(accepted.kind, "started"); if (accepted.kind !== "started") throw new Error("send rejected");
  await accepted.done; await answered.closed;
  assert.equal(run.status, "completed", `${run.errorMessage}\n${answered.stderr()}`); assert.equal(run.pendingAsk, undefined);
  const input = JSON.parse(readFileSync(`${answered.manifest}.inputs`, "utf8"))[0];
  assert.equal(input.split("<owner-answer").length, 2, "owner answer wrapped exactly once");
  assert.ok(input.includes('ask-id="native-question"')); assert.ok(input.includes("Use the native route 漢🙂"));
  assert.equal(run.sessionPath, sourceSession); assert.equal(run.resumeCount, 5); assert.equal(completions, 6);
  const again = await child("ask"), askAgain = sendToRun(run, "Ask before failing", options);
  assert.equal(askAgain.kind, "started"); if (askAgain.kind !== "started") throw new Error("send rejected");
  await askAgain.done; await again.closed; assert.equal(run.status, "blocked");
  const failed = await child("failure"), failReply = sendToRun(run, "Accepted answer before failure", options);
  assert.equal(failReply.kind, "started"); if (failReply.kind !== "started") throw new Error("send rejected");
  await failReply.done; await failed.closed;
  assert.equal(run.status, "failed", run.errorMessage);
  assert.equal(run.pendingAsk, undefined, "native ack plus correlated start is not rolled back by later model failure");
  assert.equal(run.herdrResultUnavailable, true);
  assert.equal(resultRef(run), undefined, "accepted but empty failure cannot advertise historical output");
  assert.equal(run.resumeCount, 7); assert.equal(completions, 8);
  const retired = await child("retired"), retireSend = sendToRun(run, "Retire this native session", options);
  assert.equal(retireSend.kind, "started"); if (retireSend.kind !== "started") throw new Error("send rejected");
  await retireSend.done; await retired.closed; assert.equal(run.contextRetired, true);
  const beforeRetiredSend = readFileSync(statePath);
  assert.equal(sendToRun(run, "Forbidden continuation", options).kind, "rejected");
  assert.deepEqual(readFileSync(statePath), beforeRetiredSend);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.equal(state.calls.filter((c: any) => c.args[0] === "tab").length, 2, "busy prior pane preserved and replaced by a new subtree tab");
  assert.equal(state.retainedPanes[0].agent, "manually-started");
  assert.equal(state.retainedPanes[0].pane_id, "pane");
  assert.equal(run.herdr!.paneId, "pane-2");
  assert.equal(state.calls.filter((c: any) => c.args[1] === "close").length, 0);
  const nonces = state.calls.filter((c: any) => c.args[1] === "start").map((c: any) => c.args[c.args.indexOf("--conductor-launch") + 1]);
  assert.equal(new Set(nonces).size, 9);
  for (const c of state.calls.filter((c: any) => c.args[1] === "start")) {
    assert.ok(!c.args.includes("--mode")); assert.ok(!c.args.includes("-p"));
    assert.equal(readFileSync(c.args[c.args.indexOf("--append-system-prompt") + 1], "utf8"), run.systemPrompt);
  }
  t.diagnostic(JSON.stringify({ nativeVersion: "0.87.1", generations: nonces.length, completions, resumeCount: run.resumeCount, steerCount: run.steerCount }));
});
