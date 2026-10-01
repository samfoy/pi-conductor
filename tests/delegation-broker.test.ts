/**
 * N2: the lead-brokered blocking `delegate` for subprocess parents.
 *
 * The broker reads only the parent's own parsed event stream: start saves
 * the arguments, the first `tool_execution_update` (emitted from inside the
 * tool's execute, so the only proof it ran) claims the call exclusively and
 * enqueues one read-only depth-2 leaf. Responses are create-only files the
 * child awaits. A fake spawner stands in for processes here; the native
 * smoke drives real Pi.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { projectPersonasDir } from "../src/personas.ts";
import { RunRegistry, runsRoot, sendToRun, spawnRun, writeFinal, type SpawnOptions } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { publishJson } from "../src/effort/store.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { formatCompletionNotification } from "../src/notifications.ts";
import { DelegationBroker } from "../src/delegation-broker.ts";
import {
  DELEGATE_RESPONSE_GRACE_MS, MAX_DELEGATE_TASK_BYTES, MAX_OUTSTANDING_DELEGATIONS, RELOAD_INTERRUPTED,
  delegatePaths, delegateWaitDeadline, formatDelegateEnvelope, isDelegateCallId, validateDelegateRequest,
} from "../src/delegation.ts";
import { registerDelegate, waitForDelegateResponse } from "../src/delegate-tool.ts";
import { emptyUsage, type Persona, type Run } from "../src/types.ts";

const { piBin } = sandboxPi();

// ── Fixtures ─────────────────────────────────────────────────────────

const doc = (name: string, fm: string) => `---\nname: ${name}\ndescription: probe\n${fm}---\nYou are ${name}.\n`;

/** A project whose lead may delegate to two read-only leaves; `writer` and a read_only `builder` are invalid targets. */
function project(extra: Record<string, string> = {}): string {
  const cwd = tmpDir("n2-project-");
  mkdirSync(projectPersonasDir(cwd), { recursive: true });
  const files = {
    "lead.md": doc("lead", "agents:\n  - scout\n  - auditor\n"),
    "scout.md": doc("scout", "read_only: true\ntimeout_minutes: 7\n"),
    "auditor.md": doc("auditor", "read_only: true\ntimeout_minutes: 3\n"),
    "writer.md": doc("writer", ""),
    ...extra,
  };
  for (const [f, text] of Object.entries(files)) writeFileSync(join(projectPersonasDir(cwd), f), text);
  return cwd;
}

let seq = 0;
function parentRun(registry: RunRegistry, cwd: string, over: Partial<Run> = {}): Run {
  const id = `lead-p${++seq}`, dir = join(runsRoot(), id);
  mkdirSync(dir, { recursive: true });
  const run: Run = { id, runtime: "subprocess", persona: "lead", task: "lead task", cwd, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(),
    messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
    depth: 1, delegateAllow: ["scout", "auditor"], deadlineAt: Date.now() + 10 * 60_000, parentSessionId: "lead-session", ...over };
  registry.register(run);
  return run;
}

function harness(opts: { maxConcurrent?: number; env?: NodeJS.ProcessEnv } = {}) {
  const registry = new RunRegistry();
  const spawned: SpawnOptions[] = [];
  const spy = (o: SpawnOptions) => {
    spawned.push(o);
    const id = o.preAllocatedId ?? `${o.persona.name}-l${++seq}`, dir = join(runsRoot(), id);
    mkdirSync(dir, { recursive: true });
    const leaf: Run = { id, runtime: "subprocess", persona: o.persona.name, task: o.task, cwd: o.cwd, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(),
      messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
      depth: 2, delegateAllow: [], parentRunId: o.delegation?.parentRunId, delegateToolCallId: o.delegation?.delegateToolCallId, onComplete: o.onComplete };
    o.registry.register(leaf);
    return { run: leaf, done: new Promise<Run>(() => {}) };
  };
  const queue = new SpawnQueue(registry, opts.maxConcurrent ?? 8, 1, spy);
  const broker = new DelegationBroker({ registry, queue, env: opts.env ?? {} });
  registry.delegation = broker;
  return { registry, queue, broker, spawned };
}

const start = (id: string, args: unknown, extra: object = {}) => ({ type: "tool_execution_start", toolCallId: id, toolName: "delegate", args, ...extra });
const update = (id: string, extra: object = {}) => ({ type: "tool_execution_update", toolCallId: id, toolName: "delegate", partialResult: { content: [] }, ...extra });
const end = (id: string, isError = false) => ({ type: "tool_execution_end", toolCallId: id, toolName: "delegate", result: { content: [] }, isError });
const ask = (persona: string, task = `look at ${persona}`, extra: object = {}) => ({ persona, task, ...extra });

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
const responsePath = (parent: Run, id: string) => delegatePaths(dirname(parent.recordPath), id).response;
const claimPath = (parent: Run, id: string) => delegatePaths(dirname(parent.recordPath), id).claim;
async function response(parent: Run, id: string) {
  await until(() => existsSync(responsePath(parent, id)), `response ${id}`);
  return JSON.parse(readFileSync(responsePath(parent, id), "utf8"));
}
/** Let the broker's asynchronous roster resolution run to its effect. */
const settle = () => new Promise((r) => setTimeout(r, 60));

async function finishLeaf(registry: RunRegistry, leaf: Run, text: string, status: Run["status"] = "completed") {
  leaf.messages = [{ role: "assistant", content: [{ type: "text", text }] } as never];
  leaf.status = status;
  leaf.finishedAt = Date.now();
  await writeFinal(leaf);
  registry.notify(leaf);
  leaf.onComplete?.(leaf);
}
const leavesOf = (registry: RunRegistry, parent: Run) => registry.list().filter((r) => r.parentRunId === parent.id);

// ── Pure validation ──────────────────────────────────────────────────

test("N2 call ids: model-issued ids only; 0.99.1 nested <parent>/<n> ids and oversize ids are refused", () => {
  for (const ok of ["toolu_01AbC", "call-1", "n2_alpha", "x".repeat(128)]) assert.equal(isDelegateCallId(ok), true, ok);
  for (const bad of ["", "parent/1", "a b", "x".repeat(129), "../x", "a.b", 7, undefined]) assert.equal(isDelegateCallId(bad), false, String(bad));
});

