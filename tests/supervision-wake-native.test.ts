/**
 * S4 woken dispatches deferred inside one `agent_settled`, native. Chief A
 * makes real `staff` calls while lead B is inside its `agent_settled`, so Pi
 * defers every waking card and runs the deferred prompts in order afterwards.
 * Each case asks for exactly one persisted answer to B's ask, the later reply
 * rejected, the expected wakes and no false uncertainty notice:
 *  QM:     a chief message, then reply 1, then reply 2 (the message's own
 *          turn must not count as reply 1's).
 *  Q:      reply 1, then reply 2 (control).
 *  user:   a real user prompt deferred ahead of the replies (its turn must
 *          not count as reply 1's either).
 *  reload: a same-process /reload while reply 1 is still deferred (Pi keeps
 *          the session and its deferred prompts; the new instance must keep
 *          holding reply 1 and its reply lock).
 *  failed: reply 1's deferred run fails before it starts. It stays held (no
 *          notice, reply 2 waits) through unrelated turns and /reload, until
 *          a session start that replaces Pi's session; then it is uncertain
 *          and reply 2 is the one answer.
 *  abort:  reply 1 reaches B while B is busy, so Pi queues it as an agent
 *          follow-up; an SDK/RPC `session.abort()` without `clearQueue()`
 *          ends that run with the card still queued, and Pi's
 *          `hasPendingMessages()` does not count it. It stays held (reply 2
 *          waits) until Pi starts it with B's next run: one answer, reply 1.
 * The fake herdr CLI log stays empty. Pi 0.87.1 from CONDUCTOR_NATIVE_PI_ROOT
 * is required (missing fails, never skips); CONDUCTOR_H11_PI_ROOTS adds roots.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import type { Lead } from "./helpers/supervision-native.ts";

const { home } = sandboxPi();
const root = tmpDir("s4-wake-native-");
Object.assign(process.env, { PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", TMPDIR: root, PI_CODING_AGENT_DIR: join(root, "agent"), CONDUCTOR_MEMORY_PATH: join(root, "memory.jsonl") });
const herdrState = join(root, "fake-herdr.json");
writeFileSync(herdrState, JSON.stringify({ calls: [] }));
const SOCKET = `${herdrState}.socket`;
Object.assign(process.env, { HERDR_ENV: "1", HERDR_SOCKET_PATH: SOCKET, HERDR_PANE_ID: "pane-native", FAKE_HERDR_STATE: herdrState,
  CONDUCTOR_HERDR_BIN: fileURLToPath(new URL("./fixtures/fake-herdr.mjs", import.meta.url)) });
delete process.env.CONDUCTOR_SUBAGENT;
// ON by default, so reload and resume keep each session a lead.
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
  const output = join(root, `s4-wake-harness-${version}.mjs`);
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
const coordination = (l: Lead) => lines(l.sessionFile()).filter(e => e.type === "custom_message" && e.customType === "conductor-coordination");
const replies = (l: Lead, askId: string) => coordination(l).filter(e => e.details?.kind === "chief_reply" && e.details.notice === undefined && e.details.askId === askId);
const notices = (l: Lead) => coordination(l).filter(e => e.details?.notice === "uncertain");

type Case = "QM" | "Q" | "user" | "reload" | "failed" | "abort";

async function witness(t: test.TestContext, pi: Harness, kase: Case) {
  const v = pi.VERSION;
  rmSync(sup, { recursive: true, force: true });
  const open: Lead[] = [];
  const lead = async (label: string, opts?: Record<string, unknown>) => { const l = await pi.openLead(root, `${v}-${kase}-${label}`, opts); open.push(l); assert.deepEqual(l.errors, []); return l; };
  // `arm` runs before the conductor's agent_settled drain, `after` after it: both inside B's agent_settled.
  let arm: (() => Promise<void>) | undefined, afterDrain: (() => Promise<void>) | undefined;
  const before = (api: any) => { api.on("agent_settled", async () => { const f = arm; arm = undefined; await f?.(); }); };
  const extra = (api: any) => { api.on("agent_settled", async () => { const f = afterDrain; afterDrain = undefined; await f?.(); }); };
  try {
    const a = await lead("chief"), b = await lead("asker", { before, extra });
    for (const l of [a, b]) await l.prompt("hello");
    await a.command("/chief");
    const B = b.sessionId(), ASK = `wake-${kase}-${Date.now()}`;
    await b.prompt(`ask ${ASK}`, [pi.fauxAssistantMessage([pi.fauxToolCall("chief", { action: "ask", question: "Which base branch?" }, { id: ASK })], { stopReason: "toolUse" })]);
    await until("ask mirrored", () => record(B)?.pendingAsk?.askId === ASK);
    const staff = async (args: Record<string, unknown>) => {
      const [end] = await a.callTools([{ name: "staff", args: { lead: B, ...args } }]);
      assert.equal(end?.isError, false, `staff ${args.action}: ${end?.text}`);
      await sleep(3); // distinct createdAt: queue order is the call order
    };
    const reply = (message: string) => staff({ action: "reply", ask_id: ASK, message });
    const calls = b.calls();

    if (kase === "abort") {
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const held = async (_c: unknown, o?: { signal?: AbortSignal }) => {
        await Promise.race([gate, new Promise(r => o?.signal?.addEventListener("abort", r, { once: true }))]);
        return pi.fauxAssistantMessage("work done");
      };
      const spare = [1, 2, 3, 4].map(i => pi.fauxAssistantMessage(`spare ${i}`));
      const run = b.prompt("work", [held, ...spare]);
      await until("B streaming", () => b.session().isStreaming);
      await reply("answer one");
      await until("reply 1 claimed while B is busy", () => states(B).includes(".sending.json"));
      await b.session().abort(); // the SDK/RPC abort: no clearQueue()
      await run;
      release();
      await sleep(150);
      const afterAbort = { states: states(B), notices: notices(b).length, answers: replies(b, ASK).length };
      await reply("answer two");
      await sleep(150);
      await until("B idle after reply 2", () => b.session().isIdle);
      const afterReply2 = { states: states(B), notices: notices(b).length, answers: replies(b, ASK).length };
      await b.prompt("unrelated turn", [pi.fauxAssistantMessage("did something else"), pi.fauxAssistantMessage("read the answer"), pi.fauxAssistantMessage("an unexpected extra wake")]);
      await until("settled", () => b.session().isIdle && !states(B).some(s => s === ".json" || s === ".sending.json"));
      await sleep(100);
      const final = { states: states(B), notices: notices(b).length, answers: replies(b, ASK).map(e => /answer one/.test(e.content) ? "one" : /answer two/.test(e.content) ? "two" : "?"), calls: b.calls() - calls };
      t.diagnostic(`Pi ${v} abort: after abort ${JSON.stringify(afterAbort)}; after reply 2 ${JSON.stringify(afterReply2)}; final ${JSON.stringify(final)}`);
      assert.deepEqual(afterAbort, { states: [".sending.json"], notices: 0, answers: 0 }, "held: Pi still queues it");
      assert.deepEqual(afterReply2, { states: [".json", ".sending.json", ".slot"], notices: 0, answers: 0 }, "reply 2 waits behind the held reply 1");
      assert.deepEqual(final, { states: [".rejected.json"], notices: 0, answers: ["one"], calls: 3 }, "one answer: reply 1, started by B's next run; reply 2 rejected");
      await until("answered", () => record(B) && record(B).pendingAsk === undefined);
      return;
    }

    if (kase === "failed") {
      // Reply 1's deferred run throws before Pi starts it (an injected failure: Pi also drops every later deferred prompt).
      const session = b.session(), original = session._runAgentPrompt;
      session._runAgentPrompt = function (message: any) {
        if (message?.details?.kind === "chief_reply") { session._runAgentPrompt = original; return Promise.reject(new Error("injected wake failure")); }
        return original.call(this, message);
      };
      arm = () => reply("answer one");
      await assert.rejects(b.prompt("work", [pi.fauxAssistantMessage("work done")]), /injected wake failure/);
      assert.deepEqual(states(B), [".sending.json"], "held: Pi never started it");
      await reply("answer two"); // B is idle: reply 2 waits behind the held reply 1
      await sleep(150);
      assert.deepEqual(states(B), [".json", ".sending.json", ".slot"], "reply 2 queued, not dispatched");
      await b.prompt("unrelated turn", [pi.fauxAssistantMessage("did something else")]);
      await sleep(100);
      assert.deepEqual(states(B), [".json", ".sending.json", ".slot"], "an unrelated turn releases nothing");
      await b.reload();
      await sleep(100);
      assert.deepEqual(states(B), [".json", ".sending.json", ".slot"], "a same-process reload keeps holding it");
      assert.deepEqual([replies(b, ASK).length, notices(b).length], [0, 0], "nothing persisted, no notice yet");
      // A session start that replaces Pi's session drops its deferred prompts: now reply 1 is uncertain and reply 2 decides.
      const file = b.sessionFile()!;
      await b.newSession();
      b.respond([pi.fauxAssistantMessage("got the answer")]);
      await b.resume(file);
      await until("fallback: reply 1 uncertain, reply 2 persisted", () => replies(b, ASK).length === 1 && states(B).length === 1);
      assert.deepEqual(states(B), [".uncertain.json"]);
      assert.match(replies(b, ASK)[0].content, /answer two/, "the one answer is reply 2");
      assert.equal(notices(b).length, 1, "one notice, for reply 1");
      await until("answered", () => record(B) && record(B).pendingAsk === undefined);
      t.diagnostic(`Pi ${v} failed: held through a turn and /reload, released by resume; ${replies(b, ASK).length} answer, ${notices(b).length} notice`);
      return;
    }

    const responses = [pi.fauxAssistantMessage("work done")];
    arm = async () => {
      if (kase === "user") await b.session().prompt("a real user prompt, typed as the turn ended"); // deferred ahead of the replies
      if (kase === "QM") await staff({ action: "message", message: "heads up" });
      await reply("answer one");
      await reply("answer two");
    };
    if (kase === "reload") afterDrain = async () => { await b.session().reload(); };
    if (kase === "QM") responses.push(pi.fauxAssistantMessage("read the heads up"));
    if (kase === "user") responses.push(pi.fauxAssistantMessage("answered the user"));
    responses.push(pi.fauxAssistantMessage("read the answer"), pi.fauxAssistantMessage("an unexpected extra wake"));
    await b.prompt("work", responses);
    await until("settled", () => b.session().isIdle && !states(B).some(s => s === ".json" || s === ".sending.json"));
    await sleep(100);
    assert.deepEqual(replies(b, ASK).map(e => /answer one/.test(e.content)), [true], "exactly one persisted answer: reply 1");
    assert.deepEqual(states(B), [".rejected.json"], "reply 2 rejected; nothing uncertain");
    assert.equal(notices(b).length, 0, "no false uncertainty notice");
    const expected = kase === "QM" || kase === "user" ? 3 : 2;
    assert.equal(b.calls() - calls, expected, `wakes: work plus ${expected - 1}`);
    if (kase === "QM") assert.equal(coordination(b).filter(e => e.details?.kind === "chief_message").length, 1);
    if (kase === "user") {
      const order = lines(b.sessionFile()).flatMap(e => e.type === "message" && e.message.role === "user" && /real user prompt/.test(JSON.stringify(e.message.content)) ? ["user"] : e.details?.kind === "chief_reply" ? ["reply"] : []);
      assert.deepEqual(order, ["user", "reply"], "the user prompt ran first");
    }
    if (kase === "reload") assert.ok(b.shutdowns.includes("reload"), "reloaded while reply 1 was deferred");
    await until("answered", () => record(B) && record(B).pendingAsk === undefined);
    t.diagnostic(`Pi ${v} ${kase}: ${b.calls() - calls} B model calls, inbox ${JSON.stringify(states(B))}, ${replies(b, ASK).length} answer, ${notices(b).length} notices`);
  } finally {
    for (const l of open) { try { await l.quit(); } catch { /* already disposed */ } }
  }
  assert.deepEqual(JSON.parse(readFileSync(herdrState, "utf8")).calls, [], "S4 never invokes the herdr CLI");
}

