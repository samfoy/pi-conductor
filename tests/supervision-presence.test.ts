/**
 * S1 lead presence: a conductor-ON herdr lead (never a conductor child) with a
 * saved session publishes one record and activates `peer`; OFF, every shutdown
 * reason and a session switch remove only its own record. Each activation has a
 * fresh epoch, so a superseded activation's late timer can neither republish
 * nor delete. No herdr CLI call is ever made.
 */
import test, { after } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { makeFakeClock } from "./helpers/fake-clock.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";
import { probeHerdrOwner } from "../src/herdr/ownership.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";
import { LeadPresence, leadEligibility } from "../src/supervision/presence.ts";
import { buildLeadRecord, createLeadRecord, leadPath, leadsDir, readLeadRecord, replaceLeadRecord, scanLeads, supervisionRoot, type LeadRecord } from "../src/supervision/store.ts";
import conductor from "../src/index.ts";

sandboxPi();
const fixtures = tmpDir("s1-presence-");
const HERDR = { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(fixtures, "fake.sock"), HERDR_PANE_ID: "pane-1", HERDR_TAB_ID: "tab-1", HERDR_WORKSPACE_ID: "ws-1" };
const session = (over: { sessionId?: string; sessionFile?: string; cwd?: string } = {}) => {
  const sessionId = over.sessionId ?? randomUUID();
  return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, cwd: "/work/api", ...over };
};
const reset = () => rmSync(supervisionRoot(), { recursive: true, force: true });
const onDisk = (id: string) => readLeadRecord(leadPath(id));

function fakePi(registered = ["read", "bash", "peer", "foreign_tool"], name = "api lead") {
  let active = [...registered];
  const sets: string[][] = [];
  return {
    api: {
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { sets.push([...names]); active = names.filter(n => registered.includes(n)); },
      getAllTools: () => registered.map(name => ({ name })),
      getSessionName: () => name,
    },
    active: () => active, sets,
  };
}

