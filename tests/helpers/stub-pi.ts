/**
 * Load the real extension against a minimal pi stub, for tests that drive
 * its lifecycle handlers (session_start / session_shutdown). Returns a
 * `fire(event, payload, ctx)` that awaits every handler for that event.
 */

import conductor from "../../src/index.ts";

export type Fire = (ev: string, event: unknown, ctx: unknown) => Promise<void>;

export function loadConductor(): Fire {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const pi = {
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) =>
      void handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
    registerFlag() {}, getFlag() {},
    registerTool: () => {},
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerShortcut: () => {},
    sendMessage: () => {},
    appendEntry: () => {},
  };
  conductor(pi as any);
  return async (ev, event, ctx) => {
    for (const h of handlers.get(ev) ?? []) await h(event, ctx);
  };
}

/** A headless ExtensionContext stand-in rooted at `cwd`. */
export function stubCtx(cwd: string) {
  const theme = { fg: (_s: string, t: string) => t, bold: (t: string) => t };
  return {
    cwd,
    hasUI: false,
    ui: { notify: () => {}, setWidget: () => {}, onTerminalInput: () => () => {}, theme },
    sessionManager: { getBranch: () => [], getEntries: () => [], getLeafId: () => null, getSessionId: () => "sess" },
  };
}
