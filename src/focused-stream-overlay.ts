/**
 * pi-conductor — Focused stream overlay component.
 *
 * Thin Component that consumes FocusedStreamModel + transcript renderer to
 * produce the full-screen drilldown view. Keybinding dispatch happens here;
 * actual rendering and state live in their respective pure modules.
 */

import { visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { FocusedStreamModel } from "./focused-stream-model.ts";
import { renderHeader, renderTranscript } from "./transcript.ts";
import { classifyLine } from "./transcript-classify.ts";
import { applyThemeToLines, type ThemeFg } from "./transcript-style.ts";
import type { RunStatus } from "./types.ts";

export interface FocusedStreamOverlayOptions {
  model: FocusedStreamModel;
  onClose: () => void;
  /** Called when the user requests killing the focused agent. */
  onKill: (agentId: string) => void;
  /**
   * Called when the user requests sending a one-shot message to the focused
   * agent (the 's' key). Optional — when omitted, 's' is a no-op.
   */
  onSend?: (agentId: string) => void;
  /** Optional: triggered after every dispatched key so the TUI re-renders. */
  onChange?: () => void;
  /**
   * Slice 7: optional theme used to style the rendered output.
   * When omitted, render() returns plain (unstyled) lines — used by
   * unit tests that assert shape without ANSI. Production passes the
   * host's `Theme` instance via the focused-overlay-factory.
   */
  theme?: ThemeFg;
  /**
   * Slice 8: optional viewport-height source used to compute the
   * scroll-position hint. Pi-tui's Component interface only passes
   * `width` to render(), so the host doesn't tell us how many rows are
   * visible — callers (the focused-overlay-factory in production,
   * tests in unit suites) wire this to `process.stdout.rows` or a stub.
   * When unset (or returning a non-positive number) the scroll hint is
   * suppressed entirely — better silent than wrong.
   */
  getViewportHeight?: () => number;
}

/**
 * Lines of empty whitespace shown when there are no sub-agents to display.
 */
const EMPTY_PLACEHOLDER = [
  "",
  "  no sub-agents to display.",
  "",
  "  Spawn one via ensemble_spawn or /conductor spawn.",
  "",
];

// ── Slice 9: FOOTER_BINDINGS ──────────────────────────────────────────
//
// Single source of truth for both the rendered hint list AND the
// keystroke dispatch table. Adding a binding requires one edit; the
// pure-renderer `transcript.ts:renderFooter` (and its `FOOTER_HINTS`
// const) is gone — the overlay owns its footer entirely.
//
// The action callback receives the overlay instance and the raw input
// `data` so it can distinguish between bindings that share a hint slot
// but dispatch differently (Tab vs Shift-Tab; ↑ vs ↓; PgUp vs PgDn).

/**
 * One footer hint paired with its dispatch action. The same array drives
 * `renderFooterLine` and `handleInput` so they cannot drift.
 */
export interface FooterBinding {
  /** Visible key glyph in the hint (e.g. "Esc", "Tab/Sh-Tab", "↑↓", "c"). */
  keyDisplay: string;
  /** Plain-text label shown after the key glyph (e.g. "close", "cycle"). */
  label: string;
  /**
   * Raw input strings that fire this binding. The first entry is the
   * "primary" match used by tests; additional entries handle aliases
   * (e.g. Esc has both `\x1b` and `\u001b`).
   */
  matches: string[];
  /** Dispatch handler. Receives the overlay (for opts access) and the raw input. */
  action: (overlay: FocusedStreamOverlay, data: string) => void;
}

export const FOOTER_BINDINGS: FooterBinding[] = [
  {
    keyDisplay: "Esc",
    label: "close",
    matches: ["\x1b", "\u001b"],
    action: (o) => o.opts.onClose(),
  },
  {
    keyDisplay: "Tab/Sh-Tab",
    label: "cycle",
    matches: ["\t", "\x1b[Z"],
    action: (o, data) => {
      if (data === "\x1b[Z") o.opts.model.cyclePrev();
      else o.opts.model.cycleNext();
      o.opts.onChange?.();
    },
  },
  {
    keyDisplay: "↑↓",
    label: "scroll",
    // Order matters for tests that dispatch the *first* match — down
    // arrow is observable from a fresh (offset=0) model, where up
    // would clamp to a no-op.
    matches: ["\x1b[B", "\x1b[A", "\x1b[6~", "\x1b[5~"],
    action: (o, data) => {
      if (data === "\x1b[A") o.opts.model.scrollUp(1);
      else if (data === "\x1b[B") o.opts.model.scrollDown(1);
      else if (data === "\x1b[5~") o.opts.model.scrollUp(10);
      else if (data === "\x1b[6~") o.opts.model.scrollDown(10);
      o.opts.onChange?.();
    },
  },
  {
    keyDisplay: "s",
    label: "send",
    matches: ["s"],
    action: (o) => {
      const onSend = o.opts.onSend;
      if (!onSend) return;
      const focused = o.opts.model.focused();
      if (focused) onSend(focused.id);
    },
  },
  {
    keyDisplay: "c",
    label: "collapse",
    matches: ["c"],
    action: (o) => {
      o.opts.model.toggleCollapseToolCalls();
      o.opts.onChange?.();
    },
  },
  {
    keyDisplay: "t",
    label: "thinking",
    matches: ["t"],
    action: (o) => {
      o.opts.model.toggleShowThinking();
      o.opts.onChange?.();
    },
  },
  {
    keyDisplay: "k",
    label: "kill",
    matches: ["k"],
    action: (o) => {
      const focused = o.opts.model.focused();
      if (focused) o.opts.onKill(focused.id);
    },
  },
];

/**
 * Render the overlay footer (top ruler + hint line). Pure helper —
 * `theme` is optional; when omitted, returns plain (ANSI-free) output
 * matching the previous `transcript.ts:renderFooter` shape so unit
 * tests can assert structure without ANSI.
 *
 * Style choice (Slice 9 / O3): each hint renders as `[accent]<key>[/] <label>`.
 * The host's `keyHint` / `keyText` helpers live under
 * `dist/modes/interactive/components/keybinding-hints.js` — internal
 * to pi-coding-agent, not on its public surface — so we mirror their
 * shape with our existing `ThemeFg` interface. The accent slot picks
 * up the theme's brand colour without coupling to host internals.
 */
export function renderFooterLine(
  bindings: FooterBinding[],
  width: number,
  theme?: ThemeFg,
): string[] {
  const ruler = "─".repeat(Math.max(0, width));
  const sep = "  "; // two-space separator (per design O3, replaces " · ")
  let plain = ""; // accumulator for visible-width budgeting
  let styled = ""; // accumulator with ANSI applied (when theme set)
  for (const b of bindings) {
    const piece = `${b.keyDisplay} ${b.label}`;
    const next = plain ? plain + sep + piece : piece;
    if (visibleWidth(next) > width) break;
    plain = next;
    if (theme) {
      const stylePiece = `${theme.fg("accent", b.keyDisplay)} ${b.label}`;
      styled = styled ? styled + sep + stylePiece : stylePiece;
    }
  }
  const hintLine = theme ? styled : plain;
  return [ruler, hintLine];
}

export class FocusedStreamOverlay implements Component {
  constructor(private readonly _opts: FocusedStreamOverlayOptions) {}

  render(width: number): string[] {
    const { model, theme } = this.opts;
    model.refresh();
    const focused = model.focused();
    // Slice 9: footer is built (and styled) here, separately from the
    // body. We thread it through `applyThemeToLines` only when no theme
    // is set — when a theme IS set, `renderFooterLine` already styles
    // the hint line, and re-running it through the classifier would
    // either double-style or fall through as `text` (since the line now
    // starts with ANSI bytes, not "Esc "). Concatenating after avoids
    // both pitfalls.
    const footerLines = renderFooterLine(FOOTER_BINDINGS, width, theme);
    let bodyLines: string[];
    let status: RunStatus | undefined;
    if (!focused) {
      bodyLines = [
        ...renderRulers(width, "─"),
        ...EMPTY_PLACEHOLDER.map((s) => clip(s, width)),
      ];
      status = undefined;
    } else {
      const header = renderHeader(focused, width);
      const transcript = renderTranscript(focused, {
        width,
        collapseToolCalls: model.collapseToolCalls(),
        showThinking: model.showThinking(),
      });

      // Apply scroll offset to the transcript only — header and footer stay pinned.
      const offset = Math.min(model.scrollOffset(), Math.max(0, transcript.length - 1));
      const visibleTranscript = transcript.slice(offset);

      // Slice 8: optional scroll-position hint between body and footer.
      // Suppressed when nothing is hidden either way.
      const viewportHeight = this.opts.getViewportHeight?.() ?? 0;
      const hint = renderScrollHint(offset, transcript.length, viewportHeight);
      const hintLines = hint === null ? [] : [hint];

      bodyLines = [...header, ...visibleTranscript, ...hintLines];
      status = focused.status;
    }

    if (!theme) return [...bodyLines, ...footerLines];
    const themedBody = applyThemeToLines(bodyLines, classifyLine, theme, { status });
    return [...themedBody, ...footerLines];
  }

  invalidate(): void {
    // Stateless beyond what the model holds. Nothing to clear.
  }

  /**
   * Public access to the construction options. Used by `FOOTER_BINDINGS`
   * action callbacks so they can dispatch through the same opts the
   * Component was wired with.
   */
  get opts(): FocusedStreamOverlayOptions {
    return this._opts;
  }

  handleInput(data: string): void {
    // Slice 9: dispatch via FOOTER_BINDINGS — single source of truth.
    // The bindings cover Esc, Tab/Sh-Tab, arrow keys, c, t, s, k. Any
    // input not matched by a binding is a no-op (preserves the prior
    // "unknown keys are no-ops" contract).
    for (const binding of FOOTER_BINDINGS) {
      if (binding.matches.includes(data)) {
        binding.action(this, data);
        return;
      }
    }
  }
}

function renderRulers(width: number, ch: string): string[] {
  return [ch.repeat(Math.max(0, width))];
}

/**
 * Pure helper: produce a one-line scroll-position hint, or `null` when
 * suppressed. Slice 8 of v0.8.3 Item 3 — closes Ctrl+G overlay sub-issue
 * O2 ("`model.scrollOffset()` slices silently…").
 *
 * Shapes:
 *   `↑ N hidden  ·  ↓ M hidden`  (both top-clipped and bottom-clipped)
 *   `↑ N hidden`                  (top-clipped only)
 *   `↓ M hidden`                  (bottom-clipped only)
 *   null                          (nothing scrolled and content fits)
 *
 * Suppression rule: if `viewportHeight <= 0`, suppress — we have no
 * basis to compute what's hidden below. Otherwise, suppress when both
 * `aboveCount` and `belowCount` clamp to zero.
 */
export function renderScrollHint(
  scrollOffset: number,
  transcriptLineCount: number,
  viewportHeight: number,
): string | null {
  if (viewportHeight <= 0) return null;
  const above = Math.max(0, Math.min(scrollOffset, transcriptLineCount));
  const below = Math.max(0, transcriptLineCount - above - viewportHeight);
  if (above === 0 && below === 0) return null;
  if (above > 0 && below > 0) return `↑ ${above} hidden  ·  ↓ ${below} hidden`;
  if (above > 0) return `↑ ${above} hidden`;
  return `↓ ${below} hidden`;
}

function clip(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + "…";
}
