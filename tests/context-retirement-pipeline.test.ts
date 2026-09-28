import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnRun, sendToRun, validateSendable, RunRegistry, forceTerminate } from "../src/runs.ts";
import { buildCompletionMessage } from "../src/notifications.ts";
import { registerTools } from "../src/tools.ts";
import { registerCommands } from "../src/commands.ts";
import { executePromptAndSend } from "../src/prompt-and-send.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import type { Persona, Run } from "../src/types.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
const marker = (sessionId: string) => ({ type: "custom", customType: "conductor-context-retired", data: { sessionId } });
const persona: Persona = { name: "oracle", description: "test", inheritContext: "filtered", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1, systemPrompt: "test", source: "builtin", sourcePath: "/fake/oracle.md", readOnly: true };
const handoff = { role: "assistant", content: [{ type: "text", text: "Current state: implementation saved in src/a.ts. Checks: unit tests passed. Unresolved: integration verification. Next steps: run integration checks in a fresh child." }], stopReason: "stop" };

function fakeSpawn(t: test.TestContext, hookExit?: number) {
  const procs: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough; kill: () => boolean; unref: () => void }> = [];
  t.mock.method(cp, "spawn", (command: string, args: unknown, options?: cp.SpawnOptions) => {
    if (Array.isArray(args)) assert.ok(options?.env?.CONDUCTOR_CONFIG_CWD, "parent forwards config cwd on both spawn and resume");
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true, unref() {} });
    procs.push(proc);
    if (command === "a2-quality-check" && hookExit !== undefined) queueMicrotask(() => proc.emit("close", hookExit, null));
    return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return procs;
}
function emit(proc: { stdout: PassThrough }, event: unknown) { proc.stdout.write(JSON.stringify(event) + "\n"); }
function saveSession(run: Run, own: boolean, seeded: boolean) {
  const path = run.sessionPath ?? join(dirname(run.recordPath), "session", "fresh.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  if (!seeded) writeFileSync(path, JSON.stringify({ type: "session", version: 3, id: "fresh-child", cwd: run.cwd }) + "\n");
  const id = JSON.parse(readFileSync(path, "utf8").split("\n")[0]).id;
  appendFileSync(path, JSON.stringify(marker(own ? id : "parent-session")) + "\n");
  return path;
}

for (const seeded of [false, true]) for (const rpc of [false, true]) {
  test(`A2 fake child: ${seeded ? "seeded" : "fresh"} ${rpc ? "RPC" : "print"} overflow marker arrives AFTER agent_end, before finalization and send`, { timeout: 5000 }, async (t) => {
    const procs = fakeSpawn(t);
    const cwd = tmpDir("a2-pipeline-");
    const registry = new RunRegistry();
    const notifications: string[] = [];
    const completedFlags: unknown[] = [];
    registry.onChange(r => { if (r.status === "completed") completedFlags.push(r.contextRetired); });
    const result = await spawnRun({ registry, persona, cwd, task: "test", mode: "background", timeoutMs: 4000, steerable: rpc,
      parentMessages: seeded ? [{ role: "user", content: "history", timestamp: 1 }] : [],
      onComplete: r => { notifications.push(buildCompletionMessage(r).content); completedFlags.push(r.contextRetired); },
    });
    const run = result.run;
    t.after(() => { if (run.timeoutTimer) clearTimeout(run.timeoutTimer); });
    const proc = procs[0];
    emit(proc, { type: "turn_end", message: { ...handoff, stopReason: "length" } });
    emit(proc, { type: "agent_end", willRetry: true });
    assert.equal(run.status, "running", "must not finalize before overflow recovery persists retirement");
    assert.equal(notifications.length, 0);
    saveSession(run, true, seeded);
    emit(proc, { type: "message_end", message: handoff });
    emit(proc, { type: "agent_end" });
    assert.equal(run.status, "running", "agent_end is not settlement");
    emit(proc, { type: "agent_settled" });
    await result.done;
    assert.equal(run.contextRetired, true, "finalize must discover the exact child's marker");
    assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).contextRetired, true);
    assert.ok(completedFlags.length > 0);
    assert.ok(completedFlags.every(Boolean), "retirement known before every completion observer");
    assert.match(notifications[0], /session retired.*fresh child.*handoff/i);
    assert.equal(run.status, "completed", "retirement is not failure");
    const sent = sendToRun(run, "continue", { registry, timeoutMs: 4000 });
    assert.equal(sent.kind, "rejected");
    assert.equal(procs.length, 1, "no continuation subprocess");
    assert.equal(validateSendable(run).ok, false);

    // Opt-out is read on send and does not erase historical metadata.
    mkdirSync(join(cwd, ".pi"));
    writeFileSync(join(cwd, ".pi/conductor.json"), '{"contextRetirement":false}');
    const allowed = sendToRun(run, "continue", { registry, timeoutMs: 4000 });
    assert.equal(allowed.kind, "started");
    assert.equal(procs.length, 2);
    assert.equal(run.contextRetired, true);
    procs[1].emit("close", 0);
    if (allowed.kind === "started") await allowed.done;
  });
}

