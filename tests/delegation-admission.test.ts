/**
 * N3: two-lane admission. Lead-level (depth <= 1) work keeps A < maxConcurrent
 * with awaiting parents still counted; a depth-2 leaf of a current awaiting
 * delegator runs while executing work (A - W) < maxConcurrent. These drive the
 * production queue and broker with a fake spawner. "Executing" is measured
 * independently of the admission code: a slot holder is blocked only while one
 * of its delegate claims has no response file yet.
 */
import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { projectPersonasDir } from "../src/personas.ts";
import { RunRegistry, forceTerminate, runsRoot, spawnRun, writeFinal, type SpawnOptions } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { DelegationBroker } from "../src/delegation-broker.ts";
import { RELOAD_INTERRUPTED, delegatePaths } from "../src/delegation.ts";
import { consumesSlot } from "../src/effort/admit.ts";
import { openEffort } from "../src/effort/open.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { DEFAULT_WATCHDOG_CONFIG, Watchdog, classifyStall, evaluateRun } from "../src/watchdog.ts";
import { formatRow } from "../src/widget.ts";
import { registerTools } from "../src/tools.ts";
import { buildWatchdogStatusReport } from "../src/commands.ts";
import { emptyUsage, isTerminal, type Persona, type Run } from "../src/types.ts";

sandboxPi();

// ── Fixtures ─────────────────────────────────────────────────────────

const doc = (name: string, fm: string) => `---\nname: ${name}\ndescription: probe\n${fm}---\nYou are ${name}.\n`;
function project(): string {
  const cwd = tmpDir("n3-project-");
  mkdirSync(projectPersonasDir(cwd), { recursive: true });
  for (const [f, text] of Object.entries({ "lead.md": doc("lead", "agents:\n  - scout\n"), "scout.md": doc("scout", "read_only: true\n"), "plain.md": doc("plain", "") })) {
    writeFileSync(join(projectPersonasDir(cwd), f), text);
  }
  return cwd;
}
const persona = (name: string, over: Partial<Persona> = {}): Persona => ({ name, description: "probe", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false,
  timeoutMinutes: 10, systemPrompt: `You are ${name}.`, source: "project", sourcePath: `/fake/${name}.md`, readOnly: name === "scout", ...over });
const LEAD = persona("lead", { agents: ["scout"] }), PLAIN = persona("plain"), SCOUT = persona("scout");

const start = (id: string, args: unknown) => ({ type: "tool_execution_start", toolCallId: id, toolName: "delegate", args });
const update = (id: string) => ({ type: "tool_execution_update", toolCallId: id, toolName: "delegate", partialResult: { content: [] } });
const end = (id: string) => ({ type: "tool_execution_end", toolCallId: id, toolName: "delegate", result: { content: [] }, isError: true });

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Blocked only while a claimed delegate call has no response for the child to read. */
function blockedOnDelegate(run: Run): boolean {
  const dir = join(dirname(run.recordPath), "delegate");
  if (!existsSync(dir)) return false;
  const files = new Set(readdirSync(dir));
  return [...files].some((f) => f.endsWith(".claim.json") && !files.has(f.replace(/\.claim\.json$/, ".json")));
}

