import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import conductor from "../src/index.ts";
import type { NotificationMessage } from "../src/notifications.ts";
import type { notificationRenderer } from "../src/notification-renderer.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { stubCtx } from "./helpers/stub-pi.ts";

sandboxPi();
const T0 = 1_700_000_000_000;
async function harness(t: TestContext) {
  const cwd = tmpDir("a4-wiring-");
  let now = T0;
  t.mock.method(Date, "now", () => now);
  const ticks = new Map<number, () => void>();
  t.mock.method(globalThis, "setInterval", (fn: () => void, ms: number) => {
    ticks.set(ms, fn); return { unref() {} } as NodeJS.Timeout;
  });
  t.mock.method(globalThis, "clearInterval", () => {});
  // Don't run startup GC/reconcile against fixtures; no live host operations.
  t.mock.method(globalThis, "setImmediate", () => ({}) as NodeJS.Immediate);
  function child() {
    const proc = Object.assign(new EventEmitter(), { pid: 999999, exitCode: null as number | null,
      signalCode: null as string | null, stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
      kill(signal: string) { this.signalCode = signal; return true; }, unref() {} });
    return proc;
  }
  const children: ReturnType<typeof child>[] = [];
  t.mock.method(cp, "spawn", () => { const proc = child(); children.push(proc); return proc; });
  syncBuiltinESMExports();
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, any>(); // Pi's heterogeneous tool API boundary.
  const messages: NotificationMessage[] = [];
  const options: unknown[] = [];
  let renderer: typeof notificationRenderer;
  conductor({
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand() {}, registerShortcut() {}, appendEntry() {},
    registerMessageRenderer: (_type: string, r: typeof notificationRenderer) => { renderer = r; },
    sendMessage: (m: NotificationMessage, opts: unknown) => { messages.push(m); options.push(opts); },
  } as any);
  const ctx = { ...stubCtx(cwd), mode: "tui", hasUI: true };
  const fire = async (ev: string, event: unknown = {}) => { for (const h of handlers.get(ev) ?? []) await h(event, ctx); };
  await fire("session_start");
  const call = (name: string, args: unknown) => tools.get(`ensemble_${name}`).execute("call", args, undefined, undefined, ctx);
  t.after(async () => {
    for (const proc of children) proc.emit("close", null, "SIGTERM");
    await fire("session_shutdown", { reason: "reload" });
    t.mock.restoreAll(); syncBuiltinESMExports();
  });
  return { children, messages, options, call, cwd,
    tick(seconds: number) { now = T0 + seconds * 1000; ticks.get(30_000)!(); },
    emit(proc: ReturnType<typeof child>, message: unknown) { proc.stdout.write(JSON.stringify({ type: "message_end", message }) + "\n"); },
    render(m: NotificationMessage, width: number, expanded = true) {
      const lines = renderer!(m, { expanded, outputPad: 1 }, ctx.ui.theme)!.render(width);
      assert.ok(lines.every(line => visibleWidth(line) <= width));
      return lines.join("\n");
    },
  };
}

