import test from "node:test";
import assert from "node:assert/strict";
import { sandboxPi } from "./helpers/tmp.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { applyEvent } from "../src/event-handler.ts";
import { isObservableHere } from "../src/runtime.ts";
import { Watchdog, evaluateRun, classifyStall, DEFAULT_WATCHDOG_CONFIG as config } from "../src/watchdog.ts";
sandboxPi();

test("H9 dialog message is a human-wait card, with explicit nonwaking production wiring", async () => {
  const { buildDialogMessage } = await import("../src/notifications.ts");
  const { readFileSync } = await import("node:fs");
  const { renderNotificationCard, cardLinesToPlainText } = await import("../src/notification-renderer.ts");
  const h = await fixture();
  const message = buildDialogMessage(h.run);
  assert.equal(message.details.kind, "dialog"); assert.match(message.content, /<sub-agent-dialog>/);
  assert.match(cardLinesToPlainText(renderNotificationCard(message.details, { expanded: true })), /waiting for human UI/);
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /pi\.sendMessage\(buildDialogMessage\(run\), \{ triggerTurn: false, deliverAs: "followUp" \}\)/);
  await h.transport.stop();
});


test("H9 live evidence uses fixed bounded argv and strongly redacts secrets without splitting Unicode", async () => {
  const h = await fixture(); let reads = 0;
  h.cli.text = async (args, limits) => {
    reads++; assert.deepEqual(args, ["agent", "read", h.run.id, "--source", "recent-unwrapped", "--lines", "40"]);
    assert.equal(limits?.timeoutMs, 2000); assert.equal(limits?.maxBuffer, 4096);
    return "Bearer hide-me\nhttps://user:password@host/\n{\"api_key\":\"hidden\"}\n" + "漢🙂".repeat(2000);
  };
  const evidence = await h.transport.readStallEvidence!();
  assert.equal(reads, 1); assert.ok(Buffer.byteLength(evidence) <= 4096);
  assert.doesNotMatch(evidence, /hide-me|user:password|hidden|�/); assert.match(evidence, /漢🙂/);
  await h.transport.stop();
});


async function fixture() {
  const h = herdrFixture("running");
  h.run.transport = h.runtime.launch(h.run, [], h.run.cwd, { line() {}, close() {}, error() {}, initialDeliveryFailed() {} }, "probe", h.opts.core);
  await h.run.transport.ready; h.run.transport.observe();
  h.run.startTime = h.run.lastEventAt = 0;
  const prompt = (state: string, kind = "confirm", title = "choice", nonce = h.run.herdr!.launchNonce) => applyEvent(h.run, { type: "conductor_child", event: "ui_prompt", state, kind, title, _c: { n: nonce } });
  let now = 120000, kills = 0, dialogs = 0;
  const notices: any[] = [];
  const wd = new Watchdog({ registry: h.registry, config, now: () => now, log: { warn: (_s, data) => notices.push(data), info() {} }, kill: () => kills++, isKillOnStall: () => true, dialog: () => dialogs++ });
  const transport = h.run.transport;
  return { ...h, transport, prompt, wd, notices, now: (value: number) => { now = value; }, kills: () => kills, dialogs: () => dialogs };
}
test("H9 only attached current herdr streams are observable", async () => {
  const h = await fixture();
  assert.equal(isObservableHere(h.run), true);
  const original = h.run.herdr; h.run.herdr = { ...original!, launchNonce: "foreign" };
  assert.equal(isObservableHere(h.run), false); h.run.herdr = original;
  await h.run.transport!.stop(); assert.equal(isObservableHere(h.run), false);
});
test("H9 nested/repeated prompts suppress evaluator, rendering and kill; one dialog card per wait", async () => {
  const h = await fixture();
  h.prompt("start"); h.prompt("start"); h.prompt("start", "input", "other");
  h.wd.tick(); h.now(900000); h.wd.tick();
  assert.equal(evaluateRun(h.run, undefined, config, 900000).transition.kind, "none");
  assert.equal(classifyStall(h.run, 900000, config), null);
  assert.equal(h.dialogs(), 1); assert.equal(h.kills(), 0); assert.deepEqual(h.notices, []);
  h.prompt("end", "input", "other", "foreign"); h.prompt("end", "input", "unknown"); h.prompt("end");
  h.wd.tick(); assert.equal(classifyStall(h.run, 900000, config), null);
  h.prompt("end"); h.prompt("end", "input", "other");
  assert.equal(classifyStall(h.run, Date.now(), config)?.severity, "fresh", "actual end resets stale clock");
  h.prompt("start"); h.wd.tick(); assert.equal(h.dialogs(), 2);
  applyEvent(h.run, { type: "agent_settled" });
  assert.equal(h.run.herdrPrompts, undefined);
  await h.run.transport!.stop();
});
test("H9 first episode reads live evidence once; reminders and failed reads never poll", async () => {
  const h = await fixture(); let reads = 0;
  h.transport.readStallEvidence = async () => { reads++; return "private diagnostic 漢🙂"; };
  h.wd.tick(); await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 1); assert.match(h.notices[0]?.evidence, /private diagnostic 漢🙂/);
  h.now(180000); h.wd.tick(); await Promise.resolve();
  assert.equal(reads, 1); assert.match(h.notices[1]?.evidenceReference, /first notice/);
  h.run.lastEventAt = 180000; h.now(300000);
  h.transport.readStallEvidence = async () => { reads++; throw new Error("secret"); };
  h.wd.tick(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(reads, 2); assert.match(h.notices[2]?.evidence, /unavailable/);
  assert.ok(!h.notices[2].evidence.includes("secret"));
  await h.run.transport!.stop();
});
test("H9 a dialog arriving during diagnostic read cancels stale advisory and kill", async () => {
  const h = await fixture(); h.now(900000);
  let resolve!: (s: string) => void;
  h.transport.readStallEvidence = () => new Promise<string>(r => { resolve = r; });
  h.wd.tick(); h.prompt("start"); h.wd.tick(); resolve("old diagnostic");
  await Promise.resolve(); await Promise.resolve();
  assert.equal(h.kills(), 0); assert.equal(h.notices.length, 0); assert.equal(h.dialogs(), 1);
  await h.run.transport!.stop();
});
