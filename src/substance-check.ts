/**
 * pi-conductor — non-substantive final-message heuristic.
 *
 * Closes v0.8.1 Item 4: detect sub-agent runs that flip to `completed`
 * but whose final assistant message is an "orient yourself" preamble
 * rather than the actual report. Witnessed in the v0.7 architecture
 * review where `oracle-9k7r` stalled at "Now let me check `any`
 * leakage..." after 43 turns / ~$2.90 — the substantive output never
 * materialized and was only recovered via an `ensemble_send` corrective.
 *
 * Heuristic (OR semantics — any single condition triggers):
 *   1. The final assistant block is a `thinking_*` (no terminal text).
 *   2. The final assistant `text` content is < 200 chars.
 *   3. The final assistant `text` content matches the orient-yourself
 *      regex anchored at the start (case-insensitive, leading-ws OK):
 *        /^(let me|now i'?ll|next i'?ll|i'?ll now|i need to|let's|first[,]?\s+i)\b/i
 *
 * The check is advisory — the run still flips to `completed`. The
 * conductor sees the warning in the `<sub-agent-completed>` envelope
 * and may issue an `ensemble_send` corrective.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface SubstanceCheckResult {
  warn: boolean;
  /** Short tag for the trigger reason; populated only when `warn=true`. */
  reason?: "no_text" | "too_short" | "orient_phrase";
  /** Human-readable message suitable for surfacing in the envelope. */
  message?: string;
}

/** Length floor below which a final text is considered "too short". */
export const SUBSTANTIVE_MIN_CHARS = 200;

/**
 * Orient-yourself preambles. Anchored at start; case-insensitive;
 * leading whitespace allowed. Word-boundary terminator so e.g.
 * "Let me check" matches but "letterhead" does not.
 */
const ORIENT_PHRASE_RE =
  /^\s*(let me|now i'?ll|next i'?ll|i'?ll now|i need to|let's|first[,]?\s+i)\b/i;

/**
 * Inspect a sub-agent's full message stream and decide whether the
 * final assistant turn looks substantive. Pure: no I/O, deterministic.
 */
export function isNonSubstantiveFinalMessage(
  messages: readonly AgentMessage[],
): SubstanceCheckResult {
  // Find the LAST assistant message with a content array. We look at the
  // whole content list (text + thinking + toolUse blocks) to determine
  // whether any text was emitted and whether the trailing block is text
  // or a thinking_*.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;

    // Concatenate all text blocks for this assistant turn.
    const texts: string[] = [];
    let lastBlockKind: string | undefined;
    for (const part of content) {
      const kind = (part as any)?.type;
      if (typeof kind === "string") lastBlockKind = kind;
      if (kind === "text") {
        const t = (part as any).text;
        if (typeof t === "string") texts.push(t);
      }
    }

    // Condition 1: no text at all OR last block was a thinking_*.
    const finalText = texts.join("").trim();
    const lastIsThinking =
      typeof lastBlockKind === "string" && lastBlockKind.startsWith("thinking");
    if (finalText.length === 0 || lastIsThinking) {
      return {
        warn: true,
        reason: "no_text",
        message:
          "Final assistant message contained no terminal text " +
          `(last block: ${lastBlockKind ?? "<empty>"}).`,
      };
    }

    // Condition 2: final text is too short.
    if (finalText.length < SUBSTANTIVE_MIN_CHARS) {
      return {
        warn: true,
        reason: "too_short",
        message:
          `Final assistant text is ${finalText.length} chars ` +
          `(< ${SUBSTANTIVE_MIN_CHARS}); likely an orient-yourself preamble ` +
          "rather than the substantive report.",
      };
    }

    // Condition 3: final text starts with an orient-yourself phrase.
    if (ORIENT_PHRASE_RE.test(finalText)) {
      const preview = finalText.slice(0, 80).replace(/\s+/g, " ");
      return {
        warn: true,
        reason: "orient_phrase",
        message:
          "Final assistant text begins with an orient-yourself phrase " +
          `("${preview}…"); likely the sub-agent stopped mid-plan.`,
      };
    }

    // Found a substantive final assistant message — done.
    return { warn: false };
  }

  // No assistant messages at all — treat as no_text. (Should not happen
  // for a successfully `completed` run; defensive default.)
  return {
    warn: true,
    reason: "no_text",
    message: "Run produced no assistant messages.",
  };
}
