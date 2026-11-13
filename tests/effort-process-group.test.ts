import test from "node:test";
import assert from "node:assert/strict";
import { handleSessionShutdown } from "../src/shutdown.ts";
import type { Run } from "../src/types.ts";

test("shutdown cannot report success for a previously unconfirmed integration teardown", async () => {
  const run = { status: "integrating", effort: {}, integration: { teardownError: "group identity unavailable" } } as unknown as Run;
  await assert.rejects(handleSessionShutdown({ reason: "reload" }, { runs: [run], resetSanitizer() {} }), /group identity unavailable/);
});

import { stopOwnedProcessGroup, type GroupProcess } from "../src/effort/process-group.ts";

const owner = { pid: 101, startTime: 1000 };
const leader: GroupProcess = { ...owner, pgid: owner.pid, sid: owner.pid, state: "S" };
const child: GroupProcess = { ...leader, pid: 102, startTime: 1001 };
const gone = () => Object.assign(new Error("gone"), { code: "ESRCH" });
function harness(initial = [leader, child]) {
  let ms = 0, rows = initial;
  const signals: (NodeJS.Signals | 0)[] = [];
  return {
    signals, setRows: (next: GroupProcess[]) => { rows = next; }, elapsed: () => ms,
    deps: { processes: () => rows, signal: (pid: number, signal: NodeJS.Signals | 0) => { assert.equal(pid, -owner.pid); signals.push(signal); }, now: () => ms, wait: async (n: number) => { ms += n; } },
  };
}

test("group escalation survives leader exit and finishes on stable zombie-only membership", async () => {
  const h = harness();
  await stopOwnedProcessGroup(owner, { ...h.deps, signal: (pid, signal) => {
    h.deps.signal(pid, signal);
    if (signal === "SIGTERM") h.setRows([child]);
    if (signal === "SIGKILL") h.setRows([{ ...child, state: "Z" }]);
  } });
  assert.deepEqual(h.signals.filter(s => s !== 0), ["SIGTERM", "SIGKILL"]);
  assert.ok(h.elapsed() >= 2000 && h.elapsed() < 3000);
});

test("already-gone group needs no fingerprint, scan, signal or grace", async () => {
  let probes = 0;
  await stopOwnedProcessGroup({ pid: owner.pid }, { signal: (pid, signal) => { assert.equal(pid, -owner.pid); assert.equal(signal, 0); probes++; throw gone(); }, processes: () => assert.fail("no scan for ESRCH"), wait: async () => assert.fail("no grace for ESRCH") });
  assert.equal(probes, 1);
});

test("ESRCH racing TERM or KILL is successful teardown, not a retry on a reused group", async () => {
  for (const phase of ["SIGTERM", "SIGKILL"]) {
    const h = harness();
    await stopOwnedProcessGroup(owner, { ...h.deps, signal: (pid, sig) => { h.deps.signal(pid, sig); if (sig === phase) throw gone(); } });
    assert.equal(h.signals.at(-1), phase);
  }
});

test("cooperative disappearance returns promptly, without SIGKILL", async () => {
  const h = harness(); let stopped = false;
  await stopOwnedProcessGroup(owner, { ...h.deps, signal: (pid, sig) => { h.deps.signal(pid, sig); if (stopped) throw gone(); if (sig === "SIGTERM") stopped = true; } });
  assert.equal(h.elapsed(), 0);
  assert.deepEqual(h.signals.filter(s => s !== 0), ["SIGTERM"]);
});

test("unchanged zombies are not mistaken for runnable tasks until a timeout", async () => {
  const h = harness([{ ...leader, state: "Z" }]);
  await stopOwnedProcessGroup(owner, h.deps);
  assert.ok(h.elapsed() <= 25); assert.ok(h.signals.every(s => s === 0));
});

for (const code of ["EPERM", "EIO"]) for (const phase of [0, "SIGTERM", "SIGKILL"] as const) {
  test(`${code} at ${phase} cannot report successful teardown`, async () => {
    const h = harness();
    await assert.rejects(stopOwnedProcessGroup(owner, { ...h.deps, signal: (pid, sig) => { h.deps.signal(pid, sig); if (sig === phase) throw Object.assign(new Error(code), { code }); } }), /unconfirmed/);
    assert.equal(h.signals.at(-1), phase, "no further signalling after uncertainty");
  });
}