let seq = 0;
function harness(max: number, opts: { refuse?: (o: SpawnOptions) => boolean; observable?: boolean } = {}) {
  const registry = new RunRegistry();
  const cwd = project();
  const launches: string[] = [];
  const spy = (o: SpawnOptions) => {
    if (opts.refuse?.(o)) throw new Error("launch refused by test");
    const id = o.preAllocatedId ?? `${o.persona.name}-n3${++seq}`, dir = join(runsRoot(), id);
    mkdirSync(dir, { recursive: true });
    const leaf = o.delegation !== undefined;
    const run: Run = { id, runtime: "subprocess", persona: o.persona.name, task: o.task, cwd: o.cwd, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(),
      messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"),
      depth: leaf ? 2 : 1, delegateAllow: leaf ? [] : [...(o.persona.agents ?? [])], parentRunId: o.delegation?.parentRunId, delegateToolCallId: o.delegation?.delegateToolCallId,
      deadlineAt: Date.now() + o.timeoutMs, parentSessionId: "lead-session", ...(opts.observable ? { proc: { kill() {} } as never } : {}) };
    launches.push(id);
    o.registry.register(run);
    return { run, done: new Promise<Run>(() => {}) };
  };
  const queue = new SpawnQueue(registry, max, 1, spy);
  const broker = new DelegationBroker({ registry, queue, env: {} });
  registry.delegation = broker;

  const peak = { active: 0, executing: 0, lead: 0 };
  const sample = () => {
    const active = registry.list().filter(consumesSlot);
    peak.active = Math.max(peak.active, active.length);
    peak.executing = Math.max(peak.executing, active.filter((r) => !blockedOnDelegate(r)).length);
    peak.lead = Math.max(peak.lead, active.filter((r) => r.depth !== 2).length);
  };
  // Registered after the queue and broker, as production: it sees every state each notify leaves.
  registry.onChange(sample);

  const get = (id: string) => registry.get(id)!;
  const enqueue = (p: Persona = LEAD) => {
    const r = queue.enqueueOrSpawn({ persona: p, task: "t", cwd, mode: "background", timeoutMs: 600_000, runtimeEnv: {} });
    return r.kind === "spawned" ? r.run.id : r.placeholderRun.id;
  };
  const leaves = () => registry.list().filter((r) => r.depth === 2);
  const leaf = (callId: string) => leaves().find((r) => r.delegateToolCallId === callId);
  const responsePath = (parentId: string, callId: string) => delegatePaths(dirname(get(parentId).recordPath), callId).response;
  /** Start + first update: the claim, count and notify happen synchronously here. */
  const call = (parentId: string, callId: string, args: object = { persona: "scout", task: `look ${callId}` }) => {
    broker.observe(get(parentId), start(callId, args), cwd);
    broker.observe(get(parentId), update(callId), cwd);
  };
  /** A call is resolved once its leaf is registered or it was answered. */
  const resolved = (parentId: string, callId: string) => until(() => !!leaf(callId) || existsSync(responsePath(parentId, callId)), `call ${callId} resolved`);
  const response = async (parentId: string, callId: string) => {
    await until(() => existsSync(responsePath(parentId, callId)), `response ${callId}`);
    sample(); // a response is handed back without a registry notify
    return JSON.parse(readFileSync(responsePath(parentId, callId), "utf8"));
  };
  const finish = async (run: Run, status: Run["status"] = "completed") => {
    run.messages = [{ role: "assistant", content: [{ type: "text", text: `${run.id} ${status}` }] } as never];
    run.status = status;
    run.finishedAt = Date.now();
    await writeFinal(run);
    registry.notify(run);
  };
  return { registry, queue, broker, cwd, launches, peak, sample, get, enqueue, leaves, leaf, call, resolved, response, finish };
}

const theme = { fg: (_slot: string, s: string) => s, bold: (s: string) => s };
function statusTool(registry: RunRegistry, queue: SpawnQueue) {
  const tools = new Map<string, any>();
  registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
    getCwd: () => process.cwd(), getRegistry: () => registry, getQueue: () => queue, getModel: () => ({}) as never,
    getParentMessages: () => [], openFocusedOverlay: () => {}, pushCompletionNotification: () => {},
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
  });
  return () => tools.get("ensemble_status").execute("call", {}, undefined, undefined, { mode: "json", hasUI: false });
}

// ── Fan-out at the cap ───────────────────────────────────────────────

test("N3 four delegators at cap 4 fan out on lent slots: every leaf runs, executing work never exceeds 4 and slot holders never exceed 8", async () => {
  const h = harness(4);
  const parents = [h.enqueue(), h.enqueue(), h.enqueue(), h.enqueue()];
  assert.deepEqual(parents.map((id) => h.get(id).status), ["running", "running", "running", "running"]);
  for (const p of parents) for (const c of ["a", "b"]) h.call(p, `${p}_${c}`);
  for (const p of parents) for (const c of ["a", "b"]) await h.resolved(p, `${p}_${c}`);
  const running = h.leaves().filter((l) => l.status === "running"), queued = h.leaves().filter((l) => l.status === "queued");
  assert.equal(running.length, 4, "four awaiting parents lend four slots to leaves; N2 queues all eight behind them");
  assert.equal(queued.length, 4);
  for (const q of queued) assert.match(q.waitReason ?? "", /lent slot/);
  // A parent whose last leaf settles takes its own slot back; any other settlement frees one for a queued leaf.
  for (let i = 0; i < 8; i++) {
    const next = h.leaves().find((l) => l.status === "running");
    assert.ok(next, `a leaf is running while ${8 - i} remain (no deadlock)`);
    await h.finish(next);
  }
  for (const p of parents) for (const c of ["a", "b"]) assert.equal((await h.response(p, `${p}_${c}`)).ok, true);
  assert.deepEqual(h.peak, { active: 8, executing: 4, lead: 4 }, "A <= 2*max, A - W <= max, lead-level <= max");
});

