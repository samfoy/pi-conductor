/**
 * N2 native smoke: the real Pi CLI (`main()` from Pi 0.87.1, plus any root in
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
import { delegatePaths } from "../src/delegation.ts";
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
  for (const [f, text] of Object.entries({ "lead.md": doc("lead", "agents:\n  - scout\n  - auditor\n"), "scout.md": doc("scout", "read_only: true\n"),
    "auditor.md": doc("auditor", "read_only: true\n"), "writer.md": doc("writer", "") })) writeFileSync(join(projectPersonasDir(cwd), f), text);
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
  assert.match(final, /d_scout: ## ✓ `scout` completed[\s\S]*?<result>\nLEAF scout done; evidence=false; saw=Tool delegate not found/);
  assert.match(final, /d_auditor: ## ✓ `auditor` completed[\s\S]*?<result>\nLEAF auditor done; evidence=true/);
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
  collision(t, path);
});

for (const piRoot of (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean)) {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  test(`N2 native Pi ${version} (H11 matrix): real delegate and rejected nested ctx.executeTool delegate`, { timeout: 180000 }, async t => {
    const bundle = await child(t, piRoot);
    await witness(t, bundle.path, bundle.version);
    collision(t, bundle.path);
  });
}