test("N2 validateDelegateRequest: one fail-closed reason per check", () => {
  const registry = new RunRegistry();
  const cwd = tmpDir("n2-pure-");
  const now = Date.now();
  const parent = parentRun(registry, cwd, { deadlineAt: now + 90_000 });
  const scout = { name: "scout", readOnly: true } as Persona;
  const base = { args: ask("scout"), parent, current: true, target: scout, personaTimeoutMs: 7 * 60_000, outstanding: 0, now };
  const reason = (over: object) => { const v = validateDelegateRequest({ ...base, ...over }); return v.ok ? "ok" : v.reason; };
  assert.equal(reason({}), "ok");
  const cases: [string, object, RegExp][] = [
    ["not an object", { args: "scout" }, /arguments must be an object/],
    ["missing persona", { args: { task: "x" } }, /persona must be a non-empty string/],
    ["blank task", { args: ask("scout", "  \n") }, /task must contain non-whitespace text/],
    ["oversize task", { args: ask("scout", "x".repeat(MAX_DELEGATE_TASK_BYTES + 1)) }, /task exceeds 65536 bytes/],
    ["files not strings", { args: ask("scout", "t", { files: [3] }) }, /files must be an array of strings/],
    ["fractional timeout", { args: ask("scout", "t", { timeout_minutes: 1.5 }) }, /timeout_minutes must be a positive integer/],
    ["zero timeout", { args: ask("scout", "t", { timeout_minutes: 0 }) }, /timeout_minutes must be a positive integer/],
    ["depth 2 parent", { parent: { ...parent, depth: 2, delegateAllow: [] } }, /only a depth-1 delegator may delegate/],
    ["non-delegating parent", { parent: { ...parent, delegateAllow: [] } }, /only a depth-1 delegator may delegate/],
    ["herdr parent", { parent: { ...parent, runtime: "herdr" } }, /subprocess parents only until N5/],
    ["paused parent", { parent: { ...parent, status: "paused" } }, /parent .* is paused, not running/],
    ["stale parent", { current: false }, /not the current registered run/],
    ["outside allowlist", { args: ask("inspector"), target: { name: "inspector", readOnly: true } }, /inspector is not in this run's delegation allowlist \(scout, auditor\)/],
    ["unknown target", { target: undefined }, /persona scout is not available/],
    ["no longer read-only", { target: { name: "scout", readOnly: false } }, /scout is not read_only/],
    ["write-capable", { args: ask("builder"), parent: { ...parent, delegateAllow: ["builder"] }, target: { name: "builder", readOnly: true } }, /builder is write-capable/],
    ["outstanding cap", { outstanding: MAX_OUTSTANDING_DELEGATIONS }, /already has 8 delegate calls outstanding/],
    ["no deadline", { parent: { ...parent, deadlineAt: undefined } }, /deadline is unknown/],
    ["deadline passed", { parent: { ...parent, deadlineAt: now - 1 } }, /no time left/],
  ];
  for (const [label, over, expected] of cases) assert.match(reason(over), expected, label);
});

test("N2 timeout clamp: the leaf gets the least of persona, call and parent remaining, as an absolute deadline", () => {
  const registry = new RunRegistry();
  const now = 1_000_000;
  const parent = parentRun(registry, tmpDir("n2-clamp-"), { deadlineAt: now + 90_000 });
  const scout = { name: "scout", readOnly: true } as Persona;
  const clamp = (over: object) => { const v = validateDelegateRequest({ args: ask("scout"), parent, current: true, target: scout, personaTimeoutMs: 7 * 60_000, outstanding: 0, now, ...over }); assert.ok(v.ok); return v; };
  assert.deepEqual(clamp({}), { ok: true, timeoutMs: 90_000, deadlineAt: now + 90_000 }, "parent remaining binds");
  assert.equal(clamp({ args: ask("scout", "t", { timeout_minutes: 1 }) }).timeoutMs, 60_000, "call timeout binds");
  assert.equal(clamp({ personaTimeoutMs: 30_000 }).timeoutMs, 30_000, "persona timeout binds");
});

test("N2 child wait bound is the same clamp computed from the child's side plus two minutes", () => {
  const startedAt = 5_000;
  assert.equal(DELEGATE_RESPONSE_GRACE_MS, 120_000);
  assert.equal(delegateWaitDeadline({ startedAt, personaTimeoutMs: 600_000, ownDeadlineAt: startedAt + 90_000 }), startedAt + 90_000 + 120_000);
  assert.equal(delegateWaitDeadline({ startedAt, timeoutMinutes: 1, personaTimeoutMs: 600_000, ownDeadlineAt: startedAt + 90_000 }), startedAt + 60_000 + 120_000);
  assert.equal(delegateWaitDeadline({ startedAt, personaTimeoutMs: 30_000 }), startedAt + 30_000 + 120_000);
});

// ── Event orders ─────────────────────────────────────────────────────

test("N2 event order: start alone, start+error end, end alone and update without start never claim or spawn", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("only_start", ask("scout")), cwd);
  broker.observe(parent, start("schema_fail", { persona: "scout" }), cwd);
  broker.observe(parent, end("schema_fail", true), cwd);
  broker.observe(parent, end("no_start", true), cwd);
  broker.observe(parent, update("no_start2"), cwd);
  await settle();
  assert.equal(spawned.length, 0);
  for (const id of ["only_start", "schema_fail", "no_start", "no_start2"]) {
    assert.equal(existsSync(claimPath(parent, id)), false, `${id}: no claim`);
    assert.equal(existsSync(responsePath(parent, id)), false, `${id}: no response`);
  }
  assert.equal(parent.pendingDelegations ?? 0, 0);
});