test("A2 positive control: foreign marker cannot retire a fresh child's session", { timeout: 5000 }, async (t) => {
  const procs = fakeSpawn(t);
  const registry = new RunRegistry();
  const result = await spawnRun({ registry, persona, cwd: tmpDir("a2-foreign-"), task: "test", mode: "background", timeoutMs: 4000 });
  saveSession(result.run, false, false);
  emit(procs[0], { type: "message_end", message: handoff });
  procs[0].emit("close", 0); // print-mode exit fallback
  await result.done;
  assert.notEqual(result.run.contextRetired, true);
  assert.equal(validateSendable(result.run).ok, true);
});

test("A2 send rejects saved retirement before worktree restoration and tool spawn", { timeout: 5000 }, async (t) => {
  const procs = fakeSpawn(t);
  const registry = new RunRegistry();
  const cwd = tmpDir("a2-no-restore-");
  const result = await spawnRun({ registry, persona, cwd, task: "test", mode: "background", timeoutMs: 4000 });
  const path = saveSession(result.run, false, false);
  emit(procs[0], { type: "message_end", message: handoff });
  procs[0].emit("close", 0);
  await result.done;
  const run = result.run;
  const missing = join(cwd, ".worktrees/conductor-wt", run.id);
  writeFileSync(path, [ { type: "session", id: "retired", cwd: missing }, marker("retired") ].map(x => JSON.stringify(x)).join("\n") + "\n");
  assert.notEqual(run.contextRetired, true, "simulate record lagging the saved session");
  const sent = sendToRun(run, "continue", { registry, timeoutMs: 4000 });
  assert.equal(sent.kind, "rejected");
  assert.match(sent.kind === "rejected" ? sent.reason : "", /session retired/i, "retirement must win over missing repo/base-branch rejection");
  assert.equal(existsSync(missing), false);
  assert.equal(procs.length, 1);
  const tools: any[] = []; // heterogeneous tool execute signatures in the ExtensionAPI stub
  registerTools({ registerTool: (tool: unknown) => tools.push(tool) } as any, {
    getCwd: () => cwd, getRegistry: () => registry, getQueue: () => new SpawnQueue(registry, 4), getModel: () => new FocusedStreamModel(registry), getParentMessages: () => [], openFocusedOverlay() {}, registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister() {} }), pushCompletionNotification() {},
  });
  const output = await tools.find(x => x.name === "ensemble_send").execute("send", { agent_id: run.id, message: "continue", foreground: false });
  assert.match(JSON.stringify(output.content), /session retired/i);
  assert.equal(procs.length, 1);
  assert.equal(existsSync(missing), false);

  const notes: string[] = [];
  let command: any; // command registration boundary in the stub
  registerCommands({ registerCommand: (_name: string, spec: unknown) => { command = spec; } } as any, {
    getCwd: () => cwd, getRegistry: () => registry,
  } as any);
  for (const flag of ["", "--resume", "--steer", "--follow-up"]) {
    await command.handler(`send ${run.id} ${flag} continue`, { ui: { notify: (text: string) => notes.push(text) } });
    assert.match(notes.at(-1)!, /session retired/i);
  }
  await executePromptAndSend({
    getCtx: () => ({ ui: { notify: text => notes.push(text), input: async () => { assert.fail("retired session must not open input"); } } }),
    registry, cwd, validateSendable,
    loadConfig: () => { assert.fail("retirement must reject before persona/config resolution"); },
    resolvePersonas: async () => { assert.fail("no persona resolution"); },
    resolveTimeoutMs: () => { assert.fail("no timeout resolution"); },
    sendToRun: () => { assert.fail("no overlay send"); }, pushCompletionNotification() {},
  }, run.id);
  assert.match(notes.at(-1)!, /session retired/i);
  assert.equal(procs.length, 1);
  assert.equal(existsSync(missing), false);
});

test("A2 forced settlement discovers retirement before the completion callback", { timeout: 5000 }, async (t) => {
  const procs = fakeSpawn(t);
  const registry = new RunRegistry();
  const result = await spawnRun({ registry, persona, cwd: tmpDir("a2-kill-"), task: "test", mode: "background", timeoutMs: 4000 });
  saveSession(result.run, true, false);
  let flag: unknown;
  forceTerminate(result.run, "killed", registry, r => { flag = r.contextRetired; });
  assert.equal(flag, true);
  procs[0].emit("close", 1);
  await result.done;
});

