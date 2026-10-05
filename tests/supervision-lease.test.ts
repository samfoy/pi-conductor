/**
 * S3 chief lease store: one lease per exact HERDR_SOCKET_PATH, as H10's
 * append-only generation claim under `supervision/chief/<sha256(socket)>/`.
 * A claim is allowed only when no claim exists, the highest one is properly
 * released, or its holder is proven dead (Linux: ESRCH or a start-time
 * mismatch; off Linux: ESRCH and a claim at least 90 s old). Live, unknown,
 * malformed or gapped histories refuse. Nothing is rewritten or deleted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { ownerProvenDead, probeHerdrOwner } from "../src/herdr/ownership.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";
import {
  assertChiefLease, chiefLeaseDir, claimChiefLease, leaseHolderState, readChiefLease, releaseChiefLease, type ChiefIdentity,
} from "../src/supervision/lease.ts";
import { supervisionRoot } from "../src/supervision/store.ts";

const { home } = sandboxPi();
const fixtures = tmpDir("s3-lease-");
const START = readProcessStartTime(process.pid);
let n = 0;
const socket = () => join(fixtures, `herdr-${++n}.sock`);
const me = (over: Partial<ChiefIdentity> = {}): ChiefIdentity =>
  ({ sessionId: randomUUID(), sessionFile: "/sessions/lead.jsonl", pid: process.pid, ...(START !== undefined ? { startTime: START } : {}), epoch: randomUUID(), ...over });
const file = (sock: string, g: number, suffix = "") => join(chiefLeaseDir(sock), `${String(g).padStart(6, "0")}.json${suffix}`);
const entries = (sock: string) => readdirSync(chiefLeaseDir(sock)).sort();
const linux = { platform: "linux" };

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await once(child, "exit");
  return child.pid!;
}

test("S3 lease: an absent lease is claimed at generation 0 in a private directory keyed by sha256 of the exact socket", () => {
  const sock = socket(), id = me();
  assert.deepEqual(readChiefLease(sock), { released: false });
  assert.equal(leaseHolderState(readChiefLease(sock)), "absent");
  const claim = claimChiefLease(sock, id, { now: () => 5000 });
  assert.deepEqual(claim, { v: 1, socketPath: sock, ...id, generation: 0, at: 5000 });
  assert.equal(chiefLeaseDir(sock), join(home, ".pi", "agent", "conductor", "supervision", "chief", createHash("sha256").update(sock).digest("hex")));
  for (const dir of [supervisionRoot(), join(supervisionRoot(), "chief"), chiefLeaseDir(sock)]) assert.equal(statSync(dir).mode & 0o777, 0o700, dir);
  assert.equal(statSync(file(sock, 0)).mode & 0o777, 0o600);
  assert.deepEqual(entries(sock), ["000000.json"], "no publication temp is left behind");
  assert.deepEqual(readChiefLease(sock), { holder: claim, released: false });
  assert.equal(leaseHolderState(readChiefLease(sock)), "live");
  assertChiefLease(claim);
});

test("S3 lease: a properly released lease is claimed at the next generation; nothing is rewritten and no generation reused", () => {
  const sock = socket();
  const first = claimChiefLease(sock, me());
  const bytes = readFileSync(file(sock, 0), "utf8");
  releaseChiefLease(first);
  assert.equal(leaseHolderState(readChiefLease(sock)), "released");
  assert.throws(() => assertChiefLease(first), /fenced/, "a released claim no longer asserts");
  const second = claimChiefLease(sock, me());
  assert.equal(second.generation, 1);
  assert.equal(readFileSync(file(sock, 0), "utf8"), bytes, "the released claim is never rewritten");
  assert.deepEqual(JSON.parse(readFileSync(file(sock, 0, ".released"), "utf8")), first, "the release marker names the exact claim");
  assert.deepEqual(entries(sock), ["000000.json", "000000.json.released", "000001.json"]);
  assert.throws(() => releaseChiefLease(first), /fenced/, "an old generation's release cannot touch the new lease");
  assert.ok(!existsSync(file(sock, 1, ".released")));
  assertChiefLease(second);
});

test("S3 lease: a live holder (same pid and start time) is refused by name; an unknown one and an unproven start time too", () => {
  const sock = socket();
  const holder = claimChiefLease(sock, me({ sessionId: "holder-session" }));
  assert.throws(() => claimChiefLease(sock, me(), linux), /held by lead holder-session \(pid \d+, generation 0; live\); not taken over/);
  assert.throws(() => claimChiefLease(sock, me(), { ...linux, probe: () => ({ state: "unknown" }) }), /not proven dead/, "EPERM-style unknown never permits a takeover");
  const noStart = socket();
  claimChiefLease(noStart, me({ startTime: undefined }));
  assert.throws(() => claimChiefLease(noStart, me(), linux), /not proven dead/, "on Linux an alive pid without a recorded start time is not proven dead");
  assert.deepEqual(entries(sock), ["000000.json"], "a refusal writes nothing");
  assertChiefLease(holder);
});

test("S3 lease: a dead holder (ESRCH) is taken over; a reused pid (start mismatch) is taken over without signalling it", async t => {
  const sock = socket();
  claimChiefLease(sock, me({ pid: await deadPid(), sessionId: "gone" }));
  assert.equal(leaseHolderState(readChiefLease(sock), linux), "dead");
  assert.equal(claimChiefLease(sock, me(), linux).generation, 1);
  const reused = socket();
  claimChiefLease(reused, me({ sessionId: "previous", startTime: (START ?? 1) + 12345 }));
  const signals: unknown[] = [];
  const kill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => { signals.push(signal); return kill(pid, signal); });
  const claim = claimChiefLease(reused, me(), linux);
  t.mock.restoreAll();
  assert.equal(claim.generation, 1, "the pid now names another process: the old holder is dead");
  assert.ok(signals.length > 0 && signals.every(s => s === 0), `only kill(pid, 0) probes: ${JSON.stringify(signals)}`);
});

test("S3 lease: off Linux a holder is dead only on ESRCH AND a claim at least 90 s old; a live old holder is never taken over on age alone", () => {
  for (const [label, state, age, ok] of [
    ["ESRCH, 89.999 s old", "gone", 89_999, false],
    ["ESRCH, 90 s old", "gone", 90_000, true],
    ["alive, one day old", "alive", 86_400_000, false],
    ["unknown, one day old", "unknown", 86_400_000, false],
  ] as const) {
    const sock = socket();
    claimChiefLease(sock, me({ sessionId: "holder" }), { now: () => 1_000 });
    const options = { platform: "darwin", now: () => 1_000 + age, probe: () => ({ state }) };
    if (ok) assert.equal(claimChiefLease(sock, me(), options).generation, 1, label);
    else {
      assert.throws(() => claimChiefLease(sock, me(), options), /held by lead holder .*not taken over/, label);
      assert.deepEqual(entries(sock), ["000000.json"], `${label}: nothing written`);
    }
  }
});

test("S3 lease: on Linux an old claim of a live holder is never taken over on age alone", () => {
  const sock = socket();
  claimChiefLease(sock, me({ sessionId: "hung" }), { now: () => 0 });
  assert.throws(() => claimChiefLease(sock, me(), { platform: "linux", now: () => 10 ** 13 }), /held by lead hung .*live/);
});

test("S3 lease: ownerProvenDead is the H10 proof, pure over an injected probe result", () => {
  assert.equal(ownerProvenDead({ startTime: 7, at: 0 }, { state: "gone" }, linux), true);
  assert.equal(ownerProvenDead({ startTime: 7, at: 0 }, { state: "alive", startTime: 8 }, linux), true);
  assert.equal(ownerProvenDead({ startTime: 7, at: 0 }, { state: "alive", startTime: 7 }, linux), false);
  assert.equal(ownerProvenDead({ at: 0 }, { state: "alive", startTime: 8 }, linux), false);
  assert.equal(ownerProvenDead({ startTime: 7, at: 0 }, { state: "unknown" }, linux), false);
  assert.equal(ownerProvenDead({ at: 0 }, { state: "gone" }, { platform: "darwin", now: () => 89_999 }), false);
  assert.equal(ownerProvenDead({ at: 0 }, { state: "gone" }, { platform: "darwin", now: () => 90_000 }), true);
  assert.equal(ownerProvenDead({ at: 0 }, { state: "alive" }, { platform: "darwin", now: () => 10 ** 13 }), false);
  assert.deepEqual(probeHerdrOwner(process.pid).state, "alive");
});

// ── Malformed history refuses and grants nothing ─────────────────────

const valid = (sock: string, g: number, over: object = {}) => JSON.stringify({ v: 1, socketPath: sock, ...me({ pid: 999_999_99 }), generation: g, at: 1, ...over });
for (const [label, setup] of [
  ["a gap in the generations", (s: string) => { writeFileSync(file(s, 0), valid(s, 0), { mode: 0o600 }); writeFileSync(file(s, 2), valid(s, 2), { mode: 0o600 }); }],
  ["a history not starting at 000000", (s: string) => writeFileSync(file(s, 1), valid(s, 1), { mode: 0o600 })],
  ["an unpadded claim name", (s: string) => writeFileSync(join(chiefLeaseDir(s), "0.json"), valid(s, 0), { mode: 0o600 })],
  ["a partial (truncated) claim", (s: string) => writeFileSync(file(s, 0), valid(s, 0).slice(0, 40), { mode: 0o600 })],
  ["an empty claim", (s: string) => writeFileSync(file(s, 0), "", { mode: 0o600 })],
  ["a claim whose generation field disagrees with its name", (s: string) => writeFileSync(file(s, 0), valid(s, 1), { mode: 0o600 })],
  ["a claim for another socket", (s: string) => writeFileSync(file(s, 0), valid(s, 0, { socketPath: `${s}2` }), { mode: 0o600 })],
  ["a claim with an unknown key", (s: string) => writeFileSync(file(s, 0), valid(s, 0, { admin: true }), { mode: 0o600 })],
  ["a claim with pid 1", (s: string) => writeFileSync(file(s, 0), valid(s, 0, { pid: 1 }), { mode: 0o600 })],
  ["a malformed release marker", (s: string) => { writeFileSync(file(s, 0), valid(s, 0), { mode: 0o600 }); writeFileSync(file(s, 0, ".released"), "{}", { mode: 0o600 }); }],
  ["a release marker naming another claim", (s: string) => { writeFileSync(file(s, 0), valid(s, 0), { mode: 0o600 }); writeFileSync(file(s, 0, ".released"), valid(s, 0), { mode: 0o600 }); }],
  ["a release marker past the highest claim", (s: string) => { writeFileSync(file(s, 0), valid(s, 0), { mode: 0o600 }); writeFileSync(file(s, 1, ".released"), valid(s, 1), { mode: 0o600 }); }],
  ["a multi-linked claim", (s: string) => { writeFileSync(file(s, 0), valid(s, 0), { mode: 0o600 }); linkSync(file(s, 0), join(fixtures, `alias-${randomUUID()}`)); }],
  ["a symlinked claim", (s: string) => { const target = join(fixtures, `target-${randomUUID()}.json`); writeFileSync(target, valid(s, 0), { mode: 0o600 }); symlinkSync(target, file(s, 0)); }],
] as const) {
  test(`S3 lease: ${label} refuses every claim and writes nothing`, () => {
    const sock = socket();
    mkdirSync(chiefLeaseDir(sock), { recursive: true, mode: 0o700 });
    setup(sock);
    const before = entries(sock);
    assert.throws(() => readChiefLease(sock), /invalid chief lease; preserved for inspection/);
    // A dead-holder probe must not turn a malformed history into a privilege.
    assert.throws(() => claimChiefLease(sock, me(), { probe: () => ({ state: "gone" }), platform: "linux" }), /invalid chief lease/);
    assert.deepEqual(entries(sock), before, "preserved for inspection, nothing added");
  });
}

test("S3 lease: a symlinked or shared lease directory refuses; a crash-abandoned publication temp is ignored", () => {
  const sock = socket(), elsewhere = tmpDir("s3-lease-elsewhere-");
  mkdirSync(join(supervisionRoot(), "chief"), { recursive: true, mode: 0o700 });
  symlinkSync(elsewhere, chiefLeaseDir(sock));
  assert.throws(() => claimChiefLease(sock, me()), /not a private directory/);
  assert.deepEqual(readdirSync(elsewhere), []);
  const open = socket();
  mkdirSync(chiefLeaseDir(open));
  chmodSync(chiefLeaseDir(open), 0o755); // explicit: the process umask may already strip group/other bits
  assert.throws(() => claimChiefLease(open, me()), /not a private directory/);
  const temp = socket();
  claimChiefLease(temp, me({ pid: 999_999_99 }), { now: () => 1 });
  writeFileSync(`${file(temp, 1)}-${randomUUID()}.claim`, "{", { mode: 0o600 });
  assert.equal(claimChiefLease(temp, me(), { platform: "linux", probe: () => ({ state: "gone" }) }).generation, 1, "an unlinked temp is not a claim");
});

test("S3 lease: leases are keyed by the exact socket string; a prefix or extension of it is another lease", () => {
  const base = socket();
  const a = claimChiefLease(base, me());
  for (const other of [`${base}2`, base.slice(0, -1), `${base}/`, `${base} `]) {
    assert.notEqual(chiefLeaseDir(other), chiefLeaseDir(base));
    assert.equal(readChiefLease(other).holder, undefined, JSON.stringify(other));
    assert.equal(claimChiefLease(other, me()).generation, 0, `${JSON.stringify(other)} is independent`);
  }
  assertChiefLease(a);
});

test("S3 lease: an old epoch can neither assert nor release a newer lease, even at the same generation after its directory was recreated", () => {
  const sock = socket();
  const shared = { sessionId: "reloaded-session", sessionFile: "/sessions/reloaded.jsonl" };
  const old = claimChiefLease(sock, me({ ...shared, epoch: randomUUID() }), { now: () => 42 });
  // A human (or anything else) removes the lease directory; history restarts at 000000.
  rmSync(chiefLeaseDir(sock), { recursive: true });
  assert.throws(() => assertChiefLease(old), /fenced/);
  const fresh = claimChiefLease(sock, me({ ...shared, epoch: randomUUID() }), { now: () => 42 });
  assert.equal(fresh.generation, old.generation, "same generation, same session, pid, start time and claim time; only the epoch differs");
  assert.throws(() => assertChiefLease(old), /fenced/, "the old epoch does not hold the new lease");
  assert.throws(() => releaseChiefLease(old), /fenced/, "the old epoch cannot release the new lease");
  assert.equal(leaseHolderState(readChiefLease(sock)), "live");
  assert.ok(!existsSync(file(sock, 0, ".released")));
  assertChiefLease(fresh);
});

test("S3 lease: a release by anything but the current holder is fenced and writes no marker", () => {
  const sock = socket();
  const holder = claimChiefLease(sock, me());
  assert.throws(() => releaseChiefLease({ ...holder, sessionId: "impostor" }), /fenced/);
  assert.throws(() => releaseChiefLease({ ...holder, at: holder.at + 1 }), /fenced/);
  assert.deepEqual(entries(sock), ["000000.json"]);
  releaseChiefLease(holder);
  assert.throws(() => releaseChiefLease(holder), /fenced|EEXIST/, "a second release adds nothing");
  assert.deepEqual(entries(sock), ["000000.json", "000000.json.released"]);
});

test("S3 lease: several real processes claiming one socket at once yield exactly one holder; its own release frees the next generation", { timeout: 60000 }, async () => {
  const dir = tmpDir("s3-lease-race-");
  const sock = join(dir, "herdr.sock");
  const child = fileURLToPath(new URL("./helpers/supervision-lease-child.ts", import.meta.url));
  const procs: ChildProcess[] = [];
  const N = 6;
  const wait = async (pred: () => boolean, what: string) => { const end = Date.now() + 45_000; while (!pred()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise(r => setTimeout(r, 20)); } };
  try {
    for (let i = 0; i < N; i++) procs.push(spawn(process.execPath, ["--import", "tsx", child, dir, sock, String(i)], { cwd: process.cwd(), env: process.env, stdio: ["ignore", "ignore", "inherit"] }));
    await wait(() => readdirSync(dir).filter(f => f.startsWith("ready-")).length === N, "claimants ready");
    writeFileSync(join(dir, "go"), "");
    await wait(() => readdirSync(dir).filter(f => f.startsWith("result-")).length === N, "claimants done");
    const results = Array.from({ length: N }, (_, i) => JSON.parse(readFileSync(join(dir, `result-${i}.json`), "utf8")));
    const winners = results.filter(r => r.won);
    assert.equal(winners.length, 1, `exactly one chief: ${JSON.stringify(results)}`);
    for (const loser of results.filter(r => !r.won)) assert.match(loser.error, /EEXIST|first|changed while claiming|held by lead|invalid chief lease/, loser.error);
    assert.deepEqual(entries(sock), ["000000.json"], "one claim, no stray temp, no overwrite");
    assert.deepEqual(readChiefLease(sock).holder, winners[0].claim, "the disk holds the winner");
    writeFileSync(join(dir, "release"), "");
    await Promise.all(procs.map(p => p.exitCode !== null ? undefined : once(p, "exit")));
    assert.equal(leaseHolderState(readChiefLease(sock)), "released", "the winner released only its own generation");
    assert.equal(claimChiefLease(sock, me()).generation, 1);
  } finally { for (const p of procs) if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL"); }
});
