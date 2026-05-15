/**
 * pi-conductor — sanitizeToolNames
 *
 * Defense-in-depth in-memory sanitizer for malformed `toolCall.name`
 * values that violate the strictest provider charset (Bedrock's
 * `[a-zA-Z0-9_-]+`). When a model hallucinates XML/whitespace into a
 * tool name (witnessed in the `samfp/Rosie` session 2026-05-15:
 * `'ensemble_kill" >\n</invoke>'`, 24 bytes), every subsequent LLM turn
 * fails server-side validation and permanently soft-bricks the session
 * — "the wedge".
 *
 * Approach (per design.md, gated PASS by oracle-eur8):
 *   1. Walk the AgentMessage[] in two passes.
 *   2. Pass 1: collect every assistant-message toolCall whose `name`
 *      violates the charset; map id → { originalName, placeholder }.
 *   3. Pass 2: build a NEW array. For each message:
 *      - assistant: rewrite each bad toolCall.name to the mapped
 *        placeholder; preserve thinking + text + opaque ids.
 *      - toolResult: if its toolCallId matches a bad map entry, mirror
 *        the rewrite onto `toolName` and replace literal substrings of
 *        the bad name in `content[*].text`. Orphan toolResults with a
 *        bad `toolName` (no matching toolCall in input) are sanitized
 *        independently against the same regex.
 *      - else: pass through.
 *   4. Each unique sanitized id triggers exactly one `onSanitize`
 *      callback invocation per call (idempotent: a second pass over
 *      already-sanitized messages is a no-op and emits zero reports).
 *
 * Pure function: no I/O, no global state, no `console`, no `pi`.
 * Logging is the caller's responsibility (see `pi.on("context", …)`
 * wiring in `src/index.ts`). The session-scoped `warnedToolCallIds`
 * dedup-across-turns lives there.
 *
 * Spec: ./design.md (designer-w2a5, oracle-eur8 PASS-WITH-NOTES revised).
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * The strictest acceptable tool-name charset across major providers
 * (Bedrock; subset of Anthropic and OpenAI). A name is acceptable iff
 * it is non-empty and consists only of these characters.
 */
export const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

export interface SanitizeReport {
  /** The toolCall id whose name was sanitized. */
  toolCallId: string;
  /** The original (unsafe) name, byte-for-byte. */
  originalName: string;
  /** The placeholder we replaced it with. */
  sanitizedName: string;
}

export interface SanitizeOptions {
  /**
   * Override the charset acceptability test. Default tests against
   * TOOL_NAME_REGEX (strictest cross-provider charset). Pluggable so a
   * future provider with different rules can be supported without
   * touching the sanitizer core.
   */
  isValid?: (name: string) => boolean;
  /**
   * Override the placeholder builder. Default = slugifyForBedrock.
   * The placeholder MUST itself satisfy `isValid`.
   */
  buildPlaceholder?: (originalName: string) => string;
  /**
   * Called once per sanitized toolCallId per invocation. Default no-op.
   * Idempotence: a second invocation over the now-clean output emits
   * zero reports (no bad names found).
   */
  onSanitize?: (report: SanitizeReport) => void;
}

/**
 * Reduce an arbitrary string to a regex-safe slug ending in `_INVALID`.
 * Empty / all-noise inputs collapse to the literal `INVALID_TOOL_NAME`.
 *
 * Behavior:
 *   - replace every char outside `[a-zA-Z0-9_-]` with `_`
 *   - collapse runs of `_` to a single `_`
 *   - trim leading and trailing `_-`
 *   - cap base length at 64 chars
 *   - append `_INVALID` (so the placeholder is never a real registered tool)
 */
export function slugifyForBedrock(originalName: string): string {
  let slug = originalName.replace(/[^a-zA-Z0-9_-]/g, "_");
  slug = slug.replace(/_+/g, "_");
  slug = slug.replace(/^[_-]+|[_-]+$/g, "");
  if (slug.length > 64) slug = slug.slice(0, 64);
  return slug.length > 0 ? `${slug}_INVALID` : "INVALID_TOOL_NAME";
}

/**
 * Sanitize an AgentMessage[]. Returns a NEW array; never mutates input.
 * Rewrites any toolCall.name that fails `isValid`, mirrors the rewrite
 * onto matching toolResult.toolName + content text, and reports each
 * rewrite once per toolCallId via the supplied callback.
 *
 * Idempotent: calling twice yields the same output as calling once,
 * with zero `onSanitize` calls on the second invocation.
 */
