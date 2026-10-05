/**
 * S3 native witness: real AgentSessionRuntimes from one explicit installed Pi
 * root load the real conductor factory with an offline faux model in a fake
 * herdr env. `/chief` claims this exact socket's lease and adds `staff`
 * additively (a foreign extension's tool change survives); `staff list` sees
 * the same socket's other lead only; a chief demoted mid-turn has its `staff`
 * call rejected in that same turn while Pi still lists the tool; OFF removes
 * it before the next turn; ON, reload and an occupied lease behave as the
 * lease says; a failed session append activates nothing. The fake herdr CLI
 * log stays empty. Pi 0.87.1 from CONDUCTOR_NATIVE_PI_ROOT is required (a
 * missing root fails, never skips); CONDUCTOR_H11_PI_ROOTS adds newer roots.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { Type } from "@sinclair/typebox";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import type { Lead } from "./helpers/supervision-native.ts";

const { home } = sandboxPi();
const root = tmpDir("s3-native-");
Object.assign(process.env, { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TMPDIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), CONDUCTOR_MEMORY_PATH: join(root, "memory.jsonl") });
const herdrState = join(root, "fake-herdr.json");
writeFileSync(herdrState, JSON.stringify({ calls: [] }));
const SOCKET = `${herdrState}.socket`, OTHER = `${herdrState}.socket2`; // OTHER extends SOCKET: a prefix match would leak
Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: SOCKET, HERDR_PANE_ID: "pane-native", FAKE_HERDR_STATE: herdrState,
  CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url)) });
delete process.env.CONDUCTOR_SUBAGENT;
after(() => stop());

type Harness = { VERSION: string; openLead: (root: string, label: string, opts?: { session?: "memory" | string; tools?: string[]; extra?: (pi: any) => void }) => Promise<Lead> };

async function harness(t: test.TestContext, piRoot: string): Promise<Harness> {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version;
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? piRoot : join(piRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const path = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main);
    t.diagnostic(`${specifier}@${metadata.version}: ${path}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const output = join(root, `chief-harness-${version}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL("./helpers/supervision-native.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  const mod = await import(pathToFileURL(output).href) as Harness;
  assert.equal(mod.VERSION, version, "the harness runs the requested Pi, not the repository copy");
  return mod;
}

const leaseDir = (socket: string) => join(home, ".pi", "agent", "conductor", "supervision", "chief", createHash("sha256").update(socket).digest("hex"));
const leaseFiles = (socket = SOCKET) => existsSync(leaseDir(socket)) ? readdirSync(leaseDir(socket)).sort() : [];
const claim = (g: number, socket = SOCKET) => JSON.parse(readFileSync(join(leaseDir(socket), `${String(g).padStart(6, "0")}.json`), "utf8"));
const released = (g: number, socket = SOCKET) => existsSync(join(leaseDir(socket), `${String(g).padStart(6, "0")}.json.released`));
const highest = (socket = SOCKET) => leaseFiles(socket).filter(f => /^\d{6}\.json$/.test(f)).length - 1;
const roleEntries = (file: string) => readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(e => e.type === "custom" && e.customType === "conductor-role").map(e => e.data);
const sorted = (names: string[]) => [...names].sort();
const userConfig = join(home, ".pi", "agent", "extensions", "conductor", "config.json");

async function witness(t: test.TestContext, pi: Harness) {
  const v = pi.VERSION;
  rmSync(join(home, ".pi", "agent", "conductor", "supervision"), { recursive: true, force: true });
  const open: Lead[] = [];
  const lead = async (label: string, opts?: Parameters<Harness["openLead"]>[2]) => { const l = await pi.openLead(root, `${v}-${label}`, opts); open.push(l); return l; };
  // A foreign extension in lead a: it changes the active set itself, and its sequential probe runs a command mid-turn.
  const probe: { pi?: any; during?: () => Promise<void> } = {};
  const extra = (api: any) => {
    probe.pi = api;
    api.registerTool({ name: "demote_probe", label: "demote probe", description: "test probe", parameters: Type.Object({}), executionMode: "sequential",
      execute: async () => { await probe.during?.(); return { content: [{ type: "text", text: "probe ran" }], details: {} }; } });
  };
  try {
    const a = await lead("a", { extra }), b = await lead("b");
    process.env.HERDR_SOCKET_PATH = OTHER;
    const c = await lead("c");
    process.env.HERDR_SOCKET_PATH = SOCKET;
    for (const l of [a, b, c]) { assert.deepEqual(l.errors, []); await l.command("/conductor on"); }
    for (const l of [a, b, c]) assert.ok(l.registered().includes("staff") && !l.active().includes("staff") && l.active().includes("peer"), "staff is inactive for every lead that is not the chief");
    assert.ok(!a.registered().includes("chief"), "the chief tool waits for S4");

    // Additive: a foreign change made before /chief survives; /chief adds exactly staff.
    probe.pi.setActiveTools(probe.pi.getActiveTools().filter((n: string) => n !== "bash"));
    const before = a.active();
    assert.ok(!before.includes("bash") && before.includes("demote_probe"));
    await a.command("/chief");
    assert.deepEqual(sorted(a.active()), sorted([...before, "staff"]), "staff added; every other tool, including the foreign change, untouched");
    assert.deepEqual(leaseFiles(), ["000000.json"]);
    assert.equal(claim(0).sessionId, a.sessionId());
    assert.equal(claim(0).socketPath, SOCKET);
    const listed = await a.callTools([{ name: "staff", args: { action: "list" } }]);
    assert.equal(listed[0]?.isError, false, JSON.stringify(listed));
    assert.equal(listed[0]!.details.self, a.sessionId());
    assert.deepEqual(listed[0]!.details.leads.map((l: { lead: string }) => l.lead), [b.sessionId()], "this exact socket's other lead; self and the prefix-extended socket excluded");
    assert.deepEqual(listed[0]!.details.leads[0].available_actions, ["peer message"]);
    t.diagnostic(`Pi ${v} staff list: ${listed[0]!.text}`);
    assert.deepEqual(roleEntries(a.sessionFile()!), [{ role: "chief", generation: 0 }], "the role intent is in the session file once Pi has flushed it");

    // Another lead on the socket cannot take a live lease; another socket has its own.
    await b.command("/chief");
    assert.ok(!b.active().includes("staff"));
    assert.deepEqual(leaseFiles(), ["000000.json"], "a live holder is never taken over");
    const notChief = await b.callTools([{ name: "staff", args: { action: "list" } }]);
    assert.ok(notChief[0]?.isError, "a lead that is not the chief cannot call staff");
    await c.command("/chief");
    assert.ok(c.active().includes("staff"));
    assert.equal(claim(0, OTHER).sessionId, c.sessionId(), "one lease per exact socket string");
    const otherList = await c.callTools([{ name: "staff", args: { action: "list" } }]);
    assert.deepEqual(otherList[0]!.details.leads, [], "the other socket's chief sees neither a nor b");
    await c.command("/chief leave");
    assert.ok(released(0, OTHER) && !c.active().includes("staff"));

    // Demoted mid-turn: the same turn's staff call rejects although Pi still lists the tool.
    probe.pi.setActiveTools(probe.pi.getActiveTools().filter((n: string) => n !== "read")); // a foreign change while chief
    probe.during = async () => { await a.command("/chief leave"); };
    const turn = await a.callTools([{ name: "demote_probe" }, { name: "staff", args: { action: "list" } }]);
    probe.during = undefined;
    assert.deepEqual(turn.map(e => e.name), ["demote_probe", "staff"]);
    assert.equal(turn[1]!.isError, true);
    assert.match(turn[1]!.text, /staff unavailable: this lead does not hold the chief lease/, "rejected by staff itself, not by Pi's tool lookup");
    assert.ok(!a.active().includes("staff"), "removed for the next turn");
    assert.ok(released(0));
    assert.ok(!a.active().includes("bash") && !a.active().includes("read"), "leave never restores a snapshot: foreign changes from before and during the chief role stay");
    assert.deepEqual(roleEntries(a.sessionFile()!).at(-1), { role: "lead" });

    // OFF removes staff (and peer) before the next model turn and keeps the intent; ON reclaims the next generation.
    await a.command("/chief");
    assert.equal(highest(), 1);
    await a.command("/conductor off");
    assert.ok(!a.active().includes("staff") && !a.active().includes("peer"));
    assert.ok(released(1));
    const off = await a.callTools([{ name: "staff", args: { action: "list" } }]);
    assert.ok(off[0]?.isError && !/"leads"/.test(off[0].text), `OFF: no listing in the next turn: ${JSON.stringify(off[0])}`);
    await a.command("/conductor on");
    assert.ok(a.active().includes("staff"), "ON reclaims from the kept intent");
    assert.equal(highest(), 2);
    assert.equal(claim(2).epoch, claim(1).epoch, "the same module instance keeps its epoch; the generation moves on");

    // Occupied: a's intent cannot take a lease b now holds.
    await a.command("/conductor off");
    await b.command("/chief");
    assert.equal(claim(3).sessionId, b.sessionId());
    await a.command("/conductor on");
    assert.ok(!a.active().includes("staff"), "an occupied lease leaves a an ordinary lead");
    assert.equal(highest(), 3, "no takeover");
    await b.command("/chief leave");
    await a.command("/chief leave");

    // Reload of an ON-by-default chief: the old instance releases, the new one reclaims under a fresh epoch.
    mkdirSync(dirname(userConfig), { recursive: true });
    writeFileSync(userConfig, JSON.stringify({ defaultMode: "on" }));
    try {
      const d = await lead("d");
      await d.command("/chief");
      const first = highest();
      await d.callTools([{ name: "staff", args: { action: "list" } }]); // flushes the session
      await d.reload();
      assert.ok(released(first));
      assert.equal(highest(), first + 1);
      assert.notEqual(claim(first + 1).epoch, claim(first).epoch, "a fresh epoch per module instance");
      assert.ok(d.active().includes("staff"));
      const after = await d.callTools([{ name: "staff", args: { action: "list" } }]);
      assert.equal(after[0]!.details.generation, first + 1);
      await d.quit();
      assert.ok(released(first + 1), "quit releases only its own claim");

      // A session append that fails activates nothing and leaves the lease free.
      const e = await lead("e");
      await e.prompt("flush the session");
      assert.ok(existsSync(e.sessionFile()!));
      chmodSync(e.sessionFile()!, 0o400);
      try {
        await e.command("/chief");
        assert.ok(!e.active().includes("staff"), "no false activation");
        const g = highest();
        assert.equal(claim(g).sessionId, e.sessionId());
        assert.ok(released(g), "the claim made before the failed append is released");
        const branch = e.session().sessionManager.getBranch().filter((x: any) => x.type === "custom" && x.customType === "conductor-role").map((x: any) => x.data);
        assert.deepEqual(branch.at(-1), { role: "lead" }, "the in-memory branch ends on a lead intent");
      } finally { chmodSync(e.sessionFile()!, 0o600); }
    } finally { rmSync(userConfig, { force: true }); }
  } finally {
    for (const l of open) { try { await l.quit(); } catch { /* already disposed */ } }
  }
  for (const socket of [SOCKET, OTHER]) assert.ok(released(highest(socket), socket), "every claim is released at the end");
  assert.deepEqual(JSON.parse(readFileSync(herdrState, "utf8")).calls, [], "S3 never invokes the herdr CLI");
}

test("S3 native Pi 0.87.1: chief lease, additive staff and same-turn demotion through the real factory", { timeout: 120000 }, async t => {
  const piRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT;
  assert.ok(piRoot, "CONDUCTOR_NATIVE_PI_ROOT must name installed Pi 0.87.1; a missing minimum is a failure, not a skip");
  assert.equal(JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version, "0.87.1");
  await witness(t, await harness(t, piRoot));
});

for (const piRoot of (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean)) {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  test(`S3 native Pi ${version} (H11 matrix): chief lease, additive staff and same-turn demotion`, { timeout: 120000 }, async t => {
    await witness(t, await harness(t, piRoot));
  });
}