test("N3 an earlier lead-level entry never takes a lent slot; it runs only when a real slot frees", async () => {
  const h = harness(2);
  const p1 = h.enqueue(), p2 = h.enqueue();
  const x = h.enqueue(PLAIN);
  assert.equal(h.get(x).status, "queued");
  h.call(p1, "p1_a"); await h.resolved(p1, "p1_a");
  h.call(p2, "p2_a"); await h.resolved(p2, "p2_a");
  assert.deepEqual([h.leaf("p1_a")!.status, h.leaf("p2_a")!.status], ["running", "running"], "both leaves run on lent slots");
  assert.equal(h.get(x).status, "queued", "the lead-level entry queued first still waits: awaiting parents keep counting for it");
  assert.match(h.get(x).waitReason ?? "", /maxConcurrent \(2\)/);
  await h.finish(h.leaf("p1_a")!); await h.finish(h.leaf("p2_a")!);
  await h.response(p1, "p1_a"); await h.response(p2, "p2_a");
  assert.equal(h.get(x).status, "queued", "resumed parents hold their own slots");
  forceTerminate(h.get(p1), "killed", h.registry);
  assert.equal(h.get(x).status, "running");
  assert.equal(h.peak.lead, 2, "lead-level slot holders never exceeded maxConcurrent");
  assert.equal(h.peak.executing, 2);
});

test("N3 drain offers capacity to depth-2 entries before earlier lead-level entries", async () => {
  const h = harness(2);
  const p1 = h.enqueue();
  h.enqueue(PLAIN);
  const x = h.enqueue(PLAIN);
  assert.equal(h.get(x).status, "queued");
  h.call(p1, "c1"); await h.resolved(p1, "c1");
  h.call(p1, "c2"); await h.resolved(p1, "c2");
  assert.deepEqual([h.leaf("c1")!.status, h.leaf("c2")!.status], ["running", "queued"]);
  h.queue.setMaxConcurrent(4);
  assert.equal(h.leaf("c2")!.status, "running", "the depth-2 entry is drained first");
  assert.equal(h.get(x).status, "queued", "the earlier lead-level entry waits for a real slot after the leaf took one");
  assert.ok(h.peak.executing <= 4 && h.peak.active <= 8);
});

test("N3 no lost wake-up: a claim's increment-then-notify drains queued leaves, and a settlement drains the next", async () => {
  const h = harness(2);
  const p1 = h.enqueue(), p2 = h.enqueue();
  h.call(p1, "c1"); await h.resolved(p1, "c1");
  h.call(p1, "c2"); await h.resolved(p1, "c2");
  assert.equal(h.leaf("c2")!.status, "queued");
  h.call(p2, "c3");
  assert.equal(h.leaf("c2")!.status, "running", "p2's claim lent its slot before its own leaf was even resolved");
  await h.resolved(p2, "c3");
  assert.equal(h.leaf("c3")!.status, "queued");
  await h.finish(h.leaf("c1")!);
  assert.equal(h.leaf("c3")!.status, "running", "the settlement's own notify drained the waiting leaf");
  assert.ok(h.peak.executing <= 2, `executing peaked at ${h.peak.executing}`);
});

// ── Lifecycle boundaries ─────────────────────────────────────────────

test("N3 a parent's last leaf settling lowers A and W together: nothing is admitted on credit the parent is about to take back", async () => {
  const h = harness(2);
  const p1 = h.enqueue(), p2 = h.enqueue();
  h.call(p1, "only"); await h.resolved(p1, "only");
  h.call(p2, "q_a"); await h.resolved(p2, "q_a");
  h.call(p2, "q_b"); await h.resolved(p2, "q_b");
  assert.deepEqual([h.leaf("only")!.status, h.leaf("q_a")!.status, h.leaf("q_b")!.status], ["running", "running", "queued"]);
  await h.finish(h.leaf("only")!);
  await h.response(p1, "only");
  assert.equal(h.leaf("q_b")!.status, "queued", "p1 resumes with its own slot; q_b must keep waiting");
  assert.ok(h.peak.executing <= 2, `executing peaked at ${h.peak.executing} > maxConcurrent 2`);
  await h.finish(h.leaf("q_a")!);
  assert.equal(h.leaf("q_b")!.status, "running");
});

