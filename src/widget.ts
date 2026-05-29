/**
 * pi-conductor — Ensemble panel widget.
 *
 * Always-visible widget rendered `belowEditor` whenever there is at least one
 * non-finished sub-agent. One line per sub-agent: glyph, name, elapsed, latest
 * tool-call hint, usage. Recently-finished runs hang around for a few seconds
 * so the user can see "✓ <persona> done" before the row disappears.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { elapsedStr, formatUsage, type RunRegistry } from "./runs.ts";
import { STATUS_GLYPH } from "./status-glyph.ts";
import type { Run, RunStatus } from "./types.ts";
import { classifyStall, type WatchdogConfig } from "./watchdog.ts";

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
 * Mount the ensemble widget. It reactively re-renders when the registry
 * notifies of any change, and again when finished-linger entries expire.
 */
export function mountEnsembleWidget(
  registry: RunRegistry,
  getCtx: () => ExtensionContext | null,
  getWatchdogConfig?: () => WatchdogConfig,
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

    const active = registry.list().filter((r) => r.status !== "completed" && r.status !== "failed" && r.status !== "killed" && r.status !== "timeout" && r.status !== "hook_failed");
    const linger = recentlyFinished.map((e) => e.run);

    if (active.length === 0 && linger.length === 0) {
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
        const wdCfg = getWatchdogConfig?.();
        for (const r of active) lines.push(formatRow(r, theme, now, wdCfg));
        for (const r of linger) lines.push(formatRow(r, theme, now, wdCfg));
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
      run.status === "hook_failed"
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
): string {
  const glyph = statusGlyph(r.status, theme);
  const name = theme.fg("accent", r.persona) + theme.fg("dim", `:${r.id.split("-").pop() ?? r.id}`);
  const elapsed = theme.fg("dim", elapsedStr(r.startTime, r.finishedAt));
  const activity =
    r.status === "queued"
      ? theme.fg("dim", " (queued)")
      : r.status === "paused"
        ? theme.fg("warning", " (paused)")
        : r.hookExecuting
          ? theme.fg("warning", " · hook") // v0.11 slice 5: in-flight hook glyph
          : r.lastToolCall
            ? theme.fg("dim", ` → ${r.lastToolCall}`)
            : r.status === "running"
              ? theme.fg("dim", " starting…")
              : "";
  const usage =
    r.usage.turns > 0 ? theme.fg("muted", ` [${formatUsage(r.usage)}]`) : "";
  // v0.10 Slice 4: stall indicator. Sourced from classifyStall (pure)
  // so widget output stays deterministic and mutation-witness-able.
  // Soft → warning slot; hard → error slot with trailing `!`.
  const stall = formatStallSegment(r, theme, nowMs, wdCfg);
  return `${glyph} ${name} ${elapsed}${activity}${stall}${usage}`;
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
): string {
  if (nowMs === undefined || wdCfg === undefined) return "";
  const c = classifyStall(r, nowMs, wdCfg);
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
    case "paused":
      return "warning";
    case "completed":
      return "success";
    case "failed":
    case "killed":
    case "timeout":
    case "hook_failed":
      return "error";
  }
}
