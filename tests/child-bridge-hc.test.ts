import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installChildBridge } from "../src/child-bridge.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();

const hcSocket = "/run/user/1000/herdr-core/private.sock";
const leaked = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/leaked-herdr.sock", HERDR_PANE_ID: "leaked-pane", HERDR_TAB_ID: "leaked-tab", HERDR_WORKSPACE_ID: "leaked-ws" };

function fixture(binding: Record<string, unknown>, childEnv: Record<string, string>) {
  const runId = "oracle-hcb";
  const runDir = join(tmpDir("hc-bridge-"), runId);
  mkdirSync(join(runDir, "session"), { recursive: true });
  const sessionFile = join(runDir, "session", "child.jsonl");
  writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "session-hcb" }) + "\n");
  const herdr = { runId, launchNonce: "nonce-hcb", sessionId: "session-hcb", sessionFile, createdTab: true, ...binding };
  writeFileSync(join(runDir, "record.json"), JSON.stringify({ id: runId, runtime: "herdr", herdr }));
  const env = { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr", CONDUCTOR_RUN_ID: runId, CONDUCTOR_RUN_DIR: runDir, ...childEnv };
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const diagnostics: string[] = [];
  const pi = { getFlag: () => "nonce-hcb", on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
    const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list);
    return () => { list.splice(list.indexOf(handler), 1); };
  } };
  const ctx = { sessionManager: { getSessionId: () => "session-hcb", getSessionFile: () => sessionFile }, ui: { notify: (message: string) => diagnostics.push(message) }, shutdown: () => {} };
  const bridge = installChildBridge(pi as never, { env });
  for (const h of handlers.get("session_start") ?? []) h({ type: "session_start", reason: "startup" }, ctx);
  const helloPath = join(runDir, "launch", "nonce-hcb.json");
  const hello = () => existsSync(helloPath) ? JSON.parse(readFileSync(helloPath, "utf8")) : undefined;
  return { bridge, hello, diagnostics };
}

const hcBinding = (over: Record<string, unknown> = {}) => ({ host: "hc", socketPath: hcSocket, coreId: "core-a", parentAddress: "t1", tab: "tb-hcb", ...over });
const hcEnv = (over: Record<string, string> = {}) => ({ HC_TERMINAL_ID: "t7", HC_TERMINAL_SOCKET: hcSocket, HC_SCOPE: "scope", HC_SESSION: "private", ...over });
const tuiBinding = { socketPath: "/tmp/herdr-tui.sock", paneId: "w1:p2", terminalId: "term_2", tabId: "w1:t1", workspaceId: "w1" };
const tuiEnv = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr-tui.sock", HERDR_PANE_ID: "w1:p2", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1" };

for (const leak of [false, true]) test(`hc child: the hello names the hc terminal${leak ? ", ignoring leaked HERDR_* routing" : ""}`, () => {
  const f = fixture(hcBinding(), { ...hcEnv(), ...(leak ? leaked : {}) });
  try {
    const hello = f.hello();
    assert.ok(hello, f.diagnostics.join("\n"));
    assert.equal(hello.paneId, "t7");
    assert.equal(hello.terminalId, "t7");
    assert.equal(hello.pid, process.pid);
    assert.equal(hello.launchNonce, "nonce-hcb");
  } finally { f.bridge.dispose(); }
});

test("hc child: a persisted address must be this terminal", () => {
  const same = fixture(hcBinding({ address: "t7" }), hcEnv());
  try { assert.equal(same.hello()?.paneId, "t7", same.diagnostics.join("\n")); } finally { same.bridge.dispose(); }
  const other = fixture(hcBinding({ address: "t8" }), hcEnv());
  try {
    assert.equal(other.hello(), undefined);
    assert.match(other.diagnostics.join("\n"), /run binding mismatch/);
  } finally { other.bridge.dispose(); }
});

const refused: [string, Record<string, unknown>, Record<string, string>][] = [
  ["an hc binding seen by a TUI-env child", hcBinding(), tuiEnv],
  ["an hc binding seen by a TUI-env child with only the TUI socket in HC_TERMINAL_SOCKET", hcBinding({ socketPath: "/tmp/herdr-tui.sock" }), { ...tuiEnv, HC_TERMINAL_SOCKET: "/tmp/herdr-tui.sock" }],
  ["another core socket", hcBinding(), hcEnv({ HC_TERMINAL_SOCKET: "/run/user/1000/herdr-core/default.sock" })],
  ["a malformed terminal id", hcBinding(), hcEnv({ HC_TERMINAL_ID: "../t7" })],
  ["a multi-line terminal id", hcBinding(), hcEnv({ HC_TERMINAL_ID: "t7\nt8" })],
  ["a relative socket path", hcBinding({ socketPath: "relative.sock" }), hcEnv({ HC_TERMINAL_SOCKET: "relative.sock" })],
  ["an hc binding without its core", hcBinding({ coreId: undefined }), hcEnv()],
  ["an hc binding without its tab", hcBinding({ tab: undefined }), hcEnv()],
  ["an unknown host", hcBinding({ host: "zellij" }), hcEnv()],
  ["a TUI binding seen by an hc-only child", tuiBinding, hcEnv()],
];
for (const [name, binding, env] of refused) test(`child bridge refuses ${name}`, () => {
  const f = fixture(binding, env);
  try {
    assert.equal(f.hello(), undefined);
    assert.match(f.diagnostics.join("\n"), /run binding mismatch/);
  } finally { f.bridge.dispose(); }
});

test("TUI child: the TUI branch is unchanged even when hc variables are inherited", () => {
  const f = fixture(tuiBinding, { ...tuiEnv, ...hcEnv() });
  try {
    const hello = f.hello();
    assert.ok(hello, f.diagnostics.join("\n"));
    assert.equal(hello.paneId, "w1:p2");
    assert.equal(hello.terminalId, "term_2");
  } finally { f.bridge.dispose(); }
});
