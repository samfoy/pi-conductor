/**
 * Pure transcript renderer for the focused-stream overlay.
 *
 * Takes a Run and a set of view options, returns a string[] (one entry per
 * rendered line, each line constrained to `width` columns). No TUI imports,
 * no theme dependency, no I/O — the Component layer is responsible for
 * styling and rendering this output.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { Run } from "./types.ts";
import { elapsedStr, formatUsage } from "./runs.ts";
import { STATUS_GLYPH } from "./status-glyph.ts";
import { summarizeToolArgs } from "./tool-summary.ts";

export interface TranscriptOptions {
  /** Hard wrap width; lines that exceed it are wrapped or truncated. */
  width: number;
  /** When true, toolCall parts collapse to a single chevron line. */
  collapseToolCalls: boolean;
  /** When true, thinking parts are shown; otherwise hidden. */
  showThinking: boolean;
}

// ── Header ────────────────────────────────────────────────────────────

export function renderHeader(run: Run, width: number): string[] {
  const elapsed = elapsedStr(run.startTime, run.finishedAt);
  const usage = formatUsage(run.usage);
  const glyph = STATUS_GLYPH[run.status] ?? "·";

  const left = `${glyph} ${run.persona} (${run.id}) — ${run.status} ${elapsed}`;
  const right = usage ? `[${usage}]` : "";
  const sep = "─".repeat(Math.max(0, width));

  // Truncate to width if needed.
  const headerLine = padOrTruncate(left, right, width);
  return [sep, headerLine, sep];
}

// ── Footer ────────────────────────────────────────────────────────────

const FOOTER_HINTS = [
  "Esc close",
  "Tab/Sh-Tab cycle",
  "↑↓ scroll",
  "s send",
  "c collapse",
  "t thinking",
  "k kill",
];

export function renderFooter(width: number): string[] {
  // Greedy pack: include as many hints as fit, separated by " · ".
  const sep = " · ";
  let line = "";
  for (const hint of FOOTER_HINTS) {
    const next = line ? line + sep + hint : hint;
    if (next.length > width) break;
    line = next;
  }
  if (line.length > width) line = line.slice(0, width);
  const ruler = "─".repeat(Math.max(0, width));
  return [ruler, line];
}

// ── Transcript body ───────────────────────────────────────────────────

export function renderTranscript(run: Run, opts: TranscriptOptions): string[] {
  const out: string[] = [];
  let assistantTurnIndex = 0;

  // Build a quick lookup: toolCall id → toolResult message (the toolResult
  // following an assistant message is the response to it).
  const resultsByCallId = new Map<string, AgentMessage>();
  for (const msg of run.messages) {
    if ((msg as any).role !== "toolResult") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "toolResult" && part.toolUseId) {
        resultsByCallId.set(part.toolUseId, msg);
      }
    }
  }

  for (const msg of run.messages) {
    const role = (msg as any).role;
    if (role === "user" || role === "toolResult") {
      // toolResult is rendered inline with its toolCall, not as a top-level message.
      // user messages are the internal sub-agent prompt — hidden.
      continue;
    }

    if (role === "assistant") {
      assistantTurnIndex += 1;
      out.push(turnSeparator(assistantTurnIndex, opts.width));

      const content = (msg as any).content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        switch (part?.type) {
          case "text":
            for (const line of wrap(String(part.text ?? ""), opts.width)) {
              out.push(line);
            }
            break;
          case "thinking":
            if (opts.showThinking) {
              out.push(...renderThinking(String(part.thinking ?? ""), opts.width));
            } else {
              out.push(renderThinkingSummary(String(part.thinking ?? "")));
            }
            break;
          case "toolCall":
            out.push(...renderToolCall(part, resultsByCallId, opts));
            break;
          default:
            // Unknown part types are skipped (forward-compat).
            break;
        }
      }
    }
  }

  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────

function turnSeparator(turn: number, width: number): string {
  const label = ` turn ${turn} `;
  const filler = Math.max(0, width - label.length);
  const left = "── ";
  const right = "─".repeat(Math.max(0, filler - left.length));
  const candidate = left + label.trim() + " " + right;
  if (candidate.length > width) return candidate.slice(0, width);
  return candidate;
}

function renderThinking(text: string, width: number): string[] {
  const out: string[] = ["  ┃ thinking"];
  for (const line of wrap(text, Math.max(8, width - 4))) {
    out.push("  ┃ " + line);
  }
  return out;
}

