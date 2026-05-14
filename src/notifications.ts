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

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
