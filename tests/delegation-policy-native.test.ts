/**
 * N1 native witness: a real Pi session built from the conductor's generated
 * child argv (parsed by that Pi) and env. The minimum is Pi 0.87.1 from
 * CONDUCTOR_NATIVE_PI_ROOT and fails, never skips, when it is missing. Newer
 * roots listed in CONDUCTOR_H11_PI_ROOTS also prove `ctx.executeTool()` nested
 * calls cannot reach an excluded tool. An eligible delegator's argv comes from
 * real subprocess and herdr launches, and another extension's `delegate` stays
 * unreachable until N2 registers the conductor's own. Offline faux model only.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { buildPiArgs, buildResumePiArgs, buildSubagentEnv, RunRegistry, spawnRun } from "../src/runs.ts";
import { childToolScope } from "../src/personas.ts";
import { buildOrphanRun } from "../src/reconcile-startup.ts";
import { CONDUCTOR_LLM_TOOL_NAMES, childScopeEnv, emptyUsage, toRunRecord, type ChildToolScope, type Persona, type Run } from "../src/types.ts";
import type { NativeSurface } from "./helpers/delegation-policy-native.ts";
import { herdrLaunchArgv } from "./helpers/herdr-launch-argv.ts";

sandboxPi();
process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
const root = tmpDir("n1-native-");
process.env.TMPDIR = root; process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");
// The subprocess runtime starts this stub for real; it records the argv and env it got, then exits.
process.env.PI_BIN = join(root, "pi-capture.mjs");
writeFileSync(process.env.PI_BIN, 'import { writeFileSync } from "node:fs";\n' +
  'writeFileSync(process.env.CONDUCTOR_RUN_DIR + "/launch.json", JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\nprocess.exit(1);\n');
after(() => stop());

type Harness = { VERSION: string; nativeSurface: (root: string, label: string, opts: object) => Promise<NativeSurface> };

async function harness(t: test.TestContext, piRoot: string): Promise<Harness> {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version;
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? piRoot : join(piRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const path = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main);
    t.diagnostic(`${specifier}@${metadata.version}: ${path}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const output = join(root, `harness-${version}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL("./helpers/delegation-policy-native.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  const mod = await import(pathToFileURL(output).href) as Harness;
  assert.equal(mod.VERSION, version, "the harness runs the requested Pi, not the repository copy");
  return mod;
}

const LEAF: ChildToolScope = { depth: 2, delegateAllow: [] };
/** An eligible delegator with an explicit allowlist, the case N1 first exposed; `nested_probe` enables the nested calls. */
const DELEGATOR: Persona = { name: "lead", description: "probe", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1,
  systemPrompt: "You are lead.", source: "project", sourcePath: "/fake/lead.md", readOnly: false, tools: ["read", "nested_probe"], agents: ["inspector"] };
/** With Pi's default set only the exclusion, not a missing allowlist entry, keeps a foreign `delegate` out. */
const DELEGATORS: [string, Persona][] = [["allowlisted", DELEGATOR], ["default-tools", { ...DELEGATOR, tools: undefined }]];
const FORBIDDEN_AT_LEAF = ["ask_owner", "delegate", "subagent", "agent", "edit", "write", "insert_before", "insert_after", ...CONDUCTOR_LLM_TOOL_NAMES];
/** Tools other extensions could register; `ask_owner` is only a decoy where the conductor registers none. */
const DECOYS = ["delegate", "subagent", "agent", "ensemble_spawn", "insert_before", "insert_after"];
const notFound = /not found/;

/** The env a launcher actually hands the child, from a lead env carrying stale scope values. */
function childEnv(runDir: string, scope: ChildToolScope): NodeJS.ProcessEnv {
  return buildSubagentEnv({ PATH: process.env.PATH, HOME: process.env.HOME, CONDUCTOR_DEPTH: "1", CONDUCTOR_DELEGATE_ALLOW: "builder", CONDUCTOR_RUN_DIR: "/stale" },
    { CONDUCTOR_RUN_ID: "native-run", CONDUCTOR_CONFIG_CWD: runDir, ...childScopeEnv(runDir, scope) });
}
const fresh = (scope: ChildToolScope, tools?: string[]) =>
  buildPiArgs({ kind: "fresh", sessionDir: join(root, "unused"), systemPrompt: "S", prompt: "P", steerable: false, tools, scope });
