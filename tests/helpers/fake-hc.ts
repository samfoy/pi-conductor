import { readFileSync, writeFileSync } from "node:fs";
import { after } from "node:test";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHcCli } from "../../src/hc/cli.ts";
import { tmpDir } from "./tmp.ts";

export const fakeHcBin = fileURLToPath(new URL("../fixtures/fake-hc.mjs", import.meta.url));
const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });

export interface FakeHcTerminal {
  address: string; name: string; pid: number; parent: string | null; labels: Record<string, string>;
  argv: string[]; cwd: string; state: "live" | "finished"; die_with_parent: boolean; notify: boolean;
}
export interface FakeHcCall { args: string[]; socket: string; routingNames: string[] }

export async function fakeHc(extra: Record<string, unknown> = {}, env: Record<string, string> = {}) {
  const root = tmpDir("conductor-hc-");
  const statePath = join(root, "state.json"), socketPath = join(root, "hc.sock");
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
  server.unref();
  writeFileSync(statePath, JSON.stringify({ calls: [], socket: socketPath, coreId: "fakecore0000000000000000000000000", ...extra }));
  const cliEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, TMPDIR: root, CONDUCTOR_HC_BIN: fakeHcBin, FAKE_HC_STATE: statePath, ...env };
  const cli = createHcCli({ env: cliEnv, socketPath });
  const read = () => JSON.parse(readFileSync(statePath, "utf8"));
  const patch = (p: Record<string, unknown>) => writeFileSync(statePath, JSON.stringify({ ...read(), ...p }));
  const terminals = (): Record<string, FakeHcTerminal> => read().terminals ?? {};
  const calls = (): FakeHcCall[] => read().calls;
  const stderrOf = (address: string) => { try { return readFileSync(`${statePath}.${address}.stderr`, "utf8"); } catch { return ""; } };
  return { cli, root, socketPath, statePath, read, patch, terminals, calls, stderrOf };
}
