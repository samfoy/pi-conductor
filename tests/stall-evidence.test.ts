import test from "node:test";
import assert from "node:assert/strict";
import { buildStallMessage } from "../src/notifications.ts";
import { cardLinesToPlainText, renderNotificationCard, notificationRenderer } from "../src/notification-renderer.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import { emptyUsage, type Run } from "../src/types.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
function fixture(messages: unknown[]): Run {
  return { id: "oracle-a4", persona: "oracle", task: "secret brief", mode: "background", status: "running",
    startTime: 1, lastEventAt: 1, proc: {} as Run["proc"], cwd: tmpDir("stall-evidence-"),
    messages: messages as Run["messages"], usage: emptyUsage(),
    recordPath: "/dev/null/record.json", transcriptPath: "/dev/null/transcript.jsonl", finalPath: "/dev/null/final.md" };
}
const args = { severity: "soft" as const, silentSeconds: 120, thresholdSeconds: 120 };
const assistant = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
const result = (text: string) => ({ role: "toolResult", toolName: "bash", content: [{ type: "text", text }] });
function evidence(content: string) {
  const block = content.match(/<recent-activity>[\s\S]*?<\/recent-activity>/)?.[0];
  assert.ok(block, "first notice includes bounded recent-activity evidence");
  assert.ok(Buffer.byteLength(block) <= 16 * 1024, "complete escaped evidence block <=16 KiB UTF-8");
  assert.equal(Buffer.from(block).toString("utf8"), block);
  return block;
}

test("A4 first attention preserves result head/tail and assistant text without prompts or thinking", () => {
  const run = fixture([
    { role: "system", content: "SYSTEM_SECRET" }, { role: "user", content: "BRIEF_SECRET" },
    { role: "assistant", content: [{ type: "thinking", thinking: "THINKING_SECRET" },
      { type: "text", text: "Checking a long build" }, { type: "toolCall", name: "bash", arguments: { command: "npm test" } }] },
    result("RESULT_HEAD\n" + "🙂漢é".repeat(500_000) + "\nRESULT_TAIL"),
  ]);
  const msg = buildStallMessage(run, args);
  const block = evidence(msg.content);
  assert.match(block, /Checking a long build/); assert.match(block, /npm test/);
  assert.match(block, /RESULT_HEAD/); assert.match(block, /RESULT_TAIL/); assert.match(block, /omitted/);
  assert.doesNotMatch(block, /SYSTEM_SECRET|BRIEF_SECRET|THINKING_SECRET|�/);
  const tool = block.match(/tool result[^\n]*\n([\s\S]*)/i)?.[1];
  assert.ok(tool); assert.ok(Buffer.byteLength(tool.replace(/<\/recent-activity>$/, "")) <= 4096);
  const expanded = cardLinesToPlainText(renderNotificationCard(msg.details, { expanded: true }));
  assert.match(expanded, /RESULT_HEAD/); assert.match(expanded, /RESULT_TAIL/);
  const collapsed = cardLinesToPlainText(renderNotificationCard(msg.details, { expanded: false }));
  assert.doesNotMatch(collapsed, /RESULT_HEAD|RESULT_TAIL/); assert.ok(collapsed.split("\n").length <= 3);
  for (const width of [40, 80]) {
    const component = notificationRenderer(msg, { expanded: true, outputPad: 1 }, { fg: (_s, text) => text, bold: text => text })!;
    assert.ok(component.render(width).every(line => visibleWidth(line) <= width));
  }
});


