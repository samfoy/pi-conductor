/**
 * S1 lead presence store: one bounded private record per exact pi session id.
 * Records are presentation evidence for `peer list`, never a capability, and
 * only a proven-dead (or, off Linux, 10-minute-stale) record is ever swept.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { sandboxPi } from "./helpers/tmp.ts";
import {
  LEAD_RECORD_MAX_BYTES, LEAD_RUNS_BRIEF_MAX, LEAD_SCAN_MAX, buildLeadRecord, createLeadRecord, ensureLeadsDir, leadLiveness, leadPath, leadsDir,
  readLeadRecord, removeLeadRecordIf, replaceLeadRecord, sameLeadIdentity, scanLeads, supervisionRoot, validLeadRecord, type LeadRecord,
} from "../src/supervision/store.ts";
import { PEER_LIST_MAX_BYTES, peerListing } from "../src/supervision/tools.ts";

const { home } = sandboxPi();
const SELF_START = 4242;
/** A probe that reports every pid alive with one start time; `dead` pids are ESRCH. */
const probeWith = (dead: number[] = [], start = SELF_START) => (pid: number) =>
  dead.includes(pid) ? { state: "gone" as const } : { state: "alive" as const, startTime: start };
const LINUX = { platform: "linux", probe: probeWith(), now: () => 1_000_000 };

function fields(over: Partial<LeadRecord> = {}): Omit<LeadRecord, "v" | "role"> {
  const sessionId = over.sessionId ?? randomUUID();
  return {
    sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, generation: randomUUID(), pid: 4000, pidStartTime: SELF_START,
    socketPath: "/tmp/herdr.sock", paneId: "pane-1", tabId: "tab-1", workspaceId: "ws-1", cwd: "/work/api", repo: "api", branch: "main",
    displayName: "api lead", runs: { active: 0, blocked: 0, total: 0 }, runsBrief: [], updatedAt: 1_000_000, ...over,
  };
}
const record = (over: Partial<LeadRecord> = {}) => buildLeadRecord(fields(over));
const publish = (r: LeadRecord) => createLeadRecord(r, () => {});
const names = () => readdirSync(leadsDir()).sort();
function reset() { fs.rmSync(supervisionRoot(), { recursive: true, force: true }); }

test("S1 store: records live at supervision/leads/<sha256(exact session id)>.json under HOME", () => {
  const id = "019a-session";
  assert.equal(leadPath(id), join(home, ".pi", "agent", "conductor", "supervision", "leads", `${createHash("sha256").update(id).digest("hex")}.json`));
  assert.notEqual(leadPath(id), leadPath(`${id} `), "the exact id, not a normalized prefix, names the file");
});

test("S1 store: a record is at most 4 KiB with at most 24 run briefs, trimming briefs first", () => {
  const brief = Array.from({ length: 40 }, (_, i) => ({ id: `builder-${String(i).padStart(4, "0")}`, persona: "builder", status: "running" as const }));
  const capped = record({ runsBrief: brief });
  assert.equal(capped.runsBrief.length, LEAD_RUNS_BRIEF_MAX);
  assert.ok(Buffer.byteLength(JSON.stringify(capped)) <= LEAD_RECORD_MAX_BYTES);
  const wide = record({ cwd: `/${"d".repeat(1000)}`, sessionFile: `/${"s".repeat(1000)}`, socketPath: `/${"k".repeat(1000)}`, runsBrief: brief });
  assert.ok(wide.runsBrief.length < LEAD_RUNS_BRIEF_MAX && Buffer.byteLength(JSON.stringify(wide)) <= LEAD_RECORD_MAX_BYTES, "briefs give way to identity");
  assert.throws(() => record({ cwd: `/${"d".repeat(1023)}`, sessionFile: `/${"s".repeat(1023)}`, socketPath: `/${"k".repeat(1023)}`, paneId: "p".repeat(256), tabId: "t".repeat(256), workspaceId: "w".repeat(256), displayName: "n".repeat(300) }),
    /outside its bounds/, "identity that cannot fit fails closed instead of truncating");
  const clipped = record({ displayName: `bad\u0000name\n${"x".repeat(400)}`, branch: "b".repeat(400) });
  assert.ok(!/[\u0000-\u001f]/.test(clipped.displayName) && clipped.displayName.length <= 128 && clipped.branch!.length <= 128, "presentation text is clipped and control-free");
});