test("N2 event order: start then update claims once, counts before enqueue and spawns one scoped leaf; a duplicate update spawns nothing", async () => {
  const cwd = project(), effective = tmpDir("n2-effective-");
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd);
  const seen: number[] = [];
  registry.onChange((r) => { if (r === parent) seen.push(r.pendingDelegations ?? 0); });
  broker.observe(parent, start("call_a", ask("scout", "inspect the parser")), effective);
  broker.observe(parent, update("call_a"), effective);
  assert.ok(existsSync(claimPath(parent, "call_a")), "the claim is synchronous, before any await");
  assert.equal(parent.pendingDelegations, 1);
  assert.deepEqual(seen, [1], "the parent is notified with the new count before the leaf is enqueued");
  assert.equal(spawned.length, 0, "the leaf waits for roster resolution");
  broker.observe(parent, update("call_a"), effective);
  await settle();
  assert.equal(spawned.length, 1, "duplicate updates never duplicate a child");
  const o = spawned[0]!;
  assert.deepEqual(o.delegation, { parentRunId: parent.id, delegateToolCallId: "call_a" });
  assert.equal(o.persona.name, "scout");
  assert.equal(o.task, "inspect the parser");
  assert.equal(o.cwd, effective, "the leaf works in the parent's effective cwd");
  assert.equal(o.runtime, "subprocess");
  assert.equal(o.mode, "background");
  assert.equal(o.parentSessionId, "lead-session");
  for (const [k, v] of Object.entries({ worktree: false, mergeStrategy: "none", onCompleteHook: "", inheritContextOverride: "none", retryMaxAttempts: 1, steerable: false })) {
    assert.equal((o as never)[k], v, k);
  }
  for (const k of ["onChain", "onRetry", "effort", "touches", "files", "parentMessages"] as const) assert.equal(o[k], undefined, k);
  assert.ok(o.timeoutMs <= 7 * 60_000 && o.timeoutMs > 6 * 60_000, `persona timeout binds: ${o.timeoutMs}`);

  const [leaf] = leavesOf(registry, parent);
  await finishLeaf(registry, leaf!, "Scout found the parser bug.");
  const r = await response(parent, "call_a");
  assert.equal(r.v, 1); assert.equal(r.ok, true); assert.equal(r.toolCallId, "call_a"); assert.equal(r.parentRunId, parent.id);
  assert.equal(r.agentId, leaf!.id); assert.equal(r.status, "completed");
  assert.match(r.envelope, /<sub-agent-completed>[\s\S]*Scout found the parser bug\.[\s\S]*<\/sub-agent-completed>/);
  assert.match(r.envelope, new RegExp(`<result-ref>run:${leaf!.id}</result-ref>`));
  assert.equal(parent.pendingDelegations, 0);
  broker.observe(parent, end("call_a"), effective);
  assert.equal(leaf!.status, "completed", "an end after the response cancels nothing");
});

test("N2 nested and malformed call ids never reach the broker's effects", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("outer/1", ask("scout"), { parentToolCallId: "outer" }), cwd);
  broker.observe(parent, update("outer/1", { parentToolCallId: "outer" }), cwd);
  broker.observe(parent, start("nested", ask("scout"), { parentToolCallId: "outer" }), cwd);
  broker.observe(parent, update("nested", { parentToolCallId: "outer" }), cwd);
  broker.observe(parent, start("x".repeat(129), ask("scout")), cwd);
  broker.observe(parent, update("x".repeat(129)), cwd);
  await settle();
  assert.equal(spawned.length, 0);
  assert.equal(existsSync(delegatePaths(dirname(parent.recordPath), "nested").claim), false);
});

test("N2 an end during asynchronous resolution cancels before any queue or spawn effect", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("racy", ask("scout")), cwd);
  broker.observe(parent, update("racy"), cwd);
  broker.observe(parent, end("racy", true), cwd);
  const r = await response(parent, "racy");
  await settle();
  assert.equal(r.ok, false);
  assert.match(r.reason, /^cancelled: /);
  assert.equal(spawned.length, 0);
  assert.equal(registry.list().length, 1, "no leaf or placeholder was registered");
  assert.equal(parent.pendingDelegations, 0);
});

// ── Rejections ───────────────────────────────────────────────────────

test("N2 rejected requests write one definite response and never queue or spawn", async () => {
  const cwd = project({ "builder.md": doc("builder", "read_only: true\n") });
  const effective = tmpDir("n2-files-");
  writeFileSync(join(effective, "notes.md"), "effective cwd evidence");
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd, { delegateAllow: ["scout", "auditor", "writer", "builder", "ghost"] });
  const foreign = parentRun(registry, cwd, { id: undefined as never });
  const cases: [string, unknown, RegExp][] = [
    ["disallowed", ask("inspector"), /inspector is not in this run's delegation allowlist/],
    ["ghost", ask("ghost"), /persona ghost is not available/],
    ["writer", ask("writer"), /writer is not read_only/],
    ["builder", ask("builder"), /builder is write-capable/],
    ["missing_file", ask("scout", "t", { files: ["absent.md"] }), /files: absent\.md/],
    ["foreign_ref", ask("scout", "t", { files: [`run:${foreign.id}`] }), /not a delegate child of this run/],
    ["blank", ask("scout", " "), /non-whitespace/],
  ];
  for (const [id, args] of cases) { broker.observe(parent, start(id, args), effective); broker.observe(parent, update(id), effective); }
  for (const [id, , expected] of cases) {
    const r = await response(parent, id);
    assert.equal(r.ok, false, id);
    assert.match(r.reason, expected, id);
  }
  await settle();
  assert.equal(spawned.length, 0);
  assert.equal(leavesOf(registry, parent).length, 0);
  assert.equal(parent.pendingDelegations, 0);
});

test("N2 A5 files resolve against the parent's effective cwd and run refs name only its own children", async () => {
  const cwd = project();
  const effective = tmpDir("n2-files-");
  writeFileSync(join(effective, "notes.md"), "effective cwd evidence");
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("first", ask("scout")), effective);
  broker.observe(parent, update("first"), effective);
  await settle();
  const [child] = leavesOf(registry, parent);
  await finishLeaf(registry, child!, "First leaf result body.");
  await response(parent, "first");
  broker.observe(parent, start("second", ask("auditor", "review", { files: ["notes.md", `run:${child!.id}`] })), effective);
  broker.observe(parent, update("second"), effective);
  await settle();
  assert.equal(spawned.length, 2);
  const task = spawned[1]!.task;
  assert.match(task, /effective cwd evidence/);
  assert.match(task, /First leaf result body\./);
  assert.equal(spawned[1]!.files, undefined, "evidence is a snapshot taken before spawn, not a second read");
});

test("N2 a target that resolves to herdr is refused by name, never silently run on subprocess", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness({ env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/n2-no-socket", HERDR_PANE_ID: "pane" } });
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("to_herdr", ask("scout")), cwd);
  broker.observe(parent, update("to_herdr"), cwd);
  const r = await response(parent, "to_herdr");
  assert.equal(r.ok, false);
  assert.match(r.reason, /scout resolves to the herdr runtime; delegated leaves run on subprocess only until N5/);
  assert.equal(spawned.length, 0);
});

