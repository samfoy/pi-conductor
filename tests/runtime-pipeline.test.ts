import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { RunRegistry, spawnRun, getFinalText } from "../src/runs.ts";
import { emptyUsage, type Persona, type Run } from "../src/types.ts";
import { createRunPipeline } from "../src/run-pipeline.ts";
import { SubprocessRuntime } from "../src/subprocess-runtime.ts";
import { join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
const persona: Persona = { name: "inspector", description: "probe", defaultReads: [], systemPrompt: "Probe", inheritContext: "none", inheritSkills: false, worktree: false, timeoutMinutes: 1, readOnly: true, source: "builtin", sourcePath: "test" };
const message = (text: string) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } });
function setup(t: test.TestContext, rpc = false) {
  const signals: unknown[] = [];
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill(signal?: unknown) { signals.push(signal); return true; }, unref() {} });
  t.mock.method(cp, "spawn", () => proc);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const registry = new RunRegistry();
  let completions = 0;
  const result = spawnRun({ registry, persona, task: "probe", cwd: tmpDir("h1-pipeline-"), mode: "background", steerable: rpc, timeoutMs: 4000, onComplete: () => completions++ });
  t.after(() => { clearTimeout(result.run.timeoutTimer); });
  return { proc, signals, result, registry, completions: () => completions };
}
for (const rpc of [false, true]) {
  test(`H1 ${rpc ? "RPC" : "print"}: low-level end cannot release a run before recovered output and native settlement`, async t => {
    const h = setup(t, rpc);
    h.proc.stdout.write(JSON.stringify(message("First response before recovery")) + "\n");
    h.proc.stdout.write('{"type":"turn_end"}\n{"type":"agent_end","willRetry":true}\n');
    assert.equal(h.result.run.status, "running", "agent_end is not settlement");
    assert.equal(h.registry.countActive(), 1);
    assert.equal(h.completions(), 0);
    assert.deepEqual(h.signals, [], "no process teardown across recovery");
    h.proc.stdout.write(JSON.stringify(message("Recovered response with final evidence and verification.")) + "\n");
    h.proc.stdout.write('{"type":"agent_settled"}\n');
    await h.result.done;
    h.proc.emit("close", 0);
    assert.equal(h.completions(), 1);
    assert.equal(h.result.run.usage.turns, 2);
    assert.equal(h.registry.countActive(), 0);
    assert.match(readFileSync(h.result.run.finalPath, "utf8"), /Recovered response/);
  });
}
for (const failure of ["close", "error"]) {
  test(`H1 ${failure}: unterminated multibyte stdout tail drains before final persistence`, async t => {
    const h = setup(t);
    const text = "Final tail evidence 🧪 漢字 with complete verification.";
    const bytes = Buffer.from(JSON.stringify(message(text)));
    const split = bytes.indexOf(Buffer.from("🧪")) + 2;
    h.proc.stdout.write(bytes.subarray(0, split));
    h.proc.stdout.write(bytes.subarray(split));
    h.proc.stderr.write("stderr failure evidence");
    if (failure === "close") h.proc.emit("close", 7);
    else h.proc.emit("error", new Error("ENOENT"));
    await h.result.done;
    assert.equal(getFinalText(h.result.run.messages), text);
    assert.equal(readFileSync(h.result.run.finalPath, "utf8"), text);
    assert.equal(h.result.run.status, "failed");
    assert.equal(h.result.run.errorMessage, failure === "close" ? "stderr failure evidence" : "failed to spawn pi process");
    h.proc.emit("close", 1);
    assert.equal(h.completions(), 1);
  });
}


test("H1 pipeline observer sees parsed events and decoded close tail once, before application", async t => {
  const cwd = tmpDir("h1-observer-");
  const run: Run = { id: "inspector-observer", persona: "inspector", task: "probe", mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(), cwd,
    messages: [], usage: emptyUsage(), recordPath: join(cwd, "record.json"), transcriptPath: join(cwd, "transcript.jsonl"), finalPath: join(cwd, "final.md") };
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true, unref() {} });
  t.mock.method(cp, "spawn", () => proc); syncBuiltinESMExports();
  t.after(() => { clearTimeout(run.timeoutTimer); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const registry = new RunRegistry(); registry.register(run);
  const seen: unknown[] = [];
  const done = createRunPipeline(run, ["--mode", "json", "-p", "probe"], { registry, cwd, steerable: false, timeoutMs: 4000, runtime: new SubprocessRuntime(),
    onEvent: (observed, event) => { assert.equal(observed, run); seen.push(event); assert.equal(run.messages.length, seen.length - 1, "observe before applyEvent"); } });
  proc.stdout.write("not JSON\n\n");
  const first = message("First complete response.");
  const tail = message("Final decoded tail 🧪 with verification.");
  proc.stdout.write(JSON.stringify(first) + "\n" + JSON.stringify(tail));
  proc.emit("close", 0);
  await done;
  proc.emit("close", 0);
  assert.deepEqual(seen, [first, tail]);
  assert.equal(readFileSync(run.finalPath, "utf8"), tail.message.content[0].text);
});