test("S1 store: the validator rejects every out-of-schema record", () => {
  const good = JSON.parse(JSON.stringify(record()));
  assert.equal(validLeadRecord(good), true);
  for (const [label, bad] of [
    ["unknown key", { ...good, pendingAsk: { askId: "a" } }], ["version", { ...good, v: 2 }], ["chief role before S3", { ...good, role: "chief" }],
    ["pid 1", { ...good, pid: 1 }], ["fractional pid", { ...good, pid: 4.5 }], ["zero start time", { ...good, pidStartTime: 0 }],
    ["non-uuid generation", { ...good, generation: "epoch-1" }], ["relative cwd", { ...good, cwd: "work" }], ["relative session file", { ...good, sessionFile: "s.jsonl" }],
    ["NUL in cwd", { ...good, cwd: "/work\u0000/x" }], ["empty pane", { ...good, paneId: "" }], ["missing socket", { ...good, socketPath: undefined }],
    ["25 briefs", { ...good, runsBrief: Array.from({ length: 25 }, (_, i) => ({ id: `r${i}`, persona: "p", status: "running" })) }],
    ["brief extra key", { ...good, runsBrief: [{ id: "r", persona: "p", status: "running", task: "secret" }] }],
    ["negative count", { ...good, runs: { active: -1, blocked: 0, total: 0 } }], ["extra count", { ...good, runs: { ...good.runs, chiefs: 1 } }],
    ["oversize serialized", { ...good, displayName: "n".repeat(256), cwd: `/${"d".repeat(1023)}`, sessionFile: `/${"s".repeat(1023)}`, socketPath: `/${"k".repeat(1023)}`, repo: "r".repeat(256), branch: "b".repeat(256) }],
  ] as const) assert.equal(validLeadRecord(bad), false, label);
});

test("S1 store: directories are 0700 and records 0600; a non-private directory fails closed", () => {
  reset();
  const r = record();
  publish(r);
  assert.equal(statSync(supervisionRoot()).mode & 0o777, 0o700);
  assert.equal(statSync(leadsDir()).mode & 0o777, 0o700);
  assert.equal(statSync(leadPath(r.sessionId)).mode & 0o777, 0o600);
  replaceLeadRecord({ ...r, updatedAt: r.updatedAt + 1 }, () => {});
  assert.equal(statSync(leadPath(r.sessionId)).mode & 0o777, 0o600, "a refresh keeps the private mode");
  chmodSync(leadsDir(), 0o755);
  assert.throws(() => ensureLeadsDir(true), /not a private directory/);
  assert.throws(() => publish(record()), /not a private directory/);
  reset();
  mkdirSync(join(home, "elsewhere"), { recursive: true, mode: 0o700 });
  mkdirSync(supervisionRoot(), { recursive: true, mode: 0o700 });
  symlinkSync(join(home, "elsewhere"), leadsDir());
  assert.throws(() => ensureLeadsDir(true), /not a private directory/, "a symlinked leads dir is refused");
  assert.throws(() => scanLeads(LINUX), /not a private directory/, "a listing never reads through a redirected directory");
  reset();
  assert.deepEqual(scanLeads(LINUX), { leads: [], invalid: 0, swept: 0 }, "no directory yet is an empty listing");
});