/** The argv and env each runtime actually hands an eligible delegator: a real subprocess spawn, then its saved record relaunched on herdr. */
async function delegatorLaunches(persona: Persona): Promise<[string, { argv: string[]; env: NodeJS.ProcessEnv }][]> {
  const { run, done } = spawnRun({ registry: new RunRegistry(), persona, task: "probe", cwd: tmpDir("n1-native-spawn-"), mode: "background", timeoutMs: 20000, runtimeEnv: {} });
  await done;
  const subprocess = JSON.parse(readFileSync(join(dirname(run.recordPath), "launch.json"), "utf8"));
  const saved = { ...buildOrphanRun(JSON.parse(readFileSync(run.recordPath, "utf8")), "completed"), runtime: "herdr", status: "running" } as Run;
  const herdr = await herdrLaunchArgv(saved, { kind: "fresh", sessionDir: join(dirname(saved.recordPath), "session"), systemPrompt: "S", tools: saved.tools, excludeTools: saved.excludeTools }, process.env);
  return [["subprocess", subprocess], ["herdr", { argv: herdr.argv, env: herdr.paneEnv }]];
}
function absent(surface: NativeSurface, names: readonly string[], where: string) {
  for (const name of names) {
    assert.ok(!surface.active.includes(name), `${where}: ${name} must not be active`);
    assert.ok(!surface.registered.includes(name), `${where}: ${name} must not be registered`);
    if (surface.callable) assert.ok(!surface.callable.includes(name), `${where}: ${name} must not be callable`);
  }
}

