/**
 * Tests for v0.17-S6: UX surfaces — widget, ensemble_status, notifications,
 * history, doctor, conductor-prompt.
 *
 * WDD witnesses:
 *   W1: statusColorSlot("aborted") === "error"
 *   W2: widget annotation contains "wrapping up" when gracePeriodActive = true
 *   W3: widget formatRow contains "12/50" for maxTurns:50, usage.turns:12
 *   W4: notification for "aborted" contains "aborted" and "turn limit"
 *
 * Killing mutation for W1:
 *   Change `case "aborted": return "error"` to return "warning".
 *   → W1 assertion fails.
 *
 * Killing mutation for W2:
 *   Remove the gracePeriodActive branch from formatRow activity.
 *   → W2 assertion fails.
 *
 * Killing mutation for W3:
 *   Remove the maxTurns display from formatRow.
 *   → W3 assertion fails.
 *
 * Killing mutation for W4:
 *   Change verb to just "aborted" (drop "turn limit").
 *   → W4 second substring check fails.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { statusColorSlot } from "../src/transcript-style.ts";
import { formatRow } from "../src/widget.ts";
import { formatCompletionNotification } from "../src/notifications.ts";
import type { Run } from "../src/types.ts";

// ── W1: statusColorSlot("aborted") === "error" ────────────────────────────

test("S6 W1: statusColorSlot(aborted) === error", () => {
  assert.strictEqual(statusColorSlot("aborted"), "error");
});

// ── Shared helpers ────────────────────────────────────────────────────────

/** Minimal stub theme that just returns the raw text. */
const stubTheme = {
  fg: (_slot: string, text: string) => text,
};

function makeRun(overrides: Partial<Run>): Run {
  return {
    id: "builder-test",
    persona: "builder",
    status: "running",
    description: "test run",
    startTime: Date.now() - 10_000,
    finishedAt: undefined,
    messages: [],
    usage: { turns: 5, input: 0, output: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
    finalPath: "/tmp/final.md",
    transcriptPath: "/tmp/transcript.jsonl",
    cwd: "/tmp",
    isBackground: false,
    gracePeriodActive: false,
    hookExecuting: false,
    ...overrides,
  } as Run;
}

// ── W2: widget annotation contains "wrapping up" when gracePeriodActive ──

test("S6 W2: formatRow includes 'wrapping up' annotation when gracePeriodActive=true", () => {
  const run = makeRun({
    gracePeriodActive: true,
    maxTurns: 50,
    usage: { turns: 12, input: 0, output: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const row = formatRow(run, stubTheme, Date.now());
  assert.ok(
    row.includes("wrapping up"),
    `Row should include 'wrapping up' when gracePeriodActive=true; got: ${row}`,
  );
});

test("S6 W2 negative: formatRow omits 'wrapping up' when gracePeriodActive=false", () => {
  const run = makeRun({
    gracePeriodActive: false,
    maxTurns: 50,
    usage: { turns: 5, input: 0, output: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const row = formatRow(run, stubTheme, Date.now());
  assert.ok(
    !row.includes("wrapping up"),
    `Row should NOT include 'wrapping up' when gracePeriodActive=false; got: ${row}`,
  );
});

// ── W3: widget formatRow includes "12/50" for maxTurns:50, turns:12 ───────

test("S6 W3: widget formatRow includes turn progress N/M when maxTurns defined", () => {
  const run = makeRun({
    maxTurns: 50,
    usage: { turns: 12, input: 0, output: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const row = formatRow(run, stubTheme, Date.now());
  assert.ok(
    row.includes("12/50"),
    `Row should include '12/50' turn progress when maxTurns=50; got: ${row}`,
  );
});

test("S6 W3 negative: widget formatRow uses simple turn count when no maxTurns", () => {
  const run = makeRun({
    maxTurns: undefined,
    usage: { turns: 12, input: 0, output: 0, cost: 0, cacheRead: 0, cacheWrite: 0 },
  });
  const row = formatRow(run, stubTheme, Date.now());
  assert.ok(
    !row.includes("/50"),
    `Row should NOT include '/50' when maxTurns undefined; got: ${row}`,
  );
});

// ── W4: notification for "aborted" contains "aborted" and "turn limit" ────

test("S6 W4: notification for aborted status contains 'aborted' and 'turn limit'", () => {
  const run = makeRun({
    status: "aborted",
    finishedAt: Date.now(),
    thisInvocationStartedAt: Date.now() - 5000,
    maxTurns: 20,
    usage: { turns: 20, input: 100, output: 50, cost: 0.001, cacheRead: 0, cacheWrite: 0 },
  });
  const notification = formatCompletionNotification(run);
  assert.ok(
    notification.includes("aborted"),
    `Notification should contain 'aborted'; got snippet: ${notification.slice(0, 300)}`,
  );
  assert.ok(
    notification.includes("turn limit"),
    `Notification should contain 'turn limit'; got snippet: ${notification.slice(0, 300)}`,
  );
});
