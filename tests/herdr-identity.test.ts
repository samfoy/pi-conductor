import test from "node:test";
import assert from "node:assert/strict";
import { proveChildProcess, provePaneOurs } from "../src/herdr/identity.js";
import { binding, invocation, pane, livePane, hello } from "./fixtures/herdr-evidence.js";

const emptyEvidence = {binding, current: invocation, socketPath: binding.socketPath, pane, requireNoAgent: true};
const childEvidence = {
  ...emptyEvidence, pane: livePane, hello, platform: "linux",
  process: {pid: 99, state: "alive", startTime: 1234}, bridgeProtocol: 1,
};
function noSignal(evidence: unknown) {
  const signals: number[] = [];
  const proof = proveChildProcess(evidence as typeof childEvidence);
  if (proof.ok) signals.push(proof.pid);
  assert.deepEqual(signals, [], "unproven child must cause zero destructive calls");
  assert.equal(proof.ok, false);
  if (!proof.ok) assert.equal(proof.state, "unknown");
}
test("positive empty pane and Linux child proofs are distinct", () => {
  assert.deepEqual(provePaneOurs(emptyEvidence), {ok: true});
  assert.deepEqual(proveChildProcess(childEvidence), {ok: true, pid: 99});
  assert.equal(provePaneOurs({...emptyEvidence, pane: livePane}).ok, false);
  noSignal({...childEvidence, pane});
});
for (const field of ["pane_id", "terminal_id", "workspace_id", "tab_id", "agent", "agent_session"]) {
  for (const value of [undefined, "foreign"]) test(`pane refuses ${field}=${value}`, () => {
    assert.equal(provePaneOurs({...emptyEvidence, pane: {...pane, [field]: value}}).ok, false);
  });
}
for (const field of ["runId", "launchNonce", "sessionId", "sessionFile"]) {
  test(`current invocation refuses ${field}`, () => {
    const current = {...invocation, [field]: "foreign"};
    assert.equal(provePaneOurs({...emptyEvidence, current}).ok, false);
    noSignal({...childEvidence, current});
  });
}
for (const field of ["socketPath", "workspaceId", "tabId", "paneId", "terminalId", "runId", "launchNonce", "sessionId", "sessionFile"]) {
  test(`binding refuses missing ${field}`, () => {
    assert.equal(provePaneOurs({...emptyEvidence, binding: {...binding, [field]: undefined}}).ok, false);
    noSignal({...childEvidence, binding: {...binding, [field]: undefined}});
  });
}
for (const field of ["v", "bridgeProtocol", "runId", "launchNonce", "paneId", "pid", "pidStartTime", "sessionId", "sessionFile", "piVersion", "conductorVersion", "at"]) {
  test(`child refuses malformed hello ${field}`, () => noSignal({...childEvidence, hello: {...hello, [field]: undefined}}));
}
for (const field of ["runId", "launchNonce", "paneId", "sessionId", "sessionFile"]) {
  test(`child refuses mismatched hello ${field}`, () => noSignal({...childEvidence, hello: {...hello, [field]: "foreign"}}));
}
for (const field of ["pane_id", "terminal_id", "workspace_id", "tab_id", "agent", "agent_session"]) {
  test(`child refuses relocated or replaced ${field}`, () => noSignal({...childEvidence, pane: {...livePane, [field]: "foreign"}}));
}
for (const pid of [-5, 0, 1, 1.5, NaN, Infinity, 100]) {
  test(`child refuses unsafe or mismatched pid ${pid}`, () => noSignal({...childEvidence, hello: {...hello, pid}}));
}
test("child refuses a schema-valid id session instead of a path", () => {
  noSignal({...childEvidence, pane: {...livePane, agent_session: {...livePane.agent_session, kind: "id"}}});
});
for (const pid of [1, 99.5]) {
  test(`child refuses consistently evidenced unsafe PID ${pid}`, () => {
    noSignal({...childEvidence, binding: {...binding, childPid: pid}, hello: {...hello, pid},
      process: {...childEvidence.process, pid}});
  });
}
test("child refuses a matching hello and pane session outside the binding", () => {
  const sessionFile = "/private/foreign/session.jsonl";
  noSignal({...childEvidence, hello: {...hello, sessionFile},
    pane: {...livePane, agent_session: {...livePane.agent_session, value: sessionFile}}});
});
test("socket mismatch and ambiguous evidence never prove ownership", () => {
  assert.equal(provePaneOurs({...emptyEvidence, socketPath: "/foreign"}).ok, false);
  noSignal({...childEvidence, socketPath: "/foreign"});
  for (const p of [undefined, null, [], {}, [livePane]]) noSignal({...childEvidence, pane: p});
  noSignal({...childEvidence, hello: null});
  noSignal({...childEvidence, hello: {...hello, bridgeProtocol: 2}});
});
test("process observation must name the hello PID, including absence observations", () => {
  for (const pid of [undefined, 100]) {
    for (const state of ["alive", "gone"]) noSignal({...childEvidence, process: {...childEvidence.process, pid, state}});
  }
});
test("PID reuse, EPERM, missing procfs and malformed starts are unknown, not death", () => {
  for (const process of [{state: "unknown", code: "EPERM"}, {state: "alive"}, {state: "alive", startTime: 5678}, {state: "alive", startTime: NaN}]) noSignal({...childEvidence, process: {pid: 99, ...process}});
  for (const pidStartTime of [0, -1, 1.5, NaN, 5678]) noSignal({...childEvidence, hello: {...hello, pidStartTime}});
  noSignal({...childEvidence, binding: {...binding, childStartTime: 5678}});
  noSignal({...childEvidence, binding: {...binding, childPid: 100}});
  assert.deepEqual(proveChildProcess({...childEvidence, process: {pid: 99, state: "gone"}}), {ok: false, state: "gone", reason: "child absent"});
});
test("off Linux needs positive pid and exact Pi terminal/session, never unavailable procfs", () => {
  const ev = {...childEvidence, platform: "darwin", hello: {...hello, pidStartTime: undefined}, binding: {...binding, childStartTime: undefined}, process: {pid: 99, state: "alive"}};
  assert.deepEqual(proveChildProcess(ev), {ok: true, pid: 99});
  noSignal({...ev, process: {pid: 99, state: "unknown"}});
  for (const field of ["kind", "value", "agent"]) noSignal({...ev, pane: {...livePane, agent_session: {...livePane.agent_session, [field]: "foreign"}}});
});
test("off Linux malformed optional start evidence or unknown platform cannot authorize a signal", () => {
  for (const pidStartTime of [NaN, 0, -1, "1234"]) noSignal({...childEvidence, platform: "darwin", hello: {...hello, pidStartTime}});
  noSignal({...childEvidence, platform: undefined});
  noSignal({...childEvidence, platform: "darwin", binding: {...binding, childStartTime: 5678}});
});
test("failed child proof never implies empty-pane proof", () => {
  noSignal({...childEvidence, hello: undefined});
  assert.equal(provePaneOurs({...emptyEvidence, pane: livePane}).ok, false);
});
