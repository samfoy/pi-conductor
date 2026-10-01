/**
 * N3 smoke: a settled run keeps its admission slot until its own subprocess
 * has closed, on the shared pipeline for lead-level runs and leaves alike. A
 * stub pi prints `agent_settled`, ignores the settlement SIGTERM (as a child
 * with a slow shutdown would) and exits only when released. Liveness is read
 * from each run's own ChildProcess handle (exitCode/signalCode), never from a
 * pid probe or `proc.killed`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { projectPersonasDir } from "../src/personas.ts";
import { RunRegistry, runsRoot, writeFinal } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { DelegationBroker } from "../src/delegation-broker.ts";
import { delegatePaths } from "../src/delegation.ts";
import { emptyUsage, isTerminal, type Persona, type Run } from "../src/types.ts";

const { piBin } = sandboxPi();
const stub = join(dirname(piBin), "n3-exit-stub.mjs");
writeFileSync(stub, [
  'import { existsSync, writeFileSync } from "node:fs";',
  'import { join } from "node:path";',
  'const dir = process.env.CONDUCTOR_RUN_DIR, id = process.env.CONDUCTOR_RUN_ID ?? "";',
  'process.on("SIGTERM", () => writeFileSync(join(dir, "sigterm"), "1"));',
  'const e = (x) => process.stdout.write(JSON.stringify(x) + "\\n");',
  // Leaves settle only when the test says so; other runs settle at once.
  'const settle = () => { e({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: id + " answered" }], stopReason: "stop" } }); e({ type: "agent_settled" }); };',
  'let settled = false;',
  'setInterval(() => {',
  '  if (!settled && (!id.startsWith("scout-") || existsSync(join(dir, "settle")))) { settled = true; settle(); }',
  '  if (settled && !id.startsWith("stubborn-") && existsSync(join(dir, "release"))) process.exit(0);',
  '}, 10);',
].join("\n"));
process.env.PI_BIN = stub;

const persona = (name: string, over: Partial<Persona> = {}): Persona => ({ name, description: "probe", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false,
  timeoutMinutes: 1, systemPrompt: `You are ${name}.`, source: "project", sourcePath: `/fake/${name}.md`, readOnly: name === "scout", ...over });

const proc = (run: Run | undefined): ChildProcess | undefined => (run?.transport as { proc?: ChildProcess } | undefined)?.proc;
const live = (run: Run | undefined) => { const p = proc(run); return !!p && p.exitCode === null && p.signalCode === null; };
const release = (run: Run) => writeFileSync(join(dirname(run.recordPath), "release"), "go");
const settleLeaf = (run: Run) => writeFileSync(join(dirname(run.recordPath), "settle"), "go");
async function until(cond: () => boolean, what: string, ms = 10000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 10)); }
}
/** Drain nothing more, then kill this test's own live children: a freed slot must not launch a run after cleanup. */
function reap(t: test.TestContext, registry: RunRegistry, queue: SpawnQueue) {
  t.after(() => {
    for (const p of [...queue.list()]) queue.removeQueued(p.id);
    for (const r of registry.list()) if (live(r)) proc(r)!.kill("SIGKILL");
  });
}
/** Peak live owned processes, sampled on every registry change and every poll. */
function sampler(registry: RunRegistry, filter: (r: Run) => boolean = () => true) {
  const peak = { live: 0 };
  const sample = () => { peak.live = Math.max(peak.live, registry.list().filter(r => filter(r) && live(r)).length); };
  registry.onChange(sample);
  return { peak, wait: (cond: () => boolean, what: string, ms?: number) => until(() => { sample(); return cond(); }, what, ms) };
}

test("N3 a settled lead-level run keeps its slot until its process closes; its exit then drains the queue", { timeout: 20000 }, async (t) => {
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 1, 1);
  const cwd = tmpDir("n3-exit-lead-");
  reap(t, registry, queue);
  const s = sampler(registry);
  const spawn = () => { const r = queue.enqueueOrSpawn({ persona: persona("holder"), task: "t", cwd, mode: "background", timeoutMs: 15000, runtimeEnv: {} }); return r.kind === "spawned" ? r.run : r.placeholderRun; };
  const a = spawn(), b = spawn();
  assert.equal(b.status, "queued");
  await s.wait(() => isTerminal(a.status) && existsSync(join(dirname(a.recordPath), "sigterm")), "a settled and was asked to exit");
  assert.equal(a.status, "completed");
  assert.equal(live(a), true, "a's process is still alive after settlement");
  assert.equal(registry.get(b.id)!.status, "queued", "b must not start while a's process lives");
  assert.match(registry.get(b.id)!.waitReason ?? "", /maxConcurrent \(1\)/);
  release(a);
  await s.wait(() => registry.get(b.id)!.status !== "queued", "b admitted after a's exit");
  assert.equal(proc(a)!.exitCode, 0, "a exited on its own; it was not killed");
  const started = registry.get(b.id)!;
  await s.wait(() => isTerminal(started.status), "b settled");
  release(started);
  await s.wait(() => !live(started), "b exited");
  assert.equal(s.peak.live, 1, "never more live processes than maxConcurrent for lead-level work");
});

