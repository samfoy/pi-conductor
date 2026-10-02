// N5 fake herdr (state.v === 2): workspaces of tabs of panes, each pane with its own
// agent child, so a parent pane and its split leaf panes coexist. Shapes follow real
// herdr 0.9.1 as probed in a private session: `pane split` answers `pane_info` with
// fresh pane and terminal ids in the anchor's tab; closing a tab's last pane removes
// the tab. Agent children are owned by the test, never by this short-lived CLI.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Concurrent CLI invocations (parallel leaves) read-modify-write one file under a lock. */
function locked(statePath, fn) {
  const lock = `${statePath}.lock`, end = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) { if (e.code !== "EEXIST" || Date.now() > end) process.exit(97); sleepSync(5); }
  }
  try {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const result = fn(state);
    writeFileSync(statePath, JSON.stringify(state));
    return result;
  } finally { rmdirSync(lock); }
}
const flag = (args, name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const envOf = args => Object.fromEntries(args.flatMap((a, i) => a === "--env" ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : []));
const output = (id, result) => console.log(JSON.stringify({ id, result }));
const fail = (id, code, message) => { console.log(JSON.stringify({ id, error: { code, message } })); process.exitCode = 1; };
const visible = pane => { const { env: _env, childPid: _pid, cwd: _cwd, ...rest } = pane; return rest; };

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

export async function main(statePath, args) {
  const command = args.slice(0, 2).join(" ");
  locked(statePath, state => { state.calls.push({ args, socket: process.env.HERDR_SOCKET_PATH }); });
  if (command === "agent read") { console.log("fake terminal scrollback"); return; }
  if (command === "tab create") {
    locked(statePath, state => {
      const ws = flag(args, "--workspace");
      if (!Object.values(state.panes).some(p => p.workspace_id === ws)) return fail("cli:tab:create", "workspace_not_found", `workspace ${ws} not found`);
      const n = state.next++, tab = { tab_id: `${ws}:t${n}`, workspace_id: ws, label: flag(args, "--label"), number: n, focused: false, pane_count: 1, agent_status: "unknown" };
      const pane = { pane_id: `${ws}:p${n}`, terminal_id: `term_${n}`, workspace_id: ws, tab_id: tab.tab_id, agent: null, agent_session: null, cwd: flag(args, "--cwd"), env: envOf(args) };
      state.tabs[tab.tab_id] = tab; state.panes[pane.pane_id] = pane;
      output("cli:tab:create", { type: "tab_created", root_pane: visible(pane), tab });
    });
    return;
  }
  if (command === "pane split") {
    locked(statePath, state => {
      const anchor = state.panes[flag(args, "--pane")];
      if (!anchor) return fail("cli:pane:split", "pane_not_found", `pane ${flag(args, "--pane")} not found`);
      const n = state.next++;
      const pane = { pane_id: `${anchor.workspace_id}:p${n}`, terminal_id: `term_${n}`, workspace_id: anchor.workspace_id, tab_id: anchor.tab_id,
        agent: null, agent_session: null, cwd: flag(args, "--cwd"), env: envOf(args), direction: flag(args, "--direction"), splitFrom: anchor.pane_id };
      state.panes[pane.pane_id] = pane; state.tabs[anchor.tab_id].pane_count++;
      output("cli:pane:split", { type: "pane_info", pane: visible(pane) });
    });
    return;
  }
  if (command === "pane get") {
    locked(statePath, state => {
      const pane = state.panes[args[2]];
      if (!pane) return fail("cli:pane:get", "pane_not_found", `pane ${args[2]} not found`);
      if (pane.agent && pane.childPid && !alive(pane.childPid)) { pane.agent = null; pane.agent_session = null; }
      // A test may rewrite one identity field of what this pane reports.
      output("cli:pane:get", { type: "pane_info", pane: { ...visible(pane), ...(state.report?.[args[2]] ?? {}) } });
    });
    return;
  }
  if (command === "pane close") {
    locked(statePath, state => {
      const pane = state.panes[args[2]];
      if (!pane) return fail("cli:pane:close", "pane_not_found", `pane ${args[2]} not found`);
      if (pane.agent != null) process.exit(92); // the conductor only closes proven-empty panes
      delete state.panes[args[2]];
      (state.closed ??= []).push(args[2]);
      const tab = state.tabs[pane.tab_id];
      if (--tab.pane_count === 0) { delete state.tabs[pane.tab_id]; (state.removedTabs ??= []).push(pane.tab_id); } // herdr drops an empty tab itself
      output("cli:pane:close", { type: "ok" });
    });
    return;
  }
  if (command === "agent start") {
    const name = args[2], paneId = flag(args, "--pane"), argv = args.slice(args.indexOf("--") + 1);
    const sessionFile = flag(argv, "--session"), nonce = flag(argv, "--conductor-launch");
    const runDir = dirname(dirname(sessionFile));
    // Real herdr 0.9.1 registers only an idle agent: a task already visible keeps it busy.
    const busy = () => { try { return readdirSync(join(runDir, "inbox", nonce)).some(f => /^\d{6}-[^.]+(\.sending)?\.json$/.test(f)); } catch { return false; } };
    const manifest = locked(statePath, state => {
      const pane = state.panes[paneId];
      if (!pane) { fail("cli:agent:start", "pane_not_found", `pane ${paneId} not found`); return; }
      if (state.agentNames.includes(name)) { fail("cli:agent:start", "agent_name_taken", `agent name ${name} is already used`); return; }
      if (pane.agent != null) { fail("cli:agent:start", "agent_pane_busy", `pane ${paneId} is busy`); return; }
      state.agentNames.push(name);
      const path = join(state.manifests, `${String(state.next++).padStart(4, "0")}-${paneId.replace(/[^A-Za-z0-9]/g, "_")}.json`);
      writeFileSync(path, JSON.stringify({ runDir, nonce, paneId, socketPath: process.env.HERDR_SOCKET_PATH, paneEnv: pane.env, cwd: pane.cwd, argv }));
      return path;
    });
    if (!manifest) return;
    if (busy()) return fail("cli:agent:start", "timeout", "timed out waiting for agent startup");
    const end = Date.now() + 15000;
    while (!existsSync(`${manifest}.ready`)) { if (Date.now() > end) process.exit(94); await delay(10); }
    if (busy()) return fail("cli:agent:start", "timeout", "timed out waiting for agent startup");
    locked(statePath, state => {
      const pane = state.panes[paneId];
      pane.agent = "pi"; pane.childPid = Number(readFileSync(`${manifest}.ready`, "utf8"));
      pane.agent_session = { kind: "path", value: sessionFile, source: "integration", agent: "pi" };
      output("cli:agent:start", { type: "agent_started", agent: { ...visible(pane), name, interactive_ready: true } });
    });
    return;
  }
  process.exit(93); // tab close and anything else is never expected from the conductor
}

/** Initial v2 state: one workspace whose first tab holds the lead's own pane. */
export function initialState(manifests, leadPane = "w1:p1") {
  mkdirSync(manifests, { recursive: true });
  return { v: 2, calls: [], next: 2, agentNames: [], manifests,
    tabs: { "w1:t1": { tab_id: "w1:t1", workspace_id: "w1", label: "lead", number: 1, focused: true, pane_count: 1, agent_status: "unknown" } },
    panes: { [leadPane]: { pane_id: leadPane, terminal_id: "term_lead", workspace_id: "w1", tab_id: "w1:t1", agent: "pi", agent_session: null, cwd: "/", env: {} } } };
}