function presence(over: { env?: NodeJS.ProcessEnv; mode?: () => boolean; pi?: ReturnType<typeof fakePi>; registry?: RunRegistry; clock?: ReturnType<typeof makeFakeClock>; timers?: unknown; liveness?: object; own?: boolean; repo?: { repo?: string; branch?: string } } = {}) {
  const pi = over.pi ?? fakePi();
  const registry = over.registry ?? new RunRegistry();
  const clock = over.clock ?? makeFakeClock(1_000_000);
  const notes: string[] = [];
  const p = new LeadPresence({ pi: pi.api as never, env: over.env ?? HERDR, registry, getMode: over.mode ?? (() => true), now: clock.deps.now,
    timers: (over.timers ?? clock.deps) as never, liveness: over.liveness as never, describeRepo: () => over.repo ?? { repo: "api", branch: "main" } });
  if (over.own !== false) p.ownTool("peer");
  return { p, pi, registry, clock, notes, notify: (m: string) => void notes.push(m) };
}
function run(id: string, status: Run["status"] = "running"): Run {
  return { id, persona: "builder", task: "t", mode: "background", status, startTime: 1, lastEventAt: 1, messages: [], usage: emptyUsage(), cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`, transcriptPath: `/tmp/${id}/t.jsonl`, finalPath: `/tmp/${id}/final.md` } as Run;
}

// ── Eligibility ──────────────────────────────────────────────────────

test("S1 eligibility: only a conductor-ON herdr lead with a saved session; a hand-typed pi in a managed pane stays out", () => {
  const s = session();
  assert.deepEqual(leadEligibility(HERDR, true, s), { ok: true, socketPath: HERDR.HERDR_SOCKET_PATH, paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1" });
  for (const [label, env, on, facts, reason] of [
    ["a conductor child (also a pi typed by hand in a managed pane)", { ...HERDR, CONDUCTOR_SUBAGENT: "1" }, true, s, /conductor sub-agent/],
    ["no herdr pane", {}, true, s, /HERDR_ENV/],
    ["HERDR_ENV other than exactly 1", { ...HERDR, HERDR_ENV: "true" }, true, s, /HERDR_ENV/],
    ["an empty socket", { ...HERDR, HERDR_SOCKET_PATH: "" }, true, s, /HERDR_SOCKET_PATH/],
    ["no pane id", { ...HERDR, HERDR_PANE_ID: undefined }, true, s, /HERDR_PANE_ID/],
    ["conductor mode OFF", HERDR, false, s, /conductor mode OFF/],
    ["no session id", HERDR, true, { ...s, sessionId: undefined }, /session id/],
    ["--no-session (no session file)", HERDR, true, { ...s, sessionFile: undefined }, /saved session/],
  ] as const) {
    const got = leadEligibility(env as NodeJS.ProcessEnv, on, facts);
    assert.equal(got.ok, false, label);
    assert.match((got as { reason: string }).reason, reason, label);
  }
  assert.equal(leadEligibility({ ...HERDR, CONDUCTOR_SUBAGENT: "true" }, true, s).ok, true, "only the exact child flag marks a child");
});

// ── Mode, tools, records ─────────────────────────────────────────────

test("S1 presence: OFF publishes nothing and keeps peer inactive; ON publishes and activates; OFF removes it again", () => {
  reset();
  let on = false;
  const { p, pi, notify } = presence({ mode: () => on });
  const s = session();
  p.start(s, notify);
  assert.equal(onDisk(s.sessionId), undefined, "OFF must not publish");
  assert.deepEqual(pi.active(), ["read", "bash", "foreign_tool"], "OFF deactivates only peer");
  assert.equal(p.status().state, "inactive");
  assert.throws(() => p.assertOwned(), /conductor mode OFF/, "a peer call while OFF is rejected at execution");
  on = true; p.refresh();
  const record = onDisk(s.sessionId)!;
  assert.equal(record.pid, process.pid);
  assert.equal(record.pidStartTime, readProcessStartTime(process.pid));
  assert.deepEqual([record.sessionId, record.sessionFile, record.socketPath, record.paneId, record.cwd, record.displayName, record.role], [s.sessionId, s.sessionFile, HERDR.HERDR_SOCKET_PATH, "pane-1", "/work/api", "api lead", "lead"]);
  assert.deepEqual(pi.active(), ["read", "bash", "foreign_tool", "peer"], "ON appends only peer");
  assert.equal(p.assertOwned().generation, record.generation);
  on = false; p.refresh();
  assert.equal(onDisk(s.sessionId), undefined, "OFF unpublishes");
  assert.deepEqual(pi.active(), ["read", "bash", "foreign_tool"]);
  on = true; p.refresh();
  assert.notEqual(onDisk(s.sessionId)!.generation, record.generation, "each activation gets a fresh epoch");
  p.stop();
  assert.equal(onDisk(s.sessionId), undefined);
  assert.ok(pi.sets.every(set => set.filter(n => n !== "peer").join() === "read,bash,foreign_tool"), "no other active tool is ever touched");
});

test("S1 presence: native allow/exclude constraints win, and a lead that did not register peer never touches tools", () => {
  reset();
  const constrained = presence({ pi: fakePi(["read", "bash"]) });
  constrained.p.start(session(), constrained.notify);
  assert.equal(constrained.p.status().state, "published");
  assert.deepEqual(constrained.pi.sets, [], "peer absent from the native registry is never requested");
  constrained.p.stop();
  const plain = presence({ own: false });
  plain.p.start(session(), plain.notify);
  plain.p.refresh(); plain.p.stop();
  assert.deepEqual(plain.pi.sets, [], "an unowned name is never activated or deactivated");
  const child = presence({ env: { ...HERDR, CONDUCTOR_SUBAGENT: "1" } });
  const s = session();
  child.p.start(s, child.notify);
  assert.equal(onDisk(s.sessionId), undefined, "a child never publishes");
  assert.ok(!child.pi.active().includes("peer"));
});

test("S1 presence: the record mirrors the registry within a 2 s debounce and a 30 s heartbeat; captured identity never follows a stale getter", () => {
  reset();
  const ctx = presence();
  const s = session();
  const facts = { ...s };
  ctx.p.start(facts, ctx.notify);
  facts.sessionId = "replaced-after-start"; facts.cwd = "/elsewhere";
  const first = onDisk(s.sessionId)!;
  assert.deepEqual(first.runs, { active: 0, blocked: 0, total: 0 });
  for (const id of ["a", "b", "c"]) { ctx.registry.register(run(id)); ctx.clock.advance(500); }
  ctx.registry.register(run("d", "blocked"));
  assert.equal(onDisk(s.sessionId)!.updatedAt, first.updatedAt, "changes are coalesced, not written per event");
  ctx.clock.advance(500);
  const debounced = onDisk(s.sessionId)!;
  assert.deepEqual([debounced.runs.total, debounced.runs.blocked, debounced.runsBrief.length], [4, 1, 4]);
  assert.equal(debounced.updatedAt, first.updatedAt + 2000, "published 2 s after the first change");
  assert.equal(debounced.cwd, "/work/api", "the start-time cwd, not a later mutation");
  ctx.clock.advance(29_999);
  assert.equal(onDisk(s.sessionId)!.updatedAt, debounced.updatedAt);
  ctx.clock.advance(1);
  assert.equal(onDisk(s.sessionId)!.updatedAt, debounced.updatedAt + 30_000, "heartbeat");
  assert.equal(onDisk(s.sessionId)!.generation, first.generation);
  ctx.p.stop();
  assert.equal(ctx.clock.pendingCount(), 0, "stop disposes every timer");
  assert.equal(readdirSync(leadsDir()).length, 0, "nothing at the mutated id either");
});

test("S1 presence: every timer is unref'd so presence never keeps pi alive", () => {
  reset();
  const handles: NodeJS.Timeout[] = [];
  const ctx = presence({ timers: { setTimeout: (cb: () => void, ms: number) => { const h = setTimeout(cb, ms); handles.push(h); return h; }, clearTimeout } });
  ctx.p.start(session(), ctx.notify);
  ctx.registry.register(run("x"));
  assert.ok(handles.length >= 1);
  assert.ok(handles.every(h => !h.hasRef()), "heartbeat and debounce timers are unref'd");
  ctx.p.stop();
});

test("S1 presence: a superseded activation's late timer neither republishes after OFF nor touches the next epoch", () => {
  reset();
  const callbacks: (() => void)[] = [];
  const timers = { setTimeout: (cb: () => void) => { callbacks.push(cb); return callbacks.length; }, clearTimeout: () => {} };
  let on = true;
  const old = presence({ timers, mode: () => on });
  const s = session();
  old.p.start(s, old.notify);
  old.registry.register(run("late"));
  const stale = [...callbacks];
  on = false; old.p.refresh();
  for (const cb of stale) cb();
  assert.equal(onDisk(s.sessionId), undefined, "a delayed write after OFF does not resurrect the record");
  on = true; old.p.refresh(); old.p.stop();
  // Reload: a new module instance republishes the same session under a fresh epoch.
  const next = presence();
  next.p.start(s, next.notify);
  const fresh = onDisk(s.sessionId)!;
  for (const cb of callbacks) cb();
  assert.deepEqual(onDisk(s.sessionId), fresh, "the old epoch's timers can neither overwrite nor delete the new record");
  old.p.stop();
  assert.deepEqual(onDisk(s.sessionId), fresh, "a second stop of the old instance leaves the new owner alone");
  next.p.stop();
});

test("S1 presence: a duplicate live owner of the exact session stays inactive with a diagnostic and never deletes the owner", () => {
  reset();
  const first = presence(), second = presence();
  const s = session();
  first.p.start(s, first.notify);
  const owned = onDisk(s.sessionId)!;
  second.p.start(s, second.notify);
  assert.equal(second.p.status().state, "duplicate");
  assert.match(second.notes.join("\n"), new RegExp(`${s.sessionId}.*already has a live lead presence`));
  assert.ok(!second.pi.active().includes("peer"));
  assert.throws(() => second.p.assertOwned(), /already has a live lead presence/);
  second.p.refresh(); second.p.stop();
  assert.deepEqual(onDisk(s.sessionId), owned, "the duplicate never overwrote or removed the owner's record");
  first.p.stop();
});

test("S1 presence: a refresh loses presence to another identity, re-creates a vanished record, and fails closed on an invalid one", () => {
  reset();
  const ctx = presence();
  const s = session();
  ctx.p.start(s, ctx.notify);
  rmSync(leadPath(s.sessionId));
  ctx.clock.advance(30_000);
  assert.equal(onDisk(s.sessionId)!.pid, process.pid, "a swept record is re-created create-only");
  const intruder = buildLeadRecord({ ...onDisk(s.sessionId)!, generation: randomUUID(), pid: process.ppid });
  replaceLeadRecord(intruder, () => {});
  assert.throws(() => ctx.p.assertOwned(), /not its own/);
  ctx.clock.advance(30_000);
  assert.equal(ctx.p.status().state, "duplicate");
  assert.match(ctx.notes.join("\n"), /another instance/);
  assert.deepEqual(onDisk(s.sessionId), intruder, "the other identity's record is never overwritten");
  assert.ok(!ctx.pi.active().includes("peer"));
  ctx.p.stop();
  assert.deepEqual(onDisk(s.sessionId), intruder, "stop removes only an own record");
  reset();
  const invalid = presence();
  const t = session();
  createLeadRecord(buildLeadRecord({ ...intruder, sessionId: t.sessionId, sessionFile: t.sessionFile }), () => {});
  writeFileSync(leadPath(t.sessionId), "{broken", { mode: 0o600 });
  invalid.p.start(t, invalid.notify);
  assert.equal(invalid.p.status().state, "error");
  assert.equal(readFileSync(leadPath(t.sessionId), "utf8"), "{broken", "an invalid record is preserved for inspection");
});

test("S1 presence: a proven-dead predecessor of the same session is replaced; an unknown one is not", () => {
  reset();
  const s = session();
  const base = { ...s, sessionFile: s.sessionFile, generation: randomUUID(), pid: 999_991, pidStartTime: 5, socketPath: "/old.sock", paneId: "p", cwd: "/old", displayName: "old",
    runs: { active: 0, blocked: 0, total: 0 }, runsBrief: [], updatedAt: 1 } as Omit<LeadRecord, "v" | "role">;
  createLeadRecord(buildLeadRecord(base), () => {});
  const dead = presence({ liveness: { platform: "linux", probe: (pid: number) => pid === 999_991 ? { state: "gone" } : probeHerdrOwner(pid) } });
  dead.p.start(s, dead.notify);
  assert.equal(dead.p.status().state, "published");
  assert.equal(onDisk(s.sessionId)!.pid, process.pid);
  dead.p.stop();
  createLeadRecord(buildLeadRecord(base), () => {});
  const unknown = presence({ liveness: { platform: "linux", probe: (pid: number) => pid === 999_991 ? { state: "unknown" } : probeHerdrOwner(pid) } });
  unknown.p.start(s, unknown.notify);
  assert.equal(unknown.p.status().state, "duplicate", "unknown never permits a takeover");
  assert.equal(onDisk(s.sessionId)!.pid, 999_991);
  const ageOnly = presence({ liveness: { platform: "darwin", now: () => 10 ** 13, probe: () => ({ state: "alive" }) } });
  ageOnly.p.start(s, ageOnly.notify);
  assert.equal(ageOnly.p.status().state, "duplicate", "off Linux an old record of a live pid is not taken over on age alone");
});

// Critic finding: presentation text was clipped by code points but validated by bytes, so an eligible lead failed to publish.
const UTF8_CAP = 256;
const wellFormed = (s: string) => !s.includes("\uFFFD") && Buffer.from(s, "utf8").toString("utf8") === s;
for (const [label, name, repo] of [
  ["86 CJK characters in the session name", "界".repeat(86), {}],
  ["65 emoji in the session name", "😀".repeat(65), {}],
  ["a branch and repo over 256 bytes", "api lead", { repo: "仓".repeat(90), branch: `feature/${"分支".repeat(60)}` }],
] as [string, string, { repo?: string; branch?: string }][]) {
  test(`S1 presence: ${label} publishes, clipped on whole code points to at most 256 UTF-8 bytes`, () => {
    reset();
    const ctx = presence({ pi: fakePi(undefined, name), repo: { repo: "api", branch: "main", ...repo } });
    const s = session();
    ctx.p.start(s, ctx.notify);
    assert.equal(ctx.p.status().state, "published", `an eligible lead must publish: ${JSON.stringify(ctx.p.status())}`);
    const record = onDisk(s.sessionId)!;
    for (const [field, input] of [["displayName", name], ["repo", repo.repo ?? "api"], ["branch", repo.branch ?? "main"]] as const) {
      const kept = record[field]!, points = Array.from(input);
      assert.ok(wellFormed(kept), `${field} is valid Unicode with no replacement character`);
      assert.ok(Buffer.byteLength(kept) <= UTF8_CAP, `${field} is within ${UTF8_CAP} bytes: ${Buffer.byteLength(kept)}`);
      assert.ok(input.startsWith(kept), `${field} is a prefix of the input`);
      if (kept !== input) assert.ok(Buffer.byteLength(points.slice(0, Array.from(kept).length + 1).join("")) > UTF8_CAP, `${field} keeps every code point that fits`);
    }
    if (!("branch" in repo)) assert.deepEqual([record.repo, record.branch], ["api", "main"], "ordinary ASCII is unchanged");
    ctx.p.stop();
  });
}

test("S1 presence: ordinary ASCII presentation text is unchanged", () => {
  reset();
  const ctx = presence({ repo: { repo: "pi-conductor", branch: "feature/s1-supervision-presence" } });
  const s = session();
  ctx.p.start(s, ctx.notify);
  assert.deepEqual([onDisk(s.sessionId)!.displayName, onDisk(s.sessionId)!.repo, onDisk(s.sessionId)!.branch], ["api lead", "pi-conductor", "feature/s1-supervision-presence"]);
  ctx.p.stop();
});

// Critic finding: the sweep's rename-aside -> restore window. A dead predecessor is judged, a successor replaces it
// before the sweep's rename, and the rename sets the successor's record aside. If a duplicate of the same session
// publishes inside that window, the restore must keep the newer record (create-only link), never overwrite it.
for (const duplicate of [false, true]) {
  test(`S1 presence: a sweep restoring a successor's record ${duplicate ? "keeps a duplicate published inside the window and drops the aside copy" : "with no intervening publisher puts it back intact"}`, (t) => {
    reset();
    const s = session();
    const deadPid = 999_993;
    const liveness = { platform: "linux", probe: (pid: number) => pid === deadPid ? { state: "gone" as const } : probeHerdrOwner(pid) };
    createLeadRecord(buildLeadRecord({ ...s, generation: randomUUID(), pid: deadPid, pidStartTime: 5, socketPath: "/old.sock", paneId: "p", cwd: "/old", displayName: "old",
      runs: { active: 0, blocked: 0, total: 0 }, runsBrief: [], updatedAt: 1 }), () => {});
    const successor = presence({ liveness }), dup = presence({ liveness });
    const path = leadPath(s.sessionId);
    const realRename = fs.renameSync;
    let phase: "scan" | "busy" | "done" = "scan";
    t.mock.method(fs, "renameSync", (from: string, to: string) => {
      if (phase !== "scan" || from !== path || !to.endsWith(".sweep")) return realRename(from, to);
      phase = "busy";
      successor.p.start(s, successor.notify); // replaces the judged predecessor before the sweep's rename
      assert.equal(successor.p.status().state, "published");
      realRename(from, to); // the sweep sets the successor's record aside
      if (duplicate) dup.p.start(s, dup.notify); // the path is empty: a create-only publish succeeds
      phase = "done";
    });
    syncBuiltinESMExports();
    let scan;
    try { scan = scanLeads(liveness); } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(phase, "done", "the rename window was exercised");
    assert.equal(scan.swept, 0, "the changed record is not swept");
    assert.deepEqual(readdirSync(leadsDir()), [path.split("/").pop()], "the aside copy is removed; no tomb remains");
    const winner = duplicate ? dup : successor, loser = duplicate ? successor : undefined;
    assert.equal(winner.p.status().state, "published");
    assert.equal(onDisk(s.sessionId)!.generation, winner.p.status().generation, duplicate ? "the newer duplicate record survives the restore" : "the successor's record is restored");
    assert.equal(winner.p.assertOwned().generation, winner.p.status().generation);
    if (loser) {
      assert.throws(() => loser.p.assertOwned(), /not its own/, "the successor no longer owns the record on disk");
      loser.clock.advance(30_000);
      assert.equal(loser.p.status().state, "duplicate", "its next heartbeat sees the other identity and goes inactive");
      assert.match(loser.notes.join("\n"), /another instance/);
      assert.ok(!loser.pi.active().includes("peer"));
      loser.p.stop();
      assert.equal(onDisk(s.sessionId)!.generation, dup.p.status().generation, "its stop leaves the duplicate's record alone");
    } else {
      successor.clock.advance(30_000);
      assert.equal(successor.p.status().state, "published", "the heartbeat keeps a restored owner published");
    }
    winner.p.stop();
    assert.equal(onDisk(s.sessionId), undefined);
  });
}