for (const variant of ["ended during resolution", "rejected by validation"] as const) {
  test(`N3 a provisional claim ${variant} while another parent's leaf runs leaves no phantom credit`, async () => {
    const h = harness(2);
    const p1 = h.enqueue(), p2 = h.enqueue();
    h.call(p2, "q_a"); await h.resolved(p2, "q_a");
    assert.equal(h.leaf("q_a")!.status, "running");
    if (variant === "ended during resolution") { h.call(p1, "gone"); h.broker.observe(h.get(p1), end("gone"), h.cwd); }
    else h.call(p1, "gone", { persona: "plain", task: "not allowed" });
    const r = await h.response(p1, "gone");
    assert.equal(r.ok, false);
    assert.equal(h.leaf("gone"), undefined);
    h.call(p2, "q_b"); await h.resolved(p2, "q_b");
    assert.equal(h.leaf("q_b")!.status, "queued", "p1's withdrawn claim must not leave a slot to lend");
    assert.ok(h.peak.executing <= 2, `executing peaked at ${h.peak.executing}`);
    assert.equal(h.get(p1).pendingDelegations, 0);
  });
}

test("N3 reported limit: a lender that resumes before its own leaf ran, while another parent's leaf holds its loan, executes max+1 until a leaf settles; nothing more is admitted", async () => {
  const h = harness(2);
  const p = h.enqueue(), q = h.enqueue();
  h.call(q, "q1"); await h.resolved(q, "q1");
  h.call(q, "q2"); await h.resolved(q, "q2");
  assert.equal(h.leaf("q2")!.status, "queued");
  h.call(p, "p1", { persona: "plain", task: "not allowed" });
  assert.equal(h.leaf("q2")!.status, "running", "p's provisional claim lent its slot to q's waiting leaf");
  assert.equal((await h.response(p, "p1")).ok, false);
  assert.equal(h.peak.executing, 3, "counterexample: p, q1 and q2 execute while maxConcurrent is 2");
  assert.equal(h.peak.active, 4, "slot holders stay within 2*max");
  h.call(q, "q3"); await h.resolved(q, "q3");
  assert.equal(h.leaf("q3")!.status, "queued", "no further admission while over");
  await h.finish(h.leaf("q1")!);
  assert.equal(h.leaf("q3")!.status, "queued", "back at max: still no admission");
  await h.finish(h.leaf("q2")!);
  assert.equal(h.leaf("q3")!.status, "running", "heals: lending resumes under max");
});

test("N3 failed launches release the call's credit once: immediate refusal, refusal at drain, and an asynchronous launch failure", async () => {
  const h = harness(1, { refuse: (o) => o.task.includes("REFUSE") });
  const p = h.enqueue();
  h.call(p, "now", { persona: "scout", task: "REFUSE now" });
  const now = await h.response(p, "now");
  assert.equal(now.ok, false);
  assert.match(now.reason, /delegation failed: launch refused by test/);
  assert.equal(h.leaf("now"), undefined);
  assert.deepEqual([h.get(p).pendingDelegations, h.get(p).provisionalDelegations ?? 0], [0, 0]);

  h.call(p, "first"); await h.resolved(p, "first");
  h.call(p, "later", { persona: "scout", task: "REFUSE at drain" }); await h.resolved(p, "later");
  assert.deepEqual([h.leaf("first")!.status, h.leaf("later")!.status], ["running", "queued"]);
  await h.finish(h.leaf("first")!);
  const later = await h.response(p, "later");
  assert.equal(h.leaf("later")!.status, "failed", "a leaf refused at drain settles; it never lingers queued outside the queue");
  assert.equal(later.status, "failed");
  assert.equal(h.queue.size(), 0);

  h.call(p, "async"); await h.resolved(p, "async");
  await h.finish(h.leaf("async")!, "failed");
  assert.equal((await h.response(p, "async")).status, "failed");
  assert.deepEqual([h.get(p).pendingDelegations, h.get(p).provisionalDelegations ?? 0], [0, 0]);
  const status = statusTool(h.registry, h.queue);
  const row = (await status()).details.running.find((r: { id: string }) => r.id === p);
  assert.equal(row.awaiting_children, undefined, "nothing left to await");
  assert.ok(h.peak.executing <= 1);
});

