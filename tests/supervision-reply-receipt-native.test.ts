/**
 * S4 reply receipts, native: whether a chief reply answered an ask is decided
 * by that reply card's line in the asking session's own file, never by the
 * reply's inbox record. Real AgentSessionRuntimes from one explicit installed
 * Pi root load the real conductor factory with an offline faux model in a fake
 * herdr env.
 *  A. The reply card's write fails (read-only session file): Pi keeps it in
 *     memory only and the record turns uncertain. Even after the 7-day sweep
 *     removes that record, the ask stays outstanding; a second reply is
 *     accepted and its persisted card answers.
 *  B. A chief message and a chief reply reach the lead inside one
 *     `agent_settled`, so Pi defers both wakes and the reply's record is
 *     classified uncertain before its own turn; Pi persists it anyway. The ask
 *     is answered and a second reply is refused and rejected: one answer.
 *  Fork: a fork's file has a new header id and copies the reply card addressed
 *     to the parent; that persisted copy answers the fork's ask. A reply held
 *     only in the parent's memory is not copied (Pi forks from the file), so
 *     the fork's ask stays outstanding until a reply persists there.
 * The fake herdr CLI log stays empty. Pi 0.87.1 from CONDUCTOR_NATIVE_PI_ROOT
 * is required (missing fails, never skips); CONDUCTOR_H11_PI_ROOTS adds roots.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import type { Lead } from "./helpers/supervision-native.ts";
import { admitCoordination, buildCoordination, INBOX_RETENTION_MS } from "../src/supervision/inbox.ts";
import { readChiefLease } from "../src/supervision/lease.ts";

const { home } = sandboxPi();
const root = tmpDir("s4-receipt-native-");
Object.assign(process.env, { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TMPDIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), CONDUCTOR_MEMORY_PATH: join(root, "memory.jsonl") });
const herdrState = join(root, "fake-herdr.json");
writeFileSync(herdrState, JSON.stringify({ calls: [] }));
const SOCKET = `${herdrState}.socket`;
Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: SOCKET, HERDR_PANE_ID: "pane-native", FAKE_HERDR_STATE: herdrState,
  CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url)) });
delete process.env.CONDUCTOR_SUBAGENT;
// ON by default, so reload and fork keep each session a lead.
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
  const output = join(root, `s4-receipt-harness-${version}.mjs`);
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
const isReply = (askId: string) => (e: any) => e.type === "custom_message" && e.customType === "conductor-coordination" && e.details?.kind === "chief_reply" && e.details.notice === undefined && e.details.askId === askId;
const fileReplies = (l: Lead, askId: string) => lines(l.sessionFile()).filter(isReply(askId));
const memReplies = (l: Lead, askId: string) => (l.session().sessionManager.getEntries() as any[]).filter(isReply(askId));
const lastUser = (l: Lead) => (l.session().sessionManager.getEntries() as any[]).filter(e => e.type === "message" && e.message.role === "user").at(-1).id as string;

type Probe = "A" | "B" | "fork";

/** Each probe opens its own chief and lead(s), so each direction reds (or not) on its own. */
async function witness(t: test.TestContext, pi: Harness, probe: Probe) {
  const v = pi.VERSION;
  rmSync(sup, { recursive: true, force: true });
  const open: Lead[] = [];
  const lead = async (label: string, opts?: Record<string, unknown>) => { const l = await pi.openLead(root, `${v}-${probe}-${label}`, opts); open.push(l); assert.deepEqual(l.errors, []); return l; };
  // Runs before the conductor's own agent_settled drain, so what it queues is dispatched inside that agent_settled.
  let arm: (() => void) | undefined;
  const before = (api: any) => { api.on("agent_settled", () => { const f = arm; arm = undefined; f?.(); }); };
  try {
    const a = await lead("chief"), b = await lead("asker", { before }), c = await lead("forker");
    for (const l of [a, b, c]) await l.prompt("hello");
    await a.command("/chief");
    const A = a.sessionId(), B = b.sessionId(), C = c.sessionId();
    const claim = () => readChiefLease(SOCKET).holder!;
    const ask = async (l: Lead, id: string, question: string) => {
      await l.prompt(`ask ${id}`, [pi.fauxAssistantMessage([pi.fauxToolCall("chief", { action: "ask", question }, { id })], { stopReason: "toolUse" })]);
      await until(`${id} mirrored`, () => record(l.sessionId())?.pendingAsk?.askId === id);
    };
    const reply = async (lead: string, askId: string, message: string) => (await a.callTools([{ name: "staff", args: { action: "reply", lead, ask_id: askId, message } }]))[0]!;
    const forced = (to: string, askId: string, text: string) => admitCoordination(buildCoordination({ kind: "chief_reply", from: A, to, socketPath: SOCKET, lease: claim(), askId, text, createdAt: Date.now() }), () => {});

    // ── A: memory-only reply, then the sweep ──
    if (probe === "A") {
    const ASK_A = `rcpt-a-${Date.now()}`;
    await ask(b, ASK_A, "Probe A: which branch?");
    chmodSync(b.sessionFile()!, 0o444);
    b.respond([pi.fauxAssistantMessage("woken by a reply Pi could not write")]);
    try {
      const first = await reply(B, ASK_A, "first, never written");
      assert.equal(first.isError, false, first.text);
      await until("the unwritten reply settles uncertain", () => states(B).includes(".uncertain.json"));
    } finally { chmodSync(b.sessionFile()!, 0o644); }
    assert.ok(b.errors.some(e => /EACCES|permission/i.test(e)), `Pi reported the failed write: ${b.errors.join(" | ")}`);
    b.errors.length = 0;
    assert.deepEqual([memReplies(b, ASK_A).length, fileReplies(b, ASK_A).length], [1, 0], "memory 1, file 0");
    await b.reload();
    await until("control: outstanding while the record is uncertain", () => record(B)?.pendingAsk?.askId === ASK_A);
    const uncertain = readdirSync(inbox(B)).find(n => n.endsWith(".uncertain.json"))!;
    const old = (Date.now() - INBOX_RETENTION_MS - 86_400_000) / 1000;
    utimesSync(join(inbox(B), uncertain), old, old);
    await b.reload(); // session_start sweeps the aged record
    await until("swept", () => states(B).length === 0);
    assert.deepEqual([memReplies(b, ASK_A).length, fileReplies(b, ASK_A).length], [1, 0], "still memory 1, file 0");
    await sleep(100);
    assert.equal(record(B)?.pendingAsk?.askId, ASK_A, "no inbox record is no receipt: the ask stays outstanding");
    b.respond([pi.fauxAssistantMessage("got the second reply")]);
    const second = await reply(B, ASK_A, "second, persisted");
    assert.equal(second.isError, false, `the second reply is accepted: ${second.text}`);
    await until("second reply persisted and retired", () => fileReplies(b, ASK_A).length === 1 && states(B).length === 0);
    await until("answered", () => record(B) && record(B).pendingAsk === undefined);
    assert.match(fileReplies(b, ASK_A)[0].content, /second, persisted/, "exactly one persisted answer: the second");
    t.diagnostic(`Pi ${v} probe A: memory ${memReplies(b, ASK_A).length} replies, file ${fileReplies(b, ASK_A).length}`);
    return;
    }

    // ── B: two wakes deferred inside one agent_settled ──
    const ASK_B = `rcpt-b-${Date.now()}`;
    await ask(b, ASK_B, "Probe B: which reviewer?");
    arm = () => {
      const now = Date.now(), lease = claim();
      admitCoordination(buildCoordination({ kind: "chief_message", from: A, to: B, socketPath: SOCKET, lease, text: "heads up", createdAt: now }), () => {});
      admitCoordination(buildCoordination({ kind: "chief_reply", from: A, to: B, socketPath: SOCKET, lease, askId: ASK_B, text: "first answer", createdAt: now + 1 }), () => {});
    };
    await b.prompt("work", [pi.fauxAssistantMessage("work done"), pi.fauxAssistantMessage("read the heads up"), pi.fauxAssistantMessage("read the answer")]);
    assert.equal(arm, undefined, "the records were queued inside agent_settled");
    await until("both dispatches settled", () => !states(B).some(s => s === ".json" || s === ".sending.json"));
    assert.deepEqual(states(B), [".uncertain.json"], "precondition: the reply was classified uncertain before its own turn");
    assert.equal(fileReplies(b, ASK_B).length, 1, "precondition: Pi persisted it anyway");
    await until("answered by the persisted card", () => record(B) && record(B).pendingAsk === undefined);
    const again = await reply(B, ASK_B, "second answer");
    assert.equal(again.isError, true);
    assert.match(again.text, /shows no pending ask/, "staff refuses a second reply");
    forced(B, ASK_B, "second answer, forced");
    await until("the forced second reply is rejected at dispatch", () => states(B).includes(".rejected.json"));
    assert.equal(fileReplies(b, ASK_B).length, 1, "only one persisted answer");
    t.diagnostic(`Pi ${v} probe B: inbox ${JSON.stringify(states(B))}, persisted replies ${fileReplies(b, ASK_B).length}`);
    if (probe === "B") return;

    // ── Fork: the persisted copy answers; the fork's file has a new header id and the card keeps the parent as `to` ──
    await b.prompt("after the answers");
    await b.fork(lastUser(b));
    const F = b.sessionId();
    assert.notEqual(F, B);
    const forkLines = lines(b.sessionFile());
    assert.equal(forkLines[0].id, F, "the fork's header names the fork");
    assert.deepEqual(fileReplies(b, ASK_B).map(e => e.details.to), [B], "the copied card is still addressed to the parent");
    await until("the fork publishes, its ask answered by the copied persisted card", () => record(F) !== undefined && record(F).pendingAsk === undefined);
    forced(F, ASK_B, "to the fork");
    await until("a reply to the fork's answered ask is rejected", () => states(F).includes(".rejected.json"));
    assert.equal(fileReplies(b, ASK_B).length, 1);

    // ── Fork of a memory-only reply: Pi forks from the file, whose chain stops before the unwritten card (forking past it
    //    fails in Pi itself, "Entry … not found"), so nothing answers the fork's ask until a reply persists there ──
    const ASK_C = `rcpt-c-${Date.now()}`;
    await ask(c, ASK_C, "Fork probe: which tag?");
    chmodSync(c.sessionFile()!, 0o444);
    c.respond([pi.fauxAssistantMessage("woken by a reply Pi could not write")]);
    try {
      assert.equal((await reply(C, ASK_C, "lost in the parent")).isError, false);
      await until("parent reply uncertain", () => states(C).includes(".uncertain.json"));
    } finally { chmodSync(c.sessionFile()!, 0o644); }
    c.errors.length = 0;
    assert.deepEqual([memReplies(c, ASK_C).length, fileReplies(c, ASK_C).length], [1, 0]);
    const askResult = (c.session().sessionManager.getEntries() as any[]).find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolCallId === ASK_C).id as string;
    assert.ok(lines(c.sessionFile()).some(e => e.id === askResult), "the ask result itself is in the file");
    await c.fork(askResult, "at");
    const F2 = c.sessionId();
    assert.notEqual(F2, C);
    assert.equal(memReplies(c, ASK_C).length, 0, "the unwritten card is not in the fork");
    await until("the fork's ask is outstanding", () => record(F2)?.pendingAsk?.askId === ASK_C);
    c.respond([pi.fauxAssistantMessage("got it in the fork")]);
    const inFork = await reply(F2, ASK_C, "answer in the fork");
    assert.equal(inFork.isError, false, inFork.text);
    await until("persisted in the fork and answered", () => fileReplies(c, ASK_C).length === 1 && record(F2)?.pendingAsk === undefined);
    assert.deepEqual(fileReplies(c, ASK_C).map(e => e.details.to), [F2]);
    t.diagnostic(`Pi ${v} fork: copied card to ${B} answers fork ${F}; memory-only parent reply not in fork ${F2}, answered by its own persisted reply`);
  } finally {
    for (const l of open) { try { await l.quit(); } catch { /* already disposed */ } }
  }
  assert.deepEqual(JSON.parse(readFileSync(herdrState, "utf8")).calls, [], "S4 never invokes the herdr CLI");
}

