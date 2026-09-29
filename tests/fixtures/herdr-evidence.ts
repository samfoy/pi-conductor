export const invocation = {
  runId: "builder-fake", launchNonce: "nonce-fake", sessionId: "session-fake",
  sessionFile: "/private/fake/session.jsonl",
};
export const binding = {
  ...invocation, socketPath: "/private/fake/socket", workspaceId: "ws_fake",
  tabId: "tab_fake", paneId: "pane_fake", terminalId: "term_fake", createdTab: true,
  childPid: 99, childStartTime: 1234,
};
export const pane = {
  pane_id: binding.paneId, terminal_id: binding.terminalId,
  workspace_id: binding.workspaceId, tab_id: binding.tabId, agent: null,
  agent_session: null, agent_status: "unknown", focused: false, revision: 0,
};
export const hello = {
  v: 1, bridgeProtocol: 1, ...invocation, pid: 99, pidStartTime: 1234,
  paneId: binding.paneId, piVersion: "0.87.1", conductorVersion: "0.1.0", at: 100,
};
export const livePane = {
  ...pane, agent: "pi", agent_status: "idle",
  agent_session: {kind: "path", value: invocation.sessionFile, agent: "pi", source: "integration"},
};
