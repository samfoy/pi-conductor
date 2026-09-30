#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs";
const statePath = process.env.FAKE_HERDR_STATE;
if (!statePath || process.env.HERDR_SOCKET_PATH !== `${statePath}.socket`) process.exit(90);
const state = JSON.parse(readFileSync(statePath, "utf8"));
const args = process.argv.slice(2);
state.calls.push({args, socket: process.env.HERDR_SOCKET_PATH,
  routingNames: Object.keys(process.env).filter(k => k.startsWith("HERDR_"))});
const save = () => writeFileSync(statePath, JSON.stringify(state));
save();
const output = (result) => console.log(JSON.stringify({id: "fake-request", result}));
if (state.fault === "hang") { setInterval(() => {}, 1000); }
else if (state.fault === "invalid") console.log("not json " + args.join(" "));
else if (state.fault === "overflow") process.stdout.write("x".repeat(200000));
else if (state.fault === "stderr-overflow") process.stderr.write("x".repeat(200000));
else if (["nonzero", "stderr-error", "error-success"].includes(state.fault)) {
  const outputError = state.fault === "stderr-error" ? console.error : console.log;
  outputError(JSON.stringify({id: "fake-request", error: {code: state.code ?? "agent_pane_busy", message: args.join(" ") + process.env.SENTINEL_SECRET}}));
  if (state.fault !== "stderr-error") console.error(args.join(" ") + process.env.SENTINEL_SECRET);
  process.exitCode = state.fault === "error-success" ? 0 : 7;
} else if (state.fault === "response") console.log(JSON.stringify(state.response));
else if (args.includes("--help") || args.join(" ") === "integration status") console.log("fake help/status: plain text");
else if (args[0] === "agent" && args[1] === "read") console.log("fake terminal scrollback");
else if (args[0] === "tab" && args[1] === "create") {
  if (state.created && !state.allowNewTabs) process.exit(91);
  if (state.created) {
    (state.retainedPanes ??= []).push(state.pane);
    const suffix = state.retainedPanes.length + 1;
    state.pane = { ...state.pane, pane_id: `pane-${suffix}`, terminal_id: `terminal-${suffix}`, tab_id: `tab-${suffix}`, agent: null, agent_session: null };
  }
  const flag = name => args[args.indexOf(name) + 1];
  state.created = true;
  state.pane = {...state.pane, cwd: flag("--cwd"), workspace_id: flag("--workspace")};
  state.tab = {tab_id: state.pane.tab_id, workspace_id: state.pane.workspace_id, label: flag("--label"), number: 1, focused: false, pane_count: 1, agent_status: "unknown"};
  save(); output({type: "tab_created", root_pane: state.pane, tab: state.tab});
} else if (args[0] === "pane" && args[1] === "get") {
  if (state.rewriteRecord) {
    if (!state.rewriteRecord.path.startsWith(`${process.env.HOME}/`)) process.exit(95);
    writeFileSync(state.rewriteRecord.path, JSON.stringify(state.rewriteRecord.value));
    delete state.rewriteRecord; save();
  }
  if (state.childPid && state.pane.agent) {
    try { process.kill(state.childPid, 0); } catch (e) {
      if (e.code === "ESRCH") { state.pane.agent = null; state.pane.agent_session = null; save(); }
    }
  }
  output({type: "pane_info", pane: state.getPane ?? state.pane});
}
else if (args[0] === "agent" && args[1] === "start") {
  // Real herdr 0.9.1: names stay on their terminal after the agent exits, and start
  // succeeds only once the agent is idle (a task already visible keeps it busy).
  const { readdirSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const fail = (code, message) => { console.log(JSON.stringify({ id: "cli:agent:start", error: { code, message } })); save(); process.exit(1); };
  if ((state.agentNames ??= []).includes(args[2])) fail("agent_name_taken", `agent name ${args[2]} is already used`);
  state.agentNames.push(args[2]);
  const busy = () => {
    const session = args[args.indexOf("--session") + 1], nonce = args[args.indexOf("--conductor-launch") + 1];
    try { return readdirSync(join(dirname(dirname(session)), "inbox", nonce)).some(f => /^\d{6}-[^.]+(\.sending)?\.json$/.test(f)); } catch { return false; }
  };
  if (busy()) fail("timeout", "timed out waiting for agent startup");
  if (state.childPid) {
    const sessionFile = args[args.indexOf("--session") + 1];
    state.sessionFile = sessionFile;
    const { dirname } = await import("node:path");
    writeFileSync(state.manifest, JSON.stringify({ runDir: dirname(dirname(sessionFile)), mode: state.mode }));
    const { existsSync } = await import("node:fs");
    const { setTimeout: delay } = await import("node:timers/promises");
    const end = Date.now() + 10000;
    while (!existsSync(`${state.manifest}.ready`)) {
      if (Date.now() > end) process.exit(94);
      await delay(10);
    }
  }
  if (busy()) fail("timeout", "timed out waiting for agent startup");
  state.pane.agent = "pi";
  state.pane.agent_session = {kind: "path", value: state.sessionFile, source: "integration", agent: "pi"};
  save(); output({type: "agent_started", agent: {...state.pane, name: args[2], interactive_ready: true}, argv: args.slice(args.indexOf("--") + 1)});
} else if (args[0] === "pane" && args[1] === "close") {
  if (args[2] !== state.pane.pane_id || state.pane.agent != null) process.exit(92); // real herdr omits an absent agent
  state.closed = true; save(); output({type: "ok"});
} else process.exit(93);