test("S1 store: reads are bounded and no-follow; malformed, oversize, symlinked and multi-link records are refused", () => {
  reset();
  ensureLeadsDir(true);
  const r = record();
  const path = leadPath(r.sessionId);
  assert.equal(readLeadRecord(path), undefined, "absent is not an error");
  publish(r);
  assert.deepEqual(readLeadRecord(path), JSON.parse(JSON.stringify(r)));
  writeFileSync(path, "{not json", { mode: 0o600 });
  assert.throws(() => readLeadRecord(path), /invalid lead record/);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(JSON.stringify(r)), pad: "x".repeat(LEAD_RECORD_MAX_BYTES) }), { mode: 0o600 });
  assert.throws(() => readLeadRecord(path), /invalid lead record/, "an oversize file is refused before parsing");
  fs.rmSync(path);
  const target = join(home, "target.json");
  writeFileSync(target, JSON.stringify(r), { mode: 0o600 });
  symlinkSync(target, path);
  assert.throws(() => readLeadRecord(path), /invalid lead record/, "symlinks are never followed");
  fs.rmSync(path);
  writeFileSync(path, JSON.stringify(r), { mode: 0o600 });
  linkSync(path, join(home, "second-link.json"));
  assert.throws(() => readLeadRecord(path), /invalid lead record/, "a multi-link record is refused");
  const scan = scanLeads(LINUX);
  assert.deepEqual([scan.leads.length, scan.invalid, scan.swept], [0, 1, 0], "an invalid record is skipped and preserved, never swept");
  assert.ok(lstatSync(path).isFile());
  reset();
});

test("S1 store: initial publication is create-only; a replace runs only behind its fence", () => {
  reset();
  const r = record();
  publish(r);
  assert.throws(() => publish({ ...r, generation: randomUUID() }), (e: NodeJS.ErrnoException) => e.code === "EEXIST");
  assert.equal(readLeadRecord(leadPath(r.sessionId))!.generation, r.generation, "the first publisher's record is untouched");
  assert.throws(() => replaceLeadRecord({ ...r, updatedAt: 9 }, () => { throw new Error("fenced"); }), /fenced/);
  assert.equal(readLeadRecord(leadPath(r.sessionId))!.updatedAt, r.updatedAt);
  assert.deepEqual(names(), [`${createHash("sha256").update(r.sessionId).digest("hex")}.json`], "no temp files remain");
  reset();
});

test("S1 store: liveness on Linux is ESRCH or a start-time mismatch for dead; never age alone", () => {
  const r = record({ pid: 777, pidStartTime: 10 });
  const at = (probe: ReturnType<typeof probeWith> | (() => { state: "unknown" }), extra: object = {}) => leadLiveness(r, { platform: "linux", probe, now: () => r.updatedAt + 86_400_000, ...extra });
  assert.equal(at(probeWith([777])), "dead", "ESRCH");
  assert.equal(at(probeWith([], 11)), "dead", "a reused pid has another start time");
  assert.equal(at(probeWith([], 10)), "live", "same pid and start time, however old the record");
  assert.equal(at(() => ({ state: "unknown" as const })), "unknown", "EPERM proves nothing");
  assert.equal(leadLiveness({ ...r, pidStartTime: undefined }, { platform: "linux", probe: probeWith([], 10) }), "unknown", "no recorded start time proves nothing");
  assert.equal(leadLiveness(r, { platform: "linux", probe: () => ({ state: "alive" }) }), "unknown", "an unreadable start time proves nothing");
});

test("S1 store: liveness off Linux is ESRCH for dead, fresh for live, otherwise unknown", () => {
  const r = record({ pid: 777, pidStartTime: undefined });
  const at = (age: number, probe = probeWith()) => leadLiveness(r, { platform: "darwin", probe, now: () => r.updatedAt + age });
  assert.equal(at(5_000, probeWith([777])), "dead");
  assert.equal(at(90_000), "live");
  assert.equal(at(90_001), "unknown");
  assert.equal(at(5_000, (() => ({ state: "unknown" })) as never), "live", "a fresh record off Linux is live even when signalling is denied");
});

