/**
 * Tests for the inline notification card.
 *
 * Problem being fixed: `pushCompletionNotification` sent
 * `pi.sendMessage({ customType: "ensemble-notification", content })` with
 * NO `details` and the extension registered NO message renderer, so pi's
 * `CustomMessageComponent` fell back to its default branch — a
 * `[ensemble-notification]` label followed by the raw markdown, which
 * renders the embedded ```xml envelope verbatim in the transcript.
 *
 * Fix has two halves, both witnessed here:
 *   1. `buildCompletionMessage` / `buildStallMessage` attach a structured
 *      `details` payload alongside the unchanged XML `content`. The XML is
 *      the LLM's contract (and `compaction-hook.ts`'s ENVELOPE_RE depends
 *      on it byte-for-byte), so it must not change.
 *   2. `renderNotificationCard` turns that payload into styled spans, and
 *      `notificationRenderer` returns `undefined` when `details` is absent
 *      so sessions recorded before `details` existed degrade to the old
 *      rendering instead of
 *      throwing.
 *
 * Killing mutations:
 *   - drop `details` from buildCompletionMessage → W1 fails.
 *   - make the renderer ignore `expanded` → W7/W8 fail (collapsed card
 *     grows past 3 lines / expanded card loses the transcript row).
 *   - return a Text component instead of undefined on missing details →
 *     W12 fails.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildCompletionMessage,
  buildStallMessage,
  formatCompletionNotification,
  statusVerb,
} from "../src/notifications.ts";
import {
  cardLinesToPlainText,
  notificationRenderer,
  paintCardLines,
  renderNotificationCard,
  type CardTheme,
} from "../src/notification-renderer.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";

const T0 = 1_700_000_000_000;

function runFx(overrides: Partial<Run> = {}): Run {
  return {
    id: "builder-ab12",
    persona: "builder",
    task: "test task",
    mode: "background",
    status: "completed" as RunStatus,
    startTime: T0,
    lastEventAt: T0 + 72_000,
    finishedAt: T0 + 72_000,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "Implemented the thing.\nSecond line." }],
      } as Run["messages"][number],
    ],
    usage: { ...emptyUsage(), turns: 3, input: 12_400, output: 2_100, cost: 0.08 },
    cwd: "/tmp",
    recordPath: "/tmp/record.json",
    transcriptPath: "/tmp/transcript.jsonl",
    finalPath: "/tmp/final.md",
    ...overrides,
  };
}

/** Sentinel-stub theme in the same shape tests/footer-bindings.test.ts uses. */
const stubTheme: CardTheme = {
  fg: (slot, text) => `[${slot}]${text}[/]`,
  bold: (text) => `<b>${text}</b>`,
};

// ── buildCompletionMessage: the `details` payload ───────────────────────

test("W1: buildCompletionMessage attaches details alongside the XML content", () => {
  const msg = buildCompletionMessage(runFx());

  assert.equal(msg.customType, "ensemble-notification");
  assert.equal(msg.display, true);
  // The XML contract is unchanged — content is byte-identical to the
  // pre-fix formatter, which compaction-hook.ts's ENVELOPE_RE parses.
  assert.equal(msg.content, formatCompletionNotification(runFx()));

  const d = msg.details;
  assert.ok(d, "details must be present — this is the whole fix");
  assert.equal(d.kind, "completed");
  assert.equal(d.id, "builder-ab12");
  assert.equal(d.persona, "builder");
  assert.equal(d.status, "completed");
  assert.equal(d.body, "Implemented the thing.\nSecond line.");
  assert.equal(d.transcriptPath, "/tmp/transcript.jsonl");
  assert.deepEqual(d.notes, []);
});

test("W2: completion stats carry elapsed, usage and the agent id", () => {
  const d = buildCompletionMessage(runFx()).details!;
  assert.deepEqual(d.stats, ["1.2m", "3t ↑12k ↓2.1k $0.080", "builder-ab12"]);
});

