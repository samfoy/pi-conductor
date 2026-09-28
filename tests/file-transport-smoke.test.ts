import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { availableActions, buildPiArgs, buildSubAgentPrompt, RunRegistry, sendToRun, spawnRun } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import type { Persona, Run } from "../src/types.ts";

const { piBin } = sandboxPi();
const cwd = tmpDir("a5-transport-");
// Pi 0.87.1: prompt ack is acceptance, agent_end is not completion, agent_settled is.
writeFileSync(piBin, `import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const args = process.argv.slice(2);
const sessionDir = args.includes('--session-dir') ? args[args.indexOf('--session-dir') + 1] : dirname(args[args.indexOf('--session') + 1]);
const receipt = join(sessionDir, 'received.json');
const emit = e => process.stdout.write(JSON.stringify(e) + '\\n');
const finish = message => {
  writeFileSync(receipt, JSON.stringify({message, args}));
  const m = {role:'assistant',content:[{type:'text',text:'Verified the complete supplied evidence and returned the requested result.'}],stopReason:'stop'};
  emit({type:'agent_start'}); emit({type:'message_end',message:m});
  emit({type:'agent_end',messages:[m],willRetry:false});
  setTimeout(() => { writeFileSync(receipt, JSON.stringify({message, args, settled:true})); emit({type:'agent_settled'}); if (args[1] !== 'rpc') process.exit(0); }, 20);
};
if (args[1] !== 'rpc') finish(args.at(-1));
else {
  let buffer = ''; process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { buffer += chunk; let i;
    while ((i=buffer.indexOf('\\n')) >= 0) {
      const cmd = JSON.parse(buffer.slice(0,i)); buffer=buffer.slice(i+1);
      if (cmd.type !== 'prompt') throw new Error('unexpected command');
      if (cmd.message.includes('A5_REJECT_INITIAL')) { emit({id:cmd.id,type:'response',command:'prompt',success:false,error:'rejected by fake preflight'}); continue; }
      emit({id:cmd.id,type:'response',command:'prompt',success:true}); finish(cmd.message);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
`);
const persona = { name: "inspector", defaultReads: [], systemPrompt: "Persona stays short", inheritContext: "none", description: "probe", inheritSkills: false, worktree: false, timeoutMinutes: 1, readOnly: true, source: "builtin", sourcePath: "test" } satisfies Persona;
const receipt = (run: Run) => JSON.parse(readFileSync(join(dirname(run.finalPath), "session", "received.json"), "utf8"));
const body = "😀<&\r\nwhole\u2028text\u2029".repeat(8000);

for (const seeded of [false, true]) {
  test(`large actual prompt uses RPC stdin, settles and releases queue (${seeded ? "seeded" : "fresh"})`, { timeout: 8000 }, async () => {
    const registry = new RunRegistry();
    const queue = new SpawnQueue(registry, 1);
    const opts = { persona: { ...persona, inheritContext: seeded ? "full" as const : "none" as const }, task: body, cwd, mode: "background" as const, timeoutMs: 4000, parentMessages: [{ role: "user" as const, content: "seed context", timestamp: 1 }] };
    const first = queue.enqueueOrSpawn(opts);
    assert.equal(first.kind, "spawned"); if (first.kind !== "spawned") return;
    const proc = first.run.proc;
    const close = proc ? once(proc, "close") : Promise.resolve();
    const second = queue.enqueueOrSpawn({ ...opts, task: "short positive control", onComplete: () => {} });
    assert.equal(second.kind, "queued", "large prompt must start rather than E2BIG");
    assert.equal(first.run.streamingMode, "rpc");
    assert.equal(first.run.steerable, false, "transport does not grant steering");
    assert.ok(!availableActions(first.run).includes("steer"));
    const done = await first.done;
    assert.equal(done.status, "completed", done.errorMessage);
    const received = receipt(done);
    assert.equal(received.settled, true, "agent_end must not finalize before agent_settled");
    assert.equal(received.message, buildSubAgentPrompt(opts.persona, body));
    assert.ok(Buffer.byteLength(received.message) > 131072);
    assert.ok(received.args.includes(seeded ? "--session" : "--session-dir"));
    assert.ok(!received.args.includes(body));
    assert.equal(done.rpcStdinQueue?.writable ?? false, false, "settlement cleans the RPC writer");
    await close;
    assert.ok(proc?.signalCode !== null || proc?.exitCode !== null);
    assert.equal(queue.size(), 0, "settlement drained the queued successor");
    // Await the successor as well so this test leaves no live subprocess.
    const successor = registry.list().find(r => r.id !== done.id)!;
    if (successor.proc) await once(successor.proc, "close");
    const short = receipt(successor);
    assert.equal(short.args[1], "json"); assert.ok(short.args.includes("-p"));
  });
}

