/**
 * pi-conductor — Focused stream overlay component.
 *
 * Slice 6 (overlay redesign) rewrite. The component is now a
 * Container-composed three-zone modal:
 *
 *   ╭─...─╮   ← top border (HEADER_ROWS=4, row 0)
 *   │ ... │   ← status line (row 1)
 *   ├─...─┤   ← mid rule (row 2)
 *   │ ... │   ← optional spare (row 3)
 *   │ ... │   ← body row 0 (BodyZone)
 *     ...
 *   │ ... │   ← body row N-1 (last; breadcrumb when clipped)
 *   ├─...─┤   ← footer mid-rule (FOOTER_ROWS=3)
 *   │ ... │   ← hint line
 *   ╰─...─╯   ← bottom border
 *
 * Borders are drawn as `Text`-style rows (we use plain string output
 * since pi-tui's `Box` is padding+bg only — no border prop). The root
 * is a `Container` with three child zones; each zone is a thin
 * `StaticLinesZone` whose render(width) just returns its currently-
 * cached lines. The FocusedStreamOverlay's render() builds the lines,
 * pushes them onto the zones, and returns `root.render(width)`.
 *
 * Render-purity contract (design §10): the only mutation surface is
 * `_renderCache` (and the zone backings). The cache is written
 * EXCLUSIVELY inside `render()` and cleared EXCLUSIVELY inside
 * `invalidate()`. `getTranscriptLength()` reads from the cache.
 * Slice 4's grandfathered `_lastTranscriptLength` is gone — the
 * cache subsumes it.
 *
 * Existing pure modules (`transcript.ts`, `transcript-classify.ts`,
 * `transcript-style.ts`) are reused VERBATIM. Per design §2 / §12.
 */

import {
  Container,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
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
   * Optional theme used to style the rendered output. When omitted,
   * render() returns plain (unstyled) lines — used by unit tests that
   * assert shape without ANSI. Production passes the host's `Theme`
   * instance via the focused-overlay-factory.
   */
  theme?: ThemeFg;
  /**
   * Viewport-height source. Pi-tui's Component interface only passes
   * `width` to render(), so the host doesn't tell us how many rows
   * are visible — callers wire this to `tui.terminal.rows` (or a
   * stub in tests). When unset (or returning a non-positive number)
   * the overlay falls back to a 24-row default.
   *
   * Slice 6: viewport now drives the bordered chrome's row budget
   * (HEADER + body + FOOTER = viewport).
   */
  getViewportHeight?: () => number;
}

// ── Chrome geometry ──────────────────────────────────────────────────

/** Header rows: top border, status, mid rule, spare. */
export const HEADER_ROWS = 4;
/** Footer rows: mid rule, hint, bottom border. */
export const FOOTER_ROWS = 3;
/**
 * Inner-content width inset. Each side row is `│ <inner> │` — two
 * border chars plus one space of inner padding on each side, so the
 * inner content area is `width - BORDER_INSET` wide.
 */
const BORDER_INSET = 4;
/** Default viewport (rows) when `getViewportHeight` is unset. */
const DEFAULT_VIEWPORT_ROWS = 24;

// Box-drawing glyphs.
const TL = "╭";
const TR = "╮";
const BL = "╰";
const BR = "╯";
const ML = "├";
const MR = "┤";
const HORIZ = "─";
const VERT = "│";

// ── Empty state ──────────────────────────────────────────────────────

const EMPTY_HEADING = "(no sub-agents running)";
const EMPTY_PROSE = "Spawn one via ensemble_spawn or /conductor spawn.";