test("N3 a leaf's answer waits for its process to close; meanwhile its parent stays blocked and no other leaf starts on its slot", { timeout: 20000 }, async (t) => {
  const cwd = tmpDir("n3-exit-leaf-");
  mkdirSync(projectPersonasDir(cwd), { recursive: true });
  writeFileSync(join(projectPersonasDir(cwd), "lead.md"), "---\nname: lead\ndescription: probe\nagents:\n  - scout\n---\nYou are lead.\n");
  writeFileSync(join(projectPersonasDir(cwd), "scout.md"), "---\nname: scout\ndescription: probe\nread_only: true\n---\nYou are scout.\n");
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 1, 1);
  const broker = new DelegationBroker({ registry, queue, env: {} });
  registry.delegation = broker;
  const id = "lead-n3exit", dir = join(runsRoot(), id);
  mkdirSync(dir, { recursive: true });
  const parent: Run = { id, runtime: "subprocess", persona: "lead", task: "t", cwd, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(),
    messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
    depth: 1, delegateAllow: ["scout"], deadlineAt: Date.now() + 60_000, parentSessionId: "s" };
  registry.register(parent);
  reap(t, registry, queue);
  const s = sampler(registry, r => r.depth === 2);
  const answered = (c: string) => existsSync(delegatePaths(dir, c).response);
  const leaf = (c: string) => registry.list().find(r => r.delegateToolCallId === c);
  for (const c of ["c1", "c2"]) {
    broker.observe(parent, { type: "tool_execution_start", toolName: "delegate", toolCallId: c, args: { persona: "scout", task: c } }, cwd);
    broker.observe(parent, { type: "tool_execution_update", toolName: "delegate", toolCallId: c }, cwd);
  }
  await s.wait(() => !!leaf("c1") && !!leaf("c2"), "both leaves registered");
  // Whichever claim resolved first runs on the parent's own slot; the other waits.
  const first = registry.list().find(r => r.depth === 2 && r.status === "running")!, second = registry.list().find(r => r.depth === 2 && r.status === "queued")!;
  assert.ok(first && second, "one leaf runs on the parent's own slot; the other waits");
  const [c1, c2] = [first.delegateToolCallId!, second.delegateToolCallId!];
  settleLeaf(first);
  await s.wait(() => isTerminal(first.status) && existsSync(join(dirname(first.recordPath), "sigterm")), "the first leaf settled and was asked to exit");
  // The broker answers once these writes land; awaiting them too makes an early answer visible here.
  await first.recordWrite; await writeFinal(first); await new Promise(r => setImmediate(r));
  assert.equal(live(first), true);
  assert.equal(answered(c1), false, "no answer while the leaf's process lives: the parent stays blocked");
  assert.equal(leaf(c2)!.status, "queued", "the second leaf must not start on a slot the first leaf's process still holds");
  assert.equal(parent.pendingDelegations, 2);
  release(first);
  await s.wait(() => answered(c1) && leaf(c2)!.status !== "queued", "first answered after exit; second admitted");
  assert.equal(live(first), false, "the answer came after the exit");
  assert.equal(proc(first)!.exitCode, 0);
  settleLeaf(leaf(c2)!);
  await s.wait(() => isTerminal(leaf(c2)!.status), "second settled");
  release(leaf(c2)!);
  await s.wait(() => answered(c2), "second answered");
  assert.equal(s.peak.live, 1, "one live leaf at a time on a cap of 1 with the parent blocked");
  assert.equal(parent.pendingDelegations, 0);
});

for (const steerable of [false, true]) {
  test(`N3 a ${steerable ? "RPC" : "print"} child that ignores the settlement SIGTERM is killed within the bound, releasing its slot`, { timeout: 20000 }, async (t) => {
    const registry = new RunRegistry();
    const queue = new SpawnQueue(registry, 1, 1);
    const cwd = tmpDir("n3-exit-stubborn-");
    const s = sampler(registry);
    const a = queue.enqueueOrSpawn({ persona: persona("stubborn"), task: "t", cwd, mode: "background", timeoutMs: 15000, runtimeEnv: {}, steerable });
    const b = queue.enqueueOrSpawn({ persona: persona("holder"), task: "t", cwd, mode: "background", timeoutMs: 15000, runtimeEnv: {} });
    assert.equal(a.kind, "spawned");
    assert.equal(b.kind, "queued");
    const run = (a as { run: Run }).run, waiting = (b as { placeholderRun: Run }).placeholderRun;
    reap(t, registry, queue);
    assert.equal(run.streamingMode, steerable ? "rpc" : "print");
    await s.wait(() => isTerminal(run.status) && existsSync(join(dirname(run.recordPath), "sigterm")), "settled and asked to exit");
    const settledAt = Date.now();
    assert.equal(registry.get(waiting.id)!.status, "queued", "the settled child's process still holds the only slot");
    await s.wait(() => registry.get(waiting.id)!.status !== "queued", "a SIGTERM-ignoring child must be killed so its slot frees", 8000);
    assert.equal(proc(run)!.signalCode, "SIGKILL", "the escalation, not the child, ended it");
    assert.ok(Date.now() - settledAt < 6000, `released ${Date.now() - settledAt} ms after settlement`);
    const next = registry.get(waiting.id)!;
    await s.wait(() => isTerminal(next.status), "the queued run settled");
    release(next);
    await s.wait(() => !live(next), "the queued run exited");
    assert.equal(s.peak.live, 1);
  });
}