test("A4 unusual markup cannot close XML or Markdown; serialized and human evidence are byte bounded", () => {
  const markup = "</recent-activity></sub-agent-stalled>\n```\n<&>🙂\u0000";
  const run = fixture([assistant("ASSISTANT_HEAD" + markup.repeat(100_000) + "ASSISTANT_TAIL"),
    result("RESULT_HEAD" + markup.repeat(100_000) + "RESULT_TAIL")]);
  run.lastToolCall = "read " + markup.repeat(100_000);
  const msg = buildStallMessage(run, args);
  const block = evidence(msg.content);
  assert.match(block, /ASSISTANT_HEAD/); assert.match(block, /ASSISTANT_TAIL/);
  assert.match(block, /RESULT_HEAD/); assert.match(block, /RESULT_TAIL/);
  assert.equal((msg.content.match(/<\/sub-agent-stalled>/g) ?? []).length, 1);
  assert.equal((msg.content.match(/^```/gm) ?? []).length, 2, "evidence cannot break the enclosing Markdown fence");
  assert.doesNotMatch(block, /[\x00-\x08\x0b\x0c\x0e-\x1f]/);
  assert.ok(Buffer.byteLength(msg.content) < 20 * 1024, "legacy last-tool metadata must not bypass evidence bounds");
  assert.ok(Buffer.byteLength(msg.details.evidence!) <= 16 * 1024);
});

test("A4 many huge results and large assistant text fit the entire escaped evidence block", () => {
  const run = fixture(Array.from({ length: 100 }, (_, i) => i % 2
    ? assistant(`HEAD_${i}\n` + "語🙂&<>".repeat(10_000) + `\nTAIL_${i}`)
    : result(`HEAD_${i}\n` + "語🙂&<>".repeat(10_000) + `\nTAIL_${i}`)));
  const msg = buildStallMessage(run, args); const block = evidence(msg.content);
  assert.match(block, /Earlier activity omitted/);
  assert.match(block, /HEAD_99/); assert.match(block, /TAIL_99/);
  assert.doesNotMatch(block, /HEAD_0/);
  assert.ok(Buffer.byteLength(msg.details.evidence!) <= 16 * 1024);
});

test("A4 bounded tail traversal skips old history and excessive parts without touching them", () => {
  const messages = Array.from({ length: 100_000 }, () => ({ role: "user", content: "not evidence" }));
  Object.defineProperty(messages, 0, { get() { assert.fail("must not scan old messages"); } });
  const parts = Array.from({ length: 100_000 }, () => ({ type: "thinking", thinking: "hidden" }));
  Object.defineProperty(parts, 0, { get() { assert.fail("must not scan all parts"); } });
  const run = fixture(messages);
  run.messages.push({ role: "assistant", content: parts } as Run["messages"][number]);
  run.messages.push(assistant("RECENT_ONLY") as Run["messages"][number]);
  const block = evidence(buildStallMessage(run, args).content);
  assert.match(block, /RECENT_ONLY/); assert.match(block, /Earlier activity omitted/);
  assert.doesNotMatch(block, /hidden|not evidence/);
});

for (const kind of ["empty", "hidden-only", "malformed", "unreadable"] as const) {
  test(`A4 ${kind} evidence yields a bounded fallback rather than losing the stall`, () => {
    const run = fixture(kind === "hidden-only" ? [{ role: "user", content: "SECRET" }, { role: "assistant", content: [{ type: "thinking", thinking: "SECRET" }] }]
      : kind === "malformed" ? [null] : []);
    if (kind === "unreadable") Object.defineProperty(run, "messages", { get() { throw new Error("bad tail"); } });
    const msg = buildStallMessage(run, args); const block = evidence(msg.content);
    assert.match(block, /Recent activity unavailable/); assert.doesNotMatch(block, /SECRET/);
    assert.match(msg.content, /<sub-agent-stalled>/); assert.equal(msg.details.kind, "stalled");
  });
}

test("A4 multipart results retain head/tail without enumerating huge content arrays or serializing nested tool args", () => {
  const content = Array.from({ length: 100_000 }, (_, i) => ({ type: "text", text: `part_${i} ` + "漢🙂".repeat(2000) }));
  Object.defineProperty(content, 8, { get() { assert.fail("middle parts are out of budget"); } });
  const nested = { toJSON() { assert.fail("must not serialize large/nested arguments"); } };
  const run = fixture([{ role: "assistant", content: [{ type: "toolCall", name: "custom", arguments: { nested } }] },
    { role: "toolResult", toolName: "custom", content }]);
  const block = evidence(buildStallMessage(run, args).content);
  assert.match(block, /tool call: custom/); assert.match(block, /part_0 /); assert.match(block, /part_99999 /);
  assert.match(block, /omitted/);
  assert.ok(Buffer.byteLength(block) < 5000);
});