for (const replacement of [
  [{ ...leader, startTime: 2000 }],
  [{ ...child, startTime: 2000 }],
  [{ ...child, sid: 999 }],
]) test("lost PID/start or session continuity never signals a replacement group", async () => {
  const h = harness();
  await assert.rejects(stopOwnedProcessGroup(owner, { ...h.deps, signal: (pid, sig) => { h.deps.signal(pid, sig); if (sig === "SIGTERM") h.setRows(replacement); } }), /identity continuity lost/);
  assert.deepEqual(h.signals.filter(s => s !== 0), ["SIGTERM"]);
});

const late: GroupProcess = { ...child, pid: 103, startTime: 1002 };
function afterTerm(h: ReturnType<typeof harness>, scans: GroupProcess[][]) {
  let scan = -1;
  const rows = () => scans[Math.min(scan, scans.length - 1)]!;
  return { ...h.deps,
    signal: (pid: number, sig: NodeJS.Signals | 0) => {
      h.deps.signal(pid, sig);
      if (sig === "SIGTERM") { scan = 0; h.setRows(rows()); }
      if (sig === 0 && scan >= 0 && !rows().length) throw gone();
    },
    wait: async (n: number) => { await h.deps.wait(n); scan++; h.setRows(rows()); } };
}

for (const [name, scans] of [
  ["a zombie reparented after its forking leader was reaped", [[{ ...late, state: "Z" }]]],
  ["a late fork still exiting under the first TERM", [[{ ...late, state: "R" }], [{ ...late, state: "R" }], [{ ...late, state: "Z" }]]],
  ["a late fork that is reaped before the next scan", [[{ ...late, state: "R" }], []]],
] as const) test(`late fork during teardown: ${name} is waited out, never signalled`, async () => {
  const h = harness();
  await stopOwnedProcessGroup(owner, afterTerm(h, scans.map(rows => [...rows])));
  assert.deepEqual(h.signals.filter(s => s !== 0), ["SIGTERM"]);
  assert.ok(h.elapsed() < 2000);
});

for (const [name, scans] of [
  ["a different session", [[{ ...late, sid: 999, state: "Z" }]]],
  ["a reused leader start", [[{ ...leader, startTime: 2000, state: "Z" }]]],
  ["an unproven member that keeps executing past escalation", [[{ ...late, state: "Z" }], [{ ...late, state: "Z" }, { ...late, pid: 104 }]]],
] as const) test(`late fork impostor: ${name} is refused and never SIGKILLed`, async () => {
  const h = harness();
  await assert.rejects(stopOwnedProcessGroup(owner, afterTerm(h, scans.map(rows => [...rows]))), /identity continuity lost/);
  assert.deepEqual(h.signals.filter(s => s !== 0), ["SIGTERM"]);
});

test("a first scan with only unproven executing members is never signalled", async () => {
  const h = harness([child]);
  await assert.rejects(stopOwnedProcessGroup(owner, h.deps), /identity continuity lost/);
  assert.ok(h.signals.every(s => s === 0));
});

test("unknown membership, missing fingerprint and unavailable process evidence fail closed", async () => {
  for (const rows of [[], [{ ...leader, startTime: 2000 }]]) {
    const h = harness(rows);
    await assert.rejects(stopOwnedProcessGroup(owner, h.deps), /unknown|identity continuity lost/);
    assert.ok(h.signals.every(s => s === 0));
  }
  const h = harness();
  await assert.rejects(stopOwnedProcessGroup({ pid: owner.pid }, h.deps), /missing owned group start identity/);
  await assert.rejects(stopOwnedProcessGroup(owner, { ...h.deps, processes: () => { throw new Error("procfs unavailable"); } }), /procfs unavailable/);
  assert.ok(h.signals.every(s => s === 0));
});

test("unkillable tasks hit a bounded failure, never a false stopped result", async () => {
  const h = harness([{ ...leader, state: "D" }]);
  await assert.rejects(stopOwnedProcessGroup(owner, h.deps), /unconfirmed after TERM\/KILL deadline/);
  assert.equal(h.elapsed(), 3000);
  assert.deepEqual(h.signals.filter(s => s !== 0), ["SIGTERM", "SIGKILL"]);
});

test("invalid group IDs never reach process.kill", async () => {
  for (const pid of [0, 1, -1, NaN, 1.5]) await assert.rejects(stopOwnedProcessGroup({ pid, startTime: 1 }, { signal: () => assert.fail("invalid target signalled") }), /invalid owned process group/);
});