test("N3 an aborted queued leaf and a queued leaf at its deadline each release exactly their own credit", async () => {
  const h = harness(1);
  const p = h.enqueue();
  h.call(p, "run"); await h.resolved(p, "run");
  h.call(p, "abort"); await h.resolved(p, "abort");
  assert.equal(h.leaf("abort")!.status, "queued");
  const status = statusTool(h.registry, h.queue);
  const awaiting = async () => (await status()).details.running.find((r: { id: string }) => r.id === p)?.awaiting_children;
  assert.equal(await awaiting(), 2);
  h.broker.observe(h.get(p), end("abort"), h.cwd);
  assert.match((await h.response(p, "abort")).reason, /^cancelled: /);
  assert.equal(h.leaf("abort")!.status, "killed");
  assert.equal(await awaiting(), 1, "one call withdrawn, one still awaited");
  await h.finish(h.leaf("run")!);
  await h.response(p, "run");
  assert.equal(await awaiting(), undefined);
  assert.ok(h.peak.executing <= 1, `executing peaked at ${h.peak.executing}`);

  const d = harness(1);
  const late = d.enqueue();
  d.call(late, "hold"); await d.resolved(late, "hold");
  d.get(late).deadlineAt = Date.now() + 200; // the parent's deadline passes while its next leaf waits
  d.call(late, "starved"); await d.resolved(late, "starved");
  assert.equal(d.leaf("starved")!.status, "queued");
  assert.match((await d.response(late, "starved")).reason, /timeout: .* did not start before its deadline/);
  assert.equal(d.leaf("starved")!.status, "killed");
  assert.equal(d.queue.size(), 0);
  assert.equal(d.leaf("hold")!.status, "running", "only the starved call's credit was released");
  assert.ok(d.peak.executing <= 1, `executing peaked at ${d.peak.executing}`);
});

test("N3 reload: the R6 fallback stops leaves then parents without launching anything new or over-admitting", async () => {
  const h = harness(2);
  const p1 = h.enqueue(), p2 = h.enqueue();
  h.call(p1, "r1"); await h.resolved(p1, "r1");
  h.call(p2, "r2"); await h.resolved(p2, "r2");
  h.call(p1, "r3"); await h.resolved(p1, "r3");
  assert.deepEqual(["r1", "r2", "r3"].map((c) => h.leaf(c)!.status), ["running", "running", "queued"]);
  const launched = h.launches.length;
  const order: string[] = [];
  h.registry.onChange((r) => { if (isTerminal(r.status)) order.push(r.id); });
  await handleSessionShutdown({ reason: "reload" }, { runs: h.registry.list(), resetSanitizer: () => {}, delegation: h.broker });
  assert.equal(h.launches.length, launched, "no leaf launches while the broker closes");
  for (const c of ["r1", "r2", "r3"]) assert.ok(isTerminal(h.leaf(c)!.status), c);
  assert.deepEqual([h.get(p1).status, h.get(p2).status], ["killed", "killed"]);
  assert.equal(h.get(p1).errorMessage, RELOAD_INTERRUPTED);
  assert.ok(order.indexOf(p1) > Math.max(order.indexOf(h.leaf("r1")!.id), order.indexOf(h.leaf("r3")!.id)), "leaves first");
  assert.equal(h.queue.size(), 0);
  assert.ok(h.peak.executing <= 2);
});

test("N3 a parent going terminal cancels its queued leaves before its running ones, so the freed slot launches none of them", async () => {
  const h = harness(1);
  const p = h.enqueue();
  h.call(p, "t1"); await h.resolved(p, "t1");
  h.call(p, "t2"); await h.resolved(p, "t2");
  assert.deepEqual([h.leaf("t1")!.status, h.leaf("t2")!.status], ["running", "queued"]);
  const launched = h.launches.length;
  forceTerminate(h.get(p), "killed", h.registry);
  for (const c of ["t1", "t2"]) assert.match((await h.response(p, c)).reason, /^cancelled: parent .* ended \(killed\)/);
  assert.equal(h.launches.length, launched, "no leaf of a terminal parent launches");
  assert.deepEqual([h.leaf("t1")!.status, h.leaf("t2")!.status], ["killed", "killed"]);
});

// ── One predicate, current parents only ──────────────────────────────

test("N3 immediate enqueue and drain apply the same lent-lane predicate", async () => {
  const h = harness(2);
  const p = h.enqueue();
  h.call(p, "c1"); await h.resolved(p, "c1");
  const direct = (id: string) => h.queue.enqueueOrSpawn({ persona: SCOUT, task: id, cwd: h.cwd, mode: "background", timeoutMs: 60_000, runtimeEnv: {}, delegation: { parentRunId: p, delegateToolCallId: id } });
  assert.equal(h.registry.list().filter(consumesSlot).length, 2, "A = maxConcurrent: the lead lane is full");
  assert.equal(direct("d1").kind, "spawned", "the immediate path lends: A - W = 1 < 2");
  const queued = direct("d2");
  assert.equal(queued.kind, "queued");
  assert.match((queued as { placeholderRun: Run }).placeholderRun.waitReason ?? "", /lent slot/);
  await h.finish(h.leaf("c1")!);
  assert.equal(h.leaf("d2")!.status, "running", "drain admits it on the same predicate");
});