test("S1 presence: exactly one of several concurrent real processes publishing the same session wins", { timeout: 60000 }, async () => {
  reset();
  const dir = tmpDir("s1-dup-");
  const sessionId = randomUUID();
  const child = fileURLToPath(new URL("./helpers/supervision-dup-child.ts", import.meta.url));
  const procs: ChildProcess[] = [];
  const N = 6;
  try {
    for (let i = 0; i < N; i++) procs.push(spawn(process.execPath, ["--import", "tsx", child, dir, sessionId, String(i)], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "inherit"] }));
    const wait = async (pred: () => boolean, what: string) => { const end = Date.now() + 45_000; while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 20)); } };
    await wait(() => readdirSync(dir).filter(f => f.startsWith("ready-")).length === N, "children ready");
    writeFileSync(join(dir, "go"), "");
    await wait(() => readdirSync(dir).filter(f => f.startsWith("status-")).length === N, "children published");
    const states = Array.from({ length: N }, (_, i) => JSON.parse(readFileSync(join(dir, `status-${i}.json`), "utf8")));
    const winners = states.filter(s => s.state === "published");
    assert.equal(winners.length, 1, `exactly one active owner: ${JSON.stringify(states.map(s => s.state))}`);
    assert.ok(states.every(s => s.state === "published" || s.state === "duplicate" || s.state === "error"), "every loser stays inactive");
    assert.equal(onDisk(sessionId)!.generation, winners[0].generation, "the disk holds the winner, not a later overwrite");
    writeFileSync(join(dir, "release"), "");
    await Promise.all(procs.map(p => p.exitCode !== null ? undefined : new Promise(r => p.once("exit", r))));
    assert.equal(onDisk(sessionId), undefined, "the winner removed its own record; no loser removed anything else");
  } finally { for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); }
});

