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

import { elapsedStr, formatUsage, getFinalText, type RunRegistry } from "./runs.ts";
import { renderHeader, renderTranscript } from "./transcript.ts";
import { isTerminal, type Run } from "./types.ts";
import { STATUS_GLYPH } from "./status-glyph.ts";
import { classifyLine } from "./transcript-classify.ts";
import { applyThemeToLines, type ThemeFg } from "./transcript-style.ts";

/**
 * Count toolResult messages in a Run. Used by the foreground throttle
 * call-sites to decide whether to bypass the debounce window: when this
 * number grows between registry updates a new tool result has landed, and
 * we want the ↳ ✓/✗ outcome glyph visible immediately rather than
 * waiting up to FOREGROUND_STREAM_INTERVAL_MS for the trailing edge
 * (oracle §7 throttle interaction).
 */
export function countToolResultMessages(run: Run): number {
  let n = 0;
  for (const m of run.messages) {
    if ((m as any).role === "toolResult") n += 1;
  }
  return n;
}

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
 *
 * Slice 7: when `theme` is provided, the rendered lines are post-processed
 * via `applyThemeToLines` before joining — the parent's tool-card slot
 * surfaces ANSI fine. When omitted (headless tests, snapshot fixtures),
 * plain output is returned so existing assertions stay readable.
 */
export function renderForegroundStream(
  run: Run,
  width: number,
  theme?: ThemeFg,
): string {
  const headerLines = renderHeader(run, width);
  const bodyLines = renderTranscript(run, {
    width,
    collapseToolCalls: true,
    showThinking: false,
  });
  const merged = bodyLines.length === 0 ? headerLines : [...headerLines, ...bodyLines];
  const lines = theme
    ? applyThemeToLines(merged, classifyLine, theme, { status: run.status })
    : merged;
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
  // Item 15: per-send numbers in the brackets; optional ` · lifetime
  // <duration> $<cost>` suffix when the run has been resumed at least
  // once. Initial-spawn runs have resumeCount undefined or 0, in
  // which case per-send IS the lifetime.
  const perSendStart = run.thisInvocationStartedAt ?? run.startTime;
  const baseline = run.thisInvocationUsageBaseline ?? {
    turns: 0,
    input: 0,
    output: 0,
    cost: 0,
  };
  const elapsed = elapsedStr(perSendStart, run.finishedAt);
  const perSendUsage = {
    turns: Math.max(0, run.usage.turns - baseline.turns),
    input: Math.max(0, run.usage.input - baseline.input),
    output: Math.max(0, run.usage.output - baseline.output),
    cost: Math.max(0, run.usage.cost - baseline.cost),
  };
  const usage = formatUsage(perSendUsage);
  const usagePart = usage ? ` [${usage}]` : "";
  const lines: string[] = [];

  let headline = `${glyph} ${run.persona}:${run.id} ${verb} in ${elapsed}${usagePart}`;
  if ((run.resumeCount ?? 0) >= 1) {
    const lifetimeElapsed = elapsedStr(run.startTime, run.finishedAt);
    const lifetimeCost = run.usage.cost ? ` $${run.usage.cost.toFixed(3)}` : "";
    headline += ` · lifetime ${lifetimeElapsed}${lifetimeCost}`;
  }
  lines.push(headline);

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

// ── Stream width resolution ──────────────────────────────────────

/** Default width for headless contexts (RPC, CI, missing TTY). */
export const STREAM_DEFAULT_WIDTH = 100;
/** Below this, the streamed transcript becomes unreadable. */
export const STREAM_MIN_WIDTH = 40;
/** Above this, extra columns waste pi's tool-card render budget. */
export const STREAM_MAX_WIDTH = 240;

/**
 * Pick the rendering width for renderForegroundStream. Prefers the live
 * terminal columns (typically `process.stdout.columns`) clamped to
 * [STREAM_MIN_WIDTH, STREAM_MAX_WIDTH]. Falls back to STREAM_DEFAULT_WIDTH
 * for headless / unknown contexts.
 */
export function resolveStreamWidth(cols: number | undefined | null): number {
  if (typeof cols !== "number" || !Number.isFinite(cols) || cols <= 0) {
    return STREAM_DEFAULT_WIDTH;
  }
  if (cols < STREAM_MIN_WIDTH) return STREAM_MIN_WIDTH;
  if (cols > STREAM_MAX_WIDTH) return STREAM_MAX_WIDTH;
  return Math.floor(cols);
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
  /**
   * Fire `payload` synchronously regardless of leading-edge state. Cancels
   * any pending trailing fire so the throttle window restarts cleanly. Used
   * by callers that detected a high-priority event (e.g. a tool result) and
   * want it visible without waiting out the debounce window. Idempotent vs
   * dispose.
   */
  pushImmediate(payload: T): void;
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
    pushImmediate(payload: T) {
      if (disposed) return;
      // fireNow clears pending + cancels any scheduled trailing timer.
      fireNow(payload);
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

// ── Post-detach completion listener ───────────────────────────────

/**
 * Wires the registry-onChange listener responsible for pushing the
 * standard <sub-agent-completed> notification card after Esc-to-detach.
 *
 * Behavior:
 *   - Subscribes to registry changes filtered by run.id; on terminal
 *     status flip, fires `pushNotification(run)` and unsubs.
 *   - Race-guard: if the run is ALREADY terminal at install time, fires
 *     the notification synchronously and unsubs immediately. This handles
 *     the microtask window where awaitOrDetach picked detach but the run
 *     reached terminal between the race resolving and the listener
 *     installing — registry.notify() already fired with no listener
 *     attached, so without this guard the notification would be lost.
 *
 * Returns the unsubscribe function so the caller can tear down early
 * (e.g. on session shutdown).
 */
export function installPostDetachCompletionListener(
  run: Run,
  registry: RunRegistry,
  pushNotification: (run: Run) => void,
): () => void {
  let active = true;
  const unsub = registry.onChange((r) => {
    if (!active) return;
    if (r.id !== run.id) return;
    if (!isTerminal(r.status)) return;
    active = false;
    unsub();
    pushNotification(r);
  });
  // Race-guard: synchronous re-check after registering. If the run
  // already reached terminal in the microtask window between the
  // detach race resolving and this function running, notify() has
  // already fired with no listener attached — fire it now.
  if (active && isTerminal(run.status)) {
    active = false;
    unsub();
    pushNotification(run);
  }
  return () => {
    if (!active) return;
    active = false;
    unsub();
  };
}
