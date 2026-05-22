/**
 * pi-conductor — Focused stream overlay component.
 *
 * Thin Component that consumes FocusedStreamModel + transcript renderer to
 * produce the full-screen drilldown view. Keybinding dispatch happens here;
 * actual rendering and state live in their respective pure modules.
 */

import { truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
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

// ── Slice 10: empty-state polish ─────────────────────────────────────
//
// O4 closer. Replaces the prior `EMPTY_PLACEHOLDER` + leading-ruler
// pair (which read as a render bug) with a viewport-aware centred
// message. Plan §A1 (oracle amendment 1) explicitly drops `Box` from
// pi-tui — we keep the empty-state branch in plain string[] so the
// overlay stays stub-compatible with sentinel themes in tests.
//
// Styling, when a theme is set, happens INLINE here rather than via
// `applyThemeToLines` because empty-state chrome isn't a transcript
// LineKind. The outputs of `renderEmpty` are therefore returned
// directly as the body, bypassing the styler.

const EMPTY_HEADING = "(no sub-agents running)";
const EMPTY_PROSE = "Spawn one via ensemble_spawn or /conductor spawn.";

/**
 * Render the empty-state body lines (no focused run). Drops the prior
 * flanking rulers, emits a `muted`-slot heading and a `dim`-slot prose
 * line, and pads the top with empty rows so the message lands roughly
 * mid-viewport when `viewportHeight` is known.
 *
 * Layout (body lines only — footer is appended by the caller):
 *
 *   <topPad spacers>   ← Math.max(1, floor((viewport - 5) / 2))
 *   <indent>(no sub-agents running)        ← muted when theme set
 *   <blank>
 *   <indent>Spawn one via ensemble_spawn ...← dim when theme set
 *
 * `viewportHeight <= 0` → fall back to a single leading spacer (the
 * default-viewport case in unit tests, where the host hasn't wired
 * `getViewportHeight`). The overall body count is then 4 lines, down
 * from the pre-slice count of 6 (1 ruler + 5 placeholder rows).
 */
export function renderEmpty(
  width: number,
  viewportHeight: number,
  theme?: ThemeFg,
): string[] {
  // The body proper is 3 lines (heading + blank + prose). The footer
  // appended by the caller is 2 lines. So the slack budget for top
  // padding is `viewport - 3 - 2 = viewport - 5`. Halve it for
  // centring; floor; clamp to ≥1 so something is always above the
  // heading even on tiny / unknown viewports.
  const slack = Math.max(0, viewportHeight - 5);
  const topPad = Math.max(1, Math.floor(slack / 2));

  const indent = "  ";
  const headingLine = theme
    ? indent + theme.fg("muted", EMPTY_HEADING)
    : indent + EMPTY_HEADING;
  const proseLine = theme
    ? indent + theme.fg("dim", clip(EMPTY_PROSE, Math.max(0, width - visibleWidth(indent))))
    : indent + clip(EMPTY_PROSE, Math.max(0, width - visibleWidth(indent)));

  const top = Array<string>(topPad).fill("");
  return [...top, headingLine, "", proseLine];
}

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
    // Slice 4 (overlay redesign): Home/End jump-to-extremes.
    // `g`/`G` mirror the keys for less/vim-style users. The label keeps
    // the footer compact — a single hint slot covers both ends.
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
  /**
   * Slice 4: cached transcript line count from the most recent
   * `render()` call. Read by the model's `getMetrics` closure (wired
   * by the factory) to clamp `scrollDown` and drive `stickToTail`.
   *
   * This IS a render-side mutation, but it's idempotent memoization —
   * a pure side-output of `render()` that any caller could re-derive
   * by re-running `renderTranscript` with the same inputs. Slice 6's
   * three-zone chrome rewrite will introduce a true render cache and
   * make `invalidate()` clear it; until then this single counter is
   * the entire "cache".
   */
  private _lastTranscriptLength = 0;

  constructor(private readonly _opts: FocusedStreamOverlayOptions) {}

  render(width: number): string[] {
    const { model, theme } = this.opts;
    // Slice 11: render() is now a pure projection. The previous
    // implementation called `model.refresh()` here as a side effect,
    // which (a) made re-renders shift focus when the registry changed,
    // (b) coupled rendering to model lifecycle, and (c) duplicated
    // refresh work that the keystroke dispatch + registry-listener
    // (registered by installFocusedOverlayShortcut, session-scoped) now
    // own. See docs/v0.8.3-item3-plan.md "### Slice 11" + design row O6.
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
      // Slice 10: empty-state body is rendered (and styled, if a theme
      // is set) inline by `renderEmpty`. We bypass the styler entirely
      // for this branch — no rulers in the body, no LineKind mapping.
      const viewportHeight = this.opts.getViewportHeight?.() ?? 0;
      const empty = renderEmpty(width, viewportHeight, theme);
      return [...empty, ...footerLines];
    } else {
      const header = renderHeader(focused, width);
      const transcript = renderTranscript(focused, {
        width,
        collapseToolCalls: model.collapseToolCalls(),
        showThinking: model.showThinking(),
      });
      // Slice 4: cache transcript length so the model's getMetrics
      // closure can clamp scrollDown / drive stickToTail without
      // re-rendering. Pure memoization (see field comment).
      this._lastTranscriptLength = transcript.length;

      // Apply scroll offset to the transcript only — header and footer stay pinned.
      const offset = Math.min(model.scrollOffset(), Math.max(0, transcript.length - 1));
      const visibleTranscript = transcript.slice(offset);

      // Slice 8: optional scroll-position hint between body and footer.
      // Suppressed when nothing is hidden either way.
      // v0.9 deferral 1: pass agent context so multi-agent overlays
      // include a `<id> (line K/M)` breadcrumb after a Tab cycle.
      const viewportHeight = this.opts.getViewportHeight?.() ?? 0;
      const hint = renderScrollHint(offset, transcript.length, viewportHeight, {
        id: focused.id,
        agentCount: model.agentCount(),
      });
      const hintLines = hint === null ? [] : [hint];

      bodyLines = [...header, ...visibleTranscript, ...hintLines];
      status = focused.status;
    }

    if (!theme) return [...bodyLines, ...footerLines];
    const themedBody = applyThemeToLines(bodyLines, classifyLine, theme, { status });
    return [...themedBody, ...footerLines];
    // (Empty-state branch returned earlier — see Slice 10 comment above.)
  }

  /**
   * Slice 4: transcript line count from the most recent render(). Used
   * by the model's getMetrics closure. Returns 0 before the first
   * render() or when the focused branch did not run (empty state).
   */
  getTranscriptLength(): number {
    return this._lastTranscriptLength;
  }

  invalidate(): void {
    // Stateless beyond what the model holds. Nothing to clear.
    // Slice 6 will introduce a render cache; per design §10 invalidate
    // MUST clear that cache when it lands.
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
    // Slice 11: refresh the model on every keystroke, *before* dispatch.
    // This replaces the side-effect refresh that used to live in
    // render() — see the comment block above. Refreshing unconditionally
    // (rather than only when the keystroke matches a binding) keeps the
    // model fresh for any bindings whose dispatch reads the focused run
    // (e.g. 'k' kill, 's' send, 'Tab' cycle).
    this.opts.model.refresh();
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

// v0.9 deferral 2: clip uses pi-tui's visibleWidth + truncateToWidth
// instead of raw `.length` / `.slice()` so tabs (3 cols) and ANSI escape
// sequences are measured correctly. EMPTY_PROSE is plain ASCII today so
// the practical behavior is unchanged, but routing through the host
// helpers keeps the overlay safe if either constant later embeds a tab
// or pre-styled glyph.
function clip(s: string, width: number): string {
  if (visibleWidth(s) <= width) return s;
  return truncateToWidth(s, width, "…", false);
}

/**
 * Pure helper: produce a one-line scroll-position hint, or `null` when
 * suppressed. Slice 8 of v0.8.3 Item 3 — closes Ctrl+G overlay sub-issue
 * O2 ("`model.scrollOffset()` slices silently…").
 *
 * v0.9 deferral 1 — per-agent scroll-cycle annotation: when an
 * `agentContext` is supplied AND `agentCount > 1`, append a `<id>
 * (line N/M)` segment so the user has a navigation breadcrumb after
 * Tab-cycling between agents. The annotation is suppressed for single-
 * agent overlays (it would be redundant) and for empty transcripts
 * (line 0/0 is noise).
 *
 * Shapes:
 *   `↑ N hidden  ·  ↓ M hidden`                          (single agent)
 *   `↑ N hidden  ·  ↓ M hidden  ·  <id> (line K/M)`      (multi-agent)
 *   `↑ N hidden`                                          (top-clipped)
 *   `↓ M hidden`                                          (bottom-clipped)
 *   `<id> (line K/M)`                                     (multi-agent, no scroll)
 *   null                                                  (single agent, content fits)
 *
 * Suppression rule: if `viewportHeight <= 0`, suppress — we have no
 * basis to compute what's hidden below. Otherwise, suppress when both
 * `aboveCount` and `belowCount` clamp to zero AND no agent annotation
 * applies.
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