test("S1 store: a sweep removes proven-dead and off-Linux 10-minute-stale records only", () => {
  reset();
  const live = record({ pid: 100 }), dead = record({ pid: 200 }), reused = record({ pid: 300, pidStartTime: 1 });
  for (const r of [live, dead, reused]) publish(r);
  const linux = scanLeads({ platform: "linux", probe: (pid: number) => pid === 200 ? { state: "gone" } : { state: "alive", startTime: SELF_START }, now: () => live.updatedAt + 86_400_000 });
  assert.deepEqual(linux.leads.map(l => [l.record.sessionId, l.state]), [[live.sessionId, "live"]]);
  assert.equal(linux.swept, 2);
  assert.equal(readLeadRecord(leadPath(dead.sessionId)), undefined);
  assert.equal(readLeadRecord(leadPath(reused.sessionId)), undefined);
  reset();
  const fresh = record({ pidStartTime: undefined, updatedAt: 1_000_000 }), quiet = record({ pidStartTime: undefined, updatedAt: 1_000_000 - 300_000 }),
    stale = record({ pidStartTime: undefined, updatedAt: 1_000_000 - 600_001 });
  for (const r of [fresh, quiet, stale]) publish(r);
  const off = scanLeads({ platform: "darwin", probe: probeWith(), now: () => 1_000_000 });
  assert.deepEqual(new Map(off.leads.map(l => [l.record.sessionId, l.state])), new Map([[fresh.sessionId, "live"], [quiet.sessionId, "unknown"]]));
  assert.equal(off.swept, 1);
  assert.equal(readLeadRecord(leadPath(stale.sessionId)), undefined);
  const linuxStale = scanLeads({ platform: "linux", probe: () => ({ state: "unknown" as const }), now: () => 1_000_000 + 86_400_000 });
  assert.equal(linuxStale.swept, 0, "on Linux age alone never sweeps");
  reset();
});

