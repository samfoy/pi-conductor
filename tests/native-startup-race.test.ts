/**
 * Pi 0.87.1 native faux startup race (diagnosed by critic-opus-h11-q81d): when a provider
 * registration's background availability refresh supersedes the awaited startup refresh, Pi's
 * settings-default model resolution finds faux unconfigured and the agent falls back to an
 * `unknown` placeholder ("No API key found for the selected model"). The native children
 * (native-merger-child.ts, native-delegate-child.ts) therefore name faux/faux-1 when the
 * conductor passed no --model, and only serve registered faux models. Each row here forces the
 * race in a private child (helpers/native-startup-race.ts) bundled against the explicit 0.87.1
 * root, and asserts the forcing really superseded the startup refresh.
 */
// First import: throws on an inherited herdr scope before any repository module evaluates.
import "./helpers/no-live-scope.ts";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stop } from "esbuild";
import { bundleNative } from "./helpers/native-merger-bundle.ts";
import { git } from "./helpers/effort-integration.ts";
import { tmpDir } from "./helpers/tmp.ts";

const root = tmpDir("native-startup-race-");
const agentDir = join(root, "agent");
mkdirSync(agentDir);
// The racy path: the children's settings default, as in every other native smoke.
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1", quietStartup: true, enableInstallTelemetry: false }));
after(() => stop());
const REPEAT = Number(process.env.NATIVE_STARTUP_REPEAT ?? 8), CONTROL = Number(process.env.NATIVE_STARTUP_CONTROL_REPEAT ?? 2);

const helpers = fileURLToPath(new URL("./helpers/", import.meta.url));
const forced = (child: string) => ({ contents: `import ${JSON.stringify(join(helpers, "native-startup-race.ts"))};\nimport ${JSON.stringify(join(helpers, child))};\n` });
let bundles: Promise<{ merger: string; delegate: string }> | undefined;
const bundled = (t: test.TestContext) => bundles ??= (async () => ({
  merger: await bundleNative(join(root, "forced-merger-0.87.1.mjs"), forced("native-merger-child.ts"), line => t.diagnostic(line)),
  delegate: await bundleNative(join(root, "forced-delegate-0.87.1.mjs"), forced("native-delegate-child.ts")),
}))();

interface Outcome { code: number | null; stderr: string; assistants: { provider?: string; model?: string; stopReason?: string; errorMessage?: string; text: string }[]; trace?: { r2Superseded?: boolean }; caller?: { callerModel: string | null } }
let seq = 0;
/** One forced child as the conductor would launch it, with a whitelisted env: no credentials, herdr or GIT_* routing. */
function launch(bin: string, opts: { depth: "1" | "2"; prompt: string; model?: string; thinking?: string; env?: Record<string, string> }): Promise<Outcome> {
  const dir = join(root, `run-${++seq}`), cwd = join(dir, "cwd"), fixture = join(dir, "fixture");
  mkdirSync(cwd, { recursive: true }); mkdirSync(fixture);
  git(cwd, "init", "-q", "-b", "main");
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME!, TMPDIR: process.env.TMPDIR ?? root, LANG: "C.UTF-8", TERM: "dumb",
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_CODING_AGENT_DIR: agentDir, CONDUCTOR_MEMORY_PATH: join(dir, "memory.jsonl"),
    CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: opts.depth, CONDUCTOR_RUN_ID: `startup-race-${seq}`, CONDUCTOR_RUN_DIR: dir,
    M6A_FIXTURE: fixture, M6A_MERGER_SCENARIO: "resolve", N2_FIXTURE: fixture, NATIVE_STARTUP_TRACE_DIR: fixture, ...opts.env };
  const args = ["--mode", "json", "-p", "--session-dir", join(dir, "session"), "--exclude-tools", "chief,peer,staff,subagent,agent",
    "--append-system-prompt", "Startup race regression.", ...(opts.model ? ["--model", opts.model] : []), ...(opts.thinking ? ["--thinking", opts.thinking] : []), opts.prompt];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", d => { stdout += d; }); child.stderr!.on("data", d => { stderr += d; });
    // Only this test's own child handle is ever signalled.
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("error", reject);
    child.on("close", code => {
      clearTimeout(timer);
      const events = stdout.split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const assistants = events.filter(e => e.type === "message_end" && e.message?.role === "assistant").map(({ message: m }) => ({
        provider: m.provider, model: m.model, stopReason: m.stopReason, errorMessage: m.errorMessage,
        text: (m.content ?? []).filter((p: { type: string }) => p.type === "text").map((p: { text: string }) => p.text).join("") }));
      const read = (name: string) => existsSync(join(fixture, name)) ? JSON.parse(readFileSync(join(fixture, name), "utf8")) : undefined;
      resolve({ code, stderr, assistants, trace: read(`race-${child.pid}.json`), caller: read(`caller-model-${child.pid}.json`) });
    });
  });
}
/** At most eight forced children at a time. */
async function many(n: number, start: () => Promise<Outcome>): Promise<Outcome[]> {
  const results: Outcome[] = [];
  for (let i = 0; i < n; i += 8) results.push(...await Promise.all(Array.from({ length: Math.min(8, n - i) }, start)));
  return results;
}
/** Diagnostic only, never a pass condition: how every forced child ended. */
const tally = (runs: Outcome[]) => JSON.stringify(runs.reduce<Record<string, number>>((acc, o) => {
  const kind = /No API key found for the selected model/.test(o.stderr) ? "unknown-placeholder preflight"
    : o.code === 0 && o.assistants.length ? `served ${[...new Set(o.assistants.map(a => `${a.provider}/${a.model}`))].join(",")}` : `exit ${o.code}`;
  const key = `${kind}${o.trace?.r2Superseded ? " (R2 superseded)" : ""}`;
  acc[key] = (acc[key] ?? 0) + 1; return acc;
}, {}));
const forcedRace = (o: Outcome) => assert.equal(o.trace?.r2Superseded, true, `the forcing superseded Pi's awaited startup availability refresh: ${JSON.stringify(o.trace)}`);
const served = (o: Outcome, model: string) => {
  assert.equal(o.code, 0, o.stderr.slice(-600));
  assert.ok(o.assistants.length > 0, "the child answered");
  for (const a of o.assistants) assert.deepEqual([`${a.provider}/${a.model}`, a.stopReason === "error" ? a.errorMessage : "ok"], [model, "ok"]);
};

