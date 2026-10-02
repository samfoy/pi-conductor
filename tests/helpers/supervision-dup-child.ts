// S1 concurrency witness: one real process per would-be owner of the same exact
// session id. Every child starts publishing at the same release instant.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LeadPresence } from "../../src/supervision/presence.ts";

const [dir, sessionId, index] = process.argv.slice(2) as [string, string, string];
const presence = new LeadPresence({
  pi: { getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [], getSessionName: () => undefined } as never,
  env: { HERDR_ENV: "1", HERDR_SOCKET_PATH: join(dir, "herdr.sock"), HERDR_PANE_ID: `pane-${index}` },
  registry: { list: () => [], onChange: () => () => {}, countActive: () => 0 } as never,
  getMode: () => true,
  describeRepo: () => ({}),
});
writeFileSync(join(dir, `ready-${index}`), String(process.pid));
while (!existsSync(join(dir, "go"))) { /* spin: start as close together as the scheduler allows */ }
presence.start({ sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, cwd: "/work" });
writeFileSync(join(dir, `status-${index}.json`), JSON.stringify(presence.status()));
while (!existsSync(join(dir, "release"))) await new Promise(r => setTimeout(r, 10));
presence.stop();