/**
 * Render the empty-state body lines (no focused run). Keeps the
 * v0.8.3 polish: muted heading + dim prose, top-padded so the message
 * lands roughly mid-body. Output is NOT side-wall-wrapped — the
 * caller wraps each line via `sideRow`. Expected to be passed
 * `bodyRows` (= viewport - HEADER_ROWS - FOOTER_ROWS) as
 * viewportHeight; budget math centres heading inside the body zone.
 *
 * Body proper is 3 lines (heading + blank + prose). Top padding
 * eats `viewportHeight - 3` rows, halved for centring (clamped ≥1).
 * Output length: max(4, viewportHeight). Caller responsible for
 * truncation if the body zone is smaller.
 */
export function renderEmpty(
  width: number,
  viewportHeight: number,
  theme?: ThemeFg,
): string[] {
  const heading = theme ? theme.fg("muted", clip(EMPTY_HEADING, width)) : clip(EMPTY_HEADING, width);
  const prose = theme ? theme.fg("dim", clip(EMPTY_PROSE, width)) : clip(EMPTY_PROSE, width);
  const contentRows = 3; // heading + blank + prose
  const extraSlack = Math.max(0, viewportHeight - contentRows);
  const topPad = viewportHeight > 0 ? Math.max(1, Math.floor(extraSlack / 2)) : 1;
  const out: string[] = [];
  for (let i = 0; i < topPad; i++) out.push("");
  out.push(heading);
  out.push("");
  out.push(prose);
  return out;
}

