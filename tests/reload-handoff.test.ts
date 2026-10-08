/**
 * /reload spares running subprocess children, but their close handlers stay
 * in the old extension instance, whose pi API pi invalidates. Before the
 * handoff, a survivor's completion card was lost (crashes.json 2026-10-08,
 * critic-rwzn: the REJECTED verdict never reached the session), and the
 * new instance's startup reconcile SIGTERMed a live steerable (RPC) survivor
 * as `orphaned: rpc-stream-detached`.
 *
 * The scenarios drive real extension instances in one process, as pi does:
 * ensemble_spawn in A with a PI_BIN stub, A's session_shutdown{reload}, then
 * B's session_start{reload}. Killing mutations: drop the watcher → no card in
 * B; drop the old instance's handed-off check → a second card from A; drop
 * the survivor set from classifyRecord → the RPC stub is SIGTERMed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import conductor from "../src/index.ts";
import { classifyRecord } from "../src/reconcile-startup.ts";
import { claimReloadSurvivors, handOffCandidate, publishReloadSurvivors } from "../src/reload-handoff.ts";
import { emptyUsage, toRunRecord, type Run } from "../src/types.ts";
import { stubCtx } from "./helpers/stub-pi.ts";
import { tmpDir } from "./helpers/tmp.ts";

const STALE = "This extension ctx is stale after session replacement or reload.";

function run(over: Partial<Run> = {}): Run {
  return {
    id: "r", persona: "critic", task: "t", mode: "background", status: "running",
    startTime: 1_000, lastEventAt: 1_000, pid: 4_242, parentPid: process.pid, parentSessionId: "sess",
    streamingMode: "rpc", steerable: true, messages: [], usage: emptyUsage(), cwd: "/tmp",
    recordPath: "/tmp/r/record.json", transcriptPath: "/tmp/r/transcript.jsonl", finalPath: "/tmp/r/final.md",
    ...over,
  };
}

// ── classifyRecord ─────────────────────────────────────────────────────────

test("a live RPC run the previous instance handed off is readopted, not killed", () => {
  const record = toRunRecord(run());
  assert.equal(classifyRecord(record, () => true, 0, process.pid, () => true, "sess", "unknown", new Set(["r"])), "readopt");
  assert.equal(classifyRecord(record, () => true, 0, process.pid, () => true, "sess"), "reclassify-killed", "a crash orphan keeps the RPC policy");
});

test("a survivor whose child already exited is readopted: the previous instance still writes its outcome", () => {
  const record = toRunRecord(run({ streamingMode: "print", steerable: false }));
  assert.equal(classifyRecord(record, () => false, 0, process.pid, () => true, "sess", "unknown", new Set(["r"])), "readopt");
});

test("a survivor id does not override ownership: another live session's run stays foreign", () => {
  const record = toRunRecord(run({ parentSessionId: "other" }));
  assert.equal(classifyRecord(record, () => true, 0, process.pid, () => true, "sess", "unknown", new Set(["r"])), "skip-foreign");
});

// ── the process-global slot ────────────────────────────────────────────────

test("survivors are claimed once, per session", () => {
  const kill = () => {};
  publishReloadSurvivors("slot-a", new Map([["x", { terminate: kill }], ["y", {}]]));
  publishReloadSurvivors("slot-b", new Map([["z", {}]]));
  const a = claimReloadSurvivors("slot-a");
  assert.deepEqual([...a.keys()].sort(), ["x", "y"]);
  assert.equal(a.get("x")!.terminate, kill, "the holder's kill travels with the id");
  assert.equal(claimReloadSurvivors("slot-a").size, 0, "a second claim gets nothing");
  assert.deepEqual([...claimReloadSurvivors("slot-b").keys()], ["z"]);
});

test("only live ordinary subprocess runs are handed off", () => {
  assert.equal(handOffCandidate(run()), true);
  assert.equal(handOffCandidate(run({ status: "paused" })), true);
  assert.equal(handOffCandidate(run({ status: "completed" })), false);
  assert.equal(handOffCandidate(run({ status: "queued" })), false);
  assert.equal(handOffCandidate(run({ runtime: "herdr" })), false, "herdr has its own fenced owner handoff");
  assert.equal(handOffCandidate(run({ effort: {} as never })), false, "effort recovery owns effort runs");
  assert.equal(handOffCandidate(run({ mergerFor: "w" } as never)), false);
  assert.equal(handOffCandidate(run({ depth: 2, parentRunId: "p" } as never)), false, "the lead never posts a leaf's card");
});

// ── real reload, real child ────────────────────────────────────────────────

type Message = { content?: string; details?: { kind?: string; id?: string; status?: string } };

interface Instance {
  fire: (ev: string, event: unknown, ctx: unknown) => Promise<void>;
  tools: Map<string, { execute: (...a: any[]) => Promise<any> }>;
  cards: (id: string) => Message[];
  /** pi invalidates the old runtime after session_shutdown; sendMessage then throws. */
  markStale: () => void;
}

