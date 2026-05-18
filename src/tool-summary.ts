/**
 * Tool-call argument summarizer — the *core* helper, with no `$ ` prefix
 * and no `shortenPath` opinions. Used by the transcript renderer for the
 * collapsed `▸ <tool> <summary>` line.
 *
 * The widget's `lastToolCall` field (set in `event-handler.ts`) re-applies
 * the `$ ` prefix and `shortenPath` shortening on top of (or alongside)
 * this core, so its output deliberately diverges where shape constraints
 * conflict.
 */

import { visibleWidth } from "@earendil-works/pi-tui";

const MAX_SUMMARY_LEN = 50;
const MAX_KV_VALUE_LEN = 30;

const ELLIPSIS = "…";
const ELLIPSIS_W = 1; // visibleWidth("…") === 1

/**
 * Head-and-tail truncate `text` so the rendered width is exactly `max`.
 *
 * When `text` already fits, returns it unchanged. Otherwise returns
 * `head + … + tail` allocated 60:40 across the post-ellipsis budget — both
 * ends survive so commands like `bash aws sts get-caller-identity --profile
 * tickety 2>/dev/null` keep their meaningful argument tail visible. Closes
 * v0.8.1 sub-issue #1.
 *
 * Pure: no state, no side effects, deterministic.
 *
 * Edge cases:
 *   - max <= 0          → empty string
 *   - max === 1         → just the ellipsis
 *   - max === 2         → first 2 visible chars (no room for head…tail)
 *   - max >= 3          → head…tail with 60:40 head:tail allocation
 */
export function shortenMiddle(text: string, max: number): string {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  if (max === ELLIPSIS_W) return ELLIPSIS;
  if (max < 3) return text.slice(0, max);
  const budget = max - ELLIPSIS_W;
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(text.length - tailLen) : "";
  return head + ELLIPSIS + tail;
}

export function summarizeToolArgs(name: string, args: Record<string, any>): string {
  switch (name) {
    case "bash":
      return shortenMiddle(String(args.command ?? ""), MAX_SUMMARY_LEN);
    case "read":
    case "write":
    case "edit":
      return shorten(String(args.file_path ?? args.path ?? ""), MAX_SUMMARY_LEN);
    case "grep":
      return shorten(String(args.pattern ?? ""), MAX_SUMMARY_LEN);
    default: {
      const pairs: string[] = [];
      for (const [k, v] of Object.entries(args)) {
        const repr = typeof v === "string" ? v : JSON.stringify(v);
        pairs.push(`${k}=${shorten(repr, MAX_KV_VALUE_LEN)}`);
      }
      return shorten(pairs.join(" "), MAX_SUMMARY_LEN);
    }
  }
}

function shorten(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