// ── Footer bindings (single source of truth) ─────────────────────────
//
// The footer row pairs each binding with a hint slot. handleInput
// dispatches input through the same array so the hint line and the
// dispatch table cannot drift.

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
    keyDisplay: "Home/End",
    label: "top/tail",
    matches: ["\x1b[H", "\x1b[F", "g", "G"],
    action: (o, data) => {
      if (data === "\x1b[H" || data === "g") o.opts.model.jumpToHome();
      else o.opts.model.jumpToTail();
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
    // Slice 5 (overlay redesign): fold expand/collapse for tool-call
    // JSON walls and thinking bodies. Lowercase = additive (expand);
    // uppercase = destructive (collapse). OPPOSITE to vim/less
    // convention; design §11 chose lowercase=expand because the more
    // aggressive action gets the shifted key.
    //
    // Slice 6 fold-in: footer hint label restored to the plan's
    // verbatim wording (`e:expand all  E:collapse all`) so the
    // fold-marker line's `(e expand all · E collapse all)` hint
    // matches the footer hint.
    keyDisplay: "e/E",
    label: "expand all/collapse all",
    matches: ["e", "E"],
    action: (o, data) => {
      if (data === "e") o.opts.model.expandAll();
      else o.opts.model.collapseAll();
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
 * Render the overlay footer hint line at `width`. Returns a single
 * string (the line). Pure helper — `theme` is optional; when set,
 * each binding's key glyph is styled via the `accent` slot and the
 * label is plain.
 */
export function renderFooterHintLine(
  bindings: FooterBinding[],
  width: number,
  theme?: ThemeFg,
): string {
  const sep = "  ";
  let plain = "";
  let styled = "";
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
  return theme ? styled : plain;
}

/**
 * Legacy two-line `[ruler, hintLine]` shape — kept for tests that
 * pinned the prior render path. New code should prefer
 * `renderFooterHintLine` and let the chrome supply the rule.
 */
export function renderFooterLine(
  bindings: FooterBinding[],
  width: number,
  theme?: ThemeFg,
): string[] {
  const ruler = HORIZ.repeat(Math.max(0, width));
  return [ruler, renderFooterHintLine(bindings, width, theme)];
}

// ── Scroll hint ──────────────────────────────────────────────────────

/**
 * Pure helper: produce a one-line scroll-position hint, or `null`
 * when suppressed.
 *
 * Shapes:
 *   `↑ N hidden  ·  ↓ M hidden`                          (single agent)
 *   `↑ N hidden  ·  ↓ M hidden  ·  <id> (line K/M)`      (multi-agent)
 *   `↑ N hidden`                                          (top-clipped)
 *   `↓ M hidden`                                          (bottom-clipped)
 *   `<id> (line K/M)`                                     (multi-agent, no scroll)
 *   null                                                  (single agent, content fits)
 *
 * `viewportHeight <= 0` → suppress (we have no basis to compute
 * what's hidden below).
 */
export function renderScrollHint(
  scrollOffset: number,
  transcriptLineCount: number,
  viewportHeight: number,
  agentContext?: { id: string; agentCount: number },
): string | null {
  if (viewportHeight <= 0) return null;
  const above = Math.max(0, Math.min(scrollOffset, transcriptLineCount));
  const below = Math.max(0, transcriptLineCount - above - viewportHeight);

  let scrollPart: string | null;
  if (above === 0 && below === 0) scrollPart = null;
  else if (above > 0 && below > 0) scrollPart = `↑ ${above} hidden  ·  ↓ ${below} hidden`;
  else if (above > 0) scrollPart = `↑ ${above} hidden`;
  else scrollPart = `↓ ${below} hidden`;

  let agentPart: string | null = null;
  if (
    agentContext &&
    agentContext.agentCount > 1 &&
    transcriptLineCount > 0
  ) {
    const lineNum = Math.min(scrollOffset + 1, transcriptLineCount);
    agentPart = `${agentContext.id} (line ${lineNum}/${transcriptLineCount})`;
  }

  if (scrollPart && agentPart) return `${scrollPart}  ·  ${agentPart}`;
  if (scrollPart) return scrollPart;
  if (agentPart) return agentPart;
  return null;
}

// ── Layout helpers ───────────────────────────────────────────────────

function clip(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  return truncateToWidth(s, width, "…", false);
}

/**
 * Pad inner content to fill `innerWidth` cells. We INTENTIONALLY do
 * not truncate when the content is wider than `innerWidth` —
 * production renderers (`renderHeader`, `renderTranscript`,
 * `renderFooterHintLine`) are already width-aware and emit content
 * sized to fit. The only scenario where `visibleWidth(content) >
 * innerWidth` is when a test passes a bracket-sentinel theme
 * (`[slot]X[/]`); those literal brackets count toward visibleWidth
 * but disappear under a real ANSI theme. Truncating them would
 * silently drop bindings/glyphs the assertions are looking for.
 * Right-padding only keeps the chrome solid in production while
 * leaving sentinel tests untouched.
 */
function padInner(content: string, innerWidth: number): string {
  if (innerWidth <= 0) return "";
  const w = visibleWidth(content);
  if (w >= innerWidth) return content;
  return content + " ".repeat(innerWidth - w);
}

function topBorder(width: number, theme?: ThemeFg): string {
  if (width < 2) return HORIZ.repeat(width);
  const s = TL + HORIZ.repeat(width - 2) + TR;
  return theme ? theme.fg("border", s) : s;
}

function midBorder(width: number, theme?: ThemeFg): string {
  if (width < 2) return HORIZ.repeat(width);
  const s = ML + HORIZ.repeat(width - 2) + MR;
  return theme ? theme.fg("border", s) : s;
}

function bottomBorder(width: number, theme?: ThemeFg): string {
  if (width < 2) return HORIZ.repeat(width);
  const s = BL + HORIZ.repeat(width - 2) + BR;
  return theme ? theme.fg("border", s) : s;
}

/**
 * Wrap `inner` in `│ … │` side walls, padding to fill `width` cells
 * exactly. `inner` is expected to already be themed (or plain) at
 * `width - BORDER_INSET` cells. Border glyphs are themed via the
 * `border` slot when a theme is provided.
 */
function sideRow(inner: string, width: number, theme?: ThemeFg): string {
  if (width < BORDER_INSET) {
    // Degenerate — no room for chrome; fall back to plain padded line.
    return padInner(inner, Math.max(0, width));
  }
  const innerWidth = width - BORDER_INSET;
  const left = theme ? theme.fg("border", `${VERT} `) : `${VERT} `;
  const right = theme ? theme.fg("border", ` ${VERT}`) : ` ${VERT}`;
  return left + padInner(inner, innerWidth) + right;
}

// ── Zone components ──────────────────────────────────────────────────
//
// Each zone is a thin Component holding pre-computed lines. The
// FocusedStreamOverlay populates them inside its own render() and
// then asks the root Container to concatenate. `invalidate()` clears
// the backing — Container.invalidate() cascades to children, so a
// single root.invalidate() resets every zone.

class StaticLinesZone implements Component {
  private _lines: string[] = [];
  setLines(lines: string[]): void {
    this._lines = lines;
  }
  render(_width: number): string[] {
    return this._lines;
  }
  invalidate(): void {
    this._lines = [];
  }
}

// ── Main component ───────────────────────────────────────────────────

export class FocusedStreamOverlay implements Component {
  private readonly _root: Container;
  private readonly _headerZone: StaticLinesZone;
  private readonly _bodyZone: StaticLinesZone;
  private readonly _footerZone: StaticLinesZone;
  /**
   * Slice 6 render cache. Single mutation surface: written ONLY
   * inside `render()`, cleared ONLY inside `invalidate()`. Subsumes
   * the slice-4 grandfathered `_lastTranscriptLength` mutation.
   * `getTranscriptLength()` reads from this field; the model's
   * `getMetrics` closure (wired by the factory) calls that getter.
   */
  private _renderCache: { transcriptLength: number } | null = null;

  constructor(private readonly _opts: FocusedStreamOverlayOptions) {
    this._root = new Container();
    this._headerZone = new StaticLinesZone();
    this._bodyZone = new StaticLinesZone();
    this._footerZone = new StaticLinesZone();
    this._root.addChild(this._headerZone);
    this._root.addChild(this._bodyZone);
    this._root.addChild(this._footerZone);
  }

  /**
   * Public access to the construction options. Used by `FOOTER_BINDINGS`
   * action callbacks so they can dispatch through the same opts the
   * Component was wired with.
   */
  get opts(): FocusedStreamOverlayOptions {
    return this._opts;
  }

  render(width: number): string[] {
    const { model, theme } = this.opts;
    const focused = model.focused();
    const viewportRaw = this.opts.getViewportHeight?.();
    const viewport =
      viewportRaw && viewportRaw > 0 ? viewportRaw : DEFAULT_VIEWPORT_ROWS;
    const bodyRows = Math.max(1, viewport - HEADER_ROWS - FOOTER_ROWS);
    const innerWidth = Math.max(0, width - BORDER_INSET);

    let transcriptLength = 0;
    let bodyInnerLines: string[];
    let statusInner = "";
    let status: RunStatus | undefined;

    if (!focused) {
      // Empty state body (themed inline).
      bodyInnerLines = renderEmpty(innerWidth, bodyRows, theme);
      // Truncate / pad body to bodyRows.
      bodyInnerLines = fitToHeight(bodyInnerLines, bodyRows);
      // No status line.
    } else {
      // Status line — reuse renderHeader (returns [topRuler, statusLine])
      // and take the second entry. The chrome supplies our own top
      // border so the inner top ruler is dropped.
      const hdr = renderHeader(focused, innerWidth);
      statusInner = hdr[1] ?? "";

      // Body transcript.
      const transcript = renderTranscript(focused, {
        width: innerWidth,
        collapseToolCalls: model.collapseToolCalls(),
        showThinking: model.showThinking(),
        isExpanded: (key, def) => model.isExpanded(key, def),
      });
      transcriptLength = transcript.length;

      const offset = Math.min(
        model.scrollOffset(),
        Math.max(0, transcript.length - 1),
      );
      let bodyContent = transcript.slice(offset, offset + bodyRows);

      const hint = renderScrollHint(offset, transcript.length, bodyRows, {
        id: focused.id,
        agentCount: model.agentCount(),
      });
      // Pad to bodyRows so chrome geometry is stable regardless of
      // transcript length. When clipped, the breadcrumb takes the
      // bottom row.
      bodyContent = fitToHeight(bodyContent, bodyRows);
      if (hint !== null) {
        bodyContent[bodyContent.length - 1] = hint;
      }
      bodyInnerLines = bodyContent;
      status = focused.status;
    }

    // Apply theme to body via classify + applyThemeToLines (preserves
    // existing per-LineKind styling — header glyph, tool glyph, etc.).
    // Empty-state lines are already themed inline by `renderEmpty`,
    // and classify will fall through to `text` for everything else
    // there — passing them through applyThemeToLines is a no-op for
    // already-styled content (the `[muted]…[/]` sentinels are stable)
    // because `text` slot is non-disruptive.
    const themedBodyInner = theme
      ? applyThemeToLines(bodyInnerLines, classifyLine, theme, { status })
      : bodyInnerLines;

    // Apply theme to status line via classify+applyThemeToLines so a
    // header line picks up the status-correlated `accent`/`success`/etc.
    let themedStatusInner = statusInner;
    if (focused && theme) {
      const styled = applyThemeToLines([statusInner], classifyLine, theme, { status });
      themedStatusInner = styled[0] ?? statusInner;
    }

    // Footer hint (themed inline by renderFooterHintLine).
    const footerHint = renderFooterHintLine(FOOTER_BINDINGS, innerWidth, theme);

    // Compose zones.
    const headerLines: string[] = [
      topBorder(width, theme),
      sideRow(themedStatusInner, width, theme),
      midBorder(width, theme),
      sideRow("", width, theme),
    ];
    const bodyLines: string[] = themedBodyInner.map((l) => sideRow(l, width, theme));
    // Body might still be < bodyRows if fitToHeight produced a short
    // list (only happens at viewport=0); guarantee exact height.
    while (bodyLines.length < bodyRows) bodyLines.push(sideRow("", width, theme));
    if (bodyLines.length > bodyRows) bodyLines.length = bodyRows;
    const footerLines: string[] = [
      midBorder(width, theme),
      sideRow(footerHint, width, theme),
      bottomBorder(width, theme),
    ];

    this._headerZone.setLines(headerLines);
    this._bodyZone.setLines(bodyLines);
    this._footerZone.setLines(footerLines);

    // The single cache mutation site (write inside render()).
    this._renderCache = { transcriptLength };

    return this._root.render(width);
  }

  /**
   * Slice 4 plumbing. Returns the transcript line count from the most
   * recent `render()`. Sourced from the slice-6 `_renderCache`. Pre
   * first render returns 0 — callers (the model's getMetrics closure)
   * treat 0 as "no transcript yet, no scroll needed".
   */
  getTranscriptLength(): number {
    return this._renderCache?.transcriptLength ?? 0;
  }

  /**
   * Slice 6 contract: invalidate clears the render cache. Must be
   * called from outside `render()` only — render owns the write
   * surface, invalidate owns the clear. The Container.invalidate()
   * cascade also empties each zone's stored lines so a stale frame
   * cannot survive a registry change.
   */
  invalidate(): void {
    this._root.invalidate();
    this._renderCache = null;
  }

  handleInput(data: string): void {
    // Slice 11: refresh model on every keystroke before dispatch.
    this.opts.model.refresh();
    for (const binding of FOOTER_BINDINGS) {
      if (binding.matches.includes(data)) {
        binding.action(this, data);
        return;
      }
    }
  }
}

/**
 * Truncate or right-pad a body content array to exactly `rows` lines.
 * Truncation drops the tail; padding appends empty strings.
 */
function fitToHeight(lines: string[], rows: number): string[] {
  if (rows <= 0) return [];
  if (lines.length === rows) return lines.slice();
  if (lines.length > rows) return lines.slice(0, rows);
  const out = lines.slice();
  while (out.length < rows) out.push("");
  return out;
}
