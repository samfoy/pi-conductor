/**
 * pi-conductor — filterParentContext
 *
 * Pure function that decides what slice of the parent conductor's
 * conversation should be carried into a sub-agent spawned with
 * `inherit_context: filtered`.
 *
 * Rules (from PRD §"Context inheritance"):
 *   Include: user prose, assistant prose, file reads/writes, the explicit task.
 *   Exclude: prior `ensemble_*` tool calls + their results, `subagent` tool
 *            calls + results, `<sub-agent-completed>` cards.
 *   Defensive: drop bash entries flagged excludeFromContext (`!!` prefix).
 *   Preserve: BranchSummary / CompactionSummary (those ARE the abridgement).
 *
 * Reimplemented per locked PRD decision — we do NOT depend on
 * `pi-subagents/shared/fork-context.ts`.
 *
 * No I/O. Tested in tests/context-filter.test.ts.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

export interface FilterOptions {
  /**
   * Tool name prefixes whose calls (and matching results) are dropped.
   * A tool name matches a prefix if `toolName.startsWith(prefix)`.
   * Default: drops everything that orchestrates further sub-agents
   * (`ensemble_*`, `subagent`).
   */
  excludeToolPrefixes?: string[];
  /**
   * `customType` prefixes to drop entirely from the inherited transcript.
   * Default: `ensemble-notification` (the `<sub-agent-completed>` cards),
   * plus `subagent` to also drop the pi-essentials/subagent extension's
   * leak surface (`subagent-notify`, `subagent_control_notice`,
   * `subagent-slash-result`).
   */
  excludeCustomTypePrefixes?: string[];
  /** Back-compat alias for excludeCustomTypePrefixes (matched as exact equality). */
  excludeCustomTypes?: string[];
  /**
   * If true, drop assistant `thinking` content blocks. Thinking is the
   * parent's internal reasoning and frequently contains orchestration
   * plans or quotes from the conductor system-prompt addendum that we
   * don't want leaking to the sub-agent. Default: true.
   */
  dropThinking?: boolean;
  /**
   * If true, drop BashExecutionMessage entries with `excludeFromContext=true`
   * (the `!!`-prefix bash convention). Default: true.
   */
  dropBashExcludeFromContext?: boolean;
}

const DEFAULT_TOOL_PREFIXES = ["ensemble_", "subagent"];
const DEFAULT_CUSTOM_TYPE_PREFIXES = ["ensemble-notification", "subagent"];

function matchesAnyPrefix(name: string, prefixes: string[]): boolean {
  for (const p of prefixes) {
    if (name.startsWith(p)) return true;
  }
  return false;
}

/**
 * Filter parent messages into the slice the sub-agent should inherit.
 *
 * Returns a new array (does not mutate input). Assistant messages whose tool
 * calls are dropped are rewritten to retain prose/thinking blocks; if no
 * blocks remain, the assistant message itself is dropped to avoid emitting
 * an empty turn.
 */
