/**
 * M6b native smoke: under `merger:"ask"` a conflict launches nothing; only the production
 * `/conductor effort resolve` (fake UI confirm) starts one real Pi 0.87.1 merger (bundled from
 * CONDUCTOR_NATIVE_PI_ROOT via helpers/native-merger-bundle.ts, the fixed faux/faux-1 model of
 * helpers/native-merger-child.ts) through the launcher, SpawnQueue, spawnRun and pipeline. Private
 * repo, private HOME with an explicit subprocess runtime, and a refusing herdr shim on PATH.
 */
// First import: throws on an inherited herdr scope before any repository module evaluates.
import "./helpers/no-live-scope.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stop } from "esbuild";
import { bundleNativeMerger } from "./helpers/native-merger-bundle.ts";
import { git, until } from "./helpers/effort-integration.ts";
import { land, mergerFixture, trailerCount } from "./helpers/effort-merger.ts";
import { command, conflicted, preserving } from "./helpers/effort-resolve.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { createMergerLauncher } from "../src/effort/merger.ts";
import { SpawnQueue } from "../src/queue.ts";
import { sendToRun } from "../src/runs.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";
import { isTerminal, type Run } from "../src/types.ts";

const { home } = sandboxPi();
process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
const root = tmpDir("m6b-native-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");
mkdirSync(join(root, "agent"), { recursive: true });
writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", quietStartup: true, enableInstallTelemetry: false }));
// Explicit subprocess runtime (private user config) and a herdr CLI that refuses and records any call.
mkdirSync(join(home, ".pi", "agent", "extensions", "conductor"), { recursive: true });
writeFileSync(join(home, ".pi", "agent", "extensions", "conductor", "config.json"), JSON.stringify({ runtime: "subprocess" }));
const herdrCalls = join(root, "herdr-invoked");
mkdirSync(join(root, "bin"));
writeFileSync(join(root, "bin", "herdr"), `#!/bin/sh\necho "$*" >> "${herdrCalls}"\necho "herdr refused in the M6b smoke" >&2\nexit 97\n`, { mode: 0o755 });
process.env.PATH = `${join(root, "bin")}:${process.env.PATH}`;
after(() => stop());

let bundled: Promise<string> | undefined;
const child = (t: test.TestContext) => bundled ??= bundleNativeMerger(root, line => t.diagnostic(line));
async function poll(cond: () => boolean, what: string, ms = 45000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 20)); }
}

