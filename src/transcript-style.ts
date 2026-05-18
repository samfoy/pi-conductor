/**
 * Component-layer styling for transcript output.
 *
 * Slice 7 of v0.8.3 Item 3 — the architectural fork landing point. The
 * pure renderers in `transcript.ts` and `foreground-stream.ts` emit
 * plain (monochrome) string[]; this module is where ANSI is introduced.
 *
 * Strategy (Option A from `docs/v0.8.3-item3-design.md` §3): pure
 * renderer → `classifyLine()` → `applyTheme()`. The theme is consumed
 * by the Component layer (focused-stream-overlay, foreground stream's
 * tool-card) which calls `applyThemeToLines()` over the rendered
 * `string[]`. The pure renderers themselves stay theme-free and their
 * snapshot tests stay ANSI-free.
 *
 * Spike outcome: pi-coding-agent's `Theme` class (modes/interactive/
 * theme/theme.d.ts) is a class with private state, so tests can't
 * construct one. We bypass that with a structural `ThemeFg` interface
 * that `Theme` satisfies and a sentinel-stub fake that wraps a slot
 * marker around the input. Everything in this module depends only on
 * the structural subset; both real and stub themes work without
 * adapters.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ClassifiedLine } from "./transcript-classify.ts";
import type { RunStatus } from "./types.ts";

/**
 * Structural subset of pi-coding-agent's `Theme` class — the only piece
 * Slice 7 needs. The real `Theme` satisfies this; tests can pass a
 * sentinel-stub fake `{ fg: (slot, text) => `[${slot}]${text}[/]` }`.
 */
export interface ThemeFg {
  fg(color: ThemeColor, text: string): string;
}

/**
 * Map a run status to the theme slot used for its header glyph and
 * prose. Mirrors the design in docs/v0.8.3-item3-design.md §6 row O5
 * and the existing widget.ts statusColorSlot precedent.
 */
export function statusColorSlot(status: RunStatus): ThemeColor {
  switch (status) {
    case "running":
      return "accent";
    case "completed":
      return "success";
    case "failed":
    case "killed":
    case "timeout":
      return "error";
    case "paused":
      return "warning";
    case "queued":
      return "muted";
  }
}

export interface ApplyThemeOpts {
  /**
   * Run status used to colour header lines. When omitted, headers fall
   * back to `accent` (the live-running slot). Lines of kinds other than
   * `header` ignore this field.
   */
  status?: RunStatus;
}

/**
 * Apply ANSI styling to a single line based on its classified kind.
 *
 * Pure: same `(line, classified, theme, opts)` → same output. No I/O,
 * no module-scope state.
 *
 * Mapping (matches docs/v0.8.3-item3-design.md §3 + §6):
 *   header   → status-derived slot (running=accent, completed=success,
 *              failed/killed/timeout=error, paused=warning, queued=muted)
 *   ruler    → borderMuted
 *   tool     → first 2 chars (chevron + space) coloured `accent`,
 *              rest plain so summary text stays readable
 *   outcome  → ✓ → success, ✗ → error, default (… pending) → dim
 *   thinking → dim (the leading `· ` summary marker and `┃` body gutter
 *              both read as the same low-intensity colour)
 *   scrollHint→ dim
 *   turnSep  → dim
 *   footer   → dim (Slice 9 will further split key vs label)
 *   text     → unchanged
 */
export function applyTheme(
  line: string,
  classified: ClassifiedLine,
  theme: ThemeFg,
  opts: ApplyThemeOpts = {},
): string {
  switch (classified.kind) {
    case "header": {
      const slot = opts.status ? statusColorSlot(opts.status) : "accent";
      return theme.fg(slot, line);
    }
    case "ruler":
      return theme.fg("borderMuted", line);
    case "tool": {
      // Colour the leading chevron + space; leave the rest plain so
      // summarised arguments don't compete with the chevron for
      // attention. Slice 9 may further colour the tool name itself.
      if (line.length < 2) return theme.fg("accent", line);
      const head = line.slice(0, 2);
      const tail = line.slice(2);
      return theme.fg("accent", head) + tail;
    }
    case "outcome": {
      // Pattern-match the outcome glyph from the line so we don't need
      // to thread a separate flag through the classifier. The renderer
      // emits exactly three shapes:
      //   " ↳ ✓ <preview>" or " ↳ ✓"
      //   " ↳ ✗ <preview>" or " ↳ ✗"
      //   " ↳ …"           (pending)
      if (line.includes("↳ ✓")) return theme.fg("success", line);
      if (line.includes("↳ ✗")) return theme.fg("error", line);
      return theme.fg("dim", line);
    }
    case "thinking":
      return theme.fg("dim", line);
    case "scrollHint":
      return theme.fg("dim", line);
    case "turnSep":
      return theme.fg("dim", line);
    case "footer":
      return theme.fg("dim", line);
    case "text":
      return line;
  }
}

/**
 * Convenience helper: apply `applyTheme` over an entire rendered
 * `string[]`, classifying each line. The Component-layer call sites
 * (focused-stream-overlay.render, renderForegroundStream) compose this
 * after the pure renderers.
 *
 * `classify` is parameterised so call sites can inject a fake (e.g. for
 * tests) without dragging the classifier in. In production it is
 * `classifyLine` from `./transcript-classify.ts`.
 */
export function applyThemeToLines(
  lines: readonly string[],
  classify: (line: string) => ClassifiedLine,
  theme: ThemeFg,
  opts: ApplyThemeOpts = {},
): string[] {
  return lines.map((line) => applyTheme(line, classify(line), theme, opts));
}