test("N3 a leaf whose parent is not a current awaiting depth-1 delegator gets no lent slot", async () => {
  const cases: [string, (h: ReturnType<typeof harness>, p: string) => string][] = [
    ["unknown parent", () => "lead-ghost"],
    ["depth-2 parent", (h) => h.leaf("c1")!.id],
    ["non-delegating parent", (h) => h.registry.list().find((r) => r.persona === "plain")!.id],
    ["A6-blocked delegator", (h, p) => { const b: Run = { ...h.get(p), id: "lead-blocked", status: "blocked", pendingDelegations: 0 }; h.registry.register(b); return b.id; }],
    ["terminal delegator", (h, p) => { const t: Run = { ...h.get(p), id: "lead-done", status: "completed", pendingDelegations: 0 }; h.registry.register(t); return t.id; }],
  ];
  for (const [label, parentOf] of cases) {
    const h = harness(3);
    const p = h.enqueue(); h.enqueue(PLAIN);
    h.call(p, "c1"); await h.resolved(p, "c1");
    assert.equal(h.registry.list().filter(consumesSlot).length, 3, label);
    const parentRunId = parentOf(h, p);
    const r = h.queue.enqueueOrSpawn({ persona: SCOUT, task: "t", cwd: h.cwd, mode: "background", timeoutMs: 60_000, runtimeEnv: {}, delegation: { parentRunId, delegateToolCallId: "x" } });
    assert.equal(r.kind, "queued", `${label}: no lent slot`);
    assert.match((r as { placeholderRun: Run }).placeholderRun.waitReason ?? "", /waits for maxConcurrent \(3\)/, label);
    const control = (id: string) => h.queue.enqueueOrSpawn({ persona: SCOUT, task: "t", cwd: h.cwd, mode: "background", timeoutMs: 60_000, runtimeEnv: {}, delegation: { parentRunId: p, delegateToolCallId: id } }).kind;
    assert.equal(control("ok1"), "spawned", `${label}: a leaf of the awaiting parent still lends`);
    assert.equal(control("ok2"), "queued", `${label}: the invalid parent and its waiting leaf lend nothing more`);
  }
});

// ── Effort writers keep their isolation ──────────────────────────────

const git = (cwd: string, ...args: string[]) => cp.execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe" }).trim();
function effortHarness(t: test.TestContext, max: number, maxParallel: number) {
  const cwd = tmpDir("n3-effort-"); git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  mkdirSync(join(cwd, "src")); writeFileSync(join(cwd, "src", "old"), "base\n");
  git(cwd, "add", ".gitignore", "src"); git(cwd, "commit", "-m", "base");
  openEffort(cwd, "one", "owner", { verify: "", maxParallel });
  const registry = new RunRegistry(); const started: Promise<Run>[] = [];
  const queue = new SpawnQueue(registry, max, 1, (opts) => { const result = spawnRun(opts); started.push(result.done); return result; });
  const realSpawn = cp.spawn;
  t.mock.method(cp, "spawn", (command: string, args: string[] | cp.SpawnOptions, opts?: cp.SpawnOptions) => {
    if (command !== process.env.PI_BIN) return Array.isArray(args) ? realSpawn(command, args, opts ?? {}) : realSpawn(command, args);
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), unref() {}, kill() { queueMicrotask(() => proc.emit("close", 0)); return true; } });
    return proc;
  });
  syncBuiltinESMExports();
  t.after(async () => {
    for (const p of [...queue.list()]) queue.removeQueued(p.id);
    for (const r of registry.list()) forceTerminate(r, "killed", registry);
    await Promise.all(started); t.mock.restoreAll(); syncBuiltinESMExports();
  });
  const writer = { ...persona("lead-writer"), agents: ["scout"] };
  const spawn = (p: Persona, extra: Partial<SpawnOptions>) => queue.enqueueOrSpawn({ registry, cwd, persona: p, parentSessionId: "owner", task: "t", mode: "background", timeoutMs: 10_000, runtimeEnv: {}, ...extra });
  const run = (r: ReturnType<SpawnQueue["enqueueOrSpawn"]>) => (r.kind === "spawned" ? r.run : r.placeholderRun);
  return { registry, writer, spawn, run };
}