export function sanitizeToolNames(
  messages: AgentMessage[],
  opts?: SanitizeOptions,
): AgentMessage[] {
  const isValid = opts?.isValid ?? ((n: string) => TOOL_NAME_REGEX.test(n));
  const buildPlaceholder = opts?.buildPlaceholder ?? slugifyForBedrock;
  const onSanitize = opts?.onSanitize;

  // Pass 1 — collect bad toolCall ids from assistant messages.
  const badByToolCallId = new Map<string, { original: string; placeholder: string }>();
  for (const msg of messages) {
    if ((msg as any).role !== "assistant") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "toolCall") continue;
      if (typeof block.id !== "string" || typeof block.name !== "string") continue;
      if (!isValid(block.name)) {
        if (!badByToolCallId.has(block.id)) {
          badByToolCallId.set(block.id, {
            original: block.name,
            placeholder: buildPlaceholder(block.name),
          });
        }
      }
    }
  }

  // Pass 2 — build a new array, rewriting where needed. Always return
  // a fresh top-level array (matches the design's "always returns a
  // new array" invariant; avoids reference-identity inconsistency that
  // historically tripped up filterParentContext tests).
  const reportedIds = new Set<string>();
  const reportOnce = (id: string, original: string, sanitized: string): void => {
    if (reportedIds.has(id)) return;
    reportedIds.add(id);
    if (onSanitize) {
      onSanitize({ toolCallId: id, originalName: original, sanitizedName: sanitized });
    }
  };

  const out: AgentMessage[] = [];
  for (const msg of messages) {
    const role = (msg as any).role;

    if (role === "assistant") {
      const content = (msg as any).content;
      if (!Array.isArray(content)) {
        out.push(msg);
        continue;
      }
      // Are any toolCall blocks in this message bad?
      const hasBad = content.some(
        (b: any) =>
          b?.type === "toolCall" &&
          typeof b.id === "string" &&
          badByToolCallId.has(b.id),
      );
      if (!hasBad) {
        out.push(msg);
        continue;
      }
      const newContent = content.map((b: any) => {
        if (b?.type === "toolCall" && typeof b.id === "string") {
          const entry = badByToolCallId.get(b.id);
          if (entry) {
            reportOnce(b.id, entry.original, entry.placeholder);
            return { ...b, name: entry.placeholder };
          }
        }
        return b;
      });
      out.push({ ...(msg as any), content: newContent });
      continue;
    }

    if (role === "toolResult") {
      const callId = (msg as any).toolCallId;
      const entry = typeof callId === "string" ? badByToolCallId.get(callId) : undefined;
      if (entry) {
        // Paired rewrite: matched toolCallId.
        reportOnce(callId, entry.original, entry.placeholder);
        out.push(rewriteToolResult(msg, entry.original, entry.placeholder));
        continue;
      }
      // Orphan toolResult: bad toolName with no matching toolCall in input.
      const toolName = (msg as any).toolName;
      if (typeof toolName === "string" && !isValid(toolName)) {
        const placeholder = buildPlaceholder(toolName);
        // Use callId (which may be missing/non-string) only as the report
        // key; fall back to an empty string if missing so the dedup Set
        // still works deterministically.
        const reportKey = typeof callId === "string" ? callId : "";
        reportOnce(reportKey, toolName, placeholder);
        out.push(rewriteToolResult(msg, toolName, placeholder));
        continue;
      }
      out.push(msg);
      continue;
    }

    out.push(msg);
  }
  return out;
}

/**
 * Build a new toolResult message with `toolName` rewritten to the
 * placeholder, and any literal occurrences of `original` in the text
 * content replaced. Other content blocks (image, etc.) pass through.
 * Opaque ids (toolCallId) are NEVER mutated.
 */
function rewriteToolResult(
  msg: AgentMessage,
  original: string,
  placeholder: string,
): AgentMessage {
  const m = msg as any;
  const newContent = Array.isArray(m.content)
    ? m.content.map((c: any) => {
        if (c?.type === "text" && typeof c.text === "string" && c.text.includes(original)) {
          return { ...c, text: c.text.split(original).join(placeholder) };
        }
        return c;
      })
    : m.content;
  return { ...m, toolName: placeholder, content: newContent };
}
