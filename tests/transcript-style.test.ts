/**
 * Tests for the Slice 7 component-layer styling helper.
 *
 * Strategy: a sentinel-stub theme that wraps the input in a marker
 * `[<slot>]<text>[/]` lets us assert the slot mapping without depending
 * on real ANSI codes (or on pi-coding-agent's Theme class, whose
 * constructor needs a full colour map). The real Theme class
 * satisfies the same `ThemeFg` structural interface, so production
 * code is identical.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import {
  applyTheme,
  applyThemeToLines,
  statusColorSlot,
  type ThemeFg,
} from "../src/transcript-style.ts";
import { classifyLine } from "../src/transcript-classify.ts";
import type { RunStatus } from "../src/types.ts";

// Sentinel-stub theme — same interface as the real Theme.fg, but emits
// markers instead of ANSI so assertions are readable.
const stub: ThemeFg = {
  fg: (slot, text) => `[${slot}]${text}[/]`,
};

// ── statusColorSlot ────────────────────────────────────────────────

test("statusColorSlot maps running → accent", () => {
  assert.equal(statusColorSlot("running"), "accent");
});

test("statusColorSlot maps completed → success", () => {
  assert.equal(statusColorSlot("completed"), "success");
});

test("statusColorSlot maps failed/killed/timeout → error", () => {
  assert.equal(statusColorSlot("failed"), "error");
  assert.equal(statusColorSlot("killed"), "error");
  assert.equal(statusColorSlot("timeout"), "error");
});

test("statusColorSlot maps paused → warning", () => {
  assert.equal(statusColorSlot("paused"), "warning");
});

test("statusColorSlot maps queued → muted", () => {
  assert.equal(statusColorSlot("queued"), "muted");
});

test("statusColorSlot covers every RunStatus (no holes)", () => {
  const statuses: RunStatus[] = [
    "queued",
    "running",
    "paused",
    "completed",
    "failed",
    "killed",
    "timeout",
  ];
  for (const s of statuses) {
    // Will throw with a TS exhaustiveness check failure if a status is
    // missed — at runtime we just assert the result is non-empty.
    const slot = statusColorSlot(s);
    assert.ok(typeof slot === "string" && slot.length > 0, `status ${s} missing slot`);
  }
});

// ── applyTheme: kind → slot mapping ───────────────────────────────────

test("applyTheme: header line uses status-derived slot (running → accent)", () => {
  const line = "● oracle (oracle-7f3a) — running 12s";
  const out = applyTheme(line, classifyLine(line), stub, { status: "running" });
  assert.equal(out, `[accent]${line}[/]`);
});

test("applyTheme: header line uses error slot for failed/killed/timeout", () => {
  const failedLine = "✗ oracle (oracle-7f3a) — failed 12s";
  const killedLine = "■ oracle (oracle-7f3a) — killed 12s";
  const timeoutLine = "⏱ oracle (oracle-7f3a) — timeout 12s";
  assert.equal(
    applyTheme(failedLine, classifyLine(failedLine), stub, { status: "failed" }),
    `[error]${failedLine}[/]`,
  );
  assert.equal(
    applyTheme(killedLine, classifyLine(killedLine), stub, { status: "killed" }),
    `[error]${killedLine}[/]`,
  );
  assert.equal(
    applyTheme(timeoutLine, classifyLine(timeoutLine), stub, { status: "timeout" }),
    `[error]${timeoutLine}[/]`,
  );
});

test("applyTheme: header line uses success slot for completed", () => {
  const line = "✓ oracle (oracle-7f3a) — completed 12s";
  const out = applyTheme(line, classifyLine(line), stub, { status: "completed" });
  assert.equal(out, `[success]${line}[/]`);
});

test("applyTheme: header line uses warning slot for paused", () => {
  const line = "⏸ oracle (oracle-7f3a) — paused 12s";
  const out = applyTheme(line, classifyLine(line), stub, { status: "paused" });
  assert.equal(out, `[warning]${line}[/]`);
});

test("applyTheme: header line uses muted slot for queued", () => {
  const line = "◌ oracle (oracle-7f3a) — queued 0s";
  const out = applyTheme(line, classifyLine(line), stub, { status: "queued" });
  assert.equal(out, `[muted]${line}[/]`);
});

test("applyTheme: header line falls back to accent when status omitted", () => {
  const line = "● oracle (oracle-7f3a) — running 12s";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[accent]${line}[/]`);
});

test("applyTheme: ruler line gets borderMuted", () => {
  const line = "─".repeat(40);
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[borderMuted]${line}[/]`);
});

test("applyTheme: tool line colours leading chevron + space, leaves tail plain", () => {
  const line = "▸ bash echo hi";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[accent]▸ [/]bash echo hi`);
});

test("applyTheme: outcome ✓ uses success slot", () => {
  const line = " ↳ ✓ ok";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[success]${line}[/]`);
});

test("applyTheme: outcome ✗ uses error slot", () => {
  const line = " ↳ ✗ exit 1";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[error]${line}[/]`);
});

test("applyTheme: outcome … (pending) uses dim slot", () => {
  const line = " ↳ …";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[dim]${line}[/]`);
});

test("applyTheme: thinking summary uses dim slot", () => {
  const line = "· thinking (40 chars / 2 lines)";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[dim]${line}[/]`);
});

test("applyTheme: thinking body line uses dim slot", () => {
  const line = "  ┃ thinking";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[dim]${line}[/]`);
});

test("applyTheme: turn separator uses dim slot", () => {
  const line = "· turn 2";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[dim]${line}[/]`);
});

test("applyTheme: footer line uses dim slot", () => {
  const line = "Esc close · Tab/Sh-Tab cycle · ↑↓ scroll";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, `[dim]${line}[/]`);
});

test("applyTheme: text kind passes through unchanged", () => {
  const line = "Looking at the auth flow now.";
  const out = applyTheme(line, classifyLine(line), stub);
  assert.equal(out, line, "text kind must NOT acquire any styling");
});

test("applyTheme: empty/blank text passes through unchanged", () => {
  const out = applyTheme("", classifyLine(""), stub);
  assert.equal(out, "");
});

// ── applyThemeToLines (composition) ─────────────────────────────────

test("applyThemeToLines: classifies and styles every line in order", () => {
  const lines = [
    "─".repeat(20),
    "● oracle (oracle-1) — running 1s",
    "Looking at things.",
    "▸ bash echo hi",
    " ↳ ✓ done",
    "· turn 2",
    "Another response.",
  ];
  const out = applyThemeToLines(lines, classifyLine, stub, { status: "running" });
  assert.equal(out.length, 7);
  assert.equal(out[0], `[borderMuted]${lines[0]}[/]`);
  assert.equal(out[1], `[accent]${lines[1]}[/]`);
  assert.equal(out[2], lines[2], "text passes through");
  assert.equal(out[3], `[accent]▸ [/]bash echo hi`);
  assert.equal(out[4], `[success]${lines[4]}[/]`);
  assert.equal(out[5], `[dim]${lines[5]}[/]`);
  assert.equal(out[6], lines[6], "text passes through");
});

test("applyThemeToLines: status defaults to accent when omitted", () => {
  const out = applyThemeToLines(
    ["● oracle (id) — running 1s"],
    classifyLine,
    stub,
  );
  assert.equal(out[0], `[accent]● oracle (id) — running 1s[/]`);
});

test("applyThemeToLines: empty input → empty output", () => {
  assert.deepEqual(applyThemeToLines([], classifyLine, stub), []);
});

// ── v0.9 deferral 2: wrap() / wrapTextWithAnsi audit ─────────────────
//
// The local `wrap()` helper in src/transcript.ts is now a thin delegate
// to pi-tui's `wrapTextWithAnsi` (commit 6793a5a). The renderer always
// wraps text BEFORE `applyTheme` injects ANSI, so the wrap path never
// sees ANSI in the production flow. These regressions pin both
// invariants: the helper itself stays ANSI-aware, and downstream styled
// output respects width when re-wrapped.

test("wrapTextWithAnsi invariant: ANSI-styled lines re-wrapped preserve visibleWidth ≤ source width", () => {
  // If anyone re-routes styled output back through a wrap path, we want
  // a green test to catch the moment they do — wrapTextWithAnsi handles
  // ANSI, but raw .length / .slice would visibly mis-wrap.
  // Use real ANSI escapes (CSI ... m) so visibleWidth strips them, just
  // like the production Theme.fg() output.
  const ansiFg = (text: string) => `\u001b[36m${text}\u001b[0m`;
  const styled = `${ansiFg("▸ ")}bash echo hello world ${ansiFg(
    "with arguments and more text to force wrapping",
  )}`;
  // Sanity: visibleWidth strips ANSI.
  assert.ok(
    visibleWidth(styled) < styled.length,
    "ANSI-wrapped string should be longer in raw chars than visible cols",
  );
  for (const w of [10, 20, 40, 80]) {
    const wrapped = wrapTextWithAnsi(styled, w);
    for (const line of wrapped) {
      assert.ok(
        visibleWidth(line) <= w,
        `wrapped line exceeded width=${w}: visibleWidth=${visibleWidth(
          line,
        )} line=${JSON.stringify(line)}`,
      );
    }
  }
});