test("W3: a resumed run gains a lifetime stat segment", () => {
  const d = buildCompletionMessage(
    runFx({
      resumeCount: 2,
      thisInvocationStartedAt: T0 + 60_000,
      thisInvocationUsageBaseline: { turns: 2, input: 10_000, output: 1_800, cost: 0.06 },
    }),
  ).details!;

  // Per-send numbers shrink to the current invocation…
  assert.equal(d.stats[0], "12s");
  // …and the lifetime totals follow as their own segment.
  assert.ok(
    d.stats.some((s) => s.startsWith("lifetime 1.2m") && s.includes("2 resumes")),
    `expected a lifetime segment, got ${JSON.stringify(d.stats)}`,
  );
});

test("W4: failure, warning and hook results become annotation notes", () => {
  const d = buildCompletionMessage(
    runFx({
      status: "hook_failed",
      errorMessage: "exited 1",
      nonSubstantiveFinal: { reason: "empty", message: "final.md was blank" },
      hookResult: {
        passed: false,
        command: "npm test",
        exitCode: 1,
        durationMs: 4_000,
        logPath: "/tmp/hook.log",
        tailText: "1 failing",
        tailBytes: 9,
        tailLines: 1,
      },
    }),
  ).details!;

  assert.deepEqual(
    d.notes.map((n) => n.slot),
    ["error", "warning", "error"],
  );
  assert.match(d.notes[0]!.text, /exited 1/);
  assert.match(d.notes[1]!.text, /final\.md was blank/);
  assert.match(d.notes[2]!.text, /npm test.*exit 1.*\/tmp\/hook\.log/);
});

test("W5: a passing hook is a muted note, not an error", () => {
  const d = buildCompletionMessage(
    runFx({
      hookResult: {
        passed: true,
        command: "npm test",
        exitCode: 0,
        durationMs: 4_000,
        logPath: "/tmp/hook.log",
        tailText: "",
        tailBytes: 0,
        tailLines: 0,
      },
    }),
  ).details!;

  assert.deepEqual(d.notes.map((n) => n.slot), ["muted"]);
  assert.match(d.notes[0]!.text, /hook ok/);
});

// ── buildStallMessage ──────────────────────────────────────────────────

test("W6: buildStallMessage details carry severity, thresholds and last tool", () => {
  const msg = buildStallMessage(runFx({ status: "running", lastToolCall: "bash(npm test)" }), {
    severity: "hard",
    silentSeconds: 700,
    thresholdSeconds: 600,
  });

  const d = msg.details!;
  assert.equal(d.kind, "stalled");
  assert.equal(d.severity, "hard");
  assert.equal(d.body, "");
  assert.deepEqual(d.stats, ["silent 700s", "threshold 600s", "builder-ab12"]);
  assert.deepEqual(d.notes.map((n) => n.slot), ["muted"]);
  assert.match(d.notes[0]!.text, /bash\(npm test\)/);
});

// ── renderNotificationCard ─────────────────────────────────────────────

test("W7: collapsed card is header + one-line preview + expand hint", () => {
  const d = buildCompletionMessage(runFx()).details!;
  const lines = renderNotificationCard(d, { expanded: false });

  assert.equal(
    cardLinesToPlainText(lines),
    [
      "✓ builder completed · 1.2m · 3t ↑12k ↓2.1k $0.080 · builder-ab12",
      "  ⎿  Implemented the thing.",
      "  ctrl+o for the full result",
    ].join("\n"),
  );
});

test("W8: expanded card shows the whole body and the transcript path", () => {
  const d = buildCompletionMessage(runFx()).details!;
  const lines = renderNotificationCard(d, { expanded: true });

  assert.equal(
    cardLinesToPlainText(lines),
    [
      "✓ builder completed · 1.2m · 3t ↑12k ↓2.1k $0.080 · builder-ab12",
      "  Implemented the thing.",
      "  Second line.",
      "  transcript: /tmp/transcript.jsonl",
    ].join("\n"),
  );
});

test("W9: the expanded body is capped and reports how much it dropped", () => {
  const body = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
  const d = buildCompletionMessage(runFx({ messages: [textMessage(body)] })).details!;
  const text = cardLinesToPlainText(renderNotificationCard(d, { expanded: true, maxBodyLines: 4 }));

  assert.ok(text.includes("  line 4"), text);
  assert.ok(!text.includes("  line 5"), text);
  assert.match(text, /… 8 more lines — see transcript/);
});

