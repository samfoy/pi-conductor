/**
 * Per-status glyph used by the transcript renderer, the foreground stream
 * card, and the ensemble panel widget. The widget wraps each glyph with
 * `theme.fg(...)` for color; the other two surfaces emit the plain char.
 *
 * Single source of truth: a regression here ripples to every rendered run
 * header, so changes need a deliberate test update in
 * `tests/status-glyph.test.ts`.
 */

import type { RunStatus } from "./types.ts";

export const STATUS_GLYPH: Record<RunStatus, string> = {
  queued: "◌",
  running: "●",
  paused: "⏸",
  completed: "✓",
  failed: "✗",
  killed: "■",
  timeout: "⏱",
  hook_failed: "⊗",
};