async function witness(t: test.TestContext, pi: Harness, nested: boolean) {
  const dir = tmpDir("n1-native-run-");
  const leaf = await pi.nativeSurface(root, `${pi.VERSION}-leaf`, { argv: fresh(LEAF), env: childEnv(dir, LEAF), decoys: [...DECOYS, "ask_owner"],
    calls: [{ name: "ask_owner", args: { question: "Leaf?" } }, ...(nested ? [{ name: "nested_probe", args: {} }] : [])],
    nested: nested ? [...FORBIDDEN_AT_LEAF, "read"] : undefined });
  absent(leaf, FORBIDDEN_AT_LEAF, "depth 2");
  for (const name of ["read", "bash", "nested_probe"]) assert.ok(leaf.active.includes(name), `depth 2 keeps ${name}; the set is not vacuous`);
  const leafAsk = leaf.ends.find(e => e.name === "ask_owner");
  assert.ok(leafAsk?.isError && notFound.test(leafAsk.text), `model-issued ask_owner at depth 2 must not resolve: ${JSON.stringify(leafAsk)}`);
  if (nested) {
    assert.ok(leaf.callable, "a newer root must expose getCallableToolNames()");
    for (const name of FORBIDDEN_AT_LEAF) assert.ok(leaf.nested[name]?.isError && notFound.test(leaf.nested[name]!.text), `nested ${name}: ${JSON.stringify(leaf.nested[name])}`);
    assert.doesNotMatch(leaf.nested.read?.text ?? "not found", notFound, "nested positive control reaches an allowed tool");
  }

  const reallowed = await pi.nativeSurface(root, `${pi.VERSION}-leaf-allow`, { argv: fresh(LEAF, ["read", "ask_owner", "delegate", "edit", "write", "subagent"]),
    env: childEnv(dir, LEAF), decoys: [...DECOYS, "ask_owner"] });
  assert.deepEqual(reallowed.active, ["read"], "a leaf's own allowlist cannot re-grant excluded tools");
  absent(reallowed, FORBIDDEN_AT_LEAF, "depth 2 allowlist");

  // A legitimate saved depth-1 run resumed from its roundtripped record still asks its owner.
  const saved = buildOrphanRun(JSON.parse(JSON.stringify(toRunRecord({ id: "oracle-saved", persona: "oracle", task: "t", mode: "background", status: "completed",
    startTime: 1, lastEventAt: 1, messages: [], usage: emptyUsage(), cwd: dir, recordPath: join(dir, "record.json"), transcriptPath: join(dir, "t.jsonl"),
    finalPath: join(dir, "final.md"), sessionPath: join(dir, "s.jsonl"), depth: 1, delegateAllow: [] } as Run))), "completed");
  const resumeArgv = buildResumePiArgs(saved, "continue");
  const lead = await pi.nativeSurface(root, `${pi.VERSION}-depth1`, { argv: resumeArgv, env: childEnv(dir, childToolScope(saved)), decoys: DECOYS,
    calls: [{ name: "ask_owner", args: { question: "A or B?" } }] });
  assert.ok(lead.active.includes("ask_owner"));
  absent(lead, ["delegate", "subagent", "agent", "ensemble_spawn"], "depth 1");
  const ask = lead.ends.find(e => e.name === "ask_owner");
  assert.equal(ask?.isError, false, JSON.stringify(ask));
  assert.equal((ask?.details as { askId?: string } | undefined)?.askId, "n1-call-0", "positive control: the depth-1 owner question is accepted");
  if (nested) {
    const probe = await pi.nativeSurface(root, `${pi.VERSION}-depth1-nested`, { argv: resumeArgv, env: childEnv(dir, childToolScope(saved)), decoys: DECOYS,
      calls: [{ name: "nested_probe", args: {} }], nested: ["ask_owner", "delegate", "subagent", "agent", "ensemble_spawn"] });
    assert.ok(probe.callable?.includes("ask_owner"));
    assert.ok(probe.nested.ask_owner?.isError && !notFound.test(probe.nested.ask_owner.text), `nested ask_owner is reached, then refused by its own sole-call rule: ${JSON.stringify(probe.nested.ask_owner)}`);
    for (const name of ["delegate", "subagent", "agent", "ensemble_spawn"]) assert.match(probe.nested[name]?.text ?? "", notFound, `nested ${name}`);
  }

  // N1 registers no delegate, so an eligible delegator still excludes the name and another extension's cannot fill it.
  for (const [kind, persona] of DELEGATORS) for (const [path, launch] of await delegatorLaunches(persona)) {
    const where = `${path} ${kind} delegator`;
    assert.equal(launch.env.CONDUCTOR_DELEGATE_ALLOW, "inspector", `${where}: the child is an eligible delegator`);
    const delegator = await pi.nativeSurface(root, `${pi.VERSION}-delegator-${path}-${kind}`, { argv: launch.argv, env: launch.env, decoys: ["delegate", "subagent", "agent"],
      calls: [{ name: "delegate", args: {} }, ...(nested ? [{ name: "nested_probe", args: {} }] : [])], nested: nested ? ["delegate", "read"] : undefined });
    const call = delegator.ends.find(e => e.name === "delegate");
    t.diagnostic(`Pi ${pi.VERSION} ${where}: active=${delegator.active.join(",")} callable=${delegator.callable?.join(",") ?? "n/a"} ` +
      `delegate=${JSON.stringify(call?.text)} nested=${JSON.stringify(delegator.nested.delegate?.text ?? null)}`);
    if (persona.tools) assert.deepEqual([...delegator.active].sort(), ["ask_owner", "nested_probe", "read"], where);
    else for (const name of ["ask_owner", "nested_probe", "read", "bash"]) assert.ok(delegator.active.includes(name), `${where} keeps ${name}; the set is not vacuous`);
    absent(delegator, ["delegate", "subagent", "agent"], where);
    assert.ok(call?.isError && notFound.test(call.text), `${where}: model-issued delegate must not resolve: ${JSON.stringify(call)}`);
    if (nested) {
      assert.ok(delegator.nested.delegate?.isError && notFound.test(delegator.nested.delegate.text), `${where}: nested delegate: ${JSON.stringify(delegator.nested.delegate)}`);
      assert.doesNotMatch(delegator.nested.read?.text ?? "not found", notFound, `${where}: nested positive control reaches an allowed tool`);
    }
  }
  t.diagnostic(`Pi ${pi.VERSION}: depth2 active=${leaf.active.join(",")} callable=${leaf.callable?.join(",") ?? "n/a"}`);
}

test("N1 native Pi 0.87.1: generated argv/env expose no forbidden tool at depth 2; depth-1 ask still works", { timeout: 60000 }, async t => {
  const piRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT;
  assert.ok(piRoot, "CONDUCTOR_NATIVE_PI_ROOT must name installed Pi 0.87.1; a missing minimum is a failure, not a skip");
  assert.equal(JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version, "0.87.1");
  await witness(t, await harness(t, piRoot), false);
});

for (const piRoot of (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean)) {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  test(`N1 native Pi ${version} (H11 matrix): nested ctx.executeTool cannot reach excluded tools`, { timeout: 60000 }, async t => {
    await witness(t, await harness(t, piRoot), version !== "0.87.1");
  });
}