test("native merger child under the forced startup race names faux/faux-1 when the conductor passed no --model", { timeout: 120000 }, async t => {
  const { merger } = await bundled(t);
  const runs = await many(REPEAT, () => launch(merger, { depth: "1", prompt: "Resolve the conflict." }));
  t.diagnostic(`forced merger default outcomes: ${tally(runs)}`);
  for (const o of runs) {
    forcedRace(o);
    assert.doesNotMatch(o.stderr, /No API key found for the selected model/);
    served(o, "faux/faux-1");
    assert.deepEqual(o.caller, { callerModel: null }, "the caller passed no --model; the fixture named faux/faux-1");
  }
  t.diagnostic(`forced merger default: ${runs.length}/${runs.length} served faux/faux-1 with R2 superseded`);
});

test("native merger child: a requested missing model fails the served-model guard; keyless faux auth fails naming faux", { timeout: 120000 }, async t => {
  const { merger } = await bundled(t);
  for (const o of await many(CONTROL, () => launch(merger, { depth: "1", prompt: "Resolve the conflict.", model: "faux/faux-missing" }))) {
    forcedRace(o);
    assert.ok(o.assistants.some(a => a.stopReason === "error" && /unregistered model served: faux\/faux-missing/.test(a.errorMessage ?? "")), JSON.stringify(o.assistants));
    assert.ok(!o.assistants.some(a => a.stopReason !== "error"), "a missing model never serves an answer");
    assert.deepEqual(o.caller, { callerModel: "faux/faux-missing" }, "an explicit caller model is kept, not replaced by the fixture default");
  }
  for (const o of await many(CONTROL, () => launch(merger, { depth: "1", prompt: "Resolve the conflict.", env: { NATIVE_FAUX_AUTH: "none" } }))) {
    forcedRace(o);
    assert.notEqual(o.code, 0);
    assert.match(o.stderr, /No API key found for faux/);
    assert.doesNotMatch(o.stderr, /selected model/, "the failure names the faux provider, not an unknown placeholder");
    assert.equal(o.assistants.length, 0);
  }
});

test("native delegate child under the forced startup race: an inheriting lead serves faux/faux-1; explicit leaf models and thinking are kept", { timeout: 120000 }, async t => {
  const { delegate } = await bundled(t);
  const leads = await many(REPEAT, () => launch(delegate, { depth: "1", prompt: "N3-PLAIN" }));
  t.diagnostic(`forced delegate lead outcomes: ${tally(leads)}`);
  for (const o of leads) {
    forcedRace(o);
    assert.doesNotMatch(o.stderr, /No API key found for the selected model/);
    served(o, "faux/faux-1"); assert.equal(o.assistants.at(-1)!.text, "N3 plain done");
    assert.deepEqual(o.caller, { callerModel: null }, "the conductor passed no --model for the lead");
  }
  for (const [persona, model, thinking] of [["scout", "faux/faux-scout", "low"], ["auditor", "faux/faux-auditor", "high"]] as const) {
    for (const o of await many(CONTROL, () => launch(delegate, { depth: "2", prompt: `N2-LEAF ${persona} startup race`, model, thinking }))) {
      forcedRace(o);
      served(o, model);
      assert.match(o.assistants.at(-1)!.text, new RegExp(`^LEAF ${persona} done; model=${model.slice(5)}; reasoning=${thinking};`));
      assert.deepEqual(o.caller, { callerModel: model }, "an explicit caller model is kept");
    }
  }
  for (const o of await many(CONTROL, () => launch(delegate, { depth: "2", prompt: "N2-LEAF scout startup race", model: "faux/faux-missing" }))) {
    forcedRace(o);
    assert.ok(o.assistants.some(a => a.stopReason === "error" && /unregistered model served: faux\/faux-missing/.test(a.errorMessage ?? "")), JSON.stringify(o.assistants));
    assert.ok(!o.assistants.some(a => a.stopReason !== "error"), "a missing model never serves an answer");
  }
  t.diagnostic(`forced delegate lead default: ${leads.length}/${leads.length} served faux/faux-1 with R2 superseded`);
});
