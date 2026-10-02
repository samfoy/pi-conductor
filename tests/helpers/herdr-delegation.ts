// N5 harness: real spawnRun -> pipeline -> broker -> queue -> spawnRun through the
// executable multi-pane fake herdr. Each `agent start` writes a manifest; the test
// spawns and owns one child process per manifest and kills only those handles.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { tmpDir } from "./tmp.ts";
import { gitTestEnv } from "./git-env.ts";
import { projectPersonasDir, resolvePersonas } from "../../src/personas.ts";
import { RunRegistry, spawnRun } from "../../src/runs.ts";
import { SpawnQueue } from "../../src/queue.ts";
import { DelegationBroker } from "../../src/delegation-broker.ts";
// @ts-expect-error plain ESM fixture without declarations
import { initialState } from "../fixtures/fake-herdr-panes.mjs";
import type { Run } from "../../src/types.ts";

export const FAKE_HERDR = fileURLToPath(new URL("../fixtures/fake-herdr.mjs", import.meta.url));
export const FAKE_CHILD = fileURLToPath(new URL("../fixtures/herdr-delegation-child.mjs", import.meta.url));
const doc = (name: string, fm: string) => `---\nname: ${name}\ndescription: probe\n${fm}---\nYou are ${name}.\n`;

export interface PaneState {
  panes: Record<string, { pane_id: string; terminal_id: string; tab_id: string; workspace_id: string; agent: string | null; env: Record<string, string>; cwd: string; direction?: string; splitFrom?: string }>;
  tabs: Record<string, { tab_id: string; pane_count: number }>;
  calls: { args: string[] }[];
  closed?: string[];
  removedTabs?: string[];
  report?: Record<string, Record<string, string>>;
}

/** `child(manifest)` returns the argv after `node` for one pane child; the fake tee child by default. */
export async function delegationHarness(t: TestContext, opts: { child?: (manifest: string) => string[]; env?: NodeJS.ProcessEnv; maxConcurrent?: number; personas?: Record<string, string> } = {}) {
  const root = tmpDir("n5-"), statePath = join(root, "state.json"), manifests = join(root, "m");
  writeFileSync(statePath, JSON.stringify(initialState(manifests)));
  const cwd = join(root, "project");
  mkdirSync(projectPersonasDir(cwd), { recursive: true });
  for (const [f, text] of Object.entries({ "lead.md": doc("lead", "agents:\n  - scout\n  - auditor\n"), "scout.md": doc("scout", "read_only: true\n"),
    "auditor.md": doc("auditor", "read_only: true\n"), "writer.md": doc("writer", ""), ...opts.personas })) writeFileSync(join(projectPersonasDir(cwd), f), text);
  const env: NodeJS.ProcessEnv = { ...gitTestEnv(), HERDR_ENV: "1", HERDR_SOCKET_PATH: `${statePath}.socket`, HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1",
    FAKE_HERDR_STATE: statePath, CONDUCTOR_HERDR_BIN: FAKE_HERDR, ...opts.env };
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, opts.maxConcurrent ?? 4, 1);
  const broker = new DelegationBroker({ registry, queue, env });
  registry.delegation = broker;
  const children = new Map<string, ChildProcess>();
  const exits: Promise<unknown>[] = [];
  const argv = opts.child ?? ((manifest: string) => ["--import", "tsx", FAKE_CHILD, manifest]);
  const watcher = setInterval(() => {
    for (const f of readdirSync(manifests)) {
      if (!/^\d{4}-.*\.json$/.test(f) || children.has(f)) continue;
      const child = spawn(process.execPath, argv(join(manifests, f)), { env: gitTestEnv(), stdio: ["ignore", "ignore", "pipe"] });
      let stderr = ""; child.stderr!.on("data", c => { stderr += c; });
      exits.push(once(child, "close").then(() => { if (child.exitCode && stderr) t.diagnostic(`pane child ${f}: ${stderr.slice(-2000)}`); }));
      children.set(f, child);
    }
  }, 10);
  t.after(async () => {
    clearInterval(watcher);
    // Only this test's own handles: a reaped handle signals nothing.
    for (const child of children.values()) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(exits);
  });
  const roster = async () => (await resolvePersonas({ cwd })).personas;
  const state = (): PaneState => JSON.parse(readFileSync(statePath, "utf8"));
  const edit = (fn: (s: PaneState) => void) => { const s = state(); fn(s); writeFileSync(statePath, JSON.stringify(s)); };
  const splits = () => state().calls.filter(c => c.args[0] === "pane" && c.args[1] === "split").map(c => c.args);
  const tabCreates = () => state().calls.filter(c => c.args[0] === "tab" && c.args[1] === "create").map(c => c.args);
  const leaves = (parent: Run) => registry.list().filter(r => r.parentRunId === parent.id).sort((a, b) => a.startTime - b.startTime);
  const manifestOf = (run: Run) => readdirSync(manifests).filter(f => /^\d{4}-.*\.json$/.test(f)).map(f => join(manifests, f))
    .find(f => JSON.parse(readFileSync(f, "utf8")).nonce === run.herdr?.launchNonce);
  let cards = 0;
  const spawnParent = async (task: string, timeoutMs = 60000) => spawnRun({ registry, persona: (await roster()).get("lead")!, task, cwd, mode: "background", timeoutMs,
    runtimeEnv: env, onComplete: () => cards++ });
  return { root, cwd, env, statePath, manifests, registry, queue, broker, children, roster, state, edit, splits, tabCreates, leaves, manifestOf, spawnParent,
    cards: () => cards, release: (name: string) => writeFileSync(join(manifests, name), "go"), running: () => readdirSync(manifests).filter(f => f.startsWith("leaf-running-")).length,
    exists: (name: string) => existsSync(join(manifests, name)) };
}

export async function until(cond: () => boolean, what: string, ms = 30000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 20)); }
}
