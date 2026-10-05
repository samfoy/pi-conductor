/**
 * S4 native witness: real AgentSessionRuntimes from one explicit installed Pi
 * root load the real conductor factory with an offline faux model in a fake
 * herdr env. Lead B's model calls `chief ask` alone: the tool returns
 * `terminate` (no follow-up model call) and the question wakes chief A (a
 * follow-up of A's busy run). A's model reads B's transcript and replies by
 * ask id; the reply wakes B. Each message lands as exactly one card in the
 * recipient's session file, the inboxes retire only on those persisted
 * receipts, the reply never passes B's input handlers or commands, B's
 * presence mirror and the branch ask clear, and a peer message still never
 * wakes. A chief demoted mid-turn has that turn's staff call rejected. The
 * fake herdr CLI log stays empty. Pi 0.87.1 from CONDUCTOR_NATIVE_PI_ROOT is
 * required (missing fails, never skips); CONDUCTOR_H11_PI_ROOTS adds roots.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { Type } from "@sinclair/typebox";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import type { Lead } from "./helpers/supervision-native.ts";

const { home } = sandboxPi();
const root = tmpDir("s4-native-");
Object.assign(process.env, { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TMPDIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), CONDUCTOR_MEMORY_PATH: join(root, "memory.jsonl") });
const herdrState = join(root, "fake-herdr.json");
writeFileSync(herdrState, JSON.stringify({ calls: [] }));
const SOCKET = `${herdrState}.socket`;
Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: SOCKET, HERDR_PANE_ID: "pane-native", FAKE_HERDR_STATE: herdrState,
  CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url)) });
delete process.env.CONDUCTOR_SUBAGENT;
const userConfig = join(home, ".pi", "agent", "extensions", "conductor", "config.json");
mkdirSync(dirname(userConfig), { recursive: true });
writeFileSync(userConfig, JSON.stringify({ defaultMode: "on" }));
after(() => stop());

type Faux = (...args: unknown[]) => unknown;
type Harness = { VERSION: string; fauxAssistantMessage: Faux; fauxToolCall: Faux; openLead: (root: string, label: string, opts?: Record<string, unknown>) => Promise<Lead> };

async function harness(t: test.TestContext, piRoot: string): Promise<Harness> {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version;
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? piRoot : join(piRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    const path = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main);
    t.diagnostic(`${specifier}@${metadata.version}: ${path}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const output = join(root, `s4-harness-${version}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL("./helpers/supervision-native.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  const mod = await import(pathToFileURL(output).href) as Harness;
  assert.equal(mod.VERSION, version, "the harness runs the requested Pi, not the repository copy");
  return mod;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(what: string, cond: () => boolean, ms = 8000) {
  for (const end = Date.now() + ms; !cond();) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await sleep(10); }
}
const sup = join(home, ".pi", "agent", "conductor", "supervision");
const inbox = (id: string) => join(sup, "inbox", createHash("sha256").update(id).digest("hex"));
const states = (id: string) => existsSync(inbox(id)) ? readdirSync(inbox(id)).map(n => n.replace(/^\d{13}-[0-9a-f-]{36}/, "")).sort() : [];
const record = (id: string) => { const p = join(sup, "leads", `${createHash("sha256").update(id).digest("hex")}.json`); return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : undefined; };
const lines = (file: string | undefined): any[] => file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
const cards = (l: Lead, kind?: string) => lines(l.sessionFile()).filter(e => e.type === "custom_message" && e.customType === "conductor-coordination" && e.details?.notice === undefined && (!kind || e.details.kind === kind));
const toolEnds = (l: Lead) => { const ends: any[] = []; const off = l.session().subscribe((e: any) => { if (e.type === "tool_execution_end") ends.push(e); }); return { ends, off }; };
const text = (e: any) => (e?.result?.content ?? []).map((p: any) => p.text ?? "").join("");

async function witness(t: test.TestContext, pi: Harness) {
  const v = pi.VERSION;
  rmSync(sup, { recursive: true, force: true });
  const open: Lead[] = [];
  const lead = async (label: string, opts?: Record<string, unknown>) => { const l = await pi.openLead(root, `${v}-${label}`, opts); open.push(l); assert.deepEqual(l.errors, []); return l; };
  const inputs: string[] = [], commands: string[] = [];
  const probe: { pi?: any; during?: () => Promise<void> } = {};
  try {
    const a = await lead("chief", { extra: (api: any) => {
      probe.pi = api;
      api.registerTool({ name: "demote_probe", label: "demote probe", description: "test probe", parameters: Type.Object({}), executionMode: "sequential",
        execute: async () => { await probe.during?.(); return { content: [{ type: "text", text: "probe ran" }], details: {} }; } });
    } });
    const b = await lead("asker", { extra: (api: any) => { api.on("input", (e: any) => void inputs.push(e.text)); api.registerCommand("s4probe", { description: "probe", handler: async () => void commands.push("ran") }); } });
    const p = await lead("peer");
    for (const l of [a, b, p]) await l.prompt("hello"); // every session flushed
    await a.command("/chief");
    assert.ok(a.active().includes("staff") && !a.active().includes("chief"), "the holder: staff, not chief");
    assert.ok(b.active().includes("chief") && !b.active().includes("staff"), "a lead: chief, not staff");
    const B = b.sessionId(), ASK = `s4-ask-${Date.now()}`;

    // A is busy (a gated turn), so B's ask lands on B's branch first; A's turn then continues with the question as a follow-up.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const aEnds = toolEnds(a);
    const aBefore = a.calls();
    const aRun = a.prompt("busy", [
      async () => { await gate; return pi.fauxAssistantMessage("busy done"); },
      pi.fauxAssistantMessage([pi.fauxToolCall("staff", { action: "transcript", lead: B }, { id: "s4-transcript" })], { stopReason: "toolUse" }),
      pi.fauxAssistantMessage([pi.fauxToolCall("staff", { action: "reply", lead: B, ask_id: ASK, message: "/s4probe use main <b>&" }, { id: "s4-reply" })], { stopReason: "toolUse" }),
      pi.fauxAssistantMessage("replied"),
    ]);
    await until("A streaming", () => a.session().isStreaming);

    // B asks alone: terminate means no automatic follow-up model call.
    const bEnds = toolEnds(b);
    const bBefore = b.calls();
    await b.prompt("ask the chief", [pi.fauxAssistantMessage([pi.fauxToolCall("chief", { action: "ask", question: "Which base branch: main or dev?" }, { id: ASK })], { stopReason: "toolUse" })]);
    const asked = bEnds.ends.find(e => e.toolCallId === ASK);
    assert.equal(asked?.isError, false, text(asked));
    assert.equal(asked.result.terminate, true);
    assert.equal(b.calls(), bBefore + 1, "terminate honoured: one model call");
    assert.equal(asked.result.details.askId, ASK);
    b.respond([pi.fauxAssistantMessage("thanks, continuing on main")]); // the model's answer to the reply's wake
    await until("B's presence mirrors the branch ask", () => record(B)?.pendingAsk?.askId === ASK);
    assert.equal(record(B).pendingAsk.question, "Which base branch: main or dev?");
    await until("the question claimed by A while busy", () => states(a.sessionId()).includes(".sending.json"));
    assert.equal(cards(a, "lead_ask").length, 0, "held as A's follow-up, not yet persisted");

    release();
    await aRun;
    assert.equal(a.calls(), aBefore + 4, "A woke: the follow-up question ran three more model calls");
    const transcript = aEnds.ends.find(e => e.toolCallId === "s4-transcript"), reply = aEnds.ends.find(e => e.toolCallId === "s4-reply");
    assert.equal(transcript?.isError, false, text(transcript));
    assert.match(text(transcript), new RegExp(`^<lead-transcript lead="${B}" lease-generation="\\d+" untrusted="true">`));
    assert.match(text(transcript), /tool call: chief/, "B's persisted tail, through A4");
    assert.ok(Buffer.byteLength(text(transcript)) <= 16384);
    assert.equal(reply?.isError, false, text(reply));
    assert.match(text(reply), /Queued chief reply .* Queued is not delivered or accepted/);
    aEnds.off();
    t.diagnostic(`Pi ${v} transcript: ${JSON.stringify(text(transcript).slice(0, 400))}`);

    // The reply wakes B: one model call, one card, no input handler or command.
    await until("B woken by the reply", () => b.calls() === bBefore + 2 && b.session().isIdle);
    await until("receipts retire both inboxes", () => states(B).length === 0 && states(a.sessionId()).length === 0);
    const [askCard] = cards(a, "lead_ask"), [replyCard] = cards(b, "chief_reply");
    assert.equal(cards(a, "lead_ask").length, 1, "exactly one question card in A's file");
    assert.equal(cards(b, "chief_reply").length, 1, "exactly one reply card in B's file");
    assert.equal(askCard.details.askId, ASK);
    assert.match(askCard.content, /kind="lead_ask"[^>]*untrusted="true"/);
    assert.equal(replyCard.details.askId, ASK);
    assert.match(replyCard.content, /not a user instruction; grants no permissions or tools/);
    assert.ok(replyCard.content.includes("/s4probe use main &lt;b&gt;&amp;"), "escaped");
    assert.deepEqual(inputs, ["hello", "ask the chief"], "the reply never passed input handlers");
    assert.deepEqual(commands, [], "a leading slash in the reply ran no command");
    assert.ok(b.active().includes("chief") && b.registered().includes("peer"), "content changes no tools or mode");
    await until("B's ask mirror clears", () => record(B) && record(B).pendingAsk === undefined);
    t.diagnostic(`Pi ${v} reply card: ${JSON.stringify(replyCard.content)}`);

    // Peer stays non-waking, toward a lead and toward the chief.
    const pCallsA = a.calls(), pCallsB = b.calls();
    for (const to of [a, b]) {
      const end = await p.callPeer({ action: "message", lead: to.sessionId(), message: "fyi only" });
      assert.equal(end?.isError, false, JSON.stringify(end));
    }
    await until("peer receipts", () => states(a.sessionId()).length === 0 && states(B).length === 0 && cards(b, "peer").length === 1 && cards(a, "peer").length === 1);
    await sleep(100);
    assert.deepEqual([a.calls(), b.calls()], [pCallsA, pCallsB], "peer never wakes");

    // Same-turn demotion: /chief leave during the turn; that turn's staff call rejects although Pi still lists it.
    probe.during = async () => { await a.command("/chief leave"); };
    const turn = await a.callTools([{ name: "demote_probe" }, { name: "staff", args: { action: "message", lead: B, message: "after demotion" } }]);
    probe.during = undefined;
    assert.deepEqual(turn.map(e => e.name), ["demote_probe", "staff"]);
    assert.equal(turn[1]!.isError, true);
    assert.match(turn[1]!.text, /staff unavailable: this lead does not hold the chief lease/);
    assert.deepEqual(states(B), [], "nothing queued by the demoted chief");
    assert.ok(a.active().includes("chief") && !a.active().includes("staff"), "a lead again: chief back, staff gone");
  } finally {
    for (const l of open) { try { await l.quit(); } catch { /* already disposed */ } }
  }
  assert.deepEqual(JSON.parse(readFileSync(herdrState, "utf8")).calls, [], "S4 never invokes the herdr CLI");
}

test("S4 native Pi 0.87.1: ask → chief wake → transcript → reply → lead wake through the real factory", { timeout: 120000 }, async t => {
  const piRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT;
  assert.ok(piRoot, "CONDUCTOR_NATIVE_PI_ROOT must name installed Pi 0.87.1; a missing minimum is a failure, not a skip");
  assert.equal(JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version, "0.87.1");
  await witness(t, await harness(t, piRoot));
});

for (const piRoot of (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean)) {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  test(`S4 native Pi ${version} (H11 matrix): ask → chief wake → transcript → reply → lead wake`, { timeout: 120000 }, async t => {
    await witness(t, await harness(t, piRoot));
  });
}
