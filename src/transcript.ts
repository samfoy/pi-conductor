/**
 * Pure transcript renderer for the focused-stream overlay.
 *
 * Takes a Run and a set of view options, returns a string[] (one entry per
 * rendered line, each line constrained to `width` columns). No TUI imports,
 * no theme dependency, no I/O — the Component layer is responsible for
 * styling and rendering this output.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Run } from "./types.ts";
import { elapsedStr, formatUsage } from "./runs.ts";

export interface TranscriptOptions {
  /** Hard wrap width; lines that exceed it are wrapped or truncated. */
  width: number;
  /** When true, toolCall parts collapse to a single chevron line. */
  collapseToolCalls: boolean;
  /** When true, thinking parts are shown; otherwise hidden. */
  showThinking: boolean;
}

const STATUS_GLYPH: Record<Run["status"], string> = {
  queued: "◌",
  running: "●",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  killed: "■",
  timeout: "⏱",
};

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

function renderToolCall(
  part: { id?: string; name: string; arguments?: Record<string, any> },
  resultsByCallId: Map<string, AgentMessage>,
  opts: TranscriptOptions,
): string[] {
  const name = part.name ?? "tool";
  if (opts.collapseToolCalls) {
    const summary = summarizeArgs(name, part.arguments ?? {});
    const line = `▸ ${name}${summary ? " " + summary : ""}`;
    return [truncateOrPad(line, opts.width)];
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

function summarizeArgs(name: string, args: Record<string, any>): string {
  switch (name) {
    case "bash":
      return shorten(String(args.command ?? ""), 50);
    case "read":
    case "write":
    case "edit":
      return shorten(String(args.file_path ?? args.path ?? ""), 50);
    case "grep":
      return shorten(String(args.pattern ?? ""), 50);
    default: {
      // Compact key=value list.
      const pairs: string[] = [];
      for (const [k, v] of Object.entries(args)) {
        const repr = typeof v === "string" ? v : JSON.stringify(v);
        pairs.push(`${k}=${shorten(repr, 30)}`);
      }
      return shorten(pairs.join(" "), 50);
    }
  }
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function firstLine(s: string): string {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length <= width) {
      out.push(para);
      continue;
    }
    let i = 0;
    while (i < para.length) {
      // Break on a space if available within the last 20 chars; otherwise hard split.
      const end = Math.min(i + width, para.length);
      let cut = end;
      if (end < para.length) {
        const slice = para.slice(i, end);
        const lastSpace = slice.lastIndexOf(" ");
        if (lastSpace >= width - 20) cut = i + lastSpace;
      }
      const segment = para.slice(i, cut);
      out.push(segment);
      i = cut + (cut < para.length && para[cut] === " " ? 1 : 0);
    }
  }
  return out;
}

function truncateOrPad(line: string, width: number): string {
  if (line.length <= width) return line;
  return line.slice(0, Math.max(0, width - 1)) + "…";
}

function padOrTruncate(left: string, right: string, width: number): string {
  if (!right) {
    return left.length <= width ? left : left.slice(0, Math.max(0, width - 1)) + "…";
  }
  const minSpace = 1;
  if (left.length + minSpace + right.length > width) {
    // Right-align right; truncate left if needed.
    const leftBudget = Math.max(0, width - right.length - minSpace);
    const leftCut = left.length > leftBudget ? left.slice(0, Math.max(0, leftBudget - 1)) + "…" : left;
    const pad = Math.max(minSpace, width - leftCut.length - right.length);
    return leftCut + " ".repeat(pad) + right;
  }
  const pad = width - left.length - right.length;
  return left + " ".repeat(pad) + right;
}
