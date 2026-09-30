// One fake-effect live teardown in its own process, built like tests/herdr-live.test.ts:
// tmpDir's exit hook is armed, the root comes from liveParentRoot(). The parent test
// checks what is left on disk after this process has exited. No herdr, no real signals.
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "../helpers/tmp.ts";
import { HerdrLiveFixture, liveParentRoot, planLiveIdentity, type LiveEffects } from "../helpers/herdr-live.ts";

tmpDir("h");
const survivor = process.argv[2] === "survivor";
const root = liveParentRoot(), id = planLiveIdentity(root, "td000001", join(root, "no-real-home"));
writeFileSync(join(root, "server.log"), "fixture evidence\n");
let serverAlive = true;
const effects: LiveEffects = {
  async exec(args) {
    if (args[1] === "list") return JSON.stringify({ sessions: [{ name: id.name, running: serverAlive, socket_path: id.socketPath, session_dir: id.sessionDir }] });
    if (args[0] === "status") return JSON.stringify({ running: true, socket: id.socketPath });
    if (args[1] === "stop") { serverAlive = false; return JSON.stringify({ stopped: true, session: { socket_path: id.socketPath } }); }
    return JSON.stringify({ deleted: true });
  },
  // Fake procfs facts: pid 999 is a captured fixture process that ignores SIGTERM when "survivor".
  startTime: pid => pid === 4242 ? (serverAlive ? 77 : undefined) : pid === 999 && survivor ? 5 : undefined,
  holdsSocket: () => true, netns: pid => pid === process.pid ? "net:[host]" : "net:[private]",
  processes: () => [{ pid: 999, startTime: 5, argv: "fake pi" }],
  signal: () => {},
  remove: path => rmSync(path, { recursive: true, force: true }),
};
const report = await new HerdrLiveFixture(id, { pid: 4242, startTime: 77, exited: () => !serverAlive, wait: async () => !serverAlive }, effects).teardown(100);
process.stdout.write(JSON.stringify({ root, report }));
