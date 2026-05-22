/**
 * Pure line classifier for the transcript renderer.
 *
 * Slice 6 of v0.8.3 Item 3: extracts the "what kind of line is this"
 * decision out of the (yet-to-land) styling layer (Slice 7) so that the
 * styler can pattern-match on a discriminated `LineKind` rather than
 * re-sniffing leading characters.
 *
 * Strategy: prefix-sniff. The pure renderers in `transcript.ts` (and the
 * thin header/footer helpers) emit a small, fixed vocabulary of line
 * shapes. We classify by leading character(s), with a `text` fallback for
 * everything else (wrapped assistant body, expanded tool-call JSON args,
 * blank lines, anything we don't recognize). This module has no
 * dependency on `transcript.ts` itself; it consumes only strings.
 *
 * Sentinel-based marking (have the renderer prefix each line with a
 * non-printing tag) was rejected: it would leak rendering concerns into
 * pure helpers and require downstream strippers. The sniff approach is
 * brittle in theory but bounded in practice — tests below pin every
 * shape `renderTranscript`/`renderHeader`/`renderFooter` actually emits.
 *
 * NO callsite consumes this module yet; Slice 7 will wire it.
 */

/**
 * Discriminated kind of a single rendered transcript line.
 *
 * The taxonomy is shaped around what a downstream styler will care about:
 * each kind maps to a distinct theme treatment in Slice 7. Adding a new
 * kind here should be paired with a corresponding rendered-line shape in
 * `transcript.ts` (or its sibling renderers) — the `text` fallback exists
 * so the classifier never throws, but it is not a substitute for a real
 * `LineKind` when the styler needs precise control.
 */
export type LineKind =
  /** Pure ─ ruler (header top/bottom, footer top). */
  | "ruler"
  /** Status-line below the ruler: starts with a STATUS_GLYPH char. */
  | "header"
  /** Footer key-hint line: `Esc close · Tab/Sh-Tab cycle · …`. */
  | "footer"
  /** Single-line `· turn N` separator between assistant turns. */
  | "turnSep"
  /** Tool-call header line: `▸ name …` (collapsed) or `▾ name` (expanded). */
  | "tool"
  /** Tool-call outcome line: ` ↳ ✓/✗/… preview` or `  ↳ preview` (expanded). */
  | "outcome"
  /** Thinking block — either `· thinking (...)` summary or `  ┃ …` body. */
  | "thinking"
  /** Overlay scroll-position hint: `↑ N hidden  ·  ↓ M hidden`. */
  | "scrollHint"
  /** Slice 5 fold marker: `  ⋯ N more lines  (e expand all · E collapse all)`. */
  | "fold"
  /** Fallback: wrapped assistant body, expanded JSON args, blanks, etc. */
  | "text";

/**
 * Result of classifying a single line. `glyph`, when present, is the
 * exact leading marker the line opened with (so the styler can color it
 * separately from the rest of the line). Absent for `text` and `footer`,
 * always present for `tool`, `outcome`, `turnSep`, `thinking` summary,
 * and `header`.
 */
export interface ClassifiedLine {
  kind: LineKind;
  glyph?: string;
}

/** STATUS_GLYPH chars that may lead a header line. Mirrors `status-glyph.ts`. */
const HEADER_GLYPHS = new Set(["◌", "●", "⏸", "✓", "✗", "■", "⏱", "⊗"]);

/**
 * Classify a single rendered line. Pure: same input → same output, no I/O.
 *
 * Order matters: the ruler check runs first because `─`-only lines never
 * collide with anything else; the more specific prefix matches run before
 * the `text` fallback.
 */
export function classifyLine(line: string): ClassifiedLine {
  // Ruler: a line consisting only of one or more `─` characters.
  if (line.length > 0 && /^─+$/.test(line)) {
    return { kind: "ruler" };
  }

  // Header: starts with a STATUS_GLYPH char followed by a space. The
  // trailing-space requirement avoids matching outcome lines (which lead
  // with whitespace) or hypothetical body text whose first character is
  // a glyph but with no trailing space (e.g. just the glyph).
  if (line.length >= 2) {
    const first = line[0]!;
    if (HEADER_GLYPHS.has(first) && line[1] === " ") {
      return { kind: "header", glyph: first };
    }
  }

  // Tool call header. Collapsed `▸ ` or expanded `▾ `.
  if (line.startsWith("▸ ") || line.startsWith("▾ ")) {
    return { kind: "tool", glyph: line[0]! };
  }

  // Outcome line. Both collapsed (` ↳ …`, 1 leading space) and expanded
  // (`  ↳ …`, 2 leading spaces) shapes match. We match leading whitespace
  // followed by the U+21B3 arrow.
  if (/^\s+↳ /.test(line) || line.startsWith(" ↳ ") || line.startsWith("  ↳ ")) {
    return { kind: "outcome", glyph: "↳" };
  }

  // Turn separator. Exactly `· turn <digits>`; trailing chars may exist
  // if a future renderer appends, but the prefix is load-bearing.
  if (/^· turn \d/.test(line)) {
    return { kind: "turnSep", glyph: "·" };
  }

  // Thinking summary line: `· thinking (...)`. Distinct from turnSep
  // because the second token is the literal word "thinking".
  if (line.startsWith("· thinking ") || line === "· thinking") {
    return { kind: "thinking", glyph: "·" };
  }

  // Thinking expanded body: 2-space indent + ┃ gutter. Both the heading
  // line `  ┃ thinking` and continuation lines `  ┃ <text>` match.
  if (line.startsWith("  ┃")) {
    return { kind: "thinking", glyph: "┃" };
  }

  // Scroll hint: `↑ N hidden`, `↓ M hidden`, the combined form
  // `↑ N hidden  ·  ↓ M hidden`, and the v0.9 multi-agent variants
  // ending in `<id> (line K/M)`. Emitted by the overlay between the
  // transcript body and footer; styling layer dims it.
  if (/^[↑↓] \d+ hidden/.test(line) || /^[A-Za-z][A-Za-z0-9_-]* \(line \d+\/\d+\)$/.test(line)) {
    return { kind: "scrollHint", glyph: line[0]! };
  }

  // Slice 5 fold marker. Exact shape only — anything matching the
  // sniff but missing the parenthetical hint stays as `text`. Two
  // leading spaces, U+22EF ("midline horizontal ellipsis"), positive
  // count, two-space gap before the parenthetical.
  if (/^ {2}⋯ \d+ more lines {2}\(e expand all · E collapse all\)$/.test(line)) {
    return { kind: "fold", glyph: "⋯" };
  }

  // Footer hint line. The first hint in `FOOTER_HINTS` is "Esc close"; if
  // any hint fits at all, the line starts with `Esc `. Greedy-pack on
  // narrow widths may truncate the tail but never the head.
  if (line.startsWith("Esc ")) {
    return { kind: "footer" };
  }

  // Fallback — wrapped assistant text, expanded tool-call JSON args
  // (2-space indent without ┃/↳), blank lines, anything unrecognized.
  return { kind: "text" };
}
