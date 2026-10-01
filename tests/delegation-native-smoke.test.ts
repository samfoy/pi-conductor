/**
 * N2/N3 native smoke: the real Pi CLI (`main()` from Pi 0.87.1, plus any root in
 * CONDUCTOR_H11_PI_ROOTS such as 0.99.1) runs as a real subprocess through
 * spawnRun -> createRunPipeline -> DelegationBroker -> SpawnQueue -> spawnRun.
 * The child loads the real conductor extension and an offline faux model.
 * Missing 0.87.1 is a failure, never a skip.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { projectPersonasDir, resolvePersonas } from "../src/personas.ts";
import { RunRegistry, buildPiArgs, buildSubagentEnv, getFinalText, spawnRun } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { DelegationBroker } from "../src/delegation-broker.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { delegatePaths } from "../src/delegation.ts";
import { consumesSlot } from "../src/effort/admit.ts";
import { childScopeEnv, isTerminal, type ChildToolScope, type Run } from "../src/types.ts";

sandboxPi();
process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
const root = tmpDir("n2-native-");
process.env.TMPDIR = root; process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");
mkdirSync(join(root, "agent"), { recursive: true });
writeFileSync(join(root, "agent", "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", quietStartup: true, enableInstallTelemetry: false }));
after(() => stop());

/** The child entry bundled against one installed Pi root; returns its path and verified version. */
async function child(t: test.TestContext, piRoot: string): Promise<{ path: string; version: string }> {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? piRoot : join(piRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const path = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main);
    t.diagnostic(`${specifier}@${metadata.version}: ${path}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const path = join(root, `child-${version}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL("./helpers/native-delegate-child.ts", import.meta.url))], outfile: path, bundle: true, platform: "node", format: "esm",
    packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  return { path, version };
}

const doc = (name: string, fm: string) => `---\nname: ${name}\ndescription: probe\n${fm}---\nYou are ${name}.\n`;
function project(): string {
  const cwd = tmpDir("n2-native-project-");
  mkdirSync(projectPersonasDir(cwd), { recursive: true });
  // scout's model comes from its frontmatter, auditor's from a project override; lead sets none and inherits faux-1.
  for (const [f, text] of Object.entries({ "lead.md": doc("lead", "agents:\n  - scout\n  - auditor\n"), "scout.md": doc("scout", "read_only: true\nmodel: faux/faux-scout\nthinking: low\n"),
    "auditor.md": doc("auditor", "read_only: true\n"), "writer.md": doc("writer", ""), "plain.md": doc("plain", "") })) writeFileSync(join(projectPersonasDir(cwd), f), text);
  writeFileSync(join(cwd, ".pi", "conductor.json"), JSON.stringify({ personaOverrides: { auditor: { model: "faux/faux-auditor", thinking: "high" } } }));
  writeFileSync(join(cwd, "notes.md"), "N2-NOTES-EVIDENCE\n");
  return cwd;
}

const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(cond: () => boolean, what: string, ms = 20000) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 20)); }
}
const events = (run: Run) => readFileSync(run.transcriptPath, "utf8").trim().split("\n").map(l => JSON.parse(l));
const response = (run: Run, id: string) => JSON.parse(readFileSync(delegatePaths(dirname(run.recordPath), id).response, "utf8"));

async function scenario(t: test.TestContext, bin: string, name: string) {
  process.env.PI_BIN = bin;
  const cwd = project(), fixture = tmpDir("n2-native-fixture-");
  process.env.N2_FIXTURE = fixture;
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 4, 1);
  registry.delegation = new DelegationBroker({ registry, queue, env: {} });
  let cards = 0;
  const lead = (await resolvePersonas({ cwd })).personas.get("lead")!;
  const { run, done } = spawnRun({ registry, persona: lead, task: `N2-PARENT ${name}`, cwd, mode: "background", timeoutMs: 45000, runtimeEnv: {}, onComplete: () => cards++ });
  // Own processes only, by the pids this test's registry recorded.
  t.after(() => { for (const r of registry.list()) if (alive(r.pid)) process.kill(r.pid!, "SIGKILL"); });
  await done;
  const leaves = registry.list().filter(r => r.parentRunId === run.id);
  await until(() => leaves.every(l => isTerminal(l.status) && !alive(l.pid)) && !alive(run.pid), "every own process exited");
  return { run, registry, leaves, fixture, cards: () => cards };
}

