/**
 * pi-conductor — Focused stream overlay component.
 *
 * Thin Component that consumes FocusedStreamModel + transcript renderer to
 * produce the full-screen drilldown view. Keybinding dispatch happens here;
 * actual rendering and state live in their respective pure modules.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { FocusedStreamModel } from "./focused-stream-model.ts";
import { renderHeader, renderFooter, renderTranscript } from "./transcript.ts";
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

export class FocusedStreamOverlay implements Component {
  constructor(private opts: FocusedStreamOverlayOptions) {}

  render(width: number): string[] {
    const { model, theme } = this.opts;
    model.refresh();
    const focused = model.focused();
    let lines: string[];
    let status: RunStatus | undefined;
    if (!focused) {
      lines = [
        ...renderRulers(width, "─"),
        ...EMPTY_PLACEHOLDER.map((s) => clip(s, width)),
        ...renderFooter(width),
      ];
      status = undefined;
    } else {
      const header = renderHeader(focused, width);
      const transcript = renderTranscript(focused, {
        width,
        collapseToolCalls: model.collapseToolCalls(),
        showThinking: model.showThinking(),
      });
      const footer = renderFooter(width);

      // Apply scroll offset to the transcript only — header and footer stay pinned.
      const offset = Math.min(model.scrollOffset(), Math.max(0, transcript.length - 1));
      const visibleTranscript = transcript.slice(offset);

      // Slice 8: optional scroll-position hint between body and footer.
      // Suppressed when nothing is hidden either way.
      const viewportHeight = this.opts.getViewportHeight?.() ?? 0;
      const hint = renderScrollHint(offset, transcript.length, viewportHeight);
      const hintLines = hint === null ? [] : [hint];

      lines = [...header, ...visibleTranscript, ...hintLines, ...footer];
      status = focused.status;
    }

    if (!theme) return lines;
    return applyThemeToLines(lines, classifyLine, theme, { status });
  }

  invalidate(): void {
    // Stateless beyond what the model holds. Nothing to clear.
  }

  handleInput(data: string): void {
    const { model, onClose, onKill, onSend, onChange } = this.opts;

    // Esc — close.
    if (data === "\x1b" || data === "\u001b") {
      onClose();
      return;
    }

    // Arrow keys.
    if (data === "\x1b[A") {
      model.scrollUp(1);
      onChange?.();
      return;
    }
    if (data === "\x1b[B") {
      model.scrollDown(1);
      onChange?.();
      return;
    }
    if (data === "\x1b[5~") {
      model.scrollUp(10);
      onChange?.();
      return;
    }
    if (data === "\x1b[6~") {
      model.scrollDown(10);
      onChange?.();
      return;
    }

    // Tab / Shift+Tab.
    if (data === "\t") {
      model.cycleNext();
      onChange?.();
      return;
    }
    if (data === "\x1b[Z") {
      model.cyclePrev();
      onChange?.();
      return;
    }

    // Single-letter keys.
    switch (data) {
      case "c":
        model.toggleCollapseToolCalls();
        onChange?.();
        return;
      case "t":
        model.toggleShowThinking();
        onChange?.();
        return;
      case "k": {
        const focused = model.focused();
        if (focused) onKill(focused.id);
        return;
      }
      case "s": {
        if (!onSend) return;
        const focused = model.focused();
        if (focused) onSend(focused.id);
        return;
      }
      default:
        return;
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
