/**
 * pi-conductor — context-inflation compaction for `<sub-agent-completed>`
 * envelopes.
 *
 * v0.8.1 Item 5. The parent conductor accumulates one envelope per
 * sub-agent completion in its on-context history. Witnessed: 12+
 * envelopes in a single chain, the largest at ~27KB (designer outputs).
 * After the parent has acted on the result, the verbatim body is dead
 * weight — we keep `<agent-id>`, `<persona>`, `<status>`, `<duration>`,
 * `<usage>`, `<transcript>`, replace `<result>` with a 200-char
 * `<result-summary>`.
 *
 * Compaction happens at the `pi.on("context", …)` layer (mirrors
 * `installSanitizerHook`): the on-disk session JSONL stays full
 * fidelity; only the LLM-facing context is rewritten.
 *
 * Strategy:
 *   - Locate every envelope (`<sub-agent-completed>...</sub-agent-completed>`)
 *     in every text block of every message.
 *   - Keep the most-recent N envelopes expanded; compact older ones.
 *   - Default N = `KEEP_RECENT_ENVELOPES`.
 *   - Idempotent: an already-compacted envelope has no `<result>` block
 *     and no `<result-summary>`-rewrite path triggers.
 */

/**
 * Number of most-recent envelopes left expanded. All older envelopes
 * are compacted on every context flush.
 */
export const KEEP_RECENT_ENVELOPES = 2;

/**
 * Maximum length of the `<result-summary>` body in the compacted form.
 * The original `<result>` content is whitespace-collapsed, then sliced
 * to this length with an ellipsis appended on truncation.
 */
export const RESULT_SUMMARY_MAX_CHARS = 200;

const ENVELOPE_RE = /<sub-agent-completed>[\s\S]*?<\/sub-agent-completed>/g;
const RESULT_RE = /(\s*)<result>\n([\s\S]*?)\n(\s*)<\/result>\n?/;

/**
 * Collapse whitespace and truncate to `max` chars; append a single
 * ellipsis (`…`) if truncated. Pure.
 */
export function summarizeResultText(text: string, max: number = RESULT_SUMMARY_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max).trimEnd() + "…";
}

/**
 * Compact a single rendered envelope block (the `<sub-agent-completed>
 * …</sub-agent-completed>` substring) by replacing its `<result>` body
 * with a truncated `<result-summary>` tag. Idempotent: an envelope
 * that has no `<result>` block (already compacted, or completed
 * without final text) is returned unchanged.
 *
 * Pure string operation.
 */
export function compactEnvelopeBlock(envelopeXml: string): string {
  const m = envelopeXml.match(RESULT_RE);
  if (!m) return envelopeXml;
  const indent = m[1] ?? "  ";
  const body = m[2] ?? "";
  const summary = summarizeResultText(body);
  const replacement = `${indent}<result-summary>${summary}</result-summary>\n`;
  return envelopeXml.replace(RESULT_RE, replacement);
}

/**
 * Locate every envelope occurrence in a single text string and return
 * an array of `{ start, end, block }` records in document order.
 */
function findEnvelopes(text: string): Array<{ start: number; end: number; block: string }> {
  const out: Array<{ start: number; end: number; block: string }> = [];
  ENVELOPE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ENVELOPE_RE.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, block: m[0] });
  }
  return out;
}

/**
 * Rewrite every envelope block in `text` whose document-order index is
 * present in `indicesToCompact`. Other envelopes are left alone.
 *
 * `firstEnvelopeIdxOffset` is the document-order index of the first
 * envelope in `text` (relative to the global walk across all messages).
 * Returns the rewritten text.
 */
function rewriteSelected(
  text: string,
  firstEnvelopeIdxOffset: number,
  shouldCompact: (globalIdx: number) => boolean,
): string {
  const hits = findEnvelopes(text);
  if (hits.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    out += text.slice(cursor, hit.start);
    const globalIdx = firstEnvelopeIdxOffset + i;
    out += shouldCompact(globalIdx) ? compactEnvelopeBlock(hit.block) : hit.block;
    cursor = hit.end;
  }
  out += text.slice(cursor);
  return out;
}