test("A4 real watchdog wiring captures evidence once, retains actions, and emits only references on reminders", async t => {
  const h = await harness(t);
  const out = await h.call("spawn", { persona: "oracle", task: "test", foreground: false, kill_on_stall: false, stall_threshold_seconds: 300 });
  assert.ok(!out.isError);
  const id = out.details.agent_id;
  h.emit(h.children[0], { role: "assistant", content: [{ type: "text", text: "CHECK_BUILD_HEAD\n" + "漢🙂".repeat(20_000) + "\nCHECK_BUILD_TAIL" },
    { type: "toolCall", id: "tool", name: "bash", arguments: { command: "npm test" } }] });
  h.emit(h.children[0], { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "BUILD_RESULT_HEAD\n" + "é".repeat(20_000) + "\nBUILD_RESULT_TAIL" }] });
  h.tick(300);
  const first = h.messages.find(m => m.details.id === id && m.details.kind === "stalled")!;
  assert.ok(first); assert.match(first.content, /<threshold-seconds>300<\/threshold-seconds>/);
  assert.match(first.content, /CHECK_BUILD_HEAD/); assert.match(first.content, /BUILD_RESULT_TAIL/);
  assert.match(first.content, /<available-actions>pause,kill,focus<\/available-actions>/);
  for (const width of [40, 80]) {
    const expanded = h.render(first, width);
    assert.match(expanded, /BUILD_RESULT_HEAD/); assert.match(expanded, /BUILD_RESULT_TAIL/);
    assert.match(expanded, /available_actions=/);
    assert.doesNotMatch(h.render(first, width, false), /BUILD_RESULT_HEAD|BUILD_RESULT_TAIL/);
  }
  assert.deepEqual(h.options[0], { triggerTurn: false, deliverAs: "followUp" });
  const sessionDir = join(process.env.HOME!, ".pi/agent/conductor/runs", id, "session");
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(join(sessionDir, "child.jsonl"), JSON.stringify({ type: "session", id: "child" }) + "\n");
  const originalRead = fs.readFileSync;
  const reads: string[] = [];
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]).endsWith(".jsonl")) reads.push(String(args[0]));
    return (originalRead as Function)(...args);
  });
  syncBuiltinESMExports();
  h.tick(450);
  const reminder = h.messages.at(-1)!;
  assert.notEqual(reminder, first); assert.match(reminder.content, /<evidence-reference>/);
  assert.doesNotMatch(reminder.content, /<recent-activity>|CHECK_BUILD_HEAD|BUILD_RESULT_TAIL/);
  assert.match(reminder.content, /reminder alone does not justify another read/);
  assert.deepEqual(reminder.details.available_actions, first.details.available_actions);
  assert.deepEqual(reads, [], "reminders do not parse saved-session or transcript logs for actions/evidence");
  h.tick(1500); h.tick(1800);
  assert.equal(h.messages.filter(m => m.details.severity === "hard").length, 1);
  assert.match(h.messages.at(-1)!.content, /<evidence-reference>/);
  assert.equal(h.children[0].signalCode, null, "advisory hard state leaves work alone");
});


for (const queued of [false, true]) {
  test(`A4 first tick past hard carries evidence and exactly one killed completion (${queued ? "queued promotion" : "direct"})`, async t => {
    const h = await harness(t);
    const blockers: string[] = [];
    if (queued) {
      for (let i = 0; i < 4; i++) blockers.push((await h.call("spawn", {
        persona: "oracle", task: "occupy slot", foreground: false, kill_on_stall: false,
      })).details.agent_id);
    }
    const out = await h.call("spawn", { persona: "oracle", task: "test", foreground: false, kill_on_stall: true });
    const id = out.details.agent_id;
    if (queued) {
      assert.match(out.details.status, /queued/);
      const killed = await h.call("kill", { agent_id: blockers[0] });
      assert.equal(killed.details.status, "killed");
      assert.equal(h.messages.filter(m => m.details.id === blockers[0]).length, 0, "tool kill stays silent");
      assert.equal(h.children.length, 5, "queued child actually starts");
    }
    const child = h.children.at(-1)!;
    h.emit(child, { role: "assistant", content: [{ type: "text", text: "HARD_FIRST_EVIDENCE" }] });
    h.tick(660);
    const notices = h.messages.filter(m => m.details.id === id);
    assert.deepEqual(notices.map(m => [m.details.kind, m.details.severity, m.details.status]),
      [["stalled", "hard", "running"], ["completed", undefined, "killed"]]);
    assert.match(notices[0].content, /<recent-activity>/); assert.match(notices[0].content, /HARD_FIRST_EVIDENCE/);
    assert.match(notices[0].content, /<threshold-seconds>600<\/threshold-seconds>/);
    for (const width of [40, 80]) assert.match(h.render(notices[0], width), /HARD_FIRST_EVIDENCE/);
    assert.equal(child.signalCode, "SIGTERM");
    child.emit("exit", null, "SIGTERM"); child.emit("close", null, "SIGTERM");
    h.tick(690); await Promise.resolve();
    assert.equal(h.messages.filter(m => m.details.id === id && m.details.kind === "completed").length, 1);
  });
}