test("N3 an awaiting effort writer keeps its maxParallel slot; lending admits its read-only leaf, never another writer or lead-level work", { timeout: 15000 }, (t) => {
  const h = effortHarness(t, 2, 1);
  const w1 = h.run(h.spawn(h.writer, { effort: "one", touches: ["src/a/**"] }));
  assert.equal(w1.status, "running");
  const cwd = w1.effort!.cwd!;
  const leaf1 = h.run(h.spawn(SCOUT, { cwd, delegation: { parentRunId: w1.id, delegateToolCallId: "w_a" } }));
  assert.equal(leaf1.status, "running");
  const leaf2 = h.run(h.spawn(SCOUT, { cwd, delegation: { parentRunId: w1.id, delegateToolCallId: "w_b" } }));
  assert.equal(leaf2.status, "running", "the awaiting writer lends its slot to its own read-only leaf");
  for (const l of [leaf1, leaf2]) assert.deepEqual([l.effort, l.worktreePath, l.depth, l.cwd], [undefined, undefined, 2, cwd], "a leaf is no effort member and gets no worktree");
  const w2 = h.run(h.spawn(h.writer, { effort: "one", touches: ["src/b/**"] }));
  assert.equal(w2.status, "queued");
  assert.match(w2.waitReason ?? "", /waits for maxConcurrent \(2\)|waits for effort maxParallel \(1\)/);
  const plain = h.run(h.spawn(PLAIN, {}));
  assert.equal(plain.status, "queued", "lead-level work never uses the writer's loan");
});

test("N3 with lead capacity left, an awaiting effort writer still holds its maxParallel slot", { timeout: 15000 }, (t) => {
  const one = effortHarness(t, 4, 1);
  const w1 = one.run(one.spawn(one.writer, { effort: "one", touches: ["src/a/**"] }));
  one.run(one.spawn(SCOUT, { cwd: w1.effort!.cwd!, delegation: { parentRunId: w1.id, delegateToolCallId: "w_a" } }));
  const disjoint = one.run(one.spawn(one.writer, { effort: "one", touches: ["src/b/**"] }));
  assert.match(disjoint.waitReason ?? "", /waits for effort maxParallel \(1\)/, "awaiting does not free the writer's effort slot");
});

test("N3 with lead capacity left, an awaiting effort writer still holds its footprint", { timeout: 15000 }, (t) => {
  const two = effortHarness(t, 4, 2);
  const v1 = two.run(two.spawn(two.writer, { effort: "one", touches: ["src/a/**"] }));
  two.run(two.spawn(SCOUT, { cwd: v1.effort!.cwd!, delegation: { parentRunId: v1.id, delegateToolCallId: "v_a" } }));
  const overlap = two.run(two.spawn(two.writer, { effort: "one", touches: ["src/a/file"] }));
  assert.match(overlap.waitReason ?? "", new RegExp(`waits on ${v1.id} \\(touches overlap\\)`), "awaiting does not release the writer's footprint");
});

// ── Activity: panel, status, watchdog ────────────────────────────────

const CFG = DEFAULT_WATCHDOG_CONFIG;
const STALE = 2 * 3_600_000;

test("N3 an awaiting parent shows ⇣N waiting in the panel and awaiting_children in ensemble_status from one count; polling never touches its event clock", async () => {
  const h = harness(2);
  const p = h.enqueue(), r = h.enqueue(PLAIN);
  h.call(p, "s_a"); await h.resolved(p, "s_a");
  h.call(p, "s_b"); await h.resolved(p, "s_b");
  h.call(p, "s_c"); await h.resolved(p, "s_c");
  const old = Date.now() - STALE;
  for (const id of [p, r]) Object.assign(h.get(id), { startTime: old, lastEventAt: old, proc: { kill() {} } });
  const runs = h.registry.list(), now = Date.now();
  const row = formatRow(h.get(p), theme, now, CFG, runs);
  assert.match(row, /⇣3 waiting/);
  assert.doesNotMatch(row, /STALLED/, "awaiting children is not a stall");
  assert.match(formatRow(h.get(r), theme, now, CFG, runs), /STALLED/, "an ordinary silent run still shows its stall");
  const status = await statusTool(h.registry, h.queue)();
  const summary = (id: string) => status.details.running.find((x: { id: string }) => x.id === id);
  assert.equal(summary(p).awaiting_children, 3);
  assert.equal("awaiting_children" in summary(r), false);
  assert.match(status.content[0].text, new RegExp(`${p}.*⇣3 waiting`));
  assert.deepEqual([h.get(p).lastEventAt, h.get(r).lastEventAt], [old, old], "status and panel reads never reset the event clock");
  await h.finish(h.leaf("s_a")!);
  assert.match(formatRow(h.get(p), theme, Date.now(), CFG, h.registry.list()), /⇣2 waiting/, "a settled leaf lowers the count");
});

