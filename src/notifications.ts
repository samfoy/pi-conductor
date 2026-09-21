/**
 * pi-conductor — <sub-agent-completed> notification card.
 *
 * Rendered as a markdown body that pi displays inline in the conversation.
 * Shape mirrors team-mode's <task-notification> XML so the conductor LLM
 * has a consistent payload to parse.
 *
 * The envelope here is the LLM's half: markdown header plus a fenced XML
 * block it parses, and the exact bytes `compaction-hook.ts` rewrites. The
 * user's half is the folded card in `notification-renderer.ts`, fed by the
 * `details` payload {@link buildCompletionMessage} attaches to the same
 * message. Both halves ship together — sending one without the other is
 * what left raw XML in the transcript until 2026-06.
 */

import { compactEnvelopeBlock } from "./compaction-hook.ts";
import { elapsedStr, formatUsage, getFinalText } from "./runs.ts";
import type { Run, RunStatus } from "./types.ts";

/** Theme slot for an annotation row under a notification card. */
export type NotificationNoteSlot = "error" | "warning" | "muted";

export interface NotificationNote {
  slot: NotificationNoteSlot;
  text: string;
}

/**
 * Structured payload attached to every `ensemble-notification` custom
 * message as `details`, and the only input
 * {@link renderNotificationCard} reads.
 *
 * Why it exists: pi resolves a custom message's renderer by `customType`
 * and hands the renderer `message.details`. We used to send content
 * only, so the host fell back to printing the raw ```xml envelope. The
 * envelope stays (it is the LLM's contract and `compaction-hook.ts`
 * rewrites it verbatim); `details` is the parallel machine-readable copy
 * the TUI draws from.
 *
 * Everything here is pre-formatted. Keeping the formatters on this side
 * means the renderer owns layout only, and the numbers in the card can
 * never drift from the numbers in the envelope.
 */
export interface EnsembleNotificationDetails {
  kind: "completed" | "stalled";
  id: string;
  persona: string;
  status: RunStatus;
  /** Stall severity. Present only when `kind === "stalled"`. */
  severity?: "soft" | "hard";
  /** Summary segments, joined with " · " onto the header line. */
  stats: string[];
  /** Sub-agent final text. Empty for stall advisories. */
  body: string;
  transcriptPath: string;
  /** Error / warning / hook rows rendered under the body. */
  notes: NotificationNote[];
}