test("W10: no expand hint when the collapsed preview is already the whole body", () => {
  const d = buildCompletionMessage(runFx({ messages: [textMessage("one line only")] })).details!;
  const text = cardLinesToPlainText(renderNotificationCard(d, { expanded: false }));

  assert.equal(text, "✓ builder completed · 1.2m · 3t ↑12k ↓2.1k $0.080 · builder-ab12\n  ⎿  one line only");
});

test("W11: status drives glyph and colour slot; persona is bold", () => {
  const cases: [RunStatus, string, string][] = [
    ["completed", "✓", "success"],
    ["failed", "✗", "error"],
    ["timeout", "⏱", "error"],
    ["killed", "■", "error"],
  ];
  for (const [status, glyph, slot] of cases) {
    const d = buildCompletionMessage(runFx({ status })).details!;
    const header = renderNotificationCard(d, { expanded: false })[0]!;
    assert.deepEqual(
      { text: header[0]!.text, slot: header[0]!.slot },
      { text: glyph, slot },
      `status ${status}`,
    );
    assert.ok(
      header.some((span) => span.text === "builder" && span.bold),
      `persona span must be bold for status ${status}`,
    );
  }
});

test("W11b: a hard stall renders a warning glyph, not a status glyph", () => {
  const d = buildStallMessage(runFx({ status: "running" }), {
    severity: "hard",
    silentSeconds: 700,
    thresholdSeconds: 600,
  }).details!;
  const header = renderNotificationCard(d, { expanded: false })[0]!;

  assert.equal(header[0]!.text, "⚠");
  assert.equal(header[0]!.slot, "warning");
  assert.match(cardLinesToPlainText([header]), /hard-stalled/);
});

// ── theme application + the host-facing renderer ────────────────────────

test("W12: renderer returns undefined for a message with no details", () => {
  const rendered = notificationRenderer(
    { customType: "ensemble-notification", content: "<sub-agent-completed>…" },
    { expanded: false, outputPad: 1 },
    stubTheme,
  );
  // Pi's CustomMessageComponent does `if (component)` and falls back to
  // its default box, so undefined is the supported degrade path for
  // sessions recorded before details existed.
  assert.equal(rendered, undefined);
});

test("W13: paintCardLines applies fg slots and bold to the right spans", () => {
  const painted = paintCardLines(
    [[{ text: "✓", slot: "success" }, { text: " " }, { text: "builder", bold: true }]],
    stubTheme,
  );
  assert.equal(painted, "[success]✓[/] <b>builder</b>");
});

// ── statusVerb extraction parity ───────────────────────────────────────

test("W14: statusVerb still produces the wording the XML header shipped with", () => {
  assert.equal(statusVerb("completed"), "completed");
  assert.equal(statusVerb("killed"), "killed");
  assert.equal(statusVerb("timeout"), "timed out");
  assert.equal(statusVerb("hook_failed"), "hook failed");
  assert.equal(statusVerb("aborted"), "aborted (turn limit)");
  assert.equal(statusVerb("failed"), "failed");
  // The header line is the pre-existing consumer; it must be unchanged.
  assert.match(formatCompletionNotification(runFx()), /## ✓ `builder` completed \(/);
});

function textMessage(text: string): Run["messages"][number] {
  return { role: "assistant", content: [{ type: "text", text }] } as Run["messages"][number];
}

// ── wiring witness ─────────────────────────────────────────────────────

test("W15: every pi.sendMessage in index.ts routes through a message builder", () => {
  const src = readFileSync(
    new URL("../src/index.ts", import.meta.url).pathname,
    "utf8",
  );

  // The regression shape: a hand-rolled envelope literal at the call site,
  // which is how one of the three sites ended up without `details`.
  assert.equal(
    src.includes(`customType: "ensemble-notification"`),
    false,
    "index.ts must not build notification messages inline — use buildCompletionMessage / buildStallMessage",
  );

  const firstArgs = [...src.matchAll(/pi\.sendMessage\(\s*([A-Za-z]+)/g)].map((m) => m[1]);
  assert.ok(firstArgs.length >= 3, `expected the 3 known send sites, found ${firstArgs.length}`);
  for (const fn of firstArgs) {
    assert.match(fn, /^build(Completion|Stall)Message$/);
  }
});