test("N2 a delegating persona that resolves to herdr is refused at spawn and at enqueue with a named reason", () => {
  const registry = new RunRegistry();
  const lead: Persona = { name: "lead", description: "probe", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1,
    systemPrompt: "You are lead.", source: "project", sourcePath: "/fake/lead.md", readOnly: false, agents: ["scout"] };
  const env = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/n2-no-socket", HERDR_PANE_ID: "pane" };
  const opts = { registry, persona: lead, task: "t", cwd: tmpDir("n2-herdr-"), mode: "background" as const, timeoutMs: 1000, runtimeEnv: env };
  assert.throws(() => spawnRun(opts), /delegating persona lead resolves to the herdr runtime; delegation supports subprocess parents only until N5/);
  assert.throws(() => new SpawnQueue(registry, 1).enqueueOrSpawn(opts), /subprocess parents only until N5/);
  assert.equal(registry.list().length, 0);
});

test("N2 a pre-existing claim is never re-spawned; the call gets a truthful uncertain answer", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd);
  publishJson(claimPath(parent, "claimed"), { v: 1, toolCallId: "claimed", parentRunId: parent.id }, () => {});
  broker.observe(parent, start("claimed", ask("scout")), cwd);
  broker.observe(parent, update("claimed"), cwd);
  const r = await response(parent, "claimed");
  await settle();
  assert.equal(r.ok, false);
  assert.match(r.reason, /already claimed.*outcome uncertain; not replayed/);
  assert.equal(spawned.length, 0);
});

test("N2 a response file that already exists is never overwritten; the call still settles once", async () => {
  const cwd = project();
  const { registry, broker } = harness();
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("taken", ask("scout")), cwd);
  broker.observe(parent, update("taken"), cwd);
  await settle();
  const foreign = JSON.stringify({ v: 1, toolCallId: "taken", parentRunId: "someone-else", ok: false, reason: "foreign" });
  writeFileSync(responsePath(parent, "taken"), foreign);
  const [leaf] = leavesOf(registry, parent);
  await finishLeaf(registry, leaf!, "late leaf answer");
  await settle();
  assert.equal(readFileSync(responsePath(parent, "taken"), "utf8"), foreign, "create-only: link EEXIST skips");
  assert.equal(parent.pendingDelegations, 0);
});

test("N2 at most 8 calls are outstanding per parent; the ninth is rejected without a spawn", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness({ maxConcurrent: 20 });
  const parent = parentRun(registry, cwd);
  for (let i = 0; i < 9; i++) { broker.observe(parent, start(`c${i}`, ask("scout", `t${i}`)), cwd); broker.observe(parent, update(`c${i}`), cwd); }
  const r = await response(parent, "c8");
  await settle();
  assert.equal(r.ok, false);
  assert.match(r.reason, /already has 8 delegate calls outstanding/);
  assert.equal(spawned.length, 8);
  assert.equal(parent.pendingDelegations, 8);
});

// ── Cancel, timeout ──────────────────────────────────────────────────

test("N2 an end while queued removes only that placeholder; while running kills only that leaf; siblings continue", async () => {
  const cwd = project();
  const { registry, spawned, broker, queue } = harness({ maxConcurrent: 1 });
  const parent = parentRun(registry, cwd);
  for (const id of ["run_one", "run_two", "queued_three"]) { broker.observe(parent, start(id, ask("scout", id)), cwd); broker.observe(parent, update(id), cwd); }
  await settle();
  assert.equal(spawned.length, 1, "the awaiting parent's lent slot (N3) runs one leaf at a cap of 1");
  assert.equal(queue.size(), 2);
  const placeholder = registry.list().find((r) => r.delegateToolCallId === "queued_three")!;
  assert.equal(placeholder.status, "queued");
  assert.deepEqual([placeholder.depth, placeholder.parentRunId, placeholder.delegateAllow], [2, parent.id, []], "the queued placeholder carries lineage");
  broker.observe(parent, end("queued_three", true), cwd);
  const q = await response(parent, "queued_three");
  assert.match(q.reason, /^cancelled: /);
  assert.equal(placeholder.status, "killed");
  assert.equal(queue.size(), 1);
  const running = leavesOf(registry, parent).find((r) => r.delegateToolCallId === "run_one")!;
  broker.observe(parent, end("run_one", true), cwd);
  const c = await response(parent, "run_one");
  assert.match(c.reason, /^cancelled: /);
  assert.equal(running.status, "killed");
  await settle();
  const two = leavesOf(registry, parent).find((r) => r.delegateToolCallId === "run_two")!;
  assert.equal(two.status, "running", "the sibling was drained into the freed slot and keeps running");
  assert.equal(existsSync(responsePath(parent, "run_two")), false);
});

test("N2 the parent going terminal cancels its outstanding calls", async () => {
  const cwd = project();
  const { registry, broker } = harness();
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("orphan", ask("scout")), cwd);
  broker.observe(parent, update("orphan"), cwd);
  await settle();
  const [leaf] = leavesOf(registry, parent);
  parent.status = "killed";
  registry.notify(parent);
  const r = await response(parent, "orphan");
  assert.match(r.reason, /^cancelled: parent .* ended \(killed\)/);
  assert.equal(leaf!.status, "killed");
  assert.equal(parent.pendingDelegations, 0);
});

test("N2 a leaf still queued at its clamped deadline is removed and answered with a timeout", async () => {
  const cwd = project();
  const { registry, broker } = harness({ maxConcurrent: 1 });
  const parent = parentRun(registry, cwd, { deadlineAt: Date.now() + 250 });
  parentRun(registry, cwd, { delegateAllow: [] }); // executing work that fills the cap the parent's loan (N3) would offer
  broker.observe(parent, start("starved", ask("scout")), cwd);
  broker.observe(parent, update("starved"), cwd);
  await settle();
  const placeholder = registry.list().find((r) => r.delegateToolCallId === "starved")!;
  assert.equal(placeholder.status, "queued");
  const r = await response(parent, "starved");
  assert.equal(r.ok, false);
  assert.match(r.reason, /timeout: .* did not start before its deadline/);
  assert.equal(placeholder.status, "killed");
});

test("N2 a leaf killed by the lead (no onComplete) still answers its call with its terminal envelope", async () => {
  const cwd = project();
  const { registry, broker } = harness();
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("tool_kill", ask("scout")), cwd);
  broker.observe(parent, update("tool_kill"), cwd);
  await settle();
  const [leaf] = leavesOf(registry, parent);
  const { forceTerminate } = await import("../src/runs.ts");
  forceTerminate(leaf!, "killed", registry);
  const r = await response(parent, "tool_kill");
  assert.equal(r.ok, true);
  assert.equal(r.status, "killed");
  assert.match(r.envelope, /<status>killed<\/status>/);
});