const harnesses = new Map<string, Promise<Harness>>();
const harnessFor = (t: test.TestContext, piRoot: string) => { if (!harnesses.has(piRoot)) harnesses.set(piRoot, harness(t, piRoot)); return harnesses.get(piRoot)!; };
const PROBES: [Probe, string][] = [["A", "an unwritten reply never answers, even after its uncertain record is swept"],
  ["B", "a persisted reply answers although its dispatch was classified uncertain"], ["fork", "a fork's copied persisted card answers; an unwritten parent reply does not"]];

for (const [probe, title] of PROBES) {
  test(`S4 native Pi 0.87.1 receipt ${probe}: ${title}`, { timeout: 120000 }, async t => {
    const piRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT;
    assert.ok(piRoot, "CONDUCTOR_NATIVE_PI_ROOT must name installed Pi 0.87.1; a missing minimum is a failure, not a skip");
    assert.equal(JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version, "0.87.1");
    await witness(t, await harnessFor(t, piRoot), probe);
  });
}

for (const piRoot of (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean)) {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  for (const [probe, title] of PROBES) {
    test(`S4 native Pi ${version} (H11 matrix) receipt ${probe}: ${title}`, { timeout: 120000 }, async t => {
      await witness(t, await harnessFor(t, piRoot), probe);
    });
  }
}