async function native(t: test.TestContext, scenario: string) {
  process.env.PI_BIN = await child(t);
  const fixture = tmpDir("m6b-native-fixture-");
  process.env.M6A_FIXTURE = fixture; process.env.M6A_MERGER_SCENARIO = scenario;
  const f = mergerFixture(t, { verify: "git rev-parse HEAD", policy: { merger: "ask" } });
  const a = f.writer("builder-a", { base: "writer\n" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  const markers = join(f.root, ".git", "hook-marker");
  f.hook(`echo "$(git rev-parse --show-toplevel)" >> "${markers}"`);
  const mergerCards: Run[] = [];
  f.registry.integrations.configureMerger(createMergerLauncher({ queue: new SpawnQueue(f.registry, 4, 1), notify: r => mergerCards.push(r), timeoutMs: 30000 }));
  // Test-owned processes by pid and procfs start time; an unproven identity is never signalled.
  const owned = new Map<number, number | undefined>();
  f.registry.onChange(r => { if (r.mergerFor && r.pid && !owned.has(r.pid)) owned.set(r.pid, readProcessStartTime(r.pid)); });
  t.after(async () => {
    writeFileSync(join(fixture, "release"), "cleanup");
    for (const [pid, start] of owned) {
      for (let i = 0; i < 100 && readProcessStartTime(pid) === start && start !== undefined; i++) await new Promise(r => setTimeout(r, 20));
      if (start !== undefined && readProcessStartTime(pid) === start) process.kill(pid, "SIGKILL");
    }
  });
  const merger = () => f.registry.list().find(r => r.mergerFor?.writerId === a.id);
  const markerLines = () => existsSync(markers) ? readFileSync(markers, "utf8").trim().split("\n") : [];
  return { ...f, a, landed, fixture, cards: [] as string[], mergerCards, merger, markerLines };
}

/** The first generation under `ask` must not launch even with a live launcher: the child refuses to start. */
async function askConflict(n: Awaited<ReturnType<typeof native>>) {
  const forbidden = join(n.fixture, "merger-launch-forbidden");
  writeFileSync(forbidden, "ask");
  const outcome = await conflicted(n, n.a, n.cards);
  assert.equal(outcome.terminal, "merge_conflict"); assert.equal(outcome.mergeResult.reason, "conflict");
  assert.equal(n.merger(), undefined, "ask launched no automatic merger"); assert.deepEqual(n.markerLines(), [], "no commit ran");
  assert.deepEqual(n.cards, ["builder-a:merge_conflict"]);
  rmSync(forbidden);
}

test("M6b native 0.87.1: ask launches nothing; a confirmed /conductor effort resolve runs one real merger whose proposal re-gates through hooks, verify and CAS, with a second card once", { timeout: 90000 }, t => preserving(t, async () => {
  const n = await native(t, "resolve");
  await askConflict(n);
  const c = command(n, n.cards);
  await c.resolve("builder-a", c.ctx(() => true));
  assert.match(c.notes.at(-1)!.message, /accepted/i, JSON.stringify(c.notes));
  assert.equal(n.a.status, "integrating", "the command returned with the generation queued");
  assert.ok(!n.merger() || !isTerminal(n.merger()!.status), "the command did not wait for the model run");
  await until(n.registry, n.a, r => r.status === "completed", 60000);
  await poll(() => n.cards.length === 2 && !n.a.integrationSettlement, "second card");
  const m = n.merger()!;
  assert.equal(m.status, "completed"); assert.equal(m.runtime, "subprocess"); assert.equal(m.cwd, n.a.integration!.merger!.candidatePath);
  const callers = readdirSync(n.fixture).filter(x => x.startsWith("caller-model-")).map(x => JSON.parse(readFileSync(join(n.fixture, x), "utf8")));
  assert.deepEqual(callers, [{ callerModel: null }], "the launcher passes no --model; the fixture names faux/faux-1");
  const turns = readdirSync(n.fixture).filter(x => x.startsWith("merger-turn-"));
  assert.ok(turns.length >= 2); assert.match(readFileSync(join(n.fixture, turns[0]!), "utf8"), /^0\.87\.1\n\n/, "Pi 0.87.1, no inherited GIT_* scope");
  const tip = n.tip();
  assert.equal(n.a.landedCommit, tip); assert.equal(git(n.root, "show", "-s", "--format=%P", tip), n.landed);
  assert.equal(git(n.root, "show", `${tip}:base`), "landed\nwriter");
  for (const trailer of ["Conductor-Effort: probe", "Conductor-Run: builder-a", `Conductor-Merger: ${m.id}`]) assert.equal(trailerCount(n.root, tip, trailer), 1, trailer);
  const lines = n.markerLines();
  assert.equal(lines.length, 2); assert.equal(lines[0], m.cwd, "the merger's own commit ran the ordinary hook");
  assert.match(lines[1]!, /\/conductor-cand\/probe\/builder-a-[0-9a-f-]{36}$/, "then the driver's re-entry commit in a fresh candidate");
  assert.equal(readFileSync(n.a.integration!.verify!.logPath, "utf8").split("\n")[0], tip, "verify ran against the exact post-hook OID");
  assert.deepEqual(n.cards, ["builder-a:merge_conflict", "builder-a:completed"], "one original card, one resolved card");
  assert.equal(n.a.integration!.previous!.reason, "conflict"); assert.equal(n.a.integration!.previous!.delivery, "attempted");
  assert.equal(n.mergerCards.length, 0, "a terminal merger is not its own card");
  assert.equal(sendToRun(m, "again", { registry: n.registry, timeoutMs: 1000, sessionId: "owner" }).kind, "rejected", "a terminal merger accepts no general resend");
  assert.equal(existsSync(herdrCalls), false, "no herdr CLI call");
}));

test("M6b native 0.87.1: after the command returns, the merger's ask_owner blocks it; the owner's send resumes it in the candidate and integrates once", { timeout: 90000 }, t => preserving(t, async () => {
  const n = await native(t, "ask");
  await askConflict(n);
  const c = command(n, n.cards);
  await c.resolve("builder-a", c.ctx(() => true));
  assert.match(c.notes.at(-1)!.message, /accepted/i);
  await poll(() => n.merger()?.status === "blocked", "merger blocked");
  const m = n.merger()!;
  assert.equal(n.a.integration!.state, "resolving"); assert.equal(n.mergerCards.length, 1, "the merger's question reaches the owner once");
  const later: Run[] = [];
  const sent = sendToRun(m, "Keep writer first.", { registry: n.registry, timeoutMs: 30000, sessionId: "owner", onComplete: r => later.push(r) });
  assert.equal(sent.kind, "started", (sent as { reason?: string }).reason);
  await until(n.registry, n.a, r => r.status === "completed", 60000);
  await poll(() => n.cards.length === 2, "second card");
  assert.equal(git(n.root, "show", `${n.a.landedCommit}:base`), "writer\nlanded", "the answer reached the resumed merger");
  assert.ok(readdirSync(n.fixture).filter(x => x.startsWith("merger-turn-")).every(x => readFileSync(join(n.fixture, x), "utf8").endsWith(m.cwd)), "resumed in the candidate");
  assert.deepEqual(n.cards, ["builder-a:merge_conflict", "builder-a:completed"]); assert.equal(later.length, 0);
  assert.equal(n.registry.list().filter(r => r.mergerFor).length, 1, "one attempt");
  assert.equal(existsSync(herdrCalls), false, "no herdr CLI call");
}));
