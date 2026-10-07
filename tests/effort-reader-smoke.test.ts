/**
 * M7 native smoke: a real Pi 0.87.1 CLI (`main()` bundled from CONDUCTOR_NATIVE_PI_ROOT with an explicit
 * esbuild alias, never the repository devDependency) runs as an effort reader through SpawnQueue,
 * spawnRun and the pipeline, with real ask_owner, real bash and an offline faux model, in a private repo.
 * It asks inside its detached view, the owner's answer resumes it there, and its verdict is pinned to the
 * OID it viewed. Writer hooks, integration and legacy merge never run. Missing 0.87.1 fails.
 */
// First import: throws on an inherited herdr scope before any repository module evaluates.
import "./helpers/no-live-scope.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stop } from "esbuild";
import { bundleNativeMerger } from "./helpers/native-merger-bundle.ts";
import { git } from "./helpers/effort-integration.ts";
import { land, mergerFixture } from "./helpers/effort-merger.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { effortDir, readEffort } from "../src/effort/store.ts";
import { stepCost } from "../src/delegation.ts";
import { SpawnQueue } from "../src/queue.ts";
import { sendToRun } from "../src/runs.ts";
import { isSettled, type Persona, type Run } from "../src/types.ts";

const { home } = sandboxPi();
assert.equal(process.env.HERDR_SOCKET_PATH, undefined); assert.equal(process.env.HERDR_ENV, undefined);
process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
const root = tmpDir("m7-native-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");
mkdirSync(join(root, "agent"), { recursive: true });
writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", quietStartup: true, enableInstallTelemetry: false }));
after(() => stop());

const finalizer: Persona = { name: "finalizer", description: "native", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1,
  systemPrompt: "Judge completeness; report a verdict.", source: "builtin", sourcePath: "/fixture", readOnly: true, excludeTools: ["edit", "write"] };
const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const settled = (registry: import("../src/runs.ts").RunRegistry, run: Run, ms = 40000) => new Promise<void>((resolve, reject) => {
  if (isSettled(run.status) && !run.processOpen) return resolve();
  const timer = setTimeout(() => { off(); reject(new Error(`not settled: ${run.status} ${run.errorMessage ?? ""} ${run.transport?.stderr?.slice(-600) ?? ""}`)); }, ms);
  const off = registry.onChange(r => { if (r === run && isSettled(r.status) && !r.processOpen) { clearTimeout(timer); off(); resolve(); } });
});