/**
 * Compact summary line emitted when `showThinking: false`. Lets the user see
 * that thinking happened (and roughly how much) without taking the vertical
 * cost of the body. Char count is the raw text length; line count is the
 * number of newline-separated segments, with empty text reporting 0 lines.
 *
 * Slice 7 will color the leading `·` via the component-layer styling helper.
 */
function renderThinkingSummary(text: string): string {
  const chars = text.length;
  const lines = text === "" ? 0 : text.split("\n").length;
  const lineWord = lines === 1 ? "line" : "lines";
  return `· thinking (${chars} chars / ${lines} ${lineWord})`;
}

function renderToolCall(
  part: { id?: string; name: string; arguments?: Record<string, any> },
  resultsByCallId: Map<string, AgentMessage>,
  opts: TranscriptOptions,
): string[] {
  const name = part.name ?? "tool";
  if (opts.collapseToolCalls) {
    const summary = summarizeToolArgs(name, part.arguments ?? {});
    const line = `▸ ${name}${summary ? " " + summary : ""}`;
    const out: string[] = [truncateOrPad(line, opts.width)];
    // Outcome line: ↳ ✓/✗/… + first-line preview. Only emitted when the
    // call carries an id we can correlate against; tests/fixtures that omit
    // id keep their pre-Slice-2 single-chevron shape.
    if (part.id) {
      const result = resultsByCallId.get(part.id);
      if (result) {
        const isError = (result as any).isError === true;
        const glyph = isError ? "✗" : "✓";
        const preview = firstLine(extractFirstResultText(result));
        const outcome = preview ? ` ↳ ${glyph} ${preview}` : ` ↳ ${glyph}`;
        out.push(truncateOrPad(outcome, opts.width));
      } else {
        // Pending: call landed but no result yet. Stable cue prevents the
        // ≤500ms flash described in plan §7 throttle interaction.
        out.push(truncateOrPad(" ↳ …", opts.width));
      }
    }
    return out;
  }

  const out: string[] = [`▾ ${name}`];
  // Pretty-print arguments line by line.
  if (part.arguments) {
    const json = JSON.stringify(part.arguments, null, 2);
    for (const ln of json.split("\n")) {
      out.push(truncateOrPad("  " + ln, opts.width));
    }
  }
  // Inline the matched tool result if present.
  if (part.id) {
    const result = resultsByCallId.get(part.id);
    if (result) {
      const content = (result as any).content;
      if (Array.isArray(content)) {
        for (const r of content) {
          const text = r?.text ?? r?.output ?? "";
          if (typeof text === "string" && text.trim()) {
            out.push(truncateOrPad("  ↳ " + firstLine(text), opts.width));
          }
        }
      }
    }
  }
  return out;
}

function extractFirstResultText(result: AgentMessage): string {
  const content = (result as any).content;
  if (!Array.isArray(content)) return "";
  for (const r of content) {
    const text = r?.text ?? r?.output ?? "";
    if (typeof text === "string" && text) return text;
  }
  return "";
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

// Width-aware wrapping/truncation.
//
// IMPORTANT: pi-tui's renderer measures lines with `visibleWidth`, which
// counts a tab (`\t`) as 3 columns and ignores ANSI escape sequences. If we
// wrap by raw `.length` / `.slice` (counting tabs as 1 char and ANSI as
// visible chars), the renderer crashes with
//   "Rendered line N exceeds terminal width (X > Y)"
// when a wrapped/padded line contains tabs or ANSI. Always go through
// pi-tui's helpers below.

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  // wrapTextWithAnsi handles \n, ANSI escapes, tabs (=3 cols), and word
  // boundaries. Every returned line satisfies visibleWidth(line) <= width.
  return wrapTextWithAnsi(text, width);
}

function truncateOrPad(line: string, width: number): string {
  if (visibleWidth(line) <= width) return line;
  return truncateToWidth(line, width, "…", false);
}

function padOrTruncate(left: string, right: string, width: number): string {
  if (!right) {
    return visibleWidth(left) <= width
      ? left
      : truncateToWidth(left, width, "…", false);
  }
  const minSpace = 1;
  const leftW = visibleWidth(left);
  const rightW = visibleWidth(right);
  if (leftW + minSpace + rightW > width) {
    // Right-align right; truncate left if needed.
    const leftBudget = Math.max(0, width - rightW - minSpace);
    const leftCut =
      leftW > leftBudget ? truncateToWidth(left, leftBudget, "…", false) : left;
    const leftCutW = visibleWidth(leftCut);
    const pad = Math.max(minSpace, width - leftCutW - rightW);
    return leftCut + " ".repeat(pad) + right;
  }
  const pad = width - leftW - rightW;
  return left + " ".repeat(pad) + right;
}
