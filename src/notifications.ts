/**
 * pi-conductor — <sub-agent-completed> notification card.
 *
 * Rendered as a markdown body that pi displays inline in the conversation.
 * Shape mirrors team-mode's <task-notification> XML so the conductor LLM
 * has a consistent payload to parse.
 *
 * v0.2: rendered as plain markdown (visible to user, machine-readable XML
 * embedded for the LLM). The "folded card" rendering described in the PRD
 * is a v1.x polish item — pi's customMessage rendering doesn't yet support
 * collapsible cards out of the box.
 */

import { compactEnvelopeBlock } from "./compaction-hook.ts";
import { elapsedStr, formatUsage, getFinalText } from "./runs.ts";
import type { Run } from "./types.ts";

export function formatCompletionNotification(run: Run): string {
  const finalText = getFinalText(run.messages);
  const usageStr = formatUsage(run.usage);
  const elapsed = elapsedStr(run.startTime, run.finishedAt);

  const lines: string[] = [];
  lines.push("```xml");
  lines.push("<sub-agent-completed>");
  lines.push(`  <agent-id>${run.id}</agent-id>`);
  lines.push(`  <persona>${run.persona}</persona>`);
  lines.push(`  <status>${run.status}</status>`);
  lines.push(`  <duration>${elapsed}</duration>`);
  lines.push(
    `  <usage><turns>${run.usage.turns}</turns><input>${run.usage.input}</input>` +
      `<output>${run.usage.output}</output><cost>${run.usage.cost.toFixed(4)}</cost></usage>`,
  );
  if (run.errorMessage) {
    lines.push(`  <error>${escapeXml(run.errorMessage)}</error>`);
  }
  if (run.nonSubstantiveFinal) {
    lines.push(
      `  <warning reason="${run.nonSubstantiveFinal.reason}">` +
        `${escapeXml(run.nonSubstantiveFinal.message)}</warning>`,
    );
  }
  if (finalText) {
    lines.push("  <result>");
    lines.push(escapeXml(finalText));
    lines.push("  </result>");
  }
  lines.push(`  <transcript>${run.transcriptPath}</transcript>`);
  lines.push("</sub-agent-completed>");
  lines.push("```");
  lines.push("");

  // Human-readable header
  const header = headerLine(run, elapsed, usageStr);
  return [header, "", ...lines].join("\n");
}

function headerLine(run: Run, elapsed: string, usageStr: string): string {
  const glyph =
    run.status === "completed" ? "✓" :
    run.status === "killed"    ? "■" :
    run.status === "timeout"   ? "⏱" : "✗";
  const verb =
    run.status === "completed" ? "completed" :
    run.status === "killed"    ? "killed" :
    run.status === "timeout"   ? "timed out" : "failed";
  const usagePart = usageStr ? `, ${usageStr}` : "";
  return `## ${glyph} \`${run.persona}\` ${verb} (${elapsed}${usagePart}) — id \`${run.id}\``;
}

/**
 * Compact form of {@link formatCompletionNotification}: replaces the
 * full `<result>` block with a `<result-summary>` truncated to
 * `RESULT_SUMMARY_MAX_CHARS` chars. The header line and all other
 * tags (`<agent-id>`, `<persona>`, `<status>`, `<duration>`,
 * `<usage>`, `<error>`, `<warning>`, `<transcript>`) are unchanged.
 *
 * Used directly by tests; the live extension produces full envelopes
 * via {@link formatCompletionNotification} and lets the
 * `installCompactionHook` rewrite older ones at context-flush time.
 * Both paths reuse {@link compactEnvelopeBlock} so the compact shape
 * is defined in exactly one place.
 */
export function formatCompletionNotificationCompact(run: Run): string {
  const full = formatCompletionNotification(run);
  // The full notification embeds the envelope inside a fenced ```xml
  // block; compactEnvelopeBlock only rewrites the
  // <sub-agent-completed>...</sub-agent-completed> substring it finds,
  // so we hand it the full string and let the regex walk to the right
  // span.
  return full.replace(
    /<sub-agent-completed>[\s\S]*?<\/sub-agent-completed>/,
    (match) => compactEnvelopeBlock(match),
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