test("N3 /conductor watchdog reports an awaiting parent as fresh and an ordinary silent run as stalled", async () => {
  const h = harness(2);
  const p = h.enqueue(), r = h.enqueue(PLAIN);
  h.call(p, "w_a"); await h.resolved(p, "w_a");
  const old = Date.now() - STALE;
  for (const id of [p, r]) Object.assign(h.get(id), { startTime: old, lastEventAt: old, proc: { kill() {} } });
  const report = buildWatchdogStatusReport({ registry: h.registry, watchdogConfig: CFG, defaultKillOnStall: true, enabled: true, now: Date.now() });
  const line = (id: string) => report.split("\n").find((l) => l.includes(id)) ?? "";
  assert.match(line(p), /\sfresh\s/);
  assert.match(line(r), /\shard\s.*kill/);
});

test("N3 evaluateRun and classifyStall suppress stalls for an awaiting parent only", () => {
  const now = 10 * STALE;
  const run = { id: "lead-x", status: "running", runtime: "subprocess", proc: {}, startTime: 0, lastEventAt: now - STALE } as unknown as Run;
  assert.equal(classifyStall(run, now, CFG, true), null);
  assert.deepEqual(evaluateRun(run, undefined, CFG, now, true).transition, { kind: "none" });
  assert.equal(classifyStall(run, now, CFG, false)?.severity, "hard");
  assert.equal(evaluateRun(run, undefined, CFG, now, false).transition.kind, "hard");
});

test("N3 watchdog: an awaiting parent never stalls; its last response opens a fresh window from the handoff; non-waiting runs stay armed and no deadline moves", async () => {
  const h = harness(4, { observable: true });
  const p = h.enqueue(), idle = h.enqueue(), plain = h.enqueue(PLAIN);
  const old = Date.now() - STALE;
  for (const id of [p, idle, plain]) Object.assign(h.get(id), { startTime: old, lastEventAt: old });
  h.call(p, "w_a"); await h.resolved(p, "w_a");
  const deadline = h.get(p).deadlineAt;
  let clock = Date.now();
  const kills: string[] = [];
  const wd = new Watchdog({ registry: h.registry, config: CFG, log: { warn() {}, info() {} }, now: () => clock, kill: (run) => kills.push(run.id), isKillOnStall: () => true });
  const dispose = wd.start();
  try {
    wd.tick();
    assert.deepEqual(kills.sort(), [idle, plain].sort(), "a non-waiting delegator and an ordinary run are still killed on stall");
    const before = Date.now();
    await h.finish(h.leaf("w_a")!);
    await h.response(p, "w_a");
    assert.ok(h.get(p).lastEventAt >= before, "the broker stamps the parent's event clock before handing the last response back");
    assert.equal(h.get(p).deadlineAt, deadline, "the hard deadline is not extended");
    clock = Date.now(); wd.tick();
    assert.equal(kills.includes(p), false, "a fresh window after the handoff, not the frozen pre-delegation clock");
    clock = h.get(p).lastEventAt + CFG.hardThresholdSeconds * 1000; wd.tick();
    assert.equal(kills.includes(p), true, "and the watchdog is armed again afterwards");
  } finally { dispose(); }
});

test("N3 watchdog: a launch inside a leaf's terminal notify never stalls the parent whose response is still being handed back", async () => {
  const h = harness(3, { observable: true });
  const p = h.enqueue();
  h.enqueue(PLAIN);
  const old = Date.now() - STALE;
  Object.assign(h.get(p), { startTime: old, lastEventAt: old });
  h.call(p, "w_a"); await h.resolved(p, "w_a");
  const x = h.enqueue(PLAIN);
  assert.equal(h.get(x).status, "queued");
  const kills: string[] = [];
  const wd = new Watchdog({ registry: h.registry, config: CFG, log: { warn() {}, info() {} }, now: () => Date.now(), kill: (run) => kills.push(run.id), isKillOnStall: () => true });
  const dispose = wd.start();
  try {
    await h.finish(h.leaf("w_a")!);
    assert.equal(h.get(x).status, "running", "the leaf's own notify launched the waiting run (a nested watchdog tick)");
    await h.response(p, "w_a");
    wd.tick();
    assert.deepEqual(kills, [], "no tick between the leaf's settlement and the handoff saw the frozen clock");
  } finally { dispose(); }
});