test("M7 native 0.87.1 reader: ask and answer inside its detached view, its validation hook in the view, no commit or integration, verdict pinned to the viewed OID, cost once", { timeout: 90000 }, async t => {
  process.env.PI_BIN = await bundleNativeMerger(root, line => t.diagnostic(line));
  const fixture = tmpDir("m7-native-fixture-");
  process.env.M6A_FIXTURE = fixture; process.env.M6A_MERGER_SCENARIO = "reader";
  const f = mergerFixture(t, { verify: "true" });
  const landed = land(f.root, f.record.intRef, { base: "landed\n" });
  // A repository commit hook marks any writer-path commit; the configured validation hook (R2) must run in the
  // view after the child exits and before the verdict is written, so it refuses if the effort already holds one.
  const commitMarker = join(fixture, "commit-hook"), closeMarker = join(fixture, "close-hook");
  f.hook(`echo "$(git rev-parse --show-toplevel)" >> "${commitMarker}"`);
  const effortJson = join(effortDir(f.root, "probe"), "effort.json");
  mkdirSync(join(home, ".pi", "agent", "extensions", "conductor"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "extensions", "conductor", "config.json"), JSON.stringify({ personaOverrides: { finalizer: {
    onCompleteHook: `if grep -q '"finalizer"' '${effortJson}'; then exit 3; fi; printf '%s %s\\n' "$(pwd)" "$(git rev-parse HEAD)" >> '${closeMarker}'` } } }));
  const queue = new SpawnQueue(f.registry, 4, 1);
  const cards: string[] = [];
  t.after(() => { for (const r of f.registry.list()) if (alive(r.pid)) process.kill(r.pid!, "SIGKILL"); });
  const result = queue.enqueueOrSpawn({ registry: f.registry, cwd: f.root, persona: finalizer, task: "Judge the integrated tip.", mode: "background", timeoutMs: 30000,
    parentSessionId: "owner", effort: "probe", onComplete: r => cards.push(`${r.status}`) });
  assert.equal(result.kind, "spawned"); if (result.kind !== "spawned") return;
  const run = result.run;
  const view = join(f.root, ".worktrees", "conductor-view", run.id);
  assert.equal(run.effort?.role, "reader"); assert.equal(run.effort?.spawnBase, landed); assert.equal(run.worktreePath, view);
  await settled(f.registry, run);
  assert.equal(run.status, "blocked", run.errorMessage);
  assert.equal(run.pendingAsk?.question, "Review only the integrated tip?");
  assert.equal(existsSync(view), true, "a blocked reader keeps its view"); assert.equal(git(view, "rev-parse", "HEAD"), landed);
  const sent = sendToRun(run, "Yes, only the integrated tip.", { registry: f.registry, timeoutMs: 30000, sessionId: "owner", onComplete: r => cards.push(`${r.status}`) });
  assert.equal(sent.kind, "started", sent.kind === "rejected" ? sent.reason : "");
  await settled(f.registry, run);
  assert.equal(run.status, "completed", `${run.errorMessage} ${run.transport?.stderr?.slice(-600) ?? ""}`);
  // The card is dispatched only after record.json and final.md are written.
  for (const end = Date.now() + 5000; cards.length < 2 && Date.now() < end;) await new Promise(r => setTimeout(r, 20));
  assert.equal(run.effort?.role, "reader", "the answer kept the frozen role");
  const callers = readdirSync(fixture).filter(x => x.startsWith("caller-model-")).map(x => JSON.parse(readFileSync(join(fixture, x), "utf8")));
  // The spawn passes no --model (the fixture names faux/faux-1); the answer resumes the session's served model.
  assert.deepEqual(callers.map(c => c.callerModel).sort(), ["faux/faux-1", null], "only a registered faux model was ever served");
  const turns = readdirSync(fixture).filter(x => x.startsWith("merger-turn-")).map(x => readFileSync(join(fixture, x), "utf8"));
  assert.ok(turns.length >= 3, `${turns.length} turns`);
  assert.ok(turns.every(x => x.startsWith("0.87.1\n\n")), "every turn ran on Pi 0.87.1 with no inherited GIT_* scope");
  assert.ok(turns.every(x => x.endsWith(`\n${view}`)), "the ask and the answered turns ran in the view");
  const final = readFileSync(run.finalPath, "utf8");
  assert.match(final, /^## Verdict: complete\n/);
  assert.match(final, new RegExp(`${landed}\\nHEAD\\nend-of-status`), "real git in the view: detached at the viewed OID, nothing in status");
  const evidence = readEffort(f.root, "probe")!.finalizer;
  assert.deepEqual(evidence && { runId: evidence.runId, tip: evidence.tip, verdict: evidence.verdict }, { runId: run.id, tip: landed, verdict: "complete" });
  assert.equal(existsSync(view), false, "the clean view is removed"); assert.equal(run.effort?.reviewed, landed);
  assert.equal(run.integration, undefined); assert.equal(run.mergeResult, undefined); assert.equal(run.hookResult?.passed, true, run.hookResult?.tailText);
  assert.deepEqual(readFileSync(closeMarker, "utf8").trim().split("\n"), [`${view} ${landed}`], "the validation hook ran once, in the view at the viewed OID, on the answered completion");
  assert.equal(existsSync(commitMarker), false, "no commit (writer path) ran");
  assert.equal(f.tip(), landed, "the integration tip did not move");
  assert.equal(existsSync(join(f.root, ".worktrees", "conductor-cand")), false, "no candidate");
  assert.equal(stepCost(run, f.registry.list()), 0.02, "the faux 0.02 of the verdict turn, counted once across ask and answer");
  assert.deepEqual(cards, ["blocked", "completed"], "one card per settlement");
});