async function witness(t: test.TestContext, bin: string, version: string) {
  const nested = version !== "0.87.1";
  const { run, leaves, cards } = await scenario(t, bin, "fanout");
  assert.equal(run.status, "completed", run.errorMessage);
  // A start alone proves nothing: schema-rejected, blocked and nested calls leave no claim, response or leaf.
  const files = readdirSync(join(dirname(run.recordPath), "delegate")).sort();
  assert.deepEqual(files, ["d_auditor.claim.json", "d_auditor.json", "d_denied.claim.json", "d_denied.json", "d_scout.claim.json", "d_scout.json"],
    "no claim or response for a schema-rejected, blocked or nested call");
  const final = getFinalText(run.messages);
  t.diagnostic(`Pi ${version} parent final:\n${final.replace(/```xml[\s\S]*?```/g, "<envelope>")}`);
  // The parent's next turn read both envelopes and every rejection as native tool results.
  // Pi served each leaf the target persona's configured model and thinking; the parent kept the agent default.
  assert.match(final, /^N2 parent model=faux-1 reasoning=off saw/);
  assert.match(final, /d_scout: ## ✓ `scout` completed[\s\S]*?<result>\nLEAF scout done; model=faux-scout; reasoning=low; evidence=false; saw=Tool delegate not found/);
  assert.match(final, /d_auditor: ## ✓ `auditor` completed[\s\S]*?<result>\nLEAF auditor done; model=faux-auditor; reasoning=high; evidence=true/);
  assert.match(final, /d_denied: ERROR delegate rejected: persona writer is not in this run's delegation allowlist \(scout, auditor\)/);
  assert.match(final, /d_schema: ERROR Validation failed for tool "delegate"/);
  assert.match(final, /d_blocked: ERROR N2 test block/);
  if (nested) assert.match(final, /d_nested: nested: ERROR delegate rejected: nested calls cannot delegate/);

  // Exactly the two allowed calls spawned leaves, with lineage and a read-only leaf scope.
  assert.deepEqual(leaves.map(l => [l.persona, l.delegateToolCallId]).sort(), [["auditor", "d_auditor"], ["scout", "d_scout"]]);
  for (const leaf of leaves) {
    assert.equal(leaf.status, "completed", leaf.errorMessage);
    assert.equal(leaf.onComplete, undefined, "the lead gets no leaf completion card");
    const record = JSON.parse(readFileSync(leaf.recordPath, "utf8"));
    assert.deepEqual([record.depth, record.delegateAllow, record.parentRunId, record.mode, record.worktreePath], [2, [], run.id, "background", undefined]);
    for (const name of ["ask_owner", "delegate", "edit", "write", "subagent", "ensemble_spawn"]) assert.ok(record.excludeTools.includes(name), `${leaf.id} excludes ${name}`);
    const answer = response(run, leaf.delegateToolCallId!);
    assert.deepEqual([answer.v, answer.ok, answer.toolCallId, answer.parentRunId, answer.agentId, answer.status], [1, true, leaf.delegateToolCallId, run.id, leaf.id, "completed"]);
    assert.match(answer.envelope, new RegExp(`<result-ref>run:${leaf.id}</result-ref>`));
  }
  const scout = leaves.find(l => l.persona === "scout")!;
  const leafDelegate = events(scout).filter(e => e.toolCallId === "leaf_delegate").map(e => e.type);
  assert.deepEqual(leafDelegate, ["tool_execution_start", "tool_execution_end"], "a leaf's delegate is unknown to Pi: start then error end");
  assert.equal(cards(), 1, "one card: the parent's");
  assert.equal(run.pendingDelegations, 0);

  // Native order: Pi emits start before validation; only executed calls emit an update.
  const parentEvents = events(run);
  const kinds = (id: string) => parentEvents.filter(e => e.toolCallId === id && /^tool_execution_/.test(e.type)).map(e => e.type.slice(15));
  for (const id of ["d_schema", "d_blocked"]) {
    assert.deepEqual(kinds(id), ["start", "end"], id);
    assert.equal(parentEvents.find(e => e.toolCallId === id && e.type === "tool_execution_end").isError, true);
  }
  for (const id of ["d_scout", "d_auditor", "d_denied"]) assert.equal(kinds(id)[1], "update", `${id}: its first update is the execution proof`);
  if (nested) assert.ok(parentEvents.some(e => e.parentToolCallId === "d_nested" && e.toolName === "delegate"), "the nested call reached the lead's stream and was ignored");

  // Abort: the parent's own abort ends the call; the broker kills only that running leaf.
  const aborted = await scenario(t, bin, "abort");
  assert.equal(aborted.leaves.length, 1);
  const [held] = aborted.leaves;
  assert.ok(readdirSync(aborted.fixture).some(f => f.startsWith("leaf-running-")), "the leaf was running when the abort came");
  assert.equal(held!.status, "killed");
  assert.match(response(aborted.run, "d_abort").reason, /^cancelled: /);
  const end = events(aborted.run).find(e => e.toolCallId === "d_abort" && e.type === "tool_execution_end");
  assert.equal(end?.isError, true);
  assert.match(JSON.stringify(end.result), /delegate aborted/);
}

/** Parse what has landed so far; the pipeline appends lines asynchronously. */
function landed(run: Run): { type: string; toolCallId?: string; isError?: boolean }[] {
  if (!existsSync(run.transcriptPath)) return [];
  return readFileSync(run.transcriptPath, "utf8").split("\n").flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** R6 boundary: the call's start reaches the lead before /reload and its first update after; it must get a definite rejection. */
async function reloadBoundary(t: test.TestContext, bin: string, version: string) {
  process.env.PI_BIN = bin;
  const cwd = project(), fixture = tmpDir("n2-native-fixture-");
  process.env.N2_FIXTURE = fixture;
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 4, 1);
  registry.delegation = new DelegationBroker({ registry, queue, env: {} });
  const lead = (await resolvePersonas({ cwd })).personas.get("lead")!;
  const { run, done } = spawnRun({ registry, persona: lead, task: "N2-PARENT reload", cwd, mode: "background", timeoutMs: 45000, runtimeEnv: {} });
  t.after(() => { for (const r of registry.list()) if (alive(r.pid)) process.kill(r.pid!, "SIGKILL"); });
  await until(() => landed(run).some(e => e.toolCallId === "d_reload" && e.type === "tool_execution_start"), "d_reload start reached the lead");
  assert.ok(!landed(run).some(e => e.toolCallId === "d_reload" && e.type === "tool_execution_update"), "the child holds the call before execute");
  await handleSessionShutdown({ reason: "reload" }, { runs: registry.list(), resetSanitizer: () => {}, delegation: registry.delegation });
  assert.equal(run.status, "running", "a parent with nothing outstanding at reload keeps running");
  writeFileSync(join(fixture, "release-reload"), "go");
  const answer = delegatePaths(dirname(run.recordPath), "d_reload").response;
  await until(() => existsSync(answer), "a post-reload first update is answered, not dropped", 15000);
  assert.match(response(run, "d_reload").reason, /lead \/reload closed this run's delegation broker/);
  await done;
  assert.equal(run.status, "completed", run.errorMessage);
  assert.equal(registry.list().filter(r => r.parentRunId === run.id).length, 0, "no leaf after reload");
  assert.deepEqual(landed(run).filter(e => e.toolCallId === "d_reload" && /^tool_execution_/.test(e.type)).map(e => e.type.slice(15)), ["start", "update", "end"]);
  const final = getFinalText(run.messages);
  assert.match(final, /d_reload: ERROR delegate rejected: lead \/reload closed this run's delegation broker/);
  t.diagnostic(`Pi ${version} reload boundary: start before reload, update after -> ${final.split("\n").at(-1)}`);
}

/** Blocked only while a claimed delegate call has no response for the child to read. */
function blockedOnDelegate(run: Run): boolean {
  const dir = join(dirname(run.recordPath), "delegate");
  if (!existsSync(dir)) return false;
  const files = new Set(readdirSync(dir));
  return [...files].some(f => f.endsWith(".claim.json") && !files.has(f.replace(/\.claim\.json$/, ".json")));
}

/**
 * N3 barrier: four real delegators fill cap 4, each fans out two real leaves
 * that hold until released, and a lead-level run queued before any leaf must
 * not start on a lent slot. Every registry transition (and every poll) samples
 * live pids, slot holders and executing work measured from claim/response files.
 */
async function lentSlots(t: test.TestContext, bin: string, version: string) {
  process.env.PI_BIN = bin;
  const cwd = project(), fixture = tmpDir("n3-native-fixture-");
  process.env.N2_FIXTURE = fixture;
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 4, 1);
  registry.delegation = new DelegationBroker({ registry, queue, env: {} });
  t.after(() => { for (const r of registry.list()) if (alive(r.pid)) process.kill(r.pid!, "SIGKILL"); });
  // Slots free at agent_settled, before the process exits; live settled runs are counted apart as `exiting`.
  const peak = { physical: 0, holders: 0, exiting: 0, active: 0, executing: 0, lead: 0 };
  const sample = () => {
    const runs = registry.list(), active = runs.filter(consumesSlot), live = runs.filter(r => alive(r.pid));
    peak.physical = Math.max(peak.physical, live.length);
    peak.holders = Math.max(peak.holders, live.filter(consumesSlot).length);
    peak.exiting = Math.max(peak.exiting, live.filter(r => isTerminal(r.status)).length);
    peak.active = Math.max(peak.active, active.length);
    peak.executing = Math.max(peak.executing, active.filter(r => !blockedOnDelegate(r)).length);
    peak.lead = Math.max(peak.lead, active.filter(r => r.depth !== 2).length);
  };
  registry.onChange(sample);
  const wait = async (cond: () => boolean, what: string) => until(() => { sample(); return cond(); }, what, 90000);
  const personas = (await resolvePersonas({ cwd })).personas;
  const spawn = (task: string, persona: string) => {
    const r = queue.enqueueOrSpawn({ persona: personas.get(persona)!, task, cwd, mode: "background", timeoutMs: 120000, runtimeEnv: {} });
    return r.kind === "spawned" ? r.run.id : r.placeholderRun.id;
  };
  const parents = [1, 2, 3, 4].map(k => spawn(`N3-PARENT ${k}`, "lead"));
  const plain = spawn("N3-PLAIN", "plain");
  assert.equal(registry.get(plain)!.status, "queued", "the cap is full of delegators");
  const leaves = () => registry.list().filter(r => r.depth === 2);
  const holding = () => readdirSync(fixture).filter(f => f.startsWith("n3-running-")).length;
  await wait(() => leaves().length === 8 && holding() === 4, "eight leaves claimed and four holding");
  assert.deepEqual(leaves().map(l => l.status).sort(), ["queued", "queued", "queued", "queued", "running", "running", "running", "running"],
    "four awaiting parents lend four slots; N2 queues every leaf behind them until the parents time out");
  for (const l of leaves().filter(l => l.status === "queued")) assert.match(l.waitReason ?? "", /lent slot/);
  assert.equal(registry.get(plain)!.status, "queued", "the earlier lead-level run never takes a lent slot");
  assert.match(registry.get(plain)!.waitReason ?? "", /maxConcurrent \(4\)/);
  writeFileSync(join(fixture, "n3-release"), "go");
  await wait(() => [...parents, plain].every(id => isTerminal(registry.get(id)!.status)) && registry.list().every(r => isTerminal(r.status) && !alive(r.pid)), "every own run settled and exited");
  for (const id of [...parents, plain]) assert.equal(registry.get(id)!.status, "completed", registry.get(id)!.errorMessage);
  assert.equal(holding(), 8, "all eight leaves ran");
  for (const [i, id] of parents.entries()) {
    const final = getFinalText(registry.get(id)!.messages);
    for (const c of ["a", "b"]) assert.match(final, new RegExp(`n3_${i + 1}_${c}: ## ✓ \`scout\` completed[\\s\\S]*?N3 LEAF ${i + 1}-${c} done`));
  }
  t.diagnostic(`Pi ${version} N3 peaks: ${JSON.stringify(peak)}`);
  const { physical, exiting, ...bounded } = peak;
  assert.deepEqual(bounded, { holders: 8, active: 8, executing: 4, lead: 4 }, "live slot holders and A <= 2*max, executing <= max, lead-level <= max");
  assert.ok(physical <= 8 + exiting, `every live pi beyond 2*max had already settled: ${physical} live, ${exiting} exiting`);
}

/** A delegator whose host also loads another extension's `delegate` fails Pi startup; a non-delegator with it starts. */
function collision(t: test.TestContext, bin: string) {
  const run = (scope: ChildToolScope) => {
    const dir = tmpDir("n2-native-clash-");
    const argv = buildPiArgs({ kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "S", prompt: "N2-PARENT none", steerable: false, scope });
    const env = buildSubagentEnv({ ...process.env, N2_FOREIGN_DELEGATE: "1", N2_FIXTURE: dir }, { CONDUCTOR_RUN_ID: "lead-clash", CONDUCTOR_CONFIG_CWD: dir, ...childScopeEnv(dir, scope) });
    return spawnSync(process.execPath, [bin, ...argv], { cwd: dir, env, encoding: "utf8", timeout: 30000 });
  };
  const clash = run({ depth: 1, delegateAllow: ["scout"] });
  t.diagnostic(`delegator + foreign delegate: exit=${clash.status} stderr=${clash.stderr.trim().split("\n")[0]}`);
  assert.equal(clash.status, 1);
  assert.match(clash.stderr, /Tool "delegate" conflicts with/);
  const plain = run({ depth: 1, delegateAllow: [] });
  assert.equal(plain.status, 0, plain.stderr);
}

test("N2 native Pi 0.87.1: real delegate through spawnRun, pipeline, broker and queue", { timeout: 180000 }, async t => {
  const piRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT;
  assert.ok(piRoot, "CONDUCTOR_NATIVE_PI_ROOT must name installed Pi 0.87.1; a missing minimum is a failure, not a skip");
  const { path, version } = await child(t, piRoot);
  assert.equal(version, "0.87.1");
  await witness(t, path, version);
  await reloadBoundary(t, path, version);
  collision(t, path);
});

test("N3 native Pi 0.87.1: four delegators at cap 4 fan out on lent slots within the bounds", { timeout: 180000 }, async t => {
  const piRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT;
  assert.ok(piRoot, "CONDUCTOR_NATIVE_PI_ROOT must name installed Pi 0.87.1; a missing minimum is a failure, not a skip");
  const { path, version } = await child(t, piRoot);
  assert.equal(version, "0.87.1");
  await lentSlots(t, path, version);
});

for (const piRoot of (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean)) {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  test(`N2 native Pi ${version} (H11 matrix): real delegate and rejected nested ctx.executeTool delegate`, { timeout: 180000 }, async t => {
    const bundle = await child(t, piRoot);
    await witness(t, bundle.path, bundle.version);
    await reloadBoundary(t, bundle.path, bundle.version);
    collision(t, bundle.path);
  });
  test(`N3 native Pi ${version} (H11 matrix): four delegators at cap 4 fan out on lent slots`, { timeout: 180000 }, async t => {
    const bundle = await child(t, piRoot);
    await lentSlots(t, bundle.path, bundle.version);
  });
}