function load(): Instance {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, { execute: (...a: any[]) => Promise<any> }>();
  const messages: Message[] = [];
  let stale = false;
  conductor({
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => void handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
    registerFlag() {}, getFlag() {},
    registerTool: (t: any) => void tools.set(t.name, t),
    registerCommand: () => {}, registerMessageRenderer: () => {}, registerShortcut: () => {},
    sendMessage: (m: Message) => { if (stale) throw new Error(STALE); messages.push(m); },
    appendEntry: () => {},
  } as any);
  return {
    tools,
    cards: id => messages.filter(m => m.details?.kind === "completed" && m.details.id === id),
    markStale: () => void (stale = true),
    fire: async (ev, event, ctx) => { for (const h of handlers.get(ev) ?? []) await h(event, ctx); },
  };
}

async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 25));
  }
}

// Prints one assistant message once `go` exists; print mode then exits 0, RPC mode settles and waits to be stopped.
const STUB = `import { existsSync } from "node:fs";
const rpc = process.argv.includes("rpc");
if (rpc) process.stdin.resume();
const t = setInterval(() => {
  if (!existsSync(process.env.RELOAD_STUB_GO)) return;
  clearInterval(t);
  const out = e => process.stdout.write(JSON.stringify(e) + "\\n");
  out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "VERDICT: REJECTED" }], stopReason: "stop" } });
  if (rpc) out({ type: "agent_settled" }); else process.exit(0);
}, 20);
`;

interface Scenario {
  steerable?: boolean;
  staleOld?: boolean;
  /** Child finishes after A's shutdown and before B's session_start. */
  finishDuringReload?: boolean;
  /** A second reload (B → C) before the child finishes. */
  twoReloads?: boolean;
  /** B reloads again before its startup reconcile has run. */
  reloadBeforeReconcile?: boolean;
  /** B stops the survivor instead of letting it finish: ensemble_kill, or a session replacement. */
  stopInNew?: "ensemble_kill" | "new";
}