// ── Envelope ─────────────────────────────────────────────────────────

test("N2 envelope: canonical under the cap; oversize falls back to the compact form with a valid ref and path", async () => {
  const dir = join(runsRoot(), "scout-env1");
  mkdirSync(dir, { recursive: true });
  const leaf: Run = { id: "scout-env1", runtime: "subprocess", persona: "scout", task: "t", cwd: dir, mode: "background", status: "completed", startTime: 1, lastEventAt: 1, finishedAt: 2,
    messages: [{ role: "assistant", content: [{ type: "text", text: "short answer" }] } as never], usage: emptyUsage(),
    recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"), depth: 2, delegateAllow: [] };
  await writeFinal(leaf);
  assert.equal(formatDelegateEnvelope(leaf, 4096), formatCompletionNotification(leaf, []));
  leaf.messages = [{ role: "assistant", content: [{ type: "text", text: "long answer ".repeat(1000) }] } as never];
  await writeFinal(leaf);
  const capped = formatDelegateEnvelope(leaf, 1024);
  assert.ok(Buffer.byteLength(capped) <= 1024, `${Buffer.byteLength(capped)} bytes`);
  assert.match(capped, /<result-ref>run:scout-env1<\/result-ref>/);
  assert.match(capped, /<result-summary>long answer/);
  assert.ok(capped.includes(`<result-omitted bytes="${Buffer.byteLength("long answer ".repeat(1000).trim())}" path="${leaf.finalPath}"`), capped);
  assert.match(capped, /<\/sub-agent-completed>/);
  assert.doesNotMatch(capped, /<result>/, "never a cut <result> presented as the whole answer");
  leaf.errorMessage = "e".repeat(4000);
  const minimal = formatDelegateEnvelope(leaf, 1024);
  assert.ok(Buffer.byteLength(minimal) <= 1024);
  assert.match(minimal, /<agent-id>scout-env1<\/agent-id>[\s\S]*<status>completed<\/status>[\s\S]*<result-ref>run:scout-env1<\/result-ref>/);
});

// ── Reload fallback (R6) ─────────────────────────────────────────────

test("N2 reload: pending subprocess parents are killed leaves-first with the R6 diagnostic; others keep running; later calls get a definite rejection", async () => {
  const cwd = project();
  const { registry, broker } = harness();
  const pending = parentRun(registry, cwd);
  const idle = parentRun(registry, cwd);
  broker.observe(pending, start("inflight", ask("scout")), cwd);
  broker.observe(pending, update("inflight"), cwd);
  await settle();
  const [leaf] = leavesOf(registry, pending);
  const order: string[] = [];
  registry.onChange((r) => { if (r.status === "killed") order.push(r.id); });
  await handleSessionShutdown({ reason: "reload" }, { runs: registry.list(), resetSanitizer: () => assert.fail("reload reset"), delegation: broker });
  assert.deepEqual(order, [leaf!.id, pending.id], "leaves first, then the parent");
  assert.equal(pending.errorMessage, RELOAD_INTERRUPTED);
  assert.equal(RELOAD_INTERRUPTED, "lead /reload interrupted subprocess delegation; resume with ensemble_send");
  assert.equal(JSON.parse(readFileSync(pending.recordPath, "utf8")).errorMessage, RELOAD_INTERRUPTED, "records were awaited before shutdown returned");
  assert.equal(JSON.parse(readFileSync(leaf!.recordPath, "utf8")).status, "killed");
  const r = await response(pending, "inflight");
  assert.match(r.reason, /^cancelled: /);
  assert.equal(idle.status, "running", "a parent without pending delegation keeps the ordinary reload preservation");
  broker.observe(idle, start("after_reload", ask("scout")), cwd);
  broker.observe(idle, update("after_reload"), cwd);
  const late = await response(idle, "after_reload");
  assert.equal(late.ok, false);
  assert.match(late.reason, /lead \/reload closed this run's delegation broker/);
  assert.equal(leavesOf(registry, idle).length, 0);
});

// ── Pipeline wiring ──────────────────────────────────────────────────

test("N2 only a subprocess delegator's parsed stream reaches the broker, with the pipeline's cwd, on spawn, queue drain and resume", { timeout: 20000 }, async () => {
  const stub = join(dirname(piBin), "n2-events.mjs");
  writeFileSync(stub, 'const e = (x) => process.stdout.write(JSON.stringify(x) + "\\n");\n' +
    'e({ type: "tool_execution_start", toolCallId: "wired", toolName: "delegate", args: {} });\ne({ type: "agent_end", messages: [] });\nprocess.exit(0);\n');
  const saved = process.env.PI_BIN; process.env.PI_BIN = stub;
  try {
    const registry = new RunRegistry();
    const seen: [string, string, string][] = [];
    registry.delegation = { observe: (run, event, cwd) => seen.push([run.id, (event as { type: string }).type, cwd]), close: async () => {} };
    const persona = (over: Partial<Persona>): Persona => ({ name: "lead", description: "probe", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1,
      systemPrompt: "You are lead.", source: "project", sourcePath: "/fake/lead.md", readOnly: false, ...over });
    const cwd = tmpDir("n2-wire-");
    const lead = spawnRun({ registry, persona: persona({ agents: ["scout"] }), task: "t", cwd, mode: "background", timeoutMs: 5000, runtimeEnv: {} });
    const plain = spawnRun({ registry, persona: persona({ name: "plain" }), task: "t", cwd, mode: "background", timeoutMs: 5000, runtimeEnv: {} });
    await Promise.all([lead.done, plain.done]);
    assert.ok(seen.some(([id, type, at]) => id === lead.run.id && type === "tool_execution_start" && at === cwd), JSON.stringify(seen));
    assert.equal(seen.filter(([id]) => id === plain.run.id).length, 0, "a non-delegator's stream is never brokered");
    assert.notEqual(lead.run.deadlineAt, undefined, "the armed hard timer stamps its due time");

    const queue = new SpawnQueue(registry, 1, 1);
    const blocker = spawnRun({ registry, persona: persona({ name: "plain" }), task: "t", cwd, mode: "background", timeoutMs: 5000, runtimeEnv: {} });
    const queued = queue.enqueueOrSpawn({ persona: persona({ agents: ["scout"] }), task: "t", cwd, mode: "background", timeoutMs: 5000, runtimeEnv: {} });
    assert.equal(queued.kind, "queued");
    await blocker.done;
    await until(() => seen.some(([id]) => id === (queued as { pending: { id: string } }).pending.id), "the drained delegator's stream");

    lead.run.sessionPath = join(dirname(lead.run.recordPath), "session", "s.jsonl");
    mkdirSync(dirname(lead.run.sessionPath), { recursive: true });
    writeFileSync(lead.run.sessionPath, JSON.stringify({ type: "session", cwd }) + "\n");
    const before = seen.filter(([id]) => id === lead.run.id).length;
    const resumed = sendToRun(lead.run, "continue", { registry, timeoutMs: 5000 });
    assert.equal(resumed.kind, "started", resumed.kind === "rejected" ? resumed.reason : "");
    await (resumed as { done: Promise<Run> }).done;
    assert.ok(seen.filter(([id]) => id === lead.run.id).length > before, "a resumed delegator is brokered again");
  } finally { if (saved === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = saved; }
});

test("N2 a leaf spawn is depth 2 with lineage and read-only argv whatever the caller passes", { timeout: 20000 }, async () => {
  const stub = join(dirname(piBin), "n2-argv.mjs");
  writeFileSync(stub, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.CONDUCTOR_RUN_DIR + "/launch.json", JSON.stringify({ argv: process.argv.slice(2), env: process.env, cwd: process.cwd() }));\nprocess.exit(0);\n');
  const saved = process.env.PI_BIN; process.env.PI_BIN = stub;
  try {
    const registry = new RunRegistry();
    const cwd = project();
    const scout: Persona = { name: "scout", description: "probe", inheritContext: "full", inheritSkills: false, defaultReads: [], worktree: true, timeoutMinutes: 1,
      systemPrompt: "You are scout.", source: "project", sourcePath: "/fake/scout.md", readOnly: true, agents: ["auditor"], tools: ["read", "edit", "delegate", "ask_owner"], onCompleteHook: "touch HOOKED" };
    let chained = 0, retried = 0;
    const { run, done } = spawnRun({ registry, persona: scout, task: "leaf task", cwd, mode: "foreground", timeoutMs: 5000, runtimeEnv: {},
      delegation: { parentRunId: "lead-x", delegateToolCallId: "call_x" }, worktree: true, mergeStrategy: "squash", onCompleteHook: "touch HOOKED2",
      onChain: () => chained++, onRetry: () => retried++, retryMaxAttempts: 5, inheritContextOverride: "full", steerable: true,
      parentMessages: [{ role: "user", content: "parent context", timestamp: 0 }] });
    await done;
    const launch = JSON.parse(readFileSync(join(dirname(run.recordPath), "launch.json"), "utf8"));
    const flag = (name: string) => launch.argv[launch.argv.indexOf(name) + 1] as string;
    const excluded = flag("--exclude-tools").split(",");
    for (const name of ["ask_owner", "delegate", "edit", "write", "insert_before", "insert_after", "subagent", "agent", "ensemble_spawn"]) assert.ok(excluded.includes(name), name);
    // A persona's own list may name them; Pi applies --exclude-tools after --tools, so they stay off.
    for (const name of flag("--tools").split(",")) assert.ok(name === "read" || excluded.includes(name), `${name} is excluded at depth 2`);
    assert.equal(launch.argv.includes("--session"), false, "no inherited context");
    assert.equal(launch.argv[1], "json", "never steerable");
    assert.equal(launch.env.CONDUCTOR_DEPTH, "2");
    assert.equal(launch.env.CONDUCTOR_DELEGATE_ALLOW, undefined);
    assert.equal(launch.cwd, cwd, "no worktree");
    const record = JSON.parse(readFileSync(run.recordPath, "utf8"));
    assert.deepEqual([record.depth, record.delegateAllow, record.parentRunId, record.delegateToolCallId], [2, [], "lead-x", "call_x"]);
    assert.equal(run.mode, "background");
    assert.equal(run.worktreePath, undefined);
    assert.equal(existsSync(join(cwd, "HOOKED")) || existsSync(join(cwd, "HOOKED2")), false, "no hook");
    assert.equal(chained + retried, 0, "no chain or retry");
    assert.equal(run.retryPolicy?.maxAttempts, 1);
    assert.throws(() => spawnRun({ registry, persona: { ...scout, readOnly: false }, task: "t", cwd, mode: "background", timeoutMs: 1000, runtimeEnv: {}, delegation: { parentRunId: "lead-x", delegateToolCallId: "call_y" } }),
      /delegated leaves must be read_only/);
  } finally { if (saved === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = saved; }
});

// ── Review corrections (B1, B2, M1–M4) ───────────────────────────────

test("N2 reload boundary: a start before /reload and its first update after are claimed and definitely rejected, never launched or dropped", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("straddle", ask("scout")), cwd);
  await handleSessionShutdown({ reason: "reload" }, { runs: registry.list(), resetSanitizer: () => assert.fail("reload reset"), delegation: broker });
  assert.equal(parent.status, "running", "a parent with nothing outstanding at reload keeps running");
  assert.equal(parent.errorMessage, undefined);
  broker.observe(parent, update("straddle"), cwd);
  assert.ok(existsSync(claimPath(parent, "straddle")), "the post-reload update is claimed, not dropped");
  const r = JSON.parse(readFileSync(responsePath(parent, "straddle"), "utf8"));
  assert.deepEqual([r.ok, r.toolCallId, r.parentRunId], [false, "straddle", parent.id]);
  assert.match(r.reason, /lead \/reload closed this run's delegation broker/);
  await settle();
  assert.equal(spawned.length, 0, "no leaf after reload");
  assert.equal(leavesOf(registry, parent).length, 0);
  assert.equal(parent.pendingDelegations, 0);
});

test("N2 a terminal parent's unfinished starts are dropped: a later update for that call claims nothing", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("stale", ask("scout")), cwd);
  parent.status = "failed";
  registry.notify(parent);
  parent.status = "running"; // as a resume would
  broker.observe(parent, update("stale"), cwd);
  await settle();
  assert.equal(existsSync(claimPath(parent, "stale")), false);
  assert.equal(spawned.length, 0);
});

test("N2 leaves launch with the target's configured model and thinking (frontmatter or override); unset inherits as a normal spawn", { timeout: 20000 }, async () => {
  const stub = join(dirname(piBin), "n2-model-argv.mjs");
  writeFileSync(stub, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.CONDUCTOR_RUN_DIR + "/launch.json", JSON.stringify({ argv: process.argv.slice(2) }));\nprocess.exit(0);\n');
  const saved = process.env.PI_BIN; process.env.PI_BIN = stub;
  try {
    const cwd = project({
      "modeled.md": doc("modeled", "read_only: true\nmodel: prov-a/model-front\nthinking: low\n"),
      "overridden.md": doc("overridden", "read_only: true\nmodel: prov-a/ignored\nthinking: low\n"),
      "plain.md": doc("plain", "read_only: true\n"),
    });
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "conductor.json"), JSON.stringify({ personaOverrides: { overridden: { model: "prov-b/model-override", thinking: "high" } } }));
    const registry = new RunRegistry();
    const queue = new SpawnQueue(registry, 8, 1);
    const broker = new DelegationBroker({ registry, queue, env: {} });
    registry.delegation = broker;
    // The parent's own model must never leak into a leaf.
    const parent = parentRun(registry, cwd, { delegateAllow: ["modeled", "overridden", "plain"], model: "prov-lead/lead-model", thinking: "xhigh" });
    for (const name of ["modeled", "overridden", "plain"]) { broker.observe(parent, start(`m_${name}`, ask(name)), cwd); broker.observe(parent, update(`m_${name}`), cwd); }
    for (const name of ["modeled", "overridden", "plain"]) assert.equal((await response(parent, `m_${name}`)).ok, true, name);
    const argv = (name: string) => {
      const leaf = leavesOf(registry, parent).find((r) => r.delegateToolCallId === `m_${name}`)!;
      const args: string[] = JSON.parse(readFileSync(join(dirname(leaf.recordPath), "launch.json"), "utf8")).argv;
      const flag = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
      return { model: flag("--model"), thinking: flag("--thinking") };
    };
    assert.deepEqual(argv("modeled"), { model: "prov-a/model-front", thinking: "low" }, "frontmatter model and thinking reach the leaf argv");
    assert.deepEqual(argv("overridden"), { model: "prov-b/model-override", thinking: "high" }, "personaOverrides win, as for ensemble_spawn");
    assert.deepEqual(argv("plain"), { model: undefined, thinking: undefined }, "unset keeps pi's inherited default, never the parent's model");
  } finally { if (saved === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = saved; }
});