/**
 * Walk a message's content (handling both string and array-of-block
 * shapes) and yield every text-bearing string a getter/setter can
 * iterate. The caller may rewrite the strings via the `setText`
 * callback. Returns the (possibly rewritten) message.
 */
function rewriteTextInMessage(
  msg: any,
  rewrite: (text: string) => string,
): any {
  if (msg == null) return msg;
  const content = msg.content;
  if (typeof content === "string") {
    const next = rewrite(content);
    return next === content ? msg : { ...msg, content: next };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const nextBlocks = content.map((block: any) => {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        const nextText = rewrite(block.text);
        if (nextText !== block.text) {
          changed = true;
          return { ...block, text: nextText };
        }
      }
      return block;
    });
    return changed ? { ...msg, content: nextBlocks } : msg;
  }
  return msg;
}

/**
 * Compact every envelope older than the most-recent N (default
 * `KEEP_RECENT_ENVELOPES`) across the given messages. Pure: returns a
 * new array; never mutates input. Messages without envelopes pass
 * through identity-equal.
 */
export function compactOlderEnvelopes(
  messages: any[],
  keepRecent: number = KEEP_RECENT_ENVELOPES,
): any[] {
  // First pass: count total envelope occurrences across all messages
  // so we know which ones to leave alone.
  let total = 0;
  const perMessageStart: number[] = new Array(messages.length).fill(0);
  for (let i = 0; i < messages.length; i++) {
    perMessageStart[i] = total;
    const msg = messages[i];
    const content = msg?.content;
    if (typeof content === "string") {
      total += findEnvelopes(content).length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          total += findEnvelopes(block.text).length;
        }
      }
    }
  }
  if (total === 0) return messages;
  const compactBefore = total - keepRecent;
  if (compactBefore <= 0) return messages;
  const shouldCompact = (globalIdx: number) => globalIdx < compactBefore;

  // Second pass: rewrite. Track a running envelope-index counter so we
  // map per-message-string offsets to the global envelope index.
  let runningGlobalIdx = 0;
  return messages.map((msg) => {
    const before = runningGlobalIdx;
    return rewriteTextInMessage(msg, (text) => {
      const hits = findEnvelopes(text);
      if (hits.length === 0) return text;
      const startIdx = runningGlobalIdx;
      runningGlobalIdx += hits.length;
      return rewriteSelected(text, startIdx, shouldCompact);
    });
    void before;
  });
}

// ── Hook registration ────────────────────────────────────────────────

export interface InstallCompactionHookOpts {
  /**
   * Override the keep-recent count. Defaults to
   * `KEEP_RECENT_ENVELOPES`. Lower values compact more aggressively;
   * 0 compacts every envelope including the most recent.
   */
  keepRecent?: number;
}

export interface InstalledCompactionHook {
  /**
   * No-op handle; reserved for symmetry with `installSanitizerHook`
   * and future per-session state (e.g. user-toggled compaction off).
   */
  reset: () => void;
}

/**
 * Register the compaction hook on `pi.on("context", …)`. Each context
 * flush rewrites all-but-the-most-recent-N `<sub-agent-completed>`
 * envelopes to the compact `<result-summary>` form.
 *
 * Mirrors `installSanitizerHook` shape so the lifecycle wiring in
 * `src/index.ts` stays uniform.
 */
export function installCompactionHook(
  pi: { on: (event: "context", handler: any) => void },
  opts: InstallCompactionHookOpts = {},
): InstalledCompactionHook {
  const keepRecent = opts.keepRecent ?? KEEP_RECENT_ENVELOPES;
  pi.on("context", async (event: { messages: any[] }) => {
    const messages = compactOlderEnvelopes(event.messages, keepRecent);
    return { messages };
  });
  return {
    reset: () => {
      // No state to clear yet.
    },
  };
}