export function filterParentContext(
  messages: AgentMessage[],
  opts: FilterOptions = {},
): AgentMessage[] {
  const excludeToolPrefixes = opts.excludeToolPrefixes ?? DEFAULT_TOOL_PREFIXES;
  // Caller may pass exact-match excludeCustomTypes (back-compat) AND/OR
  // prefix-based excludeCustomTypePrefixes; both apply.
  const excludeCustomTypePrefixes =
    opts.excludeCustomTypePrefixes ?? DEFAULT_CUSTOM_TYPE_PREFIXES;
  const excludeCustomTypesExact = opts.excludeCustomTypes ?? [];
  const dropBashEx = opts.dropBashExcludeFromContext ?? true;
  const dropThinking = opts.dropThinking ?? true;

  // Pre-pass: collect the set of toolCall ids whose tool name matches an
  // excluded prefix, so we can drop the corresponding toolResult later
  // and avoid leaving orphans behind. Also collect the set of message
  // indices whose content array contained at least one excluded toolCall;
  // those assistant messages are dropped whole (a' from v0.8.1 design §3)
  // — prose is treated as orchestration narration that survived alongside
  // the dropped tool call (e.g. "Spawning critic-X to gate the diff").
  const excludedCallIds = new Set<string>();
  const droppedAssistantIndices = new Set<number>();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || (msg as any).role !== "assistant") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;
    // First sub-pass: does this message contain ANY excluded toolCall?
    let willDrop = false;
    for (const block of content) {
      if (
        block?.type === "toolCall" &&
        typeof block.name === "string" &&
        matchesAnyPrefix(block.name, excludeToolPrefixes)
      ) {
        willDrop = true;
        break;
      }
    }
    if (!willDrop) continue;
    // Drop the whole message AND exclude EVERY toolCall id in it — not
    // just the prefix-matching ones — so sibling tool results (e.g.
    // `note`/`bash` in the same dropped turn) do not survive as orphans.
    // See docs/bugs/ensemble-spawn-validation-error-long-conductor-sessions.md
    // for the Bedrock failure mode this prevents.
    droppedAssistantIndices.add(i);
    for (const block of content) {
      if (block?.type === "toolCall" && typeof block.id === "string") {
        excludedCallIds.add(block.id);
      }
    }
  }

  const out: AgentMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const role = (msg as any).role;
    switch (role) {
      case "user":
        out.push(msg);
        break;
      case "assistant": {
        // (a') v0.8.1: any assistant message whose content array contained
        // an excluded toolCall is dropped whole — prose included.
        if (droppedAssistantIndices.has(i)) break;
        const content = (msg as any).content;
        if (!Array.isArray(content)) {
          out.push(msg);
          break;
        }
        const filtered = content.filter((block: any) => {
          if (block?.type === "thinking" && dropThinking) return false;
          // Excluded toolCalls are unreachable here — if any were present, the
          // whole message was dropped above. Keep the predicate symmetric for
          // future edits.
          if (block?.type !== "toolCall") return true;
          if (typeof block.name !== "string") return true;
          return !matchesAnyPrefix(block.name, excludeToolPrefixes);
        });
        if (filtered.length === 0) break; // drop empty turn
        if (filtered.length === content.length) {
          out.push(msg); // unchanged
        } else {
          // dropThinking-only rewrite path: when thinking blocks are stripped
          // from a turn whose original stopReason was "toolUse" but no
          // toolCall remains in the filtered content, the stale stopReason
          // no longer matches the message shape. Recompute conservatively
          // (only mutate "toolUse" → no toolCall remaining); other stop
          // reasons pass through unchanged. See design §3.5; closes the
          // v0.8.2 follow-up TODO that landed with v0.8.1 Item 1.
          const rewritten: any = { ...(msg as any), content: filtered };
          if (
            (msg as any).stopReason === "toolUse" &&
            !filtered.some((b: any) => b?.type === "toolCall")
          ) {
            rewritten.stopReason = "stop";
          }
          out.push(rewritten);
        }
        break;
      }
      case "toolResult": {
        const callId = (msg as any).toolCallId;
        if (typeof callId === "string" && excludedCallIds.has(callId)) break;
        out.push(msg);
        break;
      }
      case "bashExecution": {
        if (dropBashEx && (msg as any).excludeFromContext === true) break;
        out.push(msg);
        break;
      }
      case "custom": {
        const customType = (msg as any).customType;
        if (typeof customType === "string") {
          if (excludeCustomTypesExact.includes(customType)) break;
          if (matchesAnyPrefix(customType, excludeCustomTypePrefixes)) break;
        }
        out.push(msg);
        break;
      }
      case "branchSummary":
      case "compactionSummary":
        out.push(msg);
        break;
      default:
        // Unknown role — preserve to be safe; individual rules can drop later.
        out.push(msg);
        break;
    }
  }
  return out;
}

// ── filterParentContextCompact ────────────────────────────────────────
//
// Compact mode for `inherit_context: filtered_compact`.
//
// Motivation: when the parent conductor narrates a sub-agent failure
// (e.g. "Builder personas are auto-aborting — interpreting briefs as
// inherited parent narration"), that prose lands in the parent's
// assistant-role messages. The next sub-agent spawn inhales it via
// `filterParentContext`, reads it as a behavioural template, and copies
// the refusal pattern. The cascade is self-perpetuating: each failed
// builder's response gets seeded into the next builder's context.
//
// Compact mode strips every assistant TEXT block from the inherited
// transcript, leaving tool_use blocks intact (so file-reads / code-edits
// the parent performed remain visible). User prose, tool results, branch
// and compaction summaries pass through unchanged. A synthetic header
// message is prepended so the sub-agent knows narration was elided.
//
// See: `tests/context-filter.test.ts` regression tests including the
// "self-perpetuating refusal cascade" pin against verbatim quotes from
// `~/.pi/agent/conductor/runs/builder-p66e/session/seeded.jsonl`.

export function filterParentContextCompact(
  messages: AgentMessage[],
  opts: FilterOptions = {},
): AgentMessage[] {
  const filtered = filterParentContext(messages, opts);
  const out: AgentMessage[] = [];
  let elidedAssistantBlocks = 0;
  for (const msg of filtered) {
    if (msg.role !== "assistant") {
      out.push(msg);
      continue;
    }
    const content = (msg as any).content;
    if (!Array.isArray(content)) {
      // Bare-string assistant content gets dropped entirely (counts as one
      // elided narration block). Defensive — current pi-agent-core emits
      // arrays, but legacy fixtures may not.
      elidedAssistantBlocks += 1;
      continue;
    }
    const kept: any[] = [];
    for (const block of content) {
      if (block?.type === "text") {
        elidedAssistantBlocks += 1;
        continue;
      }
      kept.push(block);
    }
    if (kept.length === 0) {
      // Whole message was prose; drop it to avoid emitting an empty turn.
      continue;
    }
    out.push({ ...(msg as any), content: kept });
  }
  if (elidedAssistantBlocks === 0) return out;
  // Prepend a synthetic header message describing what was elided.
  const header: AgentMessage = {
    role: "assistant",
    content: [
      {
        type: "text",
        text:
          `[conductor narration elided: ${elidedAssistantBlocks} prose block(s) ` +
          `from the parent removed in filtered_compact mode. Tool calls, file ` +
          `reads, and user messages preserved. Your task is in the LAST user ` +
          `message below.]`,
      },
    ],
    api: "anthropic-messages" as any,
    provider: "anthropic" as any,
    model: "synthetic",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  } as AgentMessage;
  return [header, ...out];
}