test("N2 a delegator's child env carries its provisional deadline at launch, and a resume replaces it", { timeout: 20000 }, async () => {
  const stub = join(dirname(piBin), "n2-deadline-env.mjs");
  writeFileSync(stub, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.env.CONDUCTOR_RUN_DIR + "/launch.json", JSON.stringify({ deadline: process.env.CONDUCTOR_DEADLINE_AT ?? null }));\nprocess.exit(0);\n');
  const saved = process.env.PI_BIN; process.env.PI_BIN = stub;
  try {
    const registry = new RunRegistry();
    const cwd = tmpDir("n2-deadline-");
    const lead: Persona = { name: "lead", description: "probe", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1,
      systemPrompt: "You are lead.", source: "project", sourcePath: "/fake/lead.md", readOnly: false, agents: ["scout"] };
    const deadline = (run: Run) => JSON.parse(readFileSync(join(dirname(run.recordPath), "launch.json"), "utf8")).deadline as string | null;
    const before = Date.now();
    const { run, done } = spawnRun({ registry, persona: lead, task: "t", cwd, mode: "background", timeoutMs: 600_000, runtimeEnv: {} });
    const after = Date.now();
    await done;
    const first = deadline(run);
    assert.ok(first !== null, "the first launch carries the parent's deadline, not nothing");
    assert.ok(Number(first) >= before + 600_000 && Number(first) <= after + 600_000, `first deadline ${first}`);
    run.sessionPath = join(dirname(run.recordPath), "session", "s.jsonl");
    mkdirSync(dirname(run.sessionPath), { recursive: true });
    writeFileSync(run.sessionPath, JSON.stringify({ type: "session", cwd }) + "\n");
    const resumedAt = Date.now();
    const resumed = sendToRun(run, "continue", { registry, timeoutMs: 5_000 });
    assert.equal(resumed.kind, "started", resumed.kind === "rejected" ? resumed.reason : "");
    await (resumed as { done: Promise<Run> }).done;
    const second = Number(deadline(run));
    assert.ok(second >= resumedAt + 5_000 && second <= Date.now() + 5_000, `a resume carries its own deadline, not the stale ${first}: ${second}`);
  } finally { if (saved === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = saved; }
});

test("N2 a parent replaced in the registry while the roster resolves is rejected and never spawns", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd);
  broker.observe(parent, start("replaced", ask("scout")), cwd);
  broker.observe(parent, update("replaced"), cwd);
  registry.register({ ...parent, pendingDelegations: 0 }); // another owner now holds this id
  await settle();
  assert.equal(spawned.length, 0, "a parent that is no longer the current registered run must never spawn a leaf");
  const r = await response(parent, "replaced");
  assert.equal(r.ok, false);
  assert.match(r.reason, /not the current registered run/);
});