// ── The real factory: mode, every shutdown reason, reload ────────────

const fakeHerdrState = join(fixtures, "fake-herdr.json");
writeFileSync(fakeHerdrState, JSON.stringify({ calls: [] }));
Object.assign(process.env, { ...HERDR, HERDR_SOCKET_PATH: `${fakeHerdrState}.socket`, FAKE_HERDR_STATE: fakeHerdrState,
  CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url)) });
delete process.env.PI_CONDUCTOR_MODE;
delete process.env.CONDUCTOR_SUBAGENT;

/** The real extension against a pi stub that keeps Pi's tool-activation semantics. */
function loadFactory() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, any>(), commands = new Map<string, any>();
  let active: string[] = ["read", "bash"];
  const pi = {
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => void handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
    registerFlag() {}, getFlag() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {}, appendEntry() {},
    registerTool: (t: { name: string }) => { tools.set(t.name, t); active.push(t.name); },
    registerCommand: (name: string, c: unknown) => void commands.set(name, c),
    getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names.filter(n => tools.has(n) || n === "read" || n === "bash"); },
    getAllTools: () => [...tools.keys(), "read", "bash"].map(name => ({ name })), getSessionName: () => undefined,
  };
  conductor(pi as never);
  const fire = async (ev: string, event: unknown, ctx: unknown) => {
    if (ev === "session_start") opened.push(() => fire("session_shutdown", { reason: "quit" }, ctx));
    for (const h of handlers.get(ev) ?? []) await h(event, ctx);
  };
  return { fire, tools, commands, active: () => active };
}
/** A failed assertion must not leave a runtime's watchdog and wake timers holding the file open. */
const opened: (() => Promise<void>)[] = [];
after(async () => { for (const close of opened) await close(); });
function ctxFor(id: string, cwd: string, notes: string[] = []) {
  const theme = { fg: (_s: string, t: string) => t, bold: (t: string) => t };
  return { cwd, hasUI: false, notes, ui: { notify: (m: string) => void notes.push(m), setWidget() {}, onTerminalInput: () => () => {}, theme },
    sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => null, getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl`, getCwd: () => cwd } };
}
const command = (f: ReturnType<typeof loadFactory>, args: string, ctx: unknown) => f.commands.get("conductor").handler(args, ctx);

test("S1 real factory: OFF at start, /conductor on publishes and activates peer, /conductor off removes; cwd override is not the session cwd", async () => {
  reset();
  const cwd = tmpDir("s1-factory-cwd-"), elsewhere = tmpDir("s1-factory-override-");
  const f = loadFactory();
  assert.ok(f.tools.has("peer"), "a herdr lead registers peer");
  for (const name of ["chief", "staff"]) assert.ok(!f.tools.has(name), `${name} lands with its behaviour (S3/S4), not as a stub`);
  const id = randomUUID(), ctx = ctxFor(id, cwd);
  await f.fire("session_start", { reason: "startup" }, ctx);
  assert.ok(!f.active().includes("peer"), "OFF: peer inactive");
  assert.equal(onDisk(id), undefined);
  await command(f, "on", ctx);
  assert.ok(f.active().includes("peer"));
  await command(f, `cwd ${elsewhere}`, ctx);
  assert.equal(onDisk(id)!.cwd, cwd, "the record reports the native session cwd, not the spawn override");
  const listed = await f.tools.get("peer").execute("call-1", { action: "list" }, undefined, undefined, ctx);
  assert.equal(listed.details.self, id);
  await command(f, "off", ctx);
  assert.equal(onDisk(id), undefined);
  assert.ok(!f.active().includes("peer"));
  await assert.rejects(f.tools.get("peer").execute("call-2", { action: "list" }, undefined, undefined, ctx), /conductor mode OFF/);
  await f.fire("session_shutdown", { reason: "quit" }, ctx);
});

for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
  test(`S1 real factory: session_shutdown(${reason}) removes this lead's record`, async () => {
    reset();
    const f = loadFactory(), id = randomUUID(), ctx = ctxFor(id, tmpDir("s1-factory-"));
    await f.fire("session_start", { reason: "startup" }, ctx);
    await command(f, "on", ctx);
    assert.ok(onDisk(id));
    await f.fire("session_shutdown", { reason }, ctx);
    assert.equal(onDisk(id), undefined);
    await assert.rejects(f.tools.get("peer").execute("late", { action: "list" }, undefined, undefined, ctx), /peer unavailable/, "a stale runtime's tool refuses");
  });
}

