/**
 * pi-conductor — inline notification card.
 *
 * Registered against the `ensemble-notification` custom message type. Pi
 * looks a renderer up by `customType` when it builds a
 * `CustomMessageComponent`; with no renderer registered it falls back to
 * printing a `[ensemble-notification]` label plus the raw message content,
 * which is how the ```xml envelope ended up rendered verbatim in the
 * transcript for every sub-agent completion.
 *
 * Architecture matches `transcript.ts` → `transcript-style.ts`: the
 * renderer here is pure and theme-free (`CardLine[]` of spans), and
 * {@link paintCardLines} is the single place ANSI is introduced. Snapshot
 * assertions therefore stay readable via {@link cardLinesToPlainText}.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import type { EnsembleNotificationDetails } from "./notifications.ts";
import { statusVerb } from "./notifications.ts";
import { STATUS_GLYPH } from "./status-glyph.ts";
import { statusColorSlot, type ThemeFg } from "./transcript-style.ts";

/** One styled run of text inside a card line. */
export interface CardSpan {
  text: string;
  slot?: ThemeColor;
  bold?: boolean;
}

export type CardLine = CardSpan[];

/** `ThemeFg` plus the one style the header needs beyond a colour slot. */
export interface CardTheme extends ThemeFg {
  bold(text: string): string;
}

/**
 * Structural subset of pi-agent-core's `CustomMessage`. The real type is
 * declared in `dist/harness/messages.d.ts` and re-exported from neither
 * package root, so — same call as `ThemeFg` in `transcript-style.ts` — we
 * depend on the shape rather than reach into host internals.
 */
export interface RenderableCustomMessage {
  customType: string;
  content: string | unknown[];
  details?: unknown;
}

export interface CardOpts {
  /** Driven by pi from the global tool-expansion state (ctrl+o). */
  expanded: boolean;
  /** Cap on body lines in the expanded card. */
  maxBodyLines?: number;
}

const DEFAULT_MAX_BODY_LINES = 40;
const INDENT = "  ";
// Hardcoded rather than resolved via the host's `keyText("app.tools.expand")`:
// design D4 (see tests/footer-bindings.test.ts) keeps key labels local
// instead of reaching into pi's interactive-mode internals.
const EXPAND_KEY = "ctrl+o";

/**
 * Lay out a notification card. Collapsed is three lines at most — header,
 * first body line, expand hint — so a burst of background completions
 * can't push the conversation off screen.
 */
export function renderNotificationCard(
  d: EnsembleNotificationDetails,
  opts: CardOpts,
): CardLine[] {
  const lines: CardLine[] = [headerLine(d)];
  const bodyLines = d.body.split("\n").filter((l) => l.trim().length > 0);

  if (opts.expanded) {
    const max = opts.maxBodyLines ?? DEFAULT_MAX_BODY_LINES;
    for (const line of bodyLines.slice(0, max)) {
      lines.push([{ text: INDENT + line, slot: "toolOutput" }]);
    }
    const dropped = bodyLines.length - max;
    if (dropped > 0) {
      lines.push([
        { text: `${INDENT}… ${dropped} more lines — see transcript`, slot: "dim" },
      ]);
    }
  } else if (bodyLines.length > 0) {
    lines.push([{ text: `${INDENT}⎿  ${bodyLines[0]}`, slot: "toolOutput" }]);
    if (bodyLines.length > 1) {
      lines.push([{ text: `${INDENT}${EXPAND_KEY} for the full result`, slot: "dim" }]);
    }
  }

  for (const note of d.notes) {
    lines.push([{ text: INDENT + note.text, slot: note.slot }]);
  }
  if (opts.expanded) {
    lines.push([{ text: `${INDENT}transcript: ${d.transcriptPath}`, slot: "muted" }]);
  }
  return lines;
}

function headerLine(d: EnsembleNotificationDetails): CardLine {
  const stalled = d.kind === "stalled";
  const glyph = stalled
    ? d.severity === "hard" ? "⚠" : "·"
    : STATUS_GLYPH[d.status];
  const slot: ThemeColor = stalled
    ? d.severity === "hard" ? "warning" : "muted"
    : statusColorSlot(d.status);
  const verb = stalled ? `${d.severity}-stalled` : statusVerb(d.status);

  const line: CardLine = [
    { text: glyph, slot },
    { text: " " },
    { text: d.persona, bold: true },
    { text: ` ${verb}`, slot: "dim" },
  ];
  if (d.stats.length > 0) {
    line.push({ text: ` · ${d.stats.join(" · ")}`, slot: "dim" });
  }
  return line;
}

/** Flatten to unstyled text. Used by tests and by any non-TUI surface. */
export function cardLinesToPlainText(lines: CardLine[]): string {
  return lines.map((line) => line.map((span) => span.text).join("")).join("\n");
}

/** Introduce ANSI. The only styling step; pure given a theme. */
export function paintCardLines(lines: CardLine[], theme: CardTheme): string {
  return lines
    .map((line) =>
      line
        .map((span) => {
          const styled = span.bold ? theme.bold(span.text) : span.text;
          return span.slot ? theme.fg(span.slot, styled) : styled;
        })
        .join(""),
    )
    .join("\n");
}

/**
 * The `pi.registerMessageRenderer` callback.
 *
 * Returns `undefined` when `details` is missing so pi's
 * `CustomMessageComponent` takes its `if (component)` fallback branch and
 * prints the raw envelope. That is the degrade path for sessions recorded
 * before `details` existed — worse-looking, but never a crash and never a
 * dropped notification.
 */
export function notificationRenderer(
  message: RenderableCustomMessage,
  opts: { expanded: boolean; outputPad: number },
  theme: CardTheme,
): Component | undefined {
  const details = message.details as EnsembleNotificationDetails | undefined;
  if (!details?.kind) return undefined;
  const lines = renderNotificationCard(details, { expanded: opts.expanded });
  return new Text(paintCardLines(lines, theme), opts.outputPad, 0);
}

/** Wire the renderer up. Called from the extension factory, not lazily. */
export function registerNotificationRenderer(pi: {
  registerMessageRenderer: (
    customType: string,
    renderer: (
      message: RenderableCustomMessage,
      opts: { expanded: boolean; outputPad: number },
      theme: CardTheme,
    ) => Component | undefined,
  ) => void;
}): void {
  pi.registerMessageRenderer("ensemble-notification", notificationRenderer);
}
