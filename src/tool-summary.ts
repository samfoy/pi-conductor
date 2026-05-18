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

const MAX_SUMMARY_LEN = 50;
const MAX_KV_VALUE_LEN = 30;

export function summarizeToolArgs(name: string, args: Record<string, any>): string {
  switch (name) {
    case "bash":
      return shorten(String(args.command ?? ""), MAX_SUMMARY_LEN);
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
