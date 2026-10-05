/**
 * S3 chief role: `/chief` lets an eligible, owned S1 lead claim its exact
 * socket's lease, record `conductor-role {role:"chief", generation}` on its
 * branch, and gain `staff` additively (every other active tool untouched).
 * OFF, every shutdown reason and a session switch release only its own claim
 * and keep the intent; session start and ON reclaim from the intent only when
 * the lease is free. A 30 s tick and every `staff` call re-assert the lease;
 * a failure demotes. `staff list` shows this exact socket's other leads.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { makeFakeClock } from "./helpers/fake-clock.ts";
import { RunRegistry } from "../src/runs.ts";
import { probeHerdrOwner } from "../src/herdr/ownership.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";
import { LeadPresence } from "../src/supervision/presence.ts";
import { buildLeadRecord, createLeadRecord, leadPath, readLeadRecord, supervisionRoot } from "../src/supervision/store.ts";
import { ChiefRole, chiefLeaseDir, claimChiefLease, readChiefLease, releaseChiefLease, CHIEF_ROLE_ENTRY, branchRole } from "../src/supervision/lease.ts";
import { registerStaffTool, STAFF_LIST_MAX_BYTES } from "../src/supervision/tools.ts";
import conductor from "../src/index.ts";

sandboxPi();
const fixtures = tmpDir("s3-chief-");
const SOCKET = join(fixtures, "fake.sock");
const HERDR = { HERDR_ENV: "1", HERDR_SOCKET_PATH: SOCKET, HERDR_PANE_ID: "pane-1" };
const START = readProcessStartTime(process.pid);
const reset = () => rmSync(supervisionRoot(), { recursive: true, force: true });
const leaseFiles = (sock = SOCKET) => existsSync(chiefLeaseDir(sock)) ? readdirSync(chiefLeaseDir(sock)).sort() : [];
const session = (flushed = false) => {
  const sessionId = randomUUID(), sessionFile = join(fixtures, `${sessionId}.jsonl`);
  if (flushed) writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: sessionId })}\n`);
  return { sessionId, sessionFile, cwd: "/work/api" };
};
type Entry = { type: "custom"; customType: string; data: unknown };

function fakePi(registered = ["read", "bash", "peer", "staff", "foreign"]) {
  let active = [...registered];
  const sets: string[][] = [], entries: Entry[] = [];
  const tools = new Map<string, any>();
  const pi = {
    failAppend: undefined as Error | undefined,
    api: {
      getActiveTools: () => [...active],
      setActiveTools: (names: string[]) => { sets.push([...names]); active = names.filter(n => registered.includes(n)); },
      getAllTools: () => registered.map(name => ({ name })),
      getSessionName: () => "api lead",
      // Pi pushes the entry into memory before its file write, which is what throws.
      appendEntry: (customType: string, data: unknown) => { entries.push({ type: "custom", customType, data }); if (pi.failAppend) throw pi.failAppend; },
      registerTool: (t: { name: string }) => void tools.set(t.name, t),
    },
    active: () => active, sets, entries, tools,
    foreign: (names: string[]) => { active = names; }, // another extension's setActiveTools
  };
  return pi;
}

function lead(over: { pi?: ReturnType<typeof fakePi>; env?: NodeJS.ProcessEnv; clock?: ReturnType<typeof makeFakeClock>; timers?: unknown; liveness?: object; flushed?: boolean; s?: ReturnType<typeof session> } = {}) {
  const pi = over.pi ?? fakePi();
  const clock = over.clock ?? makeFakeClock(1_000_000);
  const notes: string[] = [];
  let on = true;
  const presence = new LeadPresence({ pi: pi.api as never, env: over.env ?? HERDR, registry: new RunRegistry(), getMode: () => on, now: clock.deps.now,
    timers: (over.timers ?? clock.deps) as never, liveness: over.liveness as never, describeRepo: () => ({ repo: "api", branch: "main" }) });
  presence.ownTool("peer");
  const chief = new ChiefRole({ pi: pi.api as never, presence, timers: (over.timers ?? clock.deps) as never });
  registerStaffTool(pi.api as never, presence, chief, { getRegistry: () => new RunRegistry(), getCwd: () => fixtures });
  const s = over.s ?? session(over.flushed);
  const notify = (m: string) => void notes.push(m);
  return {
    pi, presence, chief, clock, notes, s,
    start() { presence.start(s, notify); chief.start({ getBranch: () => pi.entries }, notify); },
    mode(value: boolean) { on = value; presence.refresh(); chief.refresh(); },
    stop() { chief.stop(); presence.stop(); },
    staff: (args: object = { action: "list" }) => pi.tools.get("staff").execute("call", args),
  };
}
const peerRecord = (over: { sessionId?: string; socketPath?: string; pid?: number; displayName?: string; runs?: { active: number; blocked: number; total: number } } = {}) =>
  createLeadRecord(buildLeadRecord({ sessionId: over.sessionId ?? randomUUID(), sessionFile: "/sessions/peer.jsonl", generation: randomUUID(), pid: over.pid ?? process.pid,
    ...(START !== undefined ? { pidStartTime: START } : {}), socketPath: over.socketPath ?? SOCKET, paneId: "pane-peer", cwd: "/work/peer", repo: "peer", branch: "dev",
    displayName: over.displayName ?? "peer lead", runs: over.runs ?? { active: 1, blocked: 0, total: 2 }, runsBrief: [], updatedAt: 1_000_000 }), () => {});
const lastRole = (entries: Entry[]) => entries.filter(e => e.customType === CHIEF_ROLE_ENTRY).at(-1)?.data;

// ── Preconditions ────────────────────────────────────────────────────

test("S3 /chief: refused while OFF, without a saved session, as a duplicate presence, or when the native tool policy leaves out staff; nothing is claimed", () => {
  reset();
  const off = lead();
  off.start(); off.mode(false);
  assert.throws(() => off.chief.become(), /chief unavailable: conductor mode OFF/);
  off.stop();
  const unsaved = lead({ s: { ...session(), sessionFile: undefined as never } });
  unsaved.start();
  assert.throws(() => unsaved.chief.become(), /chief unavailable: no saved session file/);
  unsaved.stop();
  const owner = lead(), s = owner.s;
  owner.start();
  const dup = lead({ s });
  dup.start();
  assert.throws(() => dup.chief.become(), /chief unavailable: .*already has a live lead presence/);
  dup.stop(); owner.stop();
  const narrow = lead({ pi: fakePi(["read", "peer"]) });
  narrow.start();
  assert.throws(() => narrow.chief.become(), /tool policy leaves out `staff`; no lease claimed/);
  assert.deepEqual(narrow.pi.entries, [], "no role intent without a claim");
  narrow.stop();
  assert.deepEqual(leaseFiles(), [], "no refusal claimed anything");
  for (const ctx of [off, unsaved, dup, narrow]) assert.ok(!ctx.pi.active().includes("staff"), "staff stays inactive");
});

// ── Additive activation, leave ───────────────────────────────────────

test("S3 /chief: adds only staff; another extension's tool changes before and after survive leave (no snapshot or restore)", () => {
  reset();
  const ctx = lead({ pi: fakePi(["read", "bash", "peer", "staff", "foreign", "foreign2"]) });
  ctx.pi.foreign(["read", "bash", "peer", "staff", "foreign"]);
  ctx.start();
  assert.deepEqual(ctx.pi.active(), ["read", "bash", "peer", "foreign"], "a published lead: staff inactive, everything else as Pi had it");
  ctx.pi.foreign(["read", "peer", "foreign"]); // a foreign extension drops bash before /chief
  const message = ctx.chief.become();
  assert.match(message, /chief of this herdr socket \(lease generation 0\)/);
  assert.deepEqual(ctx.pi.active(), ["read", "peer", "foreign", "staff"], "staff appended; bash stays dropped");
  assert.deepEqual(lastRole(ctx.pi.entries), { role: "chief", generation: 0 }, "the intent records the claimed generation");
  ctx.pi.foreign(["peer", "foreign", "staff", "foreign2"]); // while chief: drops read, adds foreign2
  assert.match(ctx.chief.leave(), /lease generation 0 released and `staff` removed/);
  assert.deepEqual(ctx.pi.active(), ["peer", "foreign", "foreign2"], "leave removes only staff; read is not restored and foreign2 is kept");
  assert.deepEqual(lastRole(ctx.pi.entries), { role: "lead" });
  assert.deepEqual(leaseFiles(), ["000000.json", "000000.json.released"], "only its own generation is released");
  assert.match(ctx.chief.leave(), /not the chief: no lease held; this session's role is lead/);
  ctx.stop();
});

test("S3 /chief: a native allowlist that omits staff is never widened, and an explicitly excluded tool is never re-added", () => {
  reset();
  const ctx = lead({ pi: fakePi(["read", "peer", "staff"]) });
  ctx.start();
  ctx.pi.foreign(["peer"]); // e.g. the user excluded read for this session
  ctx.chief.become();
  assert.deepEqual(ctx.pi.active(), ["peer", "staff"]);
  ctx.presence.syncTools(); ctx.presence.syncTools();
  assert.deepEqual(ctx.pi.active(), ["peer", "staff"], "re-syncing at every turn re-adds nothing");
  ctx.chief.stop();
  assert.deepEqual(ctx.pi.active(), ["peer"], "the chief's stop removes only staff");
  ctx.presence.stop();
});

// ── OFF, ON, intent restore ──────────────────────────────────────────

test("S3 OFF while chief releases the lease and removes staff before the next turn, keeps the intent; ON reclaims the next generation; a stale timer touches nothing", () => {
  reset();
  const callbacks: (() => void)[] = [];
  const timers = { setTimeout: (cb: () => void) => { callbacks.push(cb); return callbacks.length; }, clearTimeout: () => {} };
  const ctx = lead({ timers });
  ctx.start();
  ctx.chief.become();
  const stale = [...callbacks];
  ctx.mode(false);
  assert.ok(!ctx.pi.active().includes("staff") && !ctx.pi.active().includes("peer"), "OFF removes staff and peer");
  assert.deepEqual(leaseFiles(), ["000000.json", "000000.json.released"]);
  assert.deepEqual(lastRole(ctx.pi.entries), { role: "chief", generation: 0 }, "OFF keeps the persisted intent");
  assert.match(ctx.notes.join("\n"), /chief lease generation 0 released \(.*conductor mode OFF\); `staff` removed/);
  ctx.mode(true);
  assert.equal(readChiefLease(SOCKET).holder?.generation, 1, "ON reclaims at the next generation");
  assert.ok(ctx.pi.active().includes("staff"));
  assert.match(ctx.notes.join("\n"), /reclaimed the chief lease \(generation 1\)/);
  for (const cb of stale) cb();
  assert.equal(ctx.chief.status().generation, 1, "the released claim's timer cannot demote the new one");
  assert.deepEqual(leaseFiles(), ["000000.json", "000000.json.released", "000001.json"], "nor release it");
  ctx.stop();
  assert.deepEqual(leaseFiles(), ["000000.json", "000000.json.released", "000001.json", "000001.json.released"]);
});

test("S3 session start with a chief intent reclaims; an occupied lease leaves an ordinary lead with one diagnostic and no takeover", () => {
  reset();
  const first = lead();
  first.start(); first.chief.become(); first.stop();
  const resumed = lead({ s: first.s });
  resumed.pi.entries.push(...first.pi.entries);
  resumed.start();
  assert.equal(resumed.chief.status().role, "chief");
  assert.equal(readChiefLease(SOCKET).holder?.epoch, resumed.chief.epoch, "a fresh epoch, not the previous instance's");
  assert.notEqual(resumed.chief.epoch, first.chief.epoch);
  resumed.chief.stop();
  const other = claimChiefLease(SOCKET, { sessionId: "other-lead", sessionFile: "/sessions/other.jsonl", pid: process.pid, ...(START !== undefined ? { startTime: START } : {}), epoch: randomUUID() });
  resumed.presence.stop();
  const occupied = lead({ s: first.s });
  occupied.pi.entries.push(...first.pi.entries);
  occupied.start();
  assert.equal(occupied.chief.status().role, "lead");
  assert.ok(!occupied.pi.active().includes("staff"));
  assert.equal(occupied.notes.filter(n => /chief intent was not restored/.test(n)).length, 1);
  assert.match(occupied.notes.join("\n"), /held by lead other-lead .*not taken over\. It stays an ordinary lead/);
  assert.deepEqual(readChiefLease(SOCKET).holder, other, "the live holder is untouched");
  assert.throws(() => occupied.chief.become(), /held by lead other-lead/);
  occupied.stop();
  releaseChiefLease(other);
});

test("S3 role intent: only the latest well-formed conductor-role entry on the branch counts; anything malformed is a lead", () => {
  const e = (data: unknown) => ({ type: "custom", customType: CHIEF_ROLE_ENTRY, data });
  assert.equal(branchRole([]), "lead");
  assert.equal(branchRole([e({ role: "chief", generation: 3 })]), "chief");
  assert.equal(branchRole([e({ role: "chief", generation: 3 }), e({ role: "lead" })]), "lead");
  assert.equal(branchRole([e({ role: "chief", generation: 3 }), e({ role: "chief" })]), "lead", "a malformed latest entry grants nothing");
  assert.equal(branchRole([e({ role: "chief", generation: 3 }), e("chief")]), "lead");
  assert.equal(branchRole([{ type: "custom_message", customType: CHIEF_ROLE_ENTRY, data: { role: "chief", generation: 1 } }]), "lead", "only custom entries");
  assert.equal(branchRole([e({ role: "chief", generation: 3 }), { type: "custom", customType: "conductor-cwd", data: {} }]), "chief");
});

// ── Fencing ──────────────────────────────────────────────────────────

test("S3 tick: the 30 s assert never rewrites the claim, and a fenced tick demotes once: staff removed, one notice", () => {
  reset();
  const ctx = lead();
  ctx.start(); ctx.chief.become();
  const before = leaseFiles().map(f => readFileSync(join(chiefLeaseDir(SOCKET), f), "utf8"));
  ctx.clock.advance(90_000);
  assert.deepEqual(leaseFiles().map(f => readFileSync(join(chiefLeaseDir(SOCKET), f), "utf8")), before, "append-only: no heartbeat rewrite");
  assert.equal(ctx.chief.status().role, "chief");
  writeFileSync(join(chiefLeaseDir(SOCKET), "000009.json.released"), "{}", { mode: 0o600 });
  ctx.clock.advance(30_000);
  assert.equal(ctx.chief.status().role, "lead");
  assert.ok(!ctx.pi.active().includes("staff"), "demotion removes staff");
  assert.ok(ctx.pi.active().includes("peer"), "and only staff");
  assert.equal(ctx.notes.filter(n => /chief role lost/.test(n)).length, 1);
  ctx.clock.advance(120_000);
  assert.equal(ctx.notes.filter(n => /chief role lost/.test(n)).length, 1, "bounded: the demoted claim has no timer left");
  ctx.stop();
});

test("S3 tick: every chief timer is unref'd", () => {
  reset();
  const handles: NodeJS.Timeout[] = [];
  const ctx = lead({ timers: { setTimeout: (cb: () => void, ms: number) => { const h = setTimeout(cb, ms); handles.push(h); return h; }, clearTimeout } });
  ctx.start(); ctx.chief.become();
  assert.ok(handles.length >= 2 && handles.every(h => !h.hasRef()));
  ctx.stop();
});

test("S3 staff: rejects unless this lead holds the lease; a lease lost during the listing is caught before anything is returned", async () => {
  reset();
  const LATE = 4_000_001;
  let sabotage = () => {};
  const liveness = { platform: "linux", probe: (pid: number) => { if (pid === LATE) { sabotage(); return { state: "alive" as const, startTime: 77 }; } return probeHerdrOwner(pid); } };
  const ctx = lead({ liveness });
  ctx.start();
  await assert.rejects(ctx.staff(), /staff unavailable: this lead does not hold the chief lease/);
  ctx.chief.become();
  createLeadRecord(buildLeadRecord({ sessionId: "late-peer", sessionFile: "/s/late.jsonl", generation: randomUUID(), pid: LATE, pidStartTime: 77, socketPath: SOCKET, paneId: "p",
    cwd: "/w", displayName: "late", runs: { active: 0, blocked: 0, total: 0 }, runsBrief: [], updatedAt: 1_000_000 }), () => {});
  assert.equal((await ctx.staff()).details.leads.length, 1, "a working list");
  // Another holder's history appears mid-listing (here: a malformed marker), after the first check passed.
  sabotage = () => { sabotage = () => {}; writeFileSync(join(chiefLeaseDir(SOCKET), "000005.json.released"), "{}", { mode: 0o600 }); };
  await assert.rejects(ctx.staff(), /staff unavailable: chief lease generation 0 fenced/);
  assert.equal(ctx.chief.status().role, "lead", "the failure demotes");
  assert.ok(!ctx.pi.active().includes("staff"));
  await assert.rejects(ctx.staff(), /does not hold the chief lease/, "a call issued in the same turn, while the native list still shows staff, rejects");
  ctx.stop();
});

test("S3 staff list: this exact socket's other leads by exact full id with state, run counts and advisory actions; self, prefix sockets and labels excluded", async () => {
  reset();
  const UNKNOWN = 4_000_002;
  const ctx = lead({ liveness: { platform: "linux", probe: (pid: number) => pid === UNKNOWN ? { state: "unknown" as const } : probeHerdrOwner(pid) } });
  ctx.start(); ctx.chief.become();
  const same = "aaaa-same-socket-lead", unknown = "bbbb-unknown-lead";
  peerRecord({ sessionId: same, displayName: ctx.s.sessionId, runs: { active: 2, blocked: 1, total: 5 } }); // a name that looks like an id grants nothing
  createLeadRecord(buildLeadRecord({ sessionId: unknown, sessionFile: "/s/u.jsonl", generation: randomUUID(), pid: UNKNOWN, pidStartTime: 9, socketPath: SOCKET, paneId: "p",
    cwd: "/w", displayName: "u", runs: { active: 0, blocked: 0, total: 0 }, runsBrief: [], updatedAt: 1_000_000 }), () => {});
  for (const socketPath of [`${SOCKET}2`, SOCKET.slice(0, -1), `${SOCKET}/`, join(fixtures, "other.sock")]) peerRecord({ socketPath });
  const { details, content } = await ctx.staff();
  assert.equal(details.self, ctx.s.sessionId);
  assert.equal(details.generation, 0);
  assert.deepEqual(details.leads.map((l: { lead: string }) => l.lead), [same, unknown], "exact socket only, self excluded, sorted by exact id");
  assert.deepEqual(details.leads[0], { lead: same, name: ctx.s.sessionId, cwd: "/work/peer", repo: "peer", branch: "dev", state: "live", runs: { active: 2, blocked: 1, total: 5 }, available_actions: ["staff transcript", "staff message"] });
  assert.deepEqual([details.leads[1].state, details.leads[1].available_actions], ["unknown", []], "an unproven lead offers no action");
  assert.equal(JSON.parse(content[0].text).self, ctx.s.sessionId);
  for (let i = 0; i < 120; i++) peerRecord({ displayName: "x".repeat(200) });
  const big = await ctx.staff();
  assert.ok(Buffer.byteLength(JSON.stringify(big.details)) <= STAFF_LIST_MAX_BYTES && big.details.truncated === true, "bounded at 16 KiB");
  assert.deepEqual(Object.keys(ctx.pi.tools.get("staff").parameters.properties), ["action", "lead", "message", "ask_id", "files"], "S4 adds transcript, message and reply");
  ctx.stop();
});

// ── Session role entry truthfulness ──────────────────────────────────

test("S3 /chief: a failed role append activates nothing, releases the claim, leaves a lead intent in memory and says so", () => {
  reset();
  const ctx = lead({ flushed: true });
  ctx.start();
  ctx.pi.failAppend = Object.assign(new Error("EACCES: permission denied, open session.jsonl"), { code: "EACCES" });
  assert.throws(() => ctx.chief.become(), /chief not activated: this session could not record the chief role \(EACCES: permission denied.*\); lease generation 0 released/);
  assert.equal(ctx.chief.status().role, "lead");
  assert.ok(!ctx.pi.active().includes("staff"), "no false activation");
  assert.deepEqual(leaseFiles(), ["000000.json", "000000.json.released"]);
  assert.equal(branchRole(ctx.pi.entries), "lead", "the in-memory branch ends on a lead intent, so a reload claims nothing");
  ctx.pi.failAppend = undefined;
  assert.match(ctx.chief.become(), /lease generation 1/);
  ctx.stop();
});

test("S3 /chief: before Pi has written the session file, activation says the intent is not on disk yet; it never claims durability", () => {
  reset();
  const unflushed = lead();
  unflushed.start();
  const message = unflushed.chief.become();
  assert.match(message, /not on disk yet/);
  assert.doesNotMatch(message, /\b(saved|persisted|durabl)/i);
  unflushed.stop();
  const flushed = lead({ flushed: true });
  flushed.start();
  const ok = flushed.chief.become();
  assert.doesNotMatch(ok, /not on disk yet|\b(saved|persisted|durabl)/i);
  assert.match(ok, /the lease, not the intent, is the authority/i);
  flushed.stop();
});

// ── The real factory: /chief, addendum, reload ───────────────────────

const fakeHerdrState = join(fixtures, "fake-herdr.json");
writeFileSync(fakeHerdrState, JSON.stringify({ calls: [] }));
Object.assign(process.env, { ...HERDR, FAKE_HERDR_STATE: fakeHerdrState, CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url)) });
delete process.env.PI_CONDUCTOR_MODE;
delete process.env.CONDUCTOR_SUBAGENT;

function loadFactory(branch: Entry[]) {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>();
  const tools = new Map<string, any>(), commands = new Map<string, any>();
  let active: string[] = ["read", "bash"];
  const pi = {
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => void handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
    registerFlag() {}, getFlag() {}, registerShortcut() {}, registerMessageRenderer() {}, sendMessage() {},
    appendEntry: (customType: string, data: unknown) => void branch.push({ type: "custom", customType, data }),
    registerTool: (t: { name: string }) => { tools.set(t.name, t); active.push(t.name); },
    registerCommand: (name: string, c: unknown) => void commands.set(name, c),
    getActiveTools: () => [...active], setActiveTools: (names: string[]) => { active = names.filter(n => tools.has(n) || n === "read" || n === "bash"); },
    getAllTools: () => [...tools.keys(), "read", "bash"].map(name => ({ name })), getSessionName: () => undefined,
  };
  conductor(pi as never);
  const fire = async (ev: string, event: unknown, ctx: unknown) => {
    if (ev === "session_start") opened.push(async () => { await fire("session_shutdown", { reason: "quit" }, ctx); });
    let result: unknown;
    for (const h of handlers.get(ev) ?? []) result = (await h(event, ctx)) ?? result;
    return result as { systemPrompt?: string } | undefined;
  };
  return { fire, tools, commands, active: () => active };
}
const opened: (() => Promise<void>)[] = [];
after(async () => { for (const close of opened) await close(); });
function ctxFor(id: string, cwd: string, branch: Entry[], notes: string[] = []) {
  const theme = { fg: (_s: string, t: string) => t, bold: (t: string) => t };
  return { cwd, hasUI: false, notes, isIdle: () => true, hasPendingMessages: () => false,
    ui: { notify: (m: string) => void notes.push(m), setWidget() {}, onTerminalInput: () => () => {}, theme },
    sessionManager: { getBranch: () => branch, getEntries: () => branch, getLeafId: () => null, getSessionId: () => id, getSessionFile: () => join(cwd, `${id}.jsonl`), getCwd: () => cwd } };
}
const slash = (f: ReturnType<typeof loadFactory>, name: string, args: string, ctx: unknown) => f.commands.get(name).handler(args, ctx);

test("S3 real factory: /chief claims, records the role, adds staff; repeat /chief prints staff list; the chief addendum follows the conductor addendum; /chief leave", async () => {
  reset();
  const branch: Entry[] = [], notes: string[] = [];
  const f = loadFactory(branch);
  assert.ok(f.tools.has("staff") && f.commands.has("chief"), "a herdr lead registers staff and /chief");
  assert.ok(f.tools.has("chief"), "S4 registers the chief tool with its behaviour");
  const id = randomUUID(), ctx = ctxFor(id, tmpDir("s3-factory-"), branch, notes);
  await f.fire("session_start", { reason: "startup" }, ctx);
  await slash(f, "conductor", "on", ctx);
  assert.ok(f.active().includes("peer") && !f.active().includes("staff"), "ON: peer, not staff");
  const base = await f.fire("before_agent_start", { systemPrompt: "BASE" }, ctx);
  assert.doesNotMatch(base!.systemPrompt!, /Chief of this herdr socket/, "no chief addendum for a lead");
  await slash(f, "chief", "", ctx);
  assert.match(notes.at(-1)!, /chief of this herdr socket \(lease generation 0\)/);
  assert.ok(f.active().includes("staff"));
  assert.deepEqual(lastRole(branch), { role: "chief", generation: 0 });
  const prompt = (await f.fire("before_agent_start", { systemPrompt: "BASE" }, ctx))!.systemPrompt!;
  const conductorAt = prompt.indexOf("You are running in **pi-conductor** mode"), chiefAt = prompt.indexOf("## Chief of this herdr socket");
  assert.ok(prompt.startsWith("BASE") && conductorAt > 0 && chiefAt > conductorAt, "BASE, then the conductor addendum, then the chief addendum");
  assert.match(prompt.slice(chiefAt), /exact full session id/);
  assert.match(prompt.slice(chiefAt), /never by name/);
  assert.match(prompt.slice(chiefAt), /Do not poll/);
  assert.match(prompt.slice(chiefAt), /untrusted/);
  await slash(f, "chief", "", ctx);
  assert.equal(JSON.parse(notes.at(-1)!).self, id, "repeating /chief prints staff list");
  const listed = await f.tools.get("staff").execute("c1", { action: "list" }, undefined, undefined, ctx);
  assert.deepEqual(listed.details.leads, []);
  await slash(f, "chief", "bogus", ctx);
  assert.match(notes.at(-1)!, /usage: \/chief \[leave\]/);
  await slash(f, "chief", "leave", ctx);
  assert.ok(!f.active().includes("staff") && f.active().includes("peer"));
  assert.deepEqual(lastRole(branch), { role: "lead" });
  assert.doesNotMatch((await f.fire("before_agent_start", { systemPrompt: "BASE" }, ctx))!.systemPrompt!, /Chief of this herdr socket/);
  await assert.rejects(f.tools.get("staff").execute("c2", { action: "list" }, undefined, undefined, ctx), /does not hold the chief lease/);
  await f.fire("session_shutdown", { reason: "quit" }, ctx);
  assert.deepEqual(JSON.parse(readFileSync(fakeHerdrState, "utf8")).calls, [], "S3 never invokes the herdr CLI");
});

for (const reason of ["quit", "reload", "new", "resume", "fork"] as const) {
  test(`S3 real factory: session_shutdown(${reason}) releases only this chief's own lease and keeps the intent`, async () => {
    reset();
    const branch: Entry[] = [];
    const f = loadFactory(branch), ctx = ctxFor(randomUUID(), tmpDir("s3-shutdown-"), branch);
    await f.fire("session_start", { reason: "startup" }, ctx);
    await slash(f, "conductor", "on", ctx);
    await slash(f, "chief", "", ctx);
    await f.fire("session_shutdown", { reason }, ctx);
    assert.deepEqual(leaseFiles(), ["000000.json", "000000.json.released"]);
    assert.equal(branchRole(branch), "chief");
    await assert.rejects(f.tools.get("staff").execute("late", { action: "list" }, undefined, undefined, ctx), /staff unavailable/, "a stale runtime's staff refuses");
  });
}

test("S3 real factory: reload with ON by default reclaims the next generation under a fresh epoch; a toggled ON waits for /conductor on", async () => {
  reset();
  const cwd = tmpDir("s3-reload-"), id = randomUUID(), branch: Entry[] = [], notes: string[] = [];
  const ctx = ctxFor(id, cwd, branch, notes);
  const config = join(process.env.HOME!, ".pi", "agent", "extensions", "conductor", "config.json");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ defaultMode: "on" }));
  try {
    const before = loadFactory(branch);
    await before.fire("session_start", { reason: "startup" }, ctx);
    await slash(before, "chief", "", ctx);
    const first = readChiefLease(SOCKET).holder!;
    await before.fire("session_shutdown", { reason: "reload" }, ctx);
    const after = loadFactory(branch);
    await after.fire("session_start", { reason: "reload" }, ctx);
    const second = readChiefLease(SOCKET).holder!;
    assert.equal(second.generation, first.generation + 1, "the released generation is followed, never reused");
    assert.notEqual(second.epoch, first.epoch, "a fresh epoch per module instance");
    assert.ok(after.active().includes("staff"));
    await assert.rejects(before.tools.get("staff").execute("old", { action: "list" }, undefined, undefined, ctx), /staff unavailable/, "the old instance's tool refuses");
    assert.equal((await after.tools.get("staff").execute("new", { action: "list" }, undefined, undefined, ctx)).details.generation, second.generation);
    await after.fire("session_shutdown", { reason: "reload" }, ctx);
  } finally { rmSync(config); }
  const toggled = loadFactory(branch);
  await toggled.fire("session_start", { reason: "reload" }, ctx);
  assert.ok(!toggled.active().includes("staff"), "OFF after reload: no reclaim");
  assert.equal(readChiefLease(SOCKET).released, true);
  await slash(toggled, "conductor", "on", ctx);
  assert.ok(toggled.active().includes("staff"), "ON reclaims from the retained intent");
  assert.equal(readChiefLease(SOCKET).holder!.generation, 2);
  await toggled.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("S3 doctor reports the chief role and the staff tool", async () => {
  reset();
  const branch: Entry[] = [], notes: string[] = [];
  const f = loadFactory(branch), ctx = ctxFor(randomUUID(), tmpDir("s3-doctor-"), branch, notes);
  await f.fire("session_start", { reason: "startup" }, ctx);
  await slash(f, "conductor", "on", ctx);
  await slash(f, "conductor", "doctor", ctx);
  assert.match(notes.at(-1)!, /chief: lead \(no chief lease held\); staff tool: inactive/);
  await slash(f, "chief", "", ctx);
  await slash(f, "conductor", "doctor", ctx);
  assert.match(notes.at(-1)!, /chief: lease generation 0 held for this herdr socket; staff tool: active/);
  await f.fire("session_shutdown", { reason: "quit" }, ctx);
});

test("S4 real factory: a lead gets chief, not staff; the presence mirror and the panel footer follow the branch ask at turn end and after /tree", async () => {
  reset();
  const branch: Entry[] = [], notes: string[] = [];
  const f = loadFactory(branch);
  const id = randomUUID(), ctx = ctxFor(id, tmpDir("s4-factory-"), branch, notes);
  let panel: ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  (ctx.ui as { setWidget: unknown }).setWidget = (_key: string, w: typeof panel) => { panel = w; };
  await f.fire("session_start", { reason: "startup" }, ctx);
  await slash(f, "conductor", "on", ctx);
  assert.ok(f.active().includes("chief") && !f.active().includes("staff"));
  const record = () => readLeadRecord(leadPath(id));
  assert.equal(record()?.pendingAsk, undefined);
  // Pi recorded a successful `chief ask` result on the branch.
  branch.push({ type: "message", message: { role: "toolResult", toolCallId: "call-1", toolName: "chief", isError: false, content: [],
    details: { action: "ask", askId: "call-1", question: "main or dev?", askedAt: 7, chief: "c", leaseGeneration: 0 } } } as never);
  await f.fire("turn_end", {}, ctx);
  assert.deepEqual(record()?.pendingAsk, { askId: "call-1", question: "main or dev?", askedAt: 7 });
  const theme = { fg: (_s: string, t: string) => t, bold: (t: string) => t };
  assert.match(panel!(undefined, theme).render(120).join("\n"), /⧗ waiting on chief: main or dev\?/);
  branch.pop(); // /tree back to before the ask
  await f.fire("session_tree", {}, ctx);
  assert.equal(record()?.pendingAsk, undefined, "the mirror follows the rewind");
  assert.equal(panel, undefined, "no runs and no ask: the panel clears");
  await slash(f, "chief", "", ctx);
  assert.ok(f.active().includes("staff") && !f.active().includes("chief"), "the holder: staff, and its own chief tool removed");
  await f.fire("session_shutdown", { reason: "quit" }, ctx);
  assert.deepEqual(JSON.parse(readFileSync(fakeHerdrState, "utf8")).calls, [], "S4 never invokes the herdr CLI");
});