/** Shape of the `pi.sendMessage` first argument for a notification. */
export interface NotificationMessage {
  customType: "ensemble-notification";
  content: string;
  display: true;
  details: EnsembleNotificationDetails;
}

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
  // v0.11 slice 5 — <hook> block. Present when the run had a hook
  // (passed or failed); absent when no hook ran.
  if (run.hookResult) {
    const h = run.hookResult;
    const hookElapsed = elapsedStr(run.finishedAt! - h.durationMs, run.finishedAt);
    lines.push("  <hook>");
    lines.push(`    <command>${escapeXml(h.command)}</command>`);
    lines.push(`    <exit-code>${h.exitCode ?? "signal"}</exit-code>`);
    lines.push(`    <duration>${hookElapsed}</duration>`);
    lines.push(`    <log-path>${escapeXml(h.logPath)}</log-path>`);
    if (h.tailText.trim()) {
      lines.push(
        `    <tail bytes="${h.tailBytes}" lines="${h.tailLines}">${escapeXml(h.tailText)}</tail>`,
      );
    }
    lines.push("  </hook>");
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

/**
 * Past-tense wording for a terminal status, shared by the XML envelope's
 * markdown header and the inline card so the two can't disagree.
 */
export function statusVerb(status: RunStatus): string {
  switch (status) {
    case "completed": return "completed";
    case "killed": return "killed";
    case "timeout": return "timed out";
    case "hook_failed": return "hook failed";
    case "aborted": return "aborted (turn limit)"; // v0.17
    default: return "failed";
  }
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
    run.status === "timeout"   ? "⏱" :
    run.status === "hook_failed" ? "⊗" :
    run.status === "aborted"   ? "⏹" : "✗"; // v0.17: aborted (turn limit)
  const verb = statusVerb(run.status);
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

/**
 * Item 11 (2026-05-28): build the `pi.sendMessage` options for a
 * sub-agent completion notification.
 *
 * Locked decision (c) per `docs/items-11-12-inspector-map.md` §6 rec 2:
 *
 *   - **Background spawns** flip to `triggerTurn: true` ONLY (no
 *     `deliverAs`). PRD line 257 contracts that the conductor wakes
 *     on background completion. The witnessed 25-min idle bug
 *     (builder-rjpb 2026-05-27) was a background spawn that did NOT
 *     wake; under `deliverAs: "followUp"` the message gets queued
 *     via `agent.followUp(...)` on the streaming branch and then
 *     never pulls a turn when the parent is between turns.
 *     `triggerTurn: true` alone hits the `await this.agent.prompt(...)`
 *     branch in `dist/core/agent-session.js: sendCustomMessage` which
 *     fires a turn unconditionally.
 *
 *   - **Foreground spawns** keep `triggerTurn: true, deliverAs:
 *     "followUp"`. The completion is already visible inline in the
 *     parent's tool-call card (v0.4 inline-streamed transcript), so
 *     queueing the wake instead of preempting matches the v0.10 Q3
 *     advisory pattern (PRD line 614 — non-disruptive default).
 *
 * Pure: deterministic on `run.mode`. Exposed for direct unit-test
 * coverage of the options arg, which prior tests stubbed away.
 */
export function buildCompletionSendMessageOptions(run: Run): {
  triggerTurn: boolean;
  deliverAs?: "followUp" | "nextTurn";
} {
  if (run.mode === "background") {
    return { triggerTurn: true };
  }
  return { triggerTurn: true, deliverAs: "followUp" };
}

// ── Inline cards — `details` payload builders ──────────────────────────

/**
 * Build the whole `pi.sendMessage` first argument for a completion
 * notification: unchanged XML `content` for the LLM, structured
 * `details` for {@link renderNotificationCard}.
 *
 * All three call sites in `index.ts` (terminal transition, watchdog
 * advisory, dead-man-switch re-fire) go through this so `details` can't
 * be forgotten on one of them — which is exactly how the raw-XML
 * regression shipped.
 */
export function buildCompletionMessage(run: Run): NotificationMessage {
  const perSend = perSendNumbers(run);
  const perSendStart = run.thisInvocationStartedAt ?? run.startTime;
  const perSendEnd = run.finishedAt ?? perSendStart + perSend.durationMs;

  const stats = [elapsedStr(perSendStart, perSendEnd)];
  const usageStr = formatUsage(perSend);
  if (usageStr) stats.push(usageStr);
  stats.push(run.id);
  if ((run.resumeCount ?? 0) >= 1) {
    const cost = run.usage.cost ? ` $${run.usage.cost.toFixed(3)}` : "";
    const resumes = run.resumeCount === 1 ? "1 resume" : `${run.resumeCount} resumes`;
    stats.push(`lifetime ${elapsedStr(run.startTime, run.finishedAt)}${cost} (${resumes})`);
  }

  const notes: NotificationNote[] = [];
  if (run.errorMessage) notes.push({ slot: "error", text: run.errorMessage });
  if (run.nonSubstantiveFinal) {
    notes.push({
      slot: "warning",
      text: `${run.nonSubstantiveFinal.reason}: ${run.nonSubstantiveFinal.message}`,
    });
  }
  if (run.hookResult) {
    const h = run.hookResult;
    const exit = h.exitCode ?? "signal";
    notes.push({
      slot: h.passed ? "muted" : "error",
      text: h.passed
        ? `hook ok: ${h.command} (${h.logPath})`
        : `hook failed: ${h.command} (exit ${exit}) → ${h.logPath}`,
    });
  }

  return {
    customType: "ensemble-notification",
    content: formatCompletionNotification(run),
    display: true,
    details: {
      kind: "completed",
      id: run.id,
      persona: run.persona,
      status: run.status,
      stats,
      body: getFinalText(run.messages),
      transcriptPath: run.transcriptPath,
      notes,
    },
  };
}

/** {@link buildCompletionMessage} for a watchdog stall advisory. */
export function buildStallMessage(
  run: Run,
  args: { severity: "soft" | "hard"; silentSeconds: number; thresholdSeconds: number },
): NotificationMessage {
  return {
    customType: "ensemble-notification",
    content: formatStallNotification(run, args),
    display: true,
    details: {
      kind: "stalled",
      id: run.id,
      persona: run.persona,
      status: run.status,
      severity: args.severity,
      stats: [`silent ${args.silentSeconds}s`, `threshold ${args.thresholdSeconds}s`, run.id],
      body: "",
      transcriptPath: run.transcriptPath,
      notes: run.lastToolCall
        ? [{ slot: "muted" as const, text: `last tool: ${run.lastToolCall}` }]
        : [],
    },
  };
}
