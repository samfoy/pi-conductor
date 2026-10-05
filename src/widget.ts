/**
 * pi-conductor — Ensemble panel widget.
 *
 * Always-visible widget rendered `belowEditor` whenever there is at least one
 * non-finished sub-agent. One line per sub-agent: glyph, name, elapsed, latest
 * tool-call hint, usage. Recently-finished runs hang around for a few seconds
 * so the user can see "✓ <persona> done" before the row disappears. While a
 * conductor cwd override is active the panel also shows a `cwd: <path>` line.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { elapsedStr, formatUsage, type RunRegistry } from "./runs.ts";
import { STATUS_GLYPH } from "./status-glyph.ts";
import { isDelegatedLeaf, isTerminal } from "./types.ts";
import type { Run, RunStatus } from "./types.ts";
import { classifyStall, type WatchdogConfig } from "./watchdog.ts";
import { awaitingChildren } from "./delegation.ts";

const WIDGET_KEY = "conductor-ensemble";
const FINISHED_LINGER_MS = 8000;

interface RecentlyFinished {
  run: Run;
  expiresAt: number;
}

export interface EnsembleWidget {
  /** Manually refresh (after registry change). */
  refresh: () => void;
  /** Tear down the widget. */
  dispose: () => void;
}

/**
 * Returns true if a run should appear in the "active" section of the widget.
 * Delegates to `isTerminal` so new terminal statuses are handled automatically
 * (v0.17-S1 fix: explicit chain was missing "aborted" and "merge_conflict").
 */
export function isActiveRun(run: Run): boolean {
  return !isTerminal(run.status);
}

/**
 * Mount the ensemble widget. It reactively re-renders when the registry
 * notifies of any change, and again when finished-linger entries expire.
 */
/** S4 footer: one line, the question clipped to 80 code points with control characters blanked. Presentation only. */
export const CHIEF_WAIT_MAX_CHARS = 80;
export function formatChiefWait(question: string, theme: { fg(slot: string, text: string): string }): string {
  const chars = Array.from(question.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim());
  const clipped = chars.length > CHIEF_WAIT_MAX_CHARS ? `${chars.slice(0, CHIEF_WAIT_MAX_CHARS).join("")}…` : chars.join("");
  return theme.fg("warning", `⧗ waiting on chief: ${clipped}`);
}

export function mountEnsembleWidget(
  registry: RunRegistry,
  getCtx: () => ExtensionContext | null,
  getWatchdogConfig?: () => WatchdogConfig,
  getCwdOverride?: () => string | undefined,
  /** S4: this branch's outstanding `chief ask`, if any. */
  getChiefWait?: () => { question: string } | undefined,
): EnsembleWidget {
  const recentlyFinished: RecentlyFinished[] = [];
  let lingerTimer: NodeJS.Timeout | undefined;

  const render = () => {
    const ctx = getCtx();
    if (!ctx) return;

    // Prune expired linger rows.
    const now = Date.now();
    for (let i = recentlyFinished.length - 1; i >= 0; i--) {
      if (recentlyFinished[i]!.expiresAt <= now) recentlyFinished.splice(i, 1);
    }

    const runs = registry.list();
    const active = runs.filter(isActiveRun);
    const linger = recentlyFinished.map((e) => e.run);
    const cwdOverride = getCwdOverride?.();
    let wait: { question: string } | undefined;
    try { wait = getChiefWait?.(); } catch { /* presentation only */ }

    if (active.length === 0 && linger.length === 0 && !cwdOverride && !wait) {
      ctx.ui.setWidget(WIDGET_KEY, undefined);
      if (lingerTimer) {
        clearTimeout(lingerTimer);
        lingerTimer = undefined;
      }
      return;
    }

    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => {
        const lines: string[] = [];
        lines.push(theme.fg("dim", `── conductor ensemble (${active.length} active${linger.length ? `, ${linger.length} done` : ""}) ──`));
        if (cwdOverride) lines.push(theme.fg("dim", `cwd: ${cwdOverride}`));
        const wdCfg = getWatchdogConfig?.();
        for (const r of active) lines.push(formatRow(r, theme, now, wdCfg, runs));
        for (const r of linger) lines.push(formatRow(r, theme, now, wdCfg, runs));
        if (wait) lines.push(formatChiefWait(wait.question, theme));
        return new Text(lines.join("\n"), 0, 0);
      },
      { placement: "belowEditor" },
    );

    // Schedule a re-render at the next linger expiration.
    if (lingerTimer) clearTimeout(lingerTimer);
    if (recentlyFinished.length > 0) {
      const nextExpiry = Math.min(...recentlyFinished.map((e) => e.expiresAt));
      lingerTimer = setTimeout(render, Math.max(50, nextExpiry - now));
    }
  };

  const unsubscribe = registry.onChange((run) => {
    if (
      run.status === "completed" ||
      run.status === "failed" ||
      run.status === "killed" ||
      run.status === "timeout" ||
      run.status === "hook_failed" ||
      run.status === "merge_conflict" || // pre-existing omission fixed
      run.status === "aborted" // v0.17
    ) {
      // De-dup: if already in linger, just refresh expiry.
      const existing = recentlyFinished.find((e) => e.run.id === run.id);
      if (existing) existing.expiresAt = Date.now() + FINISHED_LINGER_MS;
      else recentlyFinished.push({ run, expiresAt: Date.now() + FINISHED_LINGER_MS });
    }
    render();
  });

  // Initial render.
  render();

  return {
    refresh: render,
    dispose: () => {
      unsubscribe();
      const ctx = getCtx();
      if (ctx) ctx.ui.setWidget(WIDGET_KEY, undefined);
      if (lingerTimer) clearTimeout(lingerTimer);
    },
  };
}