const harnesses = new Map<string, Promise<Harness>>();
const harnessFor = (t: test.TestContext, piRoot: string) => { if (!harnesses.has(piRoot)) harnesses.set(piRoot, harness(t, piRoot)); return harnesses.get(piRoot)!; };
const CASES: [Case, string][] = [
  ["QM", "message, reply 1, reply 2 deferred in one agent_settled: one answer"],
  ["Q", "reply 1, reply 2 deferred in one agent_settled: one answer (control)"],
  ["user", "a user prompt deferred ahead of the replies releases nothing: one answer"],
  ["reload", "a same-process reload keeps a deferred reply held: one answer"],
  ["failed", "a wake that never starts is held, then released by a replacing session start"],
  ["abort", "a busy-queued reply survives an SDK abort held, and the next run starts it: one answer"],
];

for (const [kase, title] of CASES) {
  test(`S4 native Pi 0.87.1 wake ${kase}: ${title}`, { timeout: 120000 }, async t => {
    const piRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT;
    assert.ok(piRoot, "CONDUCTOR_NATIVE_PI_ROOT must name installed Pi 0.87.1; a missing minimum is a failure, not a skip");
    assert.equal(JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version, "0.87.1");
    await witness(t, await harnessFor(t, piRoot), kase);
  });
}

for (const piRoot of (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean)) {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  for (const [kase, title] of CASES) {
    test(`S4 native Pi ${version} (H11 matrix) wake ${kase}: ${title}`, { timeout: 120000 }, async t => {
      await witness(t, await harnessFor(t, piRoot), kase);
    });
  }
}
