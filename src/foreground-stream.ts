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
 * Maximum characters in the streamed transcript output. pi's tool-call
 * cards re-render the entire text on every onUpdate; sending a 200KB
 * transcript many times per second would melt the TUI. We tail-truncate
 * when the run outgrows this limit. Note: "chars" here is JS
 * String.length (UTF-16 code units), not bytes — ASCII transcripts cap
 * at ~32KB, denser scripts can be wider.
 */
const STREAM_MAX_CHARS = 32 * 1024;

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
  if (out.length <= STREAM_MAX_CHARS) return out;
  // Tail-truncate so the most recent activity stays visible. Slice on a
  // newline boundary when possible to avoid splitting a mid-line surrogate
  // pair or a partial ANSI sequence.
  let cut = out.length - STREAM_MAX_CHARS;
  const nextNewline = out.indexOf("\n", cut);
  if (nextNewline !== -1 && nextNewline - cut < 1024) cut = nextNewline + 1;
  const tail = out.slice(cut);
  return `… (transcript truncated to last ~${STREAM_MAX_CHARS} chars) …\n${tail}`;
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

// ── Detach helpers (Esc-to-detach UX) ───────────────────────────────────

export type DetachOutcome<T> =
  | { kind: "completed"; value: T }
  | { kind: "detached" };

/**
 * Race a "done" promise against a detach signal. Returns whichever
 * settles first as a tagged outcome. The detach promise resolves with
 * void; the done promise's value is surfaced verbatim on "completed".
 */
export async function awaitOrDetach<T>(
  done: Promise<T>,
  detach: Promise<void>,
): Promise<DetachOutcome<T>> {
  return Promise.race([
    done.then((value): DetachOutcome<T> => ({ kind: "completed", value })),
    detach.then((): DetachOutcome<T> => ({ kind: "detached" })),
  ]);
}

/**
 * Format the tool result returned to the LLM when the user detaches a
 * foreground spawn. Mirrors the shape of the queued-as-background path:
 * the sub-agent is still running, and completion will arrive as a
 * <sub-agent-completed> notification card.
 */
export function renderForegroundDetachedResult(run: Run) {
  const text =
    `detached-as-background: ${run.id}\n` +
    `persona=${run.persona} mode=background (was foreground)\n\n` +
    `Foreground stream detached on user request. The sub-agent continues running in the background; ` +
    `completion will arrive as a <sub-agent-completed> notification. Do NOT re-spawn.`;
  return {
    content: [{ type: "text" as const, text }],
    details: {
      status: "detached-as-background",
      agent_id: run.id,
      persona: run.persona,
      mode: "background" as const,
    },
  };
}

// ── Update throttle ───────────────────────────────────────────────────

export interface UpdateThrottleOpts {
  /** Minimum ms between deliveries to the underlying callback. */
  intervalMs: number;
}

export interface UpdateThrottle<T> {
  /** Push the latest payload. May fire immediately or be coalesced. */
  push(payload: T): void;
  /** Force any pending payload through right now. Idempotent. */
  flush(): void;
  /** Cancel any pending fire and reject further pushes. Idempotent. */
  dispose(): void;
}

/**
 * Leading-edge + trailing-edge debouncer. The first push in an idle window
 * fires synchronously; subsequent pushes within `intervalMs` are coalesced
 * into a single trailing fire carrying the latest payload.
 *
 * Used by the foreground spawn to bound the parent tool-call card
 * re-render rate. Terminal updates should call flush() to guarantee the
 * final transcript is visible before the card collapses.
 */
export function createUpdateThrottle<T>(
  fire: (payload: T) => void,
  opts: UpdateThrottleOpts,
): UpdateThrottle<T> {
  const interval = Math.max(0, opts.intervalMs);
  let lastFireAt = -Infinity;
  let pending: { payload: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const fireNow = (payload: T) => {
    lastFireAt = Date.now();
    pending = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fire(payload);
  };

  const scheduleTrailing = () => {
    if (timer) return;
    const wait = Math.max(0, interval - (Date.now() - lastFireAt));
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      const p = pending;
      pending = null;
      if (p) fireNow(p.payload);
    }, wait);
  };

  return {
    push(payload: T) {
      if (disposed) return;
      const now = Date.now();
      if (now - lastFireAt >= interval) {
        fireNow(payload);
        return;
      }
      pending = { payload };
      scheduleTrailing();
    },
    flush() {
      if (disposed) return;
      if (!pending) return;
      const p = pending;
      fireNow(p.payload);
    },
    dispose() {
      disposed = true;
      pending = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
