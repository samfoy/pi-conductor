/**
 * pi-conductor — Focused stream overlay component.
 *
 * Thin Component that consumes FocusedStreamModel + transcript renderer to
 * produce the full-screen drilldown view. Keybinding dispatch happens here;
 * actual rendering and state live in their respective pure modules.
 */

import type { Component } from "@mariozechner/pi-tui";
import type { FocusedStreamModel } from "./focused-stream-model.ts";
import { renderHeader, renderFooter, renderTranscript } from "./transcript.ts";

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
    const { model } = this.opts;
    model.refresh();
    const focused = model.focused();
    if (!focused) {
      return [
        ...renderRulers(width, "─"),
        ...EMPTY_PLACEHOLDER.map((s) => clip(s, width)),
        ...renderFooter(width),
      ];
    }

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
    return [...header, ...visibleTranscript, ...footer];
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

function clip(s: string, width: number): string {
  if (s.length <= width) return s;
  return s.slice(0, Math.max(0, width - 1)) + "…";
}
