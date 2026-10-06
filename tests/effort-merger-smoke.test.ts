/**
 * M6a native smoke: a real Pi 0.87.1 CLI (`main()` bundled from CONDUCTOR_NATIVE_PI_ROOT with an
 * explicit esbuild alias, never the repository devDependency) runs as the merger through the
 * production launcher, SpawnQueue, spawnRun and pipeline, with real bash, real ask_owner and an
 * offline faux model. Private repositories and a private marker hook only. Missing 0.87.1 fails.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { stop } from "esbuild";
import { assertNoLiveScope, bundleNativeMerger } from "./helpers/native-merger-bundle.ts";
import { git, until } from "./helpers/effort-integration.ts";
import { land, mergerFixture, trailerCount } from "./helpers/effort-merger.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { createMergerLauncher } from "../src/effort/merger.ts";
import { readEffort } from "../src/effort/store.ts";
import { stepCost } from "../src/delegation.ts";
import { SpawnQueue } from "../src/queue.ts";
import { forceTerminate, sendToRun } from "../src/runs.ts";
import { emptyUsage, isTerminal, type Run } from "../src/types.ts";

assertNoLiveScope();
sandboxPi();
process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
const root = tmpDir("m6a-native-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");
mkdirSync(join(root, "agent"), { recursive: true });
writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", quietStartup: true, enableInstallTelemetry: false }));
after(() => stop());

let bundled: Promise<string> | undefined;
const child = (t: test.TestContext) => bundled ??= bundleNativeMerger(root, line => t.diagnostic(line));

const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
async function poll(cond: () => boolean, what: string, ms = 25000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 20)); }
}

async function native(t: test.TestContext, scenario: string, opts: { verify?: string; writer?: Record<string, string>; conflict?: boolean; maxConcurrent?: number; timeoutMs?: number } = {}) {
  process.env.PI_BIN = await child(t);
  const fixture = tmpDir("m6a-native-fixture-");
  process.env.M6A_FIXTURE = fixture; process.env.M6A_MERGER_SCENARIO = scenario;
  const f = mergerFixture(t, { verify: opts.verify ?? "git rev-parse HEAD" });
  const a = f.writer("builder-a", opts.writer ?? { base: "writer\n" });
  const landed = opts.conflict === false ? f.base : land(f.root, f.record.intRef, { base: "landed\n" });
  const markers = join(f.root, ".git", "hook-marker"), tighten = join(f.root, ".git", "tighten");
  // A private fixture hook: marks every commit, may be tightened, and edits the committed tree.
  f.hook(`top=$(git rev-parse --show-toplevel)\necho "$top" >> "${markers}"\nif test -f "${tighten}"; then echo "fixture policy: commit refused" >&2; exit 1; fi\nstamp="hook-stamp-$(basename "$top")"
echo "$top" > "$stamp" && git add -- "$stamp"`);
  const queue = new SpawnQueue(f.registry, opts.maxConcurrent ?? 4, 1);
  const cards: Run[] = [];
  f.registry.integrations.configureMerger(createMergerLauncher({ queue, notify: r => cards.push(r), timeoutMs: opts.timeoutMs ?? 30000 }));
  t.after(() => {
    // Exactly the processes this file started: registry pids and the timeout fixture's own sleep.
    for (const r of f.registry.list()) if (r.mergerFor && alive(r.pid)) process.kill(r.pid!, "SIGKILL");
    const pidFile = join(fixture, "timeout-pid");
    if (existsSync(pidFile)) { const pid = Number(readFileSync(pidFile, "utf8")); if (alive(pid)) process.kill(pid, "SIGKILL"); }
  });
  const merger = () => f.registry.list().find(r => r.mergerFor?.writerId === a.id);
  const markerLines = () => existsSync(markers) ? readFileSync(markers, "utf8").trim().split("\n") : [];
  return { ...f, a, landed, fixture, cards, queue, merger, markerLines, tighten, out: () => f.start(a) };
}
const settledMerger = async (n: Awaited<ReturnType<typeof native>>) => { await poll(() => !!n.merger() && isTerminal(n.merger()!.status) && !n.merger()!.processOpen, "merger settled and closed"); return n.merger()!; };

test("M6a native 0.87.1 merger resolves a conflict with real bash; the post-hook squash is verified and integrated once", { timeout: 60000 }, async t => {
  const n = await native(t, "resolve");
  const outcome = await n.out();
  const m = n.merger()!;
  assert.equal(outcome.terminal, "completed", `${n.a.errorMessage} ${JSON.stringify(n.a.integration)}`);
  assert.equal(m.status, "completed"); assert.equal(m.cwd, n.a.integration!.merger!.candidatePath);
  const turns = readdirSync(n.fixture).filter(x => x.startsWith("merger-turn-"));
  assert.ok(turns.length >= 2); assert.match(readFileSync(join(n.fixture, turns[0]!), "utf8"), /^0\.87\.1\n\n/, "the merger ran on Pi 0.87.1 with no inherited GIT_* scope");
  assert.ok(turns.every(x => readFileSync(join(n.fixture, x), "utf8").endsWith(m.cwd)), "the merger worked in its candidate");
  const tip = n.tip();
  assert.equal(outcome.landedCommit, tip); assert.equal(git(n.root, "show", "-s", "--format=%P", tip), n.landed);
  assert.equal(git(n.root, "show", `${tip}:base`), "landed\nwriter");
  for (const trailer of ["Conductor-Effort: probe", `Conductor-Run: ${n.a.id}`, `Conductor-Merger: ${m.id}`]) assert.equal(trailerCount(n.root, tip, trailer), 1, trailer);
  const lines = n.markerLines();
  assert.deepEqual(lines, [m.cwd, n.a.integration!.candidatePath], "ordinary hooks ran for the merger's commit, then for the driver's");
  assert.equal(git(n.root, "show", `${tip}:hook-stamp-${basename(n.a.integration!.candidatePath!)}`), n.a.integration!.candidatePath, "the integrated tree is the driver commit's post-hook tree");
  assert.equal(readFileSync(n.a.integration!.verify!.logPath, "utf8").split("\n")[0], tip, "verify ran against the exact post-hook OID");
  assert.equal(n.a.integration!.merger!.cost, 0.02); assert.equal(stepCost(n.a, n.registry.list()), 0.03, "faux 0.01 writer + 0.02 merger, once");
  assert.equal(n.cards.length, 0, "no merger card for a terminal merger");
});

test("M6a native: B integrates while A's merger is held; A then re-merges, verifies and CASes on B's tip", { timeout: 60000 }, async t => {
  const n = await native(t, "hold");
  const outA = n.out();
  await poll(() => !!n.merger()?.pid, "merger running");
  const b = n.writer("builder-b", { other: "b\n" });
  const outB = await n.start(b);
  assert.equal(outB.terminal, "completed"); assert.equal(n.a.integration!.state, "resolving");
  writeFileSync(join(n.fixture, "release"), "go");
  const outcome = await outA;
  assert.equal(outcome.terminal, "completed", n.a.errorMessage);
  assert.equal(git(n.root, "show", "-s", "--format=%P", outcome.landedCommit!), outB.landedCommit);
  assert.equal(git(n.root, "show", `${outcome.landedCommit}:other`), "b"); assert.equal(git(n.root, "show", `${outcome.landedCommit}:base`), "landed\nwriter");
});

test("M6a native: the tip moves into a new conflict while the merger works: merge_conflict, no second merger", { timeout: 60000 }, async t => {
  const n = await native(t, "hold");
  const out = n.out();
  await poll(() => !!n.merger()?.pid, "merger running");
  land(n.root, n.record.intRef, { base: "landed again\n" });
  const moved = n.tip();
  writeFileSync(join(n.fixture, "release"), "go");
  const outcome = await out;
  assert.equal(outcome.terminal, "merge_conflict"); assert.match(outcome.mergeResult.errorMessage!, /no second merger/);
  assert.equal(n.registry.list().filter(r => r.mergerFor).length, 1); assert.equal(n.tip(), moved);
});

test("M6a native: a twice-red verify is fixed by the merger and integrates", { timeout: 60000 }, async t => {
  const n = await native(t, "fix", { verify: "test ! -f broken", writer: { change: "work\n", broken: "x\n" }, conflict: false });
  const outcome = await n.out();
  assert.equal(outcome.terminal, "completed", n.a.errorMessage);
  assert.equal(n.a.integration!.merger!.kind, "verify_failed");
  assert.throws(() => git(n.root, "show", `${outcome.landedCommit}:broken`));
  assert.equal(trailerCount(n.root, outcome.landedCommit!, `Conductor-Merger: ${n.merger()!.id}`), 1);
});

test("M6a native: a proposal committed under a benign fixture hook is re-checked under the tightened hook; refusal pauses", { timeout: 60000 }, async t => {
  const n = await native(t, "resolve");
  n.registry.onChange(r => { if (r.mergerFor && r.status === "completed") writeFileSync(n.tighten, "tight"); });
  const out = n.out();
  await until(n.registry, n.a, r => r.integration?.state === "paused", 30000);
  assert.match(n.a.integration!.reason!, /candidate commit hooks failed/);
  assert.match(readFileSync(n.a.integration!.commitHook!.logPath, "utf8"), /fixture policy: commit refused/);
  assert.equal(n.markerLines().length, 2, "the driver commit ran the current hook again");
  assert.equal(n.tip(), n.landed); assert.equal(readEffort(n.root, "probe")!.status, "paused");
  assert.equal(n.a.integration!.merger!.outcome, "accepted", "accepted for re-gating only, never integrated");
  forceTerminate(n.a, "killed", n.registry); assert.equal((await out).terminal, "killed");
});

for (const [scenario, reason, timeoutMs] of [
  ["markers", /conflict markers/, undefined], ["no-commit", /no commit/, undefined], ["dirty", /untracked or ignored/, undefined],
  ["failure", /merger failed/, undefined], ["timeout", /merger timeout/, 4000],
] as const) test(`M6a native: a ${scenario} merger is rejected with its candidate and the source preserved`, { timeout: 60000 }, async t => {
  const n = await native(t, scenario, { timeoutMs });
  const started = Date.now();
  const outcome = await n.out();
  const m = await settledMerger(n);
  assert.equal(outcome.terminal, "merge_conflict"); assert.match(n.a.integration!.merger!.reason!, reason);
  assert.equal(n.tip(), n.landed); assert.ok(existsSync(m.cwd));
  if (scenario === "dirty") assert.equal(readFileSync(join(m.cwd, "notes.md"), "utf8"), "junk\n", "the bad proposal is not cleaned to force validity");
  if (scenario === "timeout") { assert.equal(m.status, "timeout"); assert.ok(Date.now() - started < 30000, "a real short timeout"); }
  assert.equal(n.registry.list().filter(r => r.mergerFor).length, 1);
});

test("M6a native: ask_owner blocks the merger and keeps the writer resolving; ensemble_send's answer resumes it in the candidate and integrates", { timeout: 60000 }, async t => {
  const n = await native(t, "ask");
  const out = n.out();
  await poll(() => n.merger()?.status === "blocked", "merger blocked");
  const m = n.merger()!;
  await poll(() => /blocked: "Keep landed first, or writer first\?"/.test(n.a.integration!.reason ?? ""), "writer shows the blocked merger");
  assert.equal(n.a.status, "integrating"); assert.equal(n.a.integration!.state, "resolving");
  assert.equal(n.cards.length, 1); assert.equal(n.cards[0]!.id, m.id, "one blocked card reaches the owner");
  const later: Run[] = [];
  const sent = sendToRun(m, "Keep writer first.", { registry: n.registry, timeoutMs: 30000, sessionId: "owner", onComplete: r => later.push(r) });
  assert.equal(sent.kind, "started", (sent as { reason?: string }).reason);
  const outcome = await out;
  assert.equal(outcome.terminal, "completed", n.a.errorMessage);
  assert.equal(git(n.root, "show", `${outcome.landedCommit}:base`), "writer\nlanded", "the answer reached the resumed merger");
  assert.ok(readdirSync(n.fixture).filter(x => x.startsWith("merger-turn-")).every(x => readFileSync(join(n.fixture, x), "utf8").endsWith(m.cwd)), "resumed in the candidate");
  assert.equal(later.length, 0, "the terminal merger is the writer's card, not its own");
});

for (const phase of ["queued", "running", "blocked"] as const) test(`M6a native: killing the writer with a ${phase} merger stops it, waits for exit and settles once`, { timeout: 60000 }, async t => {
  const n = await native(t, phase === "blocked" ? "ask" : "hold", { maxConcurrent: phase === "queued" ? 1 : 4 });
  const occupant: Run = { id: "oracle-slot", persona: "oracle", task: "hold the slot", mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(),
    cwd: n.root, recordPath: join(n.fixture, "slot.json"), transcriptPath: "", finalPath: "" };
  if (phase === "queued") n.registry.register(occupant);
  let settled = 0;
  const out = n.out().then(o => { settled++; return o; });
  await poll(() => phase === "queued" ? n.merger()?.status === "queued" : phase === "blocked" ? n.merger()?.status === "blocked" : existsSync(join(n.fixture, readdirSync(n.fixture).find(x => x.startsWith("merger-turn-")) ?? "missing")), `merger ${phase}`);
  if (phase === "queued") writeFileSync(join(n.fixture, "merger-launch-forbidden"), "x");
  const pid = n.merger()!.pid;
  forceTerminate(n.a, "killed", n.registry);
  const outcome = await out;
  const m = n.merger()!;
  assert.equal(outcome.terminal, "killed"); assert.equal(settled, 1); assert.equal(m.status, "killed");
  if (phase === "running") assert.equal(alive(pid), false, "the merger process exited before the writer settled");
  if (phase === "queued") {
    occupant.status = "completed"; n.registry.notify(occupant);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(n.merger()!.pid, undefined, "a cancelled queued merger never launches");
  }
  assert.equal(n.tip(), n.landed); assert.ok(existsSync(n.a.integration!.merger!.candidatePath));
  await new Promise(r => setTimeout(r, 100)); assert.equal(settled, 1);
});