async function reload(s: Scenario): Promise<{ old: Message[][]; next: Message[]; record: any; pidAliveAfterReconcile: boolean }> {
  const root = tmpDir("conductor-reload-handoff-");
  const sid = `sess-${Math.random().toString(36).slice(2)}`;
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN, CONDUCTOR_SUBAGENT: process.env.CONDUCTOR_SUBAGENT,
    CONDUCTOR_MEMORY_PATH: process.env.CONDUCTOR_MEMORY_PATH, RELOAD_STUB_GO: process.env.RELOAD_STUB_GO };
  const memoryPath = join(root, "memory.jsonl");
  const go = join(root, "go");
  process.env.HOME = join(root, "home");
  process.env.CONDUCTOR_MEMORY_PATH = memoryPath;
  process.env.RELOAD_STUB_GO = go;
  delete process.env.CONDUCTOR_SUBAGENT;
  writeFileSync(join(root, "pi-stub.mjs"), STUB);
  process.env.PI_BIN = join(root, "pi-stub.mjs");
  const base = stubCtx(root);
  const ctx = { ...base, sessionManager: { ...base.sessionManager, getSessionId: () => sid } };
  const conf = join(root, "home", ".pi", "agent", "extensions", "conductor");
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(conf, "config.json"), JSON.stringify({ gc: { enabled: false } }));
  const instances: Instance[] = [];
  const start = async (reason: string) => {
    const i = load();
    instances.push(i);
    await i.fire("session_start", { reason }, ctx);
    return i;
  };
  const listed = async (i: Instance, id: string) => {
    const deadline = Date.now() + 15_000;
    while (!JSON.stringify((await i.tools.get("ensemble_status")!.execute("s", {}, undefined, undefined, ctx)).content).includes(id)) {
      assert.ok(Date.now() < deadline, "timed out waiting for the reloaded instance to list the survivor");
      await new Promise(r => setTimeout(r, 25));
    }
  };
  const reloadFrom = async (i: Instance) => {
    await i.fire("session_shutdown", { reason: "reload" }, ctx);
    if (s.staleOld) i.markStale();
  };
  let stubPid: number | undefined;
  try {
    const a = await start("startup");
    const spawned = await a.tools.get("ensemble_spawn")!.execute(
      "c1", { persona: "oracle", task: "review", foreground: false, steerable: s.steerable === true }, undefined, undefined, ctx);
    assert.ok(!spawned.isError, JSON.stringify(spawned.content));
    const id: string = spawned.details.agent_id;
    const recordPath = join(root, "home", ".pi", "agent", "conductor", "runs", id, "record.json");
    const record = () => JSON.parse(readFileSync(recordPath, "utf8"));
    await until("the stub to start", () => existsSync(recordPath) && !!record().pid);
    const pid: number = record().pid;
    stubPid = pid;
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // The spawn-time record omits streamingMode (written before it is stamped); a mid-run
    // write such as an owner answer persists it, and only then does reconcile treat a live
    // RPC record as a stranded orphan. Model that record.
    if (s.steerable) writeFileSync(recordPath, JSON.stringify({ ...record(), streamingMode: "rpc", steerable: true }));

    await reloadFrom(a);
    if (s.finishDuringReload) {
      writeFileSync(go, "");
      await until("the outcome on disk", () => record().status === "completed");
    }
    let next = await start("reload");
    if (s.reloadBeforeReconcile) {
      await reloadFrom(next); // synchronous up to its first await: B's setImmediate reconcile has not run
      next = await start("reload");
    }
    await listed(next, id);
    if (s.twoReloads) {
      await reloadFrom(next);
      next = await start("reload");
      await listed(next, id);
    }
    if (s.stopInNew) {
      if (s.stopInNew === "new") await next.fire("session_shutdown", { reason: "new" }, ctx);
      else {
        const out = await next.tools.get("ensemble_kill")!.execute("k", { agent_id: id }, undefined, undefined, ctx);
        assert.ok(!out.isError, JSON.stringify(out.content));
      }
      await until("the stub to exit", () => !alive());
      await until("the old close handler", () => existsSync(memoryPath) && readFileSync(memoryPath, "utf8").length > 0);
      await new Promise(r => setTimeout(r, 1_500));
      return { old: instances.slice(0, -1).map(i => i.cards(id)), next: next.cards(id), record: record(), pidAliveAfterReconcile: false };
    }
    const pidAliveAfterReconcile = s.finishDuringReload ? true : alive();
    writeFileSync(go, "");
    await until("the card in the reloaded instance", () => next.cards(id).length > 0);
    // A's close handler records the outcome after its (suppressed) card; any duplicate is in by then.
    await until("the old close handler", () => existsSync(memoryPath) && readFileSync(memoryPath, "utf8").includes(`"status":"completed"`));
    await new Promise(r => setTimeout(r, 1_500)); // one more watcher poll
    return { old: instances.slice(0, -1).map(i => i.cards(id)), next: next.cards(id), record: record(), pidAliveAfterReconcile };
  } finally {
    if (stubPid) try { process.kill(stubPid, "SIGKILL"); } catch { /* already exited */ }
    for (const i of instances) await i.fire("session_shutdown", { reason: "quit" }, ctx).catch(() => {});
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function assertOneCard(r: Awaited<ReturnType<typeof reload>>): void {
  assert.deepEqual(r.old.map(c => c.length), r.old.map(() => 0), "no card from a replaced instance");
  assert.equal(r.next.length, 1, `cards: ${JSON.stringify(r.next.map(c => c.details))}`);
  assert.equal(r.next[0]!.details!.status, "completed");
  assert.match(r.next[0]!.content ?? "", /VERDICT: REJECTED/, "the card carries the run's final text");
  assert.equal(r.record.status, "completed");
}

test("reload: a print-mode survivor's card comes from the new instance, exactly once", { timeout: 60_000 }, async () => {
  assertOneCard(await reload({}));
});

test("reload: the same when pi has already invalidated the old instance", { timeout: 60_000 }, async () => {
  assertOneCard(await reload({ staleOld: true }));
});

test("reload: a survivor that finishes between shutdown and the new session_start still gets its card", { timeout: 60_000 }, async () => {
  assertOneCard(await reload({ finishDuringReload: true }));
});

test("reload: a survivor carried across two reloads gets one card, from the latest instance", { timeout: 60_000 }, async () => {
  assertOneCard(await reload({ twoReloads: true, staleOld: true }));
});

test("reload: a survivor still owed when the new instance reloads before its reconcile ran is carried forward", { timeout: 60_000 }, async () => {
  assertOneCard(await reload({ reloadBeforeReconcile: true, staleOld: true }));
});

test("reload: ensemble_kill in the new instance stops the survivor through its holder, silently", { timeout: 60_000 }, async () => {
  const r = await reload({ stopInNew: "ensemble_kill" });
  assert.equal(r.record.status, "killed");
  assert.deepEqual([...r.old, r.next].map(c => c.length), [0, 0], `cards: ${JSON.stringify([...r.old, r.next])}`);
});

test("reload: ensemble_kill still reaches the holder after two reloads", { timeout: 60_000 }, async () => {
  const r = await reload({ stopInNew: "ensemble_kill", twoReloads: true, staleOld: true });
  assert.equal(r.record.status, "killed");
  assert.deepEqual([...r.old, r.next].map(c => c.length), [0, 0, 0]);
});

test("reload: a later session replacement stops a survivor too, as it stops the new instance's own runs", { timeout: 60_000 }, async () => {
  const r = await reload({ stopInNew: "new", staleOld: true });
  assert.equal(r.record.status, "killed");
  assert.deepEqual([...r.old, r.next].map(c => c.length), [0, 0]);
});

test("reload: a steerable (RPC) survivor is not SIGTERMed by the new instance's reconcile, and its card arrives", { timeout: 60_000 }, async () => {
  const r = await reload({ steerable: true, staleOld: true });
  assert.equal(r.pidAliveAfterReconcile, true, "the RPC child survived the reload");
  assert.doesNotMatch(r.record.errorMessage ?? "", /orphaned/);
  assertOneCard(r);
});