for (const hookExit of [0, 1]) {
  test(`A2 retired finalization still runs quality hook (exit ${hookExit}) and preserves worktree safety`, { timeout: 5000 }, async (t) => {
    const procs = fakeSpawn(t, hookExit);
    const registry = new RunRegistry();
    const flags: unknown[] = [];
    const result = await spawnRun({ registry, persona: { ...persona, onCompleteHook: "a2-quality-check" }, cwd: tmpDir("a2-hook-"), task: "test", mode: "background", timeoutMs: 4000,
      onComplete: r => flags.push(r.contextRetired),
    });
    const run = result.run;
    saveSession(run, true, false);
    // Re-adopted worktrees must never auto-merge, even after successful retirement.
    const worktree = join(run.cwd, "kept-worktree");
    mkdirSync(worktree);
    writeFileSync(join(worktree, "partial.txt"), "unmerged work");
    run.worktreePath = worktree;
    run.worktreeBranch = "kept-branch";
    run.mergeStrategy = "squash";
    run.reconciledAtStartup = true;
    emit(procs[0], { type: "message_end", message: handoff });
    emit(procs[0], { type: "agent_settled" });
    await result.done;
    assert.equal(procs.length, 2, "the quality hook is not bypassed");
    assert.equal(run.hookResult?.passed, hookExit === 0);
    assert.equal(run.status, hookExit === 0 ? "merge_conflict" : "hook_failed");
    assert.equal(readFileSync(join(worktree, "partial.txt"), "utf8"), "unmerged work");
    assert.deepEqual(flags, [true]);
    assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).contextRetired, true);
  });
}

for (const seeded of [false, true]) for (const scenario of ["retired", "foreign-marker", "disabled", "another-run"]) {
  test(`A2 live RPC ${seeded ? "seeded" : "fresh"}: ${scenario} continuation before settlement`, { timeout: 5000 }, async (t) => {
    const procs = fakeSpawn(t);
    const registry = new RunRegistry();
    const cwd = tmpDir("a2-live-retirement-");
    if (scenario === "disabled") {
      mkdirSync(join(cwd, ".pi"));
      writeFileSync(join(cwd, ".pi/conductor.json"), '{"contextRetirement":false}');
    }
    const result = await spawnRun({ registry, persona, cwd, task: "test", mode: "background", timeoutMs: 4000, steerable: true,
      parentMessages: seeded ? [{ role: "user", content: "history", timestamp: 1 }] : [],
    });
    const run = result.run;
    const proc = procs[0];
    const writes: string[] = [];
    proc.stdin.on("data", data => writes.push(data.toString()));
    try {
      let entry;
      if (scenario === "another-run") {
        const other = { type: "session", version: 3, id: "other-child", cwd };
        entry = marker(other.id);
        // Neither a sibling run nor a nested directory is this run's session.
        for (const path of [
          join(dirname(dirname(run.recordPath)), "other-run", "session", "other.jsonl"),
          join(dirname(run.recordPath), "session", "nested", "other.jsonl"),
        ]) {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, [other, entry].map(x => JSON.stringify(x)).join("\n") + "\n");
        }
      } else {
        const path = saveSession(run, scenario !== "foreign-marker", seeded);
        const lines = readFileSync(path, "utf8").trim().split("\n");
        entry = JSON.parse(lines.at(-1)!);
      }
      emit(proc, { type: "entry_appended", entry });
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.equal(run.status, "running");
      assert.equal(Boolean(run.sessionPath), seeded, "fresh session path is not yet stamped by finalization");
      const before = [...writes];
      const beforeUsage = run.thisInvocationUsageBaseline;
      const check = validateSendable(run);
      const sent = sendToRun(run, "NEW objective", { registry, timeoutMs: 4000, streamingBehavior: "follow_up" });
      if (sent.kind === "started") void sent.ack?.catch(() => {});
      await new Promise<void>(resolve => setImmediate(resolve));
      if (scenario === "retired") {
        assert.deepEqual(writes, before, "retired live RPC child must receive no new stdin bytes");
        assert.equal(sent.kind, "rejected");
        assert.equal(check.ok, false, "shared gate also protects slash and overlay entry points");
        assert.match(sent.kind === "rejected" ? sent.reason : "", /session retired/i);
        assert.equal(run.thisInvocationUsageBaseline, beforeUsage, "no invocation mutation");
      } else {
        assert.equal(sent.kind, "started");
        assert.equal(check.ok, true);
        assert.ok(writes.slice(before.length).some(line => {
          const command = JSON.parse(line);
          return command.type === "follow_up" && command.message === "NEW objective";
        }), "foreign marker, config-off, and other-run controls permit native live sends");
      }
      assert.equal(procs.length, 1, "a live send never spawns another process");
      assert.equal(run.status, "running", "send does not settle the child");
    } finally {
      for (const id of run.pendingAcks?.keys() ?? []) emit(proc, { type: "response", id, command: "follow_up", success: true });
      emit(proc, { type: "message_end", message: handoff });
      emit(proc, { type: "agent_settled" });
      await result.done;
    }
  });
}

test("A2 host compatibility declares the verified settlement API floor in manifest, lock, and README", () => {
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.87.1");
  assert.equal(lock.packages[""].peerDependencies["@earendil-works/pi-coding-agent"], ">=0.87.1");
  assert.match(readFileSync(new URL("../README.md", import.meta.url), "utf8"), /Pi 0\.87\.1 or newer/);
});