test("S1 store: a sweep never deletes a record a new owner published after the judgement", (t) => {
  reset();
  const dead = record({ pid: 200 });
  publish(dead);
  const successor = record({ sessionId: dead.sessionId, pid: 201 });
  const path = leadPath(dead.sessionId);
  const realRename = fs.renameSync;
  let raced = false;
  t.mock.method(fs, "renameSync", (from: string, to: string) => {
    // The successor sweeps the dead record and publishes between the scan's read and its removal.
    if (!raced && from === path) { raced = true; fs.rmSync(path); publish(successor); }
    return realRename(from, to);
  });
  syncBuiltinESMExports();
  try {
    const scan = scanLeads({ platform: "linux", probe: (pid: number) => pid === 200 ? { state: "gone" } : { state: "alive", startTime: SELF_START } });
    assert.ok(raced, "the race window was exercised");
    assert.equal(scan.swept, 0);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(readLeadRecord(path)!.generation, successor.generation, "the live successor's record survives");
  assert.deepEqual(names(), [path.split("/").pop()], "no tomb remains");
  assert.equal(removeLeadRecordIf(path, r => r.generation === dead.generation), false);
  assert.equal(readLeadRecord(path)!.generation, successor.generation);
  assert.equal(removeLeadRecordIf(path, r => sameLeadIdentity(r, successor)), true);
  assert.equal(removeLeadRecordIf(path, () => true), false, "absent is a no-op");
  reset();
});

test("S1 store: a scan is bounded at 1024 entries and clears abandoned temp files", () => {
  reset();
  ensureLeadsDir(true);
  const r = record();
  publish(r);
  const orphan = join(leadsDir(), `${leadPath(r.sessionId).split("/").pop()}-${randomUUID()}.claim`), young = join(leadsDir(), `${leadPath(r.sessionId).split("/").pop()}-${randomUUID()}.tmp`);
  writeFileSync(orphan, "{}", { mode: 0o600 }); writeFileSync(young, "{}", { mode: 0o600 });
  const old = (Date.now() - 601_000) / 1000;
  utimesSync(orphan, old, old);
  scanLeads(LINUX);
  assert.ok(!names().includes(orphan.split("/").pop()!), "an abandoned publication temp file is removed");
  assert.ok(names().includes(young.split("/").pop()!), "an in-flight temp file is kept");
  for (let i = names().length; i <= LEAD_SCAN_MAX; i++) writeFileSync(join(leadsDir(), `foreign-${i}`), "");
  assert.throws(() => scanLeads(LINUX), /cap 1024/, "an over-full directory fails closed");
  assert.equal(readFileSync(leadPath(r.sessionId), "utf8").length > 0, true, "nothing is deleted on refusal");
  reset();
});

// Critic finding: the exact sha256(sessionId) file name is part of the record's identity.
test("S1 store: a valid record under another session's file name is invalid and never listed or swept", () => {
  reset();
  ensureLeadsDir(true);
  const own = record(), misplaced = record({ pid: 200 });
  publish(own);
  const elsewhere = leadPath(`not-${misplaced.sessionId}`);
  writeFileSync(elsewhere, JSON.stringify(misplaced), { mode: 0o600 });
  assert.equal(validLeadRecord(JSON.parse(readFileSync(elsewhere, "utf8"))), true, "the record itself is valid; only its path is wrong");
  for (const probe of [probeWith(), probeWith([200])]) {
    const scan = scanLeads({ platform: "linux", probe });
    assert.deepEqual(scan.leads.map(l => l.record.sessionId), [own.sessionId], "only the correctly named record is listed");
    assert.deepEqual([scan.invalid, scan.swept], [1, 0], "counted invalid; a misnamed record is preserved, even with a dead pid");
    assert.ok(lstatSync(elsewhere).isFile());
  }
  reset();
});

// Critic finding: the 16 KiB output cap, with multibyte presentation text.
test("S1 peer list: a multibyte listing past 16 KiB is valid JSON of at most 16384 bytes and says truncated", () => {
  // Entries stay under ~200 bytes, so the 240 self id lengths tried below cover every byte offset of the last entry.
  const peers = Array.from({ length: 150 }, (_, i) => record({ sessionId: `peer-${String(i).padStart(4, "0")}`, displayName: "界".repeat(10),
    cwd: `/工作/${"界".repeat(8)}`, repo: "仓库", branch: "分支".repeat(5) }));
  const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
  const scanFor = (self: LeadRecord) => ({ leads: [self, ...peers].map(r => ({ record: r, state: "live" as const })), invalid: 0, swept: 0 });
  // Choose the self id length so that packing peers up to the cap and only then appending `"truncated":true`
  // would overflow: only an implementation that reserves room for the marker stays within the cap here.
  let fixture: { self: LeadRecord; listing: ReturnType<typeof peerListing> } | undefined;
  for (let k = 0; k < 240 && !fixture; k++) {
    const self = record({ sessionId: `self-${"s".repeat(k)}` });
    const listing = peerListing(self, scanFor(self));
    const entry = listing.peers[0]!;
    assert.ok(bytes(entry) < 239, "the search range spans an entry");
    const packed = (n: number) => ({ self: self.sessionId, peers: Array(n).fill(entry) });
    let n = 0;
    while (bytes(packed(n + 1)) <= PEER_LIST_MAX_BYTES) n++;
    if (bytes(packed(n)) < PEER_LIST_MAX_BYTES && bytes({ ...packed(n), truncated: true }) > PEER_LIST_MAX_BYTES) fixture = { self, listing };
  }
  assert.ok(fixture, "a self id length puts a cap-then-marker packer over the cap");
  const { self, listing } = fixture;
  const text = JSON.stringify(listing);
  assert.equal(PEER_LIST_MAX_BYTES, 16384);
  assert.ok(Buffer.byteLength(text) <= 16384, `output is ${Buffer.byteLength(text)} bytes`);
  assert.deepEqual(JSON.parse(text), listing, "valid JSON");
  assert.equal(listing.truncated, true);
  assert.equal(listing.self, self.sessionId);
  assert.ok(listing.peers.length > 0 && listing.peers.length < peers.length);
  assert.deepEqual(listing.peers.map(p => p.lead), peers.slice(0, listing.peers.length).map(p => p.sessionId), "a sorted prefix of exact ids; self excluded");
  assert.ok(listing.peers.every(p => p.name === "界".repeat(10) && p.branch === "分支".repeat(5)), "multibyte text is carried whole");
});