export function formatRow(
  r: Run,
  theme: any,
  nowMs?: number,
  wdCfg?: WatchdogConfig,
  /** The registry's runs, for N3 `⇣N waiting`; omitted means no delegation view. */
  runs: readonly Run[] = [],
): string {
  const glyph = statusGlyph(r.status, theme);
  const awaiting = awaitingChildren(r, runs);
  const name = theme.fg("accent", r.persona) + theme.fg("dim", `:${r.id.split("-").pop() ?? r.id}`);
  const elapsed = theme.fg("dim", elapsedStr(r.startTime, r.finishedAt));
  const activity =
    r.status === "integrating" ? theme.fg("warning", ` · ${r.effort?.name}: ${r.integration?.state ?? "paused"}${r.integration?.reason ? `: ${r.integration.reason}` : ""}`) :
    r.status === "queued"
      ? theme.fg("dim", ` (queued${r.waitReason ? `: ${r.waitReason}` : ""})`)
      : r.status === "blocked"
        ? theme.fg("warning", " (blocked: awaiting owner)")
      : r.status === "paused"
        ? theme.fg("warning", " (paused)")
        : r.hookExecuting
          ? theme.fg("warning", " · hook") // v0.11 slice 5: in-flight hook glyph
          : r.gracePeriodActive
            ? theme.fg("warning", " · ⚠ wrapping up") // v0.17-S6: grace period active
            : awaiting > 0
              ? theme.fg("dim", ` ⇣${awaiting} waiting`)
            : r.lastToolCall
              ? theme.fg("dim", ` → ${r.lastToolCall}`)
              : r.status === "running"
                ? theme.fg("dim", " starting…")
                : "";
  // v0.17-S6: show ⟳N/M when maxTurns defined, ⟳N otherwise.
  const turnPart =
    r.usage.turns > 0
      ? r.maxTurns !== undefined
        ? `⟳${r.usage.turns}/${r.maxTurns}`
        : `⟳${r.usage.turns}`
      : "";
  const tokenPart = formatUsage({ turns: 0, input: r.usage.input, output: r.usage.output, cost: r.usage.cost });
  const usageStr = [turnPart, tokenPart].filter(Boolean).join(" ");
  const usage = usageStr ? theme.fg("muted", ` [${usageStr}]`) : "";
  // v0.10 Slice 4: stall indicator. Sourced from classifyStall (pure)
  // so widget output stays deterministic and mutation-witness-able.
  // Soft → warning slot; hard → error slot with trailing `!`.
  const stall = formatStallSegment(r, theme, nowMs, wdCfg, awaitingChildren(r, runs) > 0);
  // N4: a delegated leaf is indented; rows keep registry order.
  return `${isDelegatedLeaf(r) ? "  " : ""}${glyph} ${name} ${elapsed}${activity}${stall}${usage}`;
}

/**
 * v0.10 Slice 4: pure rendered string for the stall segment of a run
 * row. Returns the empty string when the run is fresh/not classified;
 * `· STALLED Ns` (warning slot) on soft; `· STALLED Ns!` (error slot)
 * on hard. Exported for direct testing — the widget render path goes
 * through ctx.ui.setWidget which is awkward to fake, but the segment
 * builder is pure.
 */
export function formatStallSegment(
  r: Run,
  theme: any,
  nowMs?: number,
  wdCfg?: WatchdogConfig,
  awaiting = false,
): string {
  if (nowMs === undefined || wdCfg === undefined) return "";
  const c = classifyStall(r, nowMs, wdCfg, awaiting);
  if (c === null) return "";
  if (c.severity === "fresh") return "";
  if (c.severity === "hard") {
    return theme.fg("error", ` · STALLED ${c.silentSeconds}s!`);
  }
  return theme.fg("warning", ` · STALLED ${c.silentSeconds}s`);
}

function statusGlyph(s: RunStatus, theme: any): string {
  // Color slot per status; glyph chars are shared via STATUS_GLYPH so the
  // widget, transcript, and foreground-stream renderers stay in lockstep.
  const slot = statusColorSlot(s);
  return theme.fg(slot, STATUS_GLYPH[s]);
}

function statusColorSlot(s: RunStatus): string {
  switch (s) {
    case "queued":
      return "dim";
    case "running":
      return "accent";
    case "integrating":
    case "blocked":
    case "paused":
      return "warning";
    case "completed":
      return "success";
    case "failed":
    case "killed":
    case "timeout":
    case "hook_failed":
    case "merge_conflict":
    case "aborted": // v0.17: turn-limit termination
      return "error";
  }
}
