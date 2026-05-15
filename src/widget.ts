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
import type { Run, RunStatus } from "./types.ts";

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

    const active = registry.list().filter((r) => r.status !== "completed" && r.status !== "failed" && r.status !== "killed" && r.status !== "timeout");
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
        for (const r of active) lines.push(formatRow(r, theme));
        for (const r of linger) lines.push(formatRow(r, theme));
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
      run.status === "timeout"
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

function formatRow(r: Run, theme: any): string {
  const glyph = statusGlyph(r.status, theme);
  const name = theme.fg("accent", r.persona) + theme.fg("dim", `:${r.id.split("-").pop() ?? r.id}`);
  const elapsed = theme.fg("dim", elapsedStr(r.startTime, r.finishedAt));
  const activity =
    r.status === "queued"
      ? theme.fg("dim", " (queued)")
      : r.status === "paused"
        ? theme.fg("warning", " (paused)")
        : r.lastToolCall
          ? theme.fg("dim", ` → ${r.lastToolCall}`)
          : r.status === "running"
            ? theme.fg("dim", " starting…")
            : "";
  const usage =
    r.usage.turns > 0 ? theme.fg("muted", ` [${formatUsage(r.usage)}]`) : "";
  return `${glyph} ${name} ${elapsed}${activity}${usage}`;
}

function statusGlyph(s: RunStatus, theme: any): string {
  switch (s) {
    case "queued":
      return theme.fg("dim", "◌");
    case "running":
      return theme.fg("accent", "●");
    case "paused":
      return theme.fg("warning", "⏸");
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "killed":
      return theme.fg("error", "■");
    case "timeout":
      return theme.fg("error", "⏱");
  }
}
