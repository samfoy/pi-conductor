/**
 * S1 native witness: real AgentSessionRuntimes from one explicit installed Pi
 * root load the real conductor factory with an offline faux model, inside an
 * injected fake herdr env. `peer` is inactive while OFF, active after ON, and
 * lists a second lead by exact id; every Pi shutdown reason removes the record,
 * reload republishes under a fresh epoch, and an unsaved session, a duplicate
 * session and a native allowlist keep it inactive. The fake herdr CLI log stays
 * empty. The minimum is Pi 0.87.1 from CONDUCTOR_NATIVE_PI_ROOT and fails,
 * never skips, when it is missing; CONDUCTOR_H11_PI_ROOTS adds newer roots.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import type { Lead } from "./helpers/supervision-native.ts";

const { home } = sandboxPi();
const root = tmpDir("s1-native-");
Object.assign(process.env, { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TMPDIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), CONDUCTOR_MEMORY_PATH: join(root, "memory.jsonl") });
// A fake herdr lead env; the fake CLI records every invocation, and S1 must make none.
const herdrState = join(root, "fake-herdr.json");
writeFileSync(herdrState, JSON.stringify({ calls: [] }));
Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: `${herdrState}.socket`, HERDR_PANE_ID: "pane-native", HERDR_TAB_ID: "tab-native", HERDR_WORKSPACE_ID: "ws-native",
  FAKE_HERDR_STATE: herdrState, CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url)) });
delete process.env.CONDUCTOR_SUBAGENT;
after(() => stop());

type Harness = { VERSION: string; openLead: (root: string, label: string, opts?: { session?: "memory" | string; tools?: string[] }) => Promise<Lead> };

async function harness(t: test.TestContext, piRoot: string): Promise<Harness> {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version;
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? piRoot : join(piRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const path = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main);
    t.diagnostic(`${specifier}@${metadata.version}: ${path}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const output = join(root, `supervision-harness-${version}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL("./helpers/supervision-native.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  const mod = await import(pathToFileURL(output).href) as Harness;
  assert.equal(mod.VERSION, version, "the harness runs the requested Pi, not the repository copy");
  return mod;
}

const recordPath = (id: string) => join(home, ".pi", "agent", "conductor", "supervision", "leads", `${createHash("sha256").update(id).digest("hex")}.json`);
const record = (id: string) => existsSync(recordPath(id)) ? JSON.parse(readFileSync(recordPath(id), "utf8")) : undefined;
const userConfig = join(home, ".pi", "agent", "extensions", "conductor", "config.json");

async function witness(t: test.TestContext, pi: Harness) {
  const v = pi.VERSION;
  const open: Lead[] = [];
  const lead = async (label: string, opts?: Parameters<Harness["openLead"]>[2]) => { const l = await pi.openLead(root, `${v}-${label}`, opts); open.push(l); return l; };
  try {
    // OFF → ON → a second lead → OFF.
    const a = await lead("a");
    assert.deepEqual(a.errors, [], "the real factory loads without conflicts");
    assert.ok(a.registered().includes("peer"), "a herdr lead registers peer");
    assert.ok(!a.registered().includes("chief"), "the chief tool lands with its behaviour (S4), not as a stub");
    assert.ok(a.registered().includes("staff") && !a.active().includes("staff"), "S3 staff is registered but inactive for a lead that is not the chief");
    assert.ok(!a.active().includes("peer"), "OFF: peer inactive");
    assert.equal(record(a.sessionId()), undefined, "OFF: nothing published");
    await a.command("/conductor on");
    assert.ok(a.active().includes("peer"), "ON: peer active");
    for (const name of ["read", "bash", "ensemble_spawn"]) assert.ok(a.active().includes(name), `ON leaves ${name} active`);
    const published = record(a.sessionId());
    assert.equal(published.sessionFile, a.sessionFile());
    assert.equal(published.pid, process.pid);
    const b = await lead("b");
    await b.command("/conductor on");
    const listed = await a.callPeer();
    assert.equal(listed?.isError, false, JSON.stringify(listed));
    assert.equal(listed!.details.self, a.sessionId());
    assert.deepEqual(listed!.details.peers.map((p: { lead: string }) => p.lead), [b.sessionId()], "exact id of the second lead; self excluded");
    assert.equal(listed!.details.peers[0].cwd, join(root, `${v}-b`), "the peer's native session cwd");
    t.diagnostic(`Pi ${v} peer list: ${listed!.text}`);
    // Duplicate: the same session file opened by a second runtime stays inactive.
    const dup = await lead("dup", { session: a.sessionFile() });
    assert.equal(dup.sessionId(), a.sessionId());
    await dup.command("/conductor on");
    assert.ok(!dup.active().includes("peer"), "a duplicate live session stays inactive");
    assert.equal(record(a.sessionId()).generation, published.generation, "the duplicate never overwrote the owner");
    await dup.quit();
    assert.equal(record(a.sessionId()).generation, published.generation, "the duplicate's shutdown never removed the owner");
    await a.command("/conductor off");
    assert.ok(!a.active().includes("peer"), "OFF again: peer inactive");
    assert.equal(record(a.sessionId()), undefined, "OFF unpublishes");
    const refused = await a.callPeer();
    assert.ok(refused?.isError, `an inactive peer is not callable: ${JSON.stringify(refused)}`);
    await b.quit();
    assert.deepEqual(b.shutdowns, ["quit"]);
    assert.equal(record(b.sessionId()), undefined, "quit unpublishes");

    // An unsaved session and a native allowlist without peer stay inactive even ON.
    const memory = await lead("memory", { session: "memory" });
    await memory.command("/conductor on");
    assert.equal(memory.sessionFile(), undefined);
    assert.ok(!memory.active().includes("peer"), "--no-session: ineligible");
    assert.equal(record(memory.sessionId()), undefined);
    const narrow = await lead("narrow", { tools: ["read"] });
    await narrow.command("/conductor on");
    assert.deepEqual(narrow.active(), ["read"], "Pi's allowlist wins over activation");
    assert.ok(!narrow.registered().includes("peer"));

    // Every Pi shutdown reason, from an ON-by-default lead: reload, new, resume, fork, quit.
    mkdirSync(dirname(userConfig), { recursive: true });
    writeFileSync(userConfig, JSON.stringify({ defaultMode: "on" }));
    try {
      const c = await lead("c");
      const idC = c.sessionId(), fileC = c.sessionFile()!;
      const first = record(idC);
      assert.ok(first && c.active().includes("peer"), "ON by config publishes at session start");
      await c.callPeer(); // persists the session file so it can be resumed and forked
      await c.reload();
      const reloaded = record(idC);
      assert.notEqual(reloaded.generation, first.generation, "reload republishes under a fresh epoch");
      assert.ok(c.active().includes("peer"));
      await c.newSession();
      const idD = c.sessionId();
      assert.notEqual(idD, idC);
      assert.equal(record(idC), undefined, "new: the replaced session's record is gone");
      assert.ok(record(idD), "the new session publishes its own");
      await c.resume(fileC);
      assert.equal(c.sessionId(), idC);
      assert.equal(record(idD), undefined, "resume: the replaced session's record is gone");
      assert.notEqual(record(idC).generation, reloaded.generation, "the resumed session republishes under a fresh epoch");
      await c.fork();
      const idE = c.sessionId();
      assert.notEqual(idE, idC);
      assert.equal(record(idC), undefined, "fork: the replaced session's record is gone");
      assert.ok(record(idE));
      await c.quit();
      assert.equal(record(idE), undefined, "quit: gone");
      assert.deepEqual(c.shutdowns, ["reload", "new", "resume", "fork", "quit"], "each reason came from Pi itself");
    } finally { rmSync(userConfig, { force: true }); }

    // A toggled ON does not survive reload (conductor-mode persistence is unchanged).
    const f = await lead("f");
    await f.command("/conductor on");
    assert.ok(record(f.sessionId()));
    await f.reload();
    assert.equal(record(f.sessionId()), undefined);
    assert.ok(!f.active().includes("peer"));
  } finally {
    for (const l of open) { try { await l.quit(); } catch { /* already disposed */ } }
  }
  assert.deepEqual(JSON.parse(readFileSync(herdrState, "utf8")).calls, [], "S1 never invokes the herdr CLI");
}

test("S1 native Pi 0.87.1: presence, peer activation and every shutdown reason through the real factory", { timeout: 120000 }, async t => {
  const piRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT;
  assert.ok(piRoot, "CONDUCTOR_NATIVE_PI_ROOT must name installed Pi 0.87.1; a missing minimum is a failure, not a skip");
  assert.equal(JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version, "0.87.1");
  await witness(t, await harness(t, piRoot));
});

for (const piRoot of (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean)) {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  test(`S1 native Pi ${version} (H11 matrix): presence, peer activation and every shutdown reason`, { timeout: 120000 }, async t => {
    await witness(t, await harness(t, piRoot));
  });
}
