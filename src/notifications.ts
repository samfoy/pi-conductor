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

/**
 * Item 15: per-send vs lifetime accounting for the completion envelope.
 *
 * `Run` carries three optional fields for the per-send / lifetime split:
 *   - `thisInvocationStartedAt` (ms-since-epoch when the current
 *     invocation began — initial spawn or most-recent resume).
 *   - `thisInvocationUsageBaseline` (snapshot of `Run.usage` at the
 *     moment the current invocation began).
 *   - `resumeCount` (number of `ensemble_send` resumes; 0 for an
 *     initial spawn).
 *
 * Readers fall back defensively when the fields are unset — see
 * `docs/backlog.md` item 15 for the witness and locked design.
 */
interface PerSendNumbers {
  /** Wall-clock ms of the current invocation only. */
  durationMs: number;
  /** Delta usage of the current invocation only. */
  turns: number;
  input: number;
  output: number;
  cost: number;
}

function perSendNumbers(run: Run): PerSendNumbers {
  const startedAt = run.thisInvocationStartedAt ?? run.startTime;
  const finishedAt = run.finishedAt ?? Date.now();
  const baseline = run.thisInvocationUsageBaseline ?? {
    turns: 0,
    input: 0,
    output: 0,
    cost: 0,
  };
  return {
    durationMs: Math.max(0, finishedAt - startedAt),
    turns: Math.max(0, run.usage.turns - baseline.turns),
    input: Math.max(0, run.usage.input - baseline.input),
    output: Math.max(0, run.usage.output - baseline.output),
    cost: Math.max(0, run.usage.cost - baseline.cost),
  };
}

export function formatCompletionNotification(run: Run): string {
  const finalText = getFinalText(run.messages);
  const perSend = perSendNumbers(run);
  // Per-send <duration>: render via elapsedStr against a synthetic
  // start anchor so the same formatter is used (s/m/h conventions).
  const perSendStart = run.thisInvocationStartedAt ?? run.startTime;
  const perSendEnd = run.finishedAt ?? perSendStart + perSend.durationMs;
  const elapsed = elapsedStr(perSendStart, perSendEnd);
  const usageStr = formatUsage({
    turns: perSend.turns,
    input: perSend.input,
    output: perSend.output,
    cost: perSend.cost,
  });
  const resumed = (run.resumeCount ?? 0) >= 1;

  const lines: string[] = [];
  lines.push("```xml");
  lines.push("<sub-agent-completed>");
  lines.push(`  <agent-id>${run.id}</agent-id>`);
  lines.push(`  <persona>${run.persona}</persona>`);
  lines.push(`  <status>${run.status}</status>`);
  lines.push(`  <duration>${elapsed}</duration>`);
  lines.push(
    `  <usage><turns>${perSend.turns}</turns><input>${perSend.input}</input>` +
      `<output>${perSend.output}</output><cost>${perSend.cost.toFixed(4)}</cost></usage>`,
  );
  if (resumed) {
    const lifetimeElapsed = elapsedStr(run.startTime, run.finishedAt);
    lines.push("  <lifetime>");
    lines.push(`    <duration>${lifetimeElapsed}</duration>`);
    lines.push(
      `    <usage><turns>${run.usage.turns}</turns><input>${run.usage.input}</input>` +
        `<output>${run.usage.output}</output><cost>${run.usage.cost.toFixed(4)}</cost></usage>`,
    );
    lines.push(`    <cost>${run.usage.cost.toFixed(4)}</cost>`);
    lines.push(`    <resumes>${run.resumeCount ?? 0}</resumes>`);
    lines.push("  </lifetime>");
  }
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

  // Human-readable header (per-send numbers; lifetime suffix when resumed)
  const header = headerLine(run, elapsed, usageStr, resumed);
  return [header, "", ...lines].join("\n");
}

function headerLine(
  run: Run,
  elapsed: string,
  usageStr: string,
  resumed: boolean,
): string {
  const glyph =
    run.status === "completed" ? "✓" :
    run.status === "killed"    ? "■" :
    run.status === "timeout"   ? "⏱" : "✗";
  const verb =
    run.status === "completed" ? "completed" :
    run.status === "killed"    ? "killed" :
    run.status === "timeout"   ? "timed out" : "failed";
  const usagePart = usageStr ? `, ${usageStr}` : "";
  let line = `## ${glyph} \`${run.persona}\` ${verb} (${elapsed}${usagePart}) — id \`${run.id}\``;
  if (resumed) {
    const lifetimeElapsed = elapsedStr(run.startTime, run.finishedAt);
    const lifetimeCost = run.usage.cost ? `$${run.usage.cost.toFixed(3)}` : "";
    const suffix = lifetimeCost
      ? ` · lifetime ${lifetimeElapsed} ${lifetimeCost}`
      : ` · lifetime ${lifetimeElapsed}`;
    line += suffix;
  }
  return line;
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

// ── v0.10 watchdog stall advisory ───────────────────────────────

/**
 * Render a `<sub-agent-stalled>` advisory envelope. Distinct shape from
 * `<sub-agent-completed>` so the parent LLM (and any tooling that
 * scrapes the conversation) can disambiguate "still running but silent"
 * from "terminal".
 *
 * Severity values:
 *   - `"soft"`: silent past the soft threshold. Run is alive; no kill.
 *   - `"hard"`: silent past the hard threshold. The kill (if any) is
 *     dispatched via {@link forceTerminate} which produces a separate
 *     `<sub-agent-completed status="killed">` envelope; this advisory is
 *     informational and may also appear when `kill_on_stall=false`.
 *
 * `silentSeconds` is computed by the caller from `now() - run.lastEventAt`.
 */
export function formatStallNotification(
  run: Run,
  args: { severity: "soft" | "hard"; silentSeconds: number; thresholdSeconds: number },
): string {
  const elapsed = elapsedStr(run.startTime);

  const lines: string[] = [];
  lines.push("```xml");
  lines.push("<sub-agent-stalled>");
  lines.push(`  <agent-id>${run.id}</agent-id>`);
  lines.push(`  <persona>${run.persona}</persona>`);
  lines.push(`  <status>${run.status}</status>`);
  lines.push(`  <duration>${elapsed}</duration>`);
  lines.push(
    `  <stall><severity>${args.severity}</severity>` +
      `<silent-seconds>${args.silentSeconds}</silent-seconds>` +
      `<threshold-seconds>${args.thresholdSeconds}</threshold-seconds></stall>`,
  );
  if (run.lastToolCall) {
    lines.push(`  <last-tool>${escapeXml(run.lastToolCall)}</last-tool>`);
  }
  lines.push(`  <transcript>${run.transcriptPath}</transcript>`);
  lines.push("</sub-agent-stalled>");
  lines.push("```");
  lines.push("");

  const glyph = args.severity === "hard" ? "⚠" : "·";
  const verb = args.severity === "hard" ? "hard-stalled" : "soft-stalled";
  const lastTool = run.lastToolCall ? `, last: ${run.lastToolCall}` : "";
  const header = `## ${glyph} \`${run.persona}\` ${verb} — silent ${args.silentSeconds}s${lastTool} — id \`${run.id}\``;
  return [header, "", ...lines].join("\n");
}
