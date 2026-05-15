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
  // and avoid leaving orphans behind.
  const excludedCallIds = new Set<string>();
  for (const msg of messages) {
    if (!msg || (msg as any).role !== "assistant") continue;
    const content = (msg as any).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block?.type === "toolCall" &&
        typeof block.name === "string" &&
        matchesAnyPrefix(block.name, excludeToolPrefixes)
      ) {
        if (typeof block.id === "string") excludedCallIds.add(block.id);
      }
    }
  }

  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!msg) continue;
    const role = (msg as any).role;
    switch (role) {
      case "user":
        out.push(msg);
        break;
      case "assistant": {
        const content = (msg as any).content;
        if (!Array.isArray(content)) {
          out.push(msg);
          break;
        }
        const filtered = content.filter((block: any) => {
          if (block?.type === "thinking" && dropThinking) return false;
          if (block?.type !== "toolCall") return true;
          if (typeof block.name !== "string") return true;
          return !matchesAnyPrefix(block.name, excludeToolPrefixes);
        });
        if (filtered.length === 0) break; // drop empty turn
        if (filtered.length === content.length) {
          out.push(msg); // unchanged
        } else {
          out.push({ ...(msg as any), content: filtered });
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