test("A4 real event and pause/resume wiring starts fresh evidence episodes", async t => {
  const h = await harness(t);
  t.mock.method(process, "kill", () => true);
  const out = await h.call("spawn", { persona: "oracle", task: "test", foreground: false, kill_on_stall: false });
  const id = out.details.agent_id; const child = h.children[0];
  h.tick(120);
  assert.match(h.messages.at(-1)!.content, /Recent activity unavailable/);
  h.emit(child, { role: "assistant", content: [{ type: "text", text: "FRESH_EVENT" }] });
  h.tick(239); assert.equal(h.messages.length, 1);
  h.tick(240); assert.match(h.messages.at(-1)!.content, /<recent-activity>/);
  assert.match(h.messages.at(-1)!.content, /FRESH_EVENT/);
  assert.equal((await h.call("pause", { agent_id: id })).details.status, "paused");
  h.tick(360); assert.equal(h.messages.length, 2);
  assert.equal((await h.call("resume", { agent_id: id })).details.status, "running");
  assert.equal(h.messages.length, 3, "resumed stale silence is a new episode, not a reminder");
  assert.match(h.messages.at(-1)!.content, /<recent-activity>/);
});

const astralToolCases = [
  { label: "read path", name: "read", arguments: { path: "🙂".repeat(30) } },
  { label: "bash head/tail", name: "bash", arguments: { command: "H" + "🙂".repeat(40) + "TAIL" } },
  { label: "generic value", name: "custom", arguments: { x: "🙂".repeat(30) } },
  { label: "generic joined pairs", name: "custom", arguments: { a: "x".repeat(29), b: "🙂".repeat(10), c: "tail" } },
];
for (const c of astralToolCases) {
  test(`A4 Unicode tool arguments survive real notification wiring: ${c.label}`, async t => {
    const h = await harness(t);
    const out = await h.call("spawn", { persona: "oracle", task: "test", foreground: false, kill_on_stall: false });
    assert.ok(!out.isError);
    h.emit(h.children[0], { role: "assistant", content: [{ type: "toolCall", id: "astral", name: c.name, arguments: c.arguments }] });
    h.emit(h.children[0], { role: "toolResult", toolName: c.name,
      content: [{ type: "text", text: "RESULT_HEAD\n" + "🙂<&>```".repeat(8000) + "\nRESULT_TAIL" }] });
    h.tick(120);
    const first = h.messages.find(m => m.details.id === out.details.agent_id && m.details.kind === "stalled")!;
    assert.ok(first);
    for (const text of [first.content, first.details.evidence!, h.render(first, 40), h.render(first, 80)]) {
      assert.equal(Buffer.from(text, "utf8").toString("utf8"), text, "valid tool arguments must not produce lone surrogates");
      assert.doesNotMatch(text, /�/, "valid tool arguments must not produce replacement characters");
      assert.match(text, /🙂/); assert.match(text, /tool call:/);
    }
    const block = first.content.match(/<recent-activity>[\s\S]*?<\/recent-activity>/)![0];
    assert.ok(Buffer.byteLength(block) <= 16 * 1024);
    const result = block.match(/tool result [^\n]*\n([\s\S]*?)\n<\/recent-activity>/)![1];
    assert.ok(Buffer.byteLength(result) <= 4 * 1024);
    assert.match(result, /RESULT_HEAD/); assert.match(result, /RESULT_TAIL/); assert.match(result, /omitted/);
    assert.match(result, /&lt;&amp;&gt;/); assert.match(result, /&#96;/);
    assert.equal((first.content.match(/^```/gm) ?? []).length, 2);
  });
}
