/**
 * Pure renderers for the v0.4 inline-streamed foreground spawn.
 *
 * `renderForegroundStream(run, width)` returns the multi-line text that
 * pi displays in the parent's tool-call card while a foreground sub-agent
 * is running. Composition: header (persona, id, status, elapsed, usage)
 * + transcript body (turn-separated assistant prose with collapsed tool
 * calls). Reuses `renderHeader` and `renderTranscript` from the focused-
 * stream overlay, so the streamed view matches what the user sees in
 * Ctrl+G.
 *
 * `renderForegroundSummary(run)` is the compact post-completion summary
 * (status glyph, persona:id, elapsed, usage, optional excerpt of the
 * final assistant text, transcript path). Replaces the full-transcript
 * dump that v0.3 used as a tool result; the streamed view above
 * remains visible in the tool-call card.
 *
 * Both helpers are pure (no I/O, no TUI).
 */

import { elapsedStr, formatUsage, getFinalText } from "./runs.ts";
import { renderHeader, renderTranscript } from "./transcript.ts";
import type { Run } from "./types.ts";

const STATUS_GLYPH: Record<Run["status"], string> = {
  queued: "◌",
  running: "●",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  killed: "■",
  timeout: "⏱",
};

/** Maximum characters in the final-text excerpt of the summary. */
const SUMMARY_EXCERPT_MAX = 120;

/**
 * Maximum bytes in the streamed transcript output. pi's tool-call cards
 * re-render the entire text on every onUpdate; sending a 200KB transcript
 * 10x/sec would melt the TUI. We truncate to the tail when the run
 * outgrows this limit.
 */
const STREAM_MAX_BYTES = 32 * 1024;

/**
 * Render the inline-streamed transcript shown in the parent's tool-call
 * card while a foreground sub-agent is running. Always shows the header;
 * the transcript body is appended only when there are messages to render.
 */
export function renderForegroundStream(run: Run, width: number): string {
  const headerLines = renderHeader(run, width);
  const bodyLines = renderTranscript(run, {
    width,
    collapseToolCalls: true,
    showThinking: false,
  });
  const lines = bodyLines.length === 0 ? headerLines : [...headerLines, ...bodyLines];
  const out = lines.join("\n");
  if (out.length <= STREAM_MAX_BYTES) return out;
  // Tail-truncate so the most recent activity stays visible.
  const tail = out.slice(out.length - STREAM_MAX_BYTES);
  return `… (transcript truncated to last ${STREAM_MAX_BYTES} bytes) …\n${tail}`;
}

/**
 * Render the compact post-completion summary. ~3 lines:
 *   ✓ persona:id completed in 14s [3t ↑1.2k ↓800 $0.012]
 *     → "first 120 chars of final assistant text…"
 *     Transcript: /path/to/transcript.jsonl
 *
 * Failure variants substitute the error message (or stop reason) for the
 * excerpt and use the appropriate status glyph.
 */
export function renderForegroundSummary(run: Run): string {
  const glyph = STATUS_GLYPH[run.status] ?? "·";
  const verb =
    run.status === "completed" ? "completed" :
    run.status === "killed" ? "killed" :
    run.status === "timeout" ? "timed out" : run.status;
  const elapsed = elapsedStr(run.startTime, run.finishedAt);
  const usage = formatUsage(run.usage);
  const usagePart = usage ? ` [${usage}]` : "";
  const lines: string[] = [];

  lines.push(`${glyph} ${run.persona}:${run.id} ${verb} in ${elapsed}${usagePart}`);

  if (run.status === "completed") {
    const final = getFinalText(run.messages);
    if (final) {
      lines.push(`  → "${truncate(collapseWhitespace(final), SUMMARY_EXCERPT_MAX)}"`);
    }
  } else if (run.errorMessage) {
    lines.push(`  → ${truncate(collapseWhitespace(run.errorMessage), SUMMARY_EXCERPT_MAX)}`);
  }

  if (run.transcriptPath) {
    lines.push(`  Transcript: ${run.transcriptPath}`);
  }

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