test("S1 real factory: reload republishes an ON-by-default lead under a fresh epoch; a toggled ON does not survive reload", async () => {
  reset();
  const cwd = tmpDir("s1-reload-"), id = randomUUID(), ctx = ctxFor(id, cwd);
  // `defaultMode: "on"` in user config: the documented ON-by-default path (it outranks PI_CONDUCTOR_MODE).
  const config = join(process.env.HOME!, ".pi", "agent", "extensions", "conductor", "config.json");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ defaultMode: "on" }));
  try {
    const before = loadFactory();
    await before.fire("session_start", { reason: "startup" }, ctx);
    const first = onDisk(id)!;
    assert.ok(first, "an ON-by-default herdr lead publishes at session start");
    await before.fire("session_shutdown", { reason: "reload" }, ctx);
    const after = loadFactory();
    await after.fire("session_start", { reason: "reload" }, ctx);
    const second = onDisk(id)!;
    assert.notEqual(second.generation, first.generation);
    assert.equal(second.sessionId, id);
    await after.fire("session_shutdown", { reason: "quit" }, ctx);
  } finally { rmSync(config); }
  const toggled = loadFactory();
  await toggled.fire("session_start", { reason: "startup" }, ctx);
  await command(toggled, "on", ctx);
  await toggled.fire("session_shutdown", { reason: "reload" }, ctx);
  const reloaded = loadFactory();
  await reloaded.fire("session_start", { reason: "reload" }, ctx);
  assert.equal(onDisk(id), undefined, "conductor-mode persistence is unchanged: the toggle is per runtime");
  assert.ok(!reloaded.active().includes("peer"));
  await reloaded.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("S1 real factory: peer list shows another lead by exact id, excludes self, and made no herdr CLI call", async () => {
  reset();
  const a = loadFactory(), b = loadFactory();
  const idA = randomUUID(), idB = randomUUID(), ctxA = ctxFor(idA, tmpDir("s1-a-")), ctxB = ctxFor(idB, tmpDir("s1-b-"));
  for (const [f, ctx] of [[a, ctxA], [b, ctxB]] as const) { await f.fire("session_start", { reason: "startup" }, ctx); await command(f, "on", ctx); }
  const listed = (await a.tools.get("peer").execute("c", { action: "list" }, undefined, undefined, ctxA)).details;
  assert.equal(listed.self, idA);
  assert.deepEqual(listed.peers.map((p: { lead: string }) => p.lead), [idB]);
  assert.deepEqual(Object.keys(listed.peers[0]).sort(), ["branch", "cwd", "lead", "name", "repo", "state", "workspace_label"]);
  assert.equal(listed.peers[0].state, "live");
  for (const [f, ctx] of [[a, ctxA], [b, ctxB]] as const) await f.fire("session_shutdown", { reason: "quit" }, ctx);
  assert.deepEqual(JSON.parse(readFileSync(fakeHerdrState, "utf8")).calls, [], "supervision never invokes the herdr CLI");
  assert.ok(!existsSync(join(leadsDir(), `${leadPath(idA).split("/").pop()}`)));
});
