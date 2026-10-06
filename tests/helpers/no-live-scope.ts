// Import FIRST in native smoke files: this module has no imports, so it evaluates and throws
// before any repository module. An inherited herdr scope would select the live herdr runtime.
const LIVE_SCOPE = ["HERDR_ENV", "HERDR_SOCKET_PATH", "HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SESSION", "HERDR_BIN_PATH", "CONDUCTOR_SUBAGENT"];
const inherited = LIVE_SCOPE.filter(key => process.env[key] !== undefined);
if (inherited.length) throw new Error(`live scope inherited (${inherited.join(", ")}): run through npm test or the ctest wrapper, never inside a live herdr scope`);
// Children inherit this env: a pre-commit hook's GIT_DIR/GIT_INDEX_FILE would route their git into the committing checkout.
for (const key of Object.keys(process.env)) if (key.startsWith("GIT_")) delete process.env[key];
export {};
