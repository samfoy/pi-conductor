/**
 * N1 native witness: a real Pi session built from the conductor's generated
 * child argv (parsed by that Pi) and env. The minimum is Pi 0.87.1 from
 * CONDUCTOR_NATIVE_PI_ROOT and fails, never skips, when it is missing. Newer
 * roots listed in CONDUCTOR_H11_PI_ROOTS also prove `ctx.executeTool()` nested
 * calls cannot reach an excluded tool. Offline faux model only.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { buildPiArgs, buildResumePiArgs, buildSubagentEnv } from "../src/runs.ts";
import { childToolScope } from "../src/personas.ts";
import { buildOrphanRun } from "../src/reconcile-startup.ts";
import { CONDUCTOR_LLM_TOOL_NAMES, childScopeEnv, emptyUsage, toRunRecord, type ChildToolScope, type Run } from "../src/types.ts";
import type { NativeSurface } from "./helpers/delegation-policy-native.ts";

sandboxPi();
process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
const root = tmpDir("n1-native-");
process.env.TMPDIR = root; process.env.PI_CODING_AGENT_DIR = join(root, "agent"); process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");
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
const DELEGATOR: ChildToolScope = { depth: 1, delegateAllow: ["inspector"] };
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

  // An eligible delegator keeps delegate out of --exclude-tools, but N1 registers no delegate tool.
  const delegator = await pi.nativeSurface(root, `${pi.VERSION}-delegator`, { argv: fresh(DELEGATOR, ["read"]), env: childEnv(dir, DELEGATOR), decoys: ["subagent", "agent"] });
  assert.equal(childEnv(dir, DELEGATOR).CONDUCTOR_DELEGATE_ALLOW, "inspector");
  assert.deepEqual([...delegator.active].sort(), ["ask_owner", "read"]);
  absent(delegator, ["delegate", "subagent", "agent"], "depth-1 delegator");
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