test("large resumed prompt reaches stdin intact, not argv", { timeout: 8000 }, async () => {
  const registry = new RunRegistry();
  const initial = spawnRun({ persona, task: "first", cwd, mode: "background", registry, timeoutMs: 4000, parentMessages: [{ role: "user", content: "prior", timestamp: 1 }], inheritContextOverride: "full" });
  await initial.done;
  const sent = sendToRun(initial.run, body, { registry, timeoutMs: 4000 });
  assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
  const proc = sent.run.proc; const close = proc ? once(proc, "close") : Promise.resolve();
  assert.equal((await sent.done).status, "completed", sent.run.errorMessage);
  assert.equal(receipt(sent.run).message, body.trim());
  await close;
});

test("large file evidence reaches the child as one complete framed user prompt", { timeout: 8000 }, async () => {
  const registry = new RunRegistry();
  const files = [join(cwd, "first.md"), join(cwd, "second.md")];
  const evidence = "😀\r\n<&evidence>".repeat(3500);
  files.forEach(p => writeFileSync(p, evidence));
  const spawned = spawnRun({ persona, task: "Use the two files", files, cwd, registry, mode: "background", timeoutMs: 4000 });
  const expected = buildSubAgentPrompt(persona, spawned.run.task);
  files.forEach(p => writeFileSync(p, "changed"));
  const proc = spawned.run.proc; const close = proc ? once(proc, "close") : Promise.resolve();
  assert.equal((await spawned.done).status, "completed", spawned.run.errorMessage);
  const received = receipt(spawned.run);
  assert.equal(received.message, expected);
  assert.ok(Buffer.byteLength(expected) > 131072);
  assert.equal((expected.match(/<file name=/g) ?? []).length, 2);
  assert.equal((expected.match(/<\/file>/g) ?? []).length, 2);
  assert.doesNotMatch(received.args[received.args.indexOf("--append-system-prompt") + 1], /&lt;&amp;evidence/);
  await close;
});

test("explicit steering remains opt-in on a short RPC spawn", { timeout: 8000 }, async () => {
  const registry = new RunRegistry();
  const spawned = spawnRun({ persona, task: "short rpc", cwd, registry, mode: "background", timeoutMs: 4000, steerable: true });
  const proc = spawned.run.proc; const close = proc ? once(proc, "close") : Promise.resolve();
  assert.equal(spawned.run.streamingMode, "rpc"); assert.equal(spawned.run.steerable, true);
  assert.ok(availableActions(spawned.run).includes("steer"));
  assert.equal((await spawned.done).status, "completed"); await close;
});

test("RPC initial rejection fails promptly, cleans stdin, and releases its slot", { timeout: 8000 }, async () => {
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 1);
  const opts = { persona, cwd, mode: "background" as const, timeoutMs: 4000 };
  const first = queue.enqueueOrSpawn({ ...opts, task: `A5_REJECT_INITIAL ${body}` });
  assert.equal(first.kind, "spawned"); if (first.kind !== "spawned") return;
  const proc = first.run.proc; const close = proc ? once(proc, "close") : Promise.resolve();
  const next = queue.enqueueOrSpawn({ ...opts, task: "after rejected prompt" });
  assert.equal(next.kind, "queued");
  const done = await first.done;
  assert.equal(done.status, "failed"); assert.match(done.errorMessage!, /initial prompt rejected: rejected by fake preflight/);
  assert.equal(done.rpcStdinQueue?.writable, false); await close;
  assert.equal(queue.size(), 0);
  const successor = registry.list().find(r => r.id !== done.id)!;
  if (successor.proc) await once(successor.proc, "close");
});

test("early child exit during a large stdin write fails without an unhandled EPIPE", { timeout: 8000 }, async () => {
  const exitStub = join(cwd, "exit-before-read.mjs"); writeFileSync(exitStub, "process.exit(1);\n");
  const previous = process.env.PI_BIN; process.env.PI_BIN = exitStub;
  try {
    const registry = new RunRegistry();
    const spawned = spawnRun({ persona, task: body.repeat(4), cwd, registry, mode: "background", timeoutMs: 4000 });
    assert.equal((await spawned.done).status, "failed");
    assert.equal(spawned.run.rpcStdinQueue?.writable, false);
  } finally { process.env.PI_BIN = previous; }
});

test("transport byte threshold and explicit RPC positive controls", () => {
  const args = (prompt: string, steerable = false) => buildPiArgs({ kind: "fresh", sessionDir: cwd, systemPrompt: "short", prompt, steerable });
  assert.equal(args("x".repeat(96 * 1024))[1], "json");
  assert.equal(args("x".repeat(96 * 1024 + 1))[1], "rpc");
  assert.equal(args("😀".repeat(25000))[1], "rpc");
  assert.equal(args("short", true)[1], "rpc");
});