test("N2 the 64 KiB task limit counts UTF-8 bytes: 65536 spawns, 65537 is rejected", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness();
  const parent = parentRun(registry, cwd);
  const exact = "é".repeat(32768), over = `${exact}a`;
  assert.deepEqual([Buffer.byteLength(exact), Buffer.byteLength(over), over.length], [65536, 65537, 32769]);
  broker.observe(parent, start("exact", ask("scout", exact)), cwd); broker.observe(parent, update("exact"), cwd);
  broker.observe(parent, start("over", ask("scout", over)), cwd); broker.observe(parent, update("over"), cwd);
  await settle();
  assert.deepEqual(spawned.map((o) => Buffer.byteLength(o.task)), [65536], "a 65537-byte task must never spawn, however few UTF-16 units it has");
  const r = await response(parent, "over");
  assert.equal(r.ok, false);
  assert.match(r.reason, /task exceeds 65536 bytes/);
});

test("N2 a run: ref to another parent's leaf is rejected and never spawns", async () => {
  const cwd = project();
  const { registry, spawned, broker } = harness();
  const one = parentRun(registry, cwd), two = parentRun(registry, cwd);
  broker.observe(one, start("own", ask("scout")), cwd); broker.observe(one, update("own"), cwd);
  await settle();
  const [leaf] = leavesOf(registry, one);
  await finishLeaf(registry, leaf!, "Parent one's private leaf result.");
  await response(one, "own");
  broker.observe(two, start("borrow", ask("auditor", "review", { files: [`run:${leaf!.id}`] })), cwd);
  broker.observe(two, update("borrow"), cwd);
  await settle();
  assert.equal(spawned.length, 1, "a ref to another parent's leaf must never reach a spawned task");
  const r = await response(two, "borrow");
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`files: run:${leaf!.id} is not a delegate child of this run`));
});

