import { register } from "tsx/esm/api";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

register();
const flag = name => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const nonce = flag("--conductor-launch"), env = process.env;
const manifest = join(env.FAKE_HC_MANIFESTS, `${nonce}.json`);
const paneEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("CONDUCTOR_")));
writeFileSync(manifest, JSON.stringify({ runDir: env.CONDUCTOR_RUN_DIR, nonce, paneId: env.HC_TERMINAL_ID, socketPath: env.HC_TERMINAL_SOCKET, paneEnv, cwd: process.cwd(), argv: process.argv.slice(2) }));
process.argv.splice(2, process.argv.length - 2, manifest);
await import("./herdr-delegation-child.mjs");