// ── Child tool ───────────────────────────────────────────────────────

function childTool(env: NodeJS.ProcessEnv) {
  let tool: any;
  registerDelegate({ registerTool: (t: any) => { tool = t; } } as never, env);
  return tool;
}
function childEnv(over: NodeJS.ProcessEnv = {}) {
  const id = `lead-c${++seq}`, dir = join(runsRoot(), id);
  mkdirSync(dir, { recursive: true });
  return { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "1", CONDUCTOR_DELEGATE_ALLOW: "scout,auditor", CONDUCTOR_RUN_ID: id, CONDUCTOR_RUN_DIR: dir,
    CONDUCTOR_CONFIG_CWD: project(), CONDUCTOR_DEADLINE_AT: String(Date.now() + 60_000), ...over };
}
const ctx = { isIdle: () => false, cwd: tmpDir("n2-ctx-") };

test("N2 child tool registers only for a validated depth-1 delegator env", () => {
  assert.equal(childTool(childEnv())?.name, "delegate");
  for (const over of [{ CONDUCTOR_DEPTH: "2" }, { CONDUCTOR_DEPTH: undefined }, { CONDUCTOR_DELEGATE_ALLOW: "" }, { CONDUCTOR_DELEGATE_ALLOW: "a b" },
    { CONDUCTOR_DELEGATE_ALLOW: "a,a" }, { CONDUCTOR_DELEGATE_ALLOW: "a,b,c,d,e,f,g,h,i" }, { CONDUCTOR_RUN_DIR: undefined }, { CONDUCTOR_RUN_ID: undefined }, { CONDUCTOR_SUBAGENT: undefined }]) {
    assert.equal(childTool(childEnv(over as NodeJS.ProcessEnv)), undefined, JSON.stringify(over));
  }
});

test("N2 child tool refuses nested ids and reused ids before its first update; no update means no spawn", async () => {
  const env = childEnv();
  const tool = childTool(env);
  let updates = 0;
  const onUpdate = () => { updates++; };
  await assert.rejects(tool.execute("outer/1", ask("scout"), undefined, onUpdate, ctx), /delegate rejected: .*nested calls cannot delegate/);
  publishJson(delegatePaths(env.CONDUCTOR_RUN_DIR!, "reused").claim, { v: 1 }, () => {});
  await assert.rejects(tool.execute("reused", ask("scout"), undefined, onUpdate, ctx), /already used in this run/);
  await assert.rejects(tool.execute("blank", ask("scout", " "), undefined, onUpdate, ctx), /delegate rejected: task must contain non-whitespace text/);
  assert.equal(updates, 0);
});

test("N2 child tool emits one execution-proof update, then returns the broker's envelope", async () => {
  const env = childEnv();
  const tool = childTool(env);
  const updates: unknown[] = [];
  const pending = tool.execute("good_call", ask("scout"), undefined, (u: unknown) => updates.push(u), ctx);
  await until(() => updates.length === 1, "first update");
  publishJson(delegatePaths(env.CONDUCTOR_RUN_DIR!, "good_call").response,
    { v: 1, toolCallId: "good_call", parentRunId: env.CONDUCTOR_RUN_ID, ok: true, agentId: "scout-1", status: "completed", envelope: "<sub-agent-completed>leaf</sub-agent-completed>" }, () => {});
  const result = await pending;
  assert.equal(result.content[0].text, "<sub-agent-completed>leaf</sub-agent-completed>");
  assert.deepEqual(result.details, { agentId: "scout-1", status: "completed" });
  assert.equal(updates.length, 1);
});

test("N2 child tool maps rejections and cancellations, and never trusts a foreign or malformed response", async () => {
  const env = childEnv();
  const tool = childTool(env);
  const publish = (id: string, value: unknown) => publishJson(delegatePaths(env.CONDUCTOR_RUN_DIR!, id).response, value, () => {});
  const run = async (id: string, value: unknown) => {
    let ready = false;
    const p = tool.execute(id, ask("scout"), undefined, () => { ready = true; }, ctx);
    await until(() => ready, id);
    publish(id, value);
    return p;
  };
  await assert.rejects(run("r1", { v: 1, toolCallId: "r1", parentRunId: env.CONDUCTOR_RUN_ID, ok: false, reason: "persona x is not in this run's delegation allowlist" }), /^Error: delegate rejected: persona x/);
  await assert.rejects(run("r2", { v: 1, toolCallId: "r2", parentRunId: env.CONDUCTOR_RUN_ID, ok: false, reason: "cancelled: parent ended" }), /^Error: delegate cancelled: parent ended/);
  await assert.rejects(run("r3", { v: 1, toolCallId: "r3", parentRunId: "another-run", ok: true, envelope: "forged" }), /malformed or foreign broker response/);
  await assert.rejects(run("r4", { v: 2, toolCallId: "r4", parentRunId: env.CONDUCTOR_RUN_ID, ok: true, envelope: "x" }), /malformed or foreign broker response/);
});

test("N2 child wait: abort and timeout reject and release the watcher, poll and timers", async () => {
  const dir = tmpDir("n2-wait-");
  const path = join(dir, "x.json");
  const handles = () => process.getActiveResourcesInfo().filter((r) => r === "FSEventWrap" || r === "Timeout").length;
  const before = handles();
  const controller = new AbortController();
  const aborted = waitForDelegateResponse(path, { toolCallId: "x", parentRunId: "p" }, Date.now() + 60_000, controller.signal);
  assert.ok(handles() > before, "the waiter holds a watcher and timers while pending");
  controller.abort();
  await assert.rejects(aborted, /delegate aborted/);
  await assert.rejects(waitForDelegateResponse(path, { toolCallId: "x", parentRunId: "p" }, Date.now() + 30), /delegate outcome unconfirmed: no broker response before the deadline; a leaf may have run/);
  await new Promise((r) => setImmediate(r));
  assert.equal(handles(), before, "nothing dangles after either outcome");
});
