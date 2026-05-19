/**
 * Pure renderer for /conductor history.
 *
 * Lists past sub-agent runs from `~/.pi/agent/conductor/runs/`, sorted by
 * mtime DESC (most recent first), capped by `limit`. Each entry shows the
 * persona, run id, status glyph, elapsed, usage, and (for completed runs)
 * a short excerpt of the final assistant text. Failures surface the error
 * message instead.
 *
 * I/O is injected via `HistoryDeps` so the renderer is pure and testable.
 */

import { elapsedStr, formatUsage } from "./runs.ts";
import { STATUS_GLYPH } from "./status-glyph.ts";
import type { RunRecord } from "./types.ts";

export interface HistoryDeps {
  /** List the run-id directory names under runsRoot(). */
  listRunIds: () => string[];
  /** Read and parse `<runDir>/record.json` for a given id. Undefined when missing/invalid. */
  readRecord: (id: string) => RunRecord | undefined;
  /** Read `<runDir>/final.md` for a given id. Undefined when missing. */
  readFinalText: (id: string) => string | undefined;
  /**
   * Most recent mtime across the run's record.json + final.md (or any
   * representative file). Used purely for ordering. Older fallback is
   * record.startTime when a stat fails.
   */
  statMtime: (id: string) => number;
  /**
   * True iff `<runDir>/.pinned` exists. Slice 4 sidecar — surfaced in
   * the history row as a `[P]` marker so users can see which runs are
   * protected from GC.
   */
  isPinned: (id: string) => boolean;
  /**
   * True iff `<runDir>/.archived` exists. Slice 3 sidecar set by
   * cold-archive. Surfaced as `[A]` plus a dim hint that resume will
   * create a fresh transcript.
   */
  isArchived: (id: string) => boolean;
}

export interface HistoryOpts {
  /** Maximum number of entries to render. */
  limit: number;
}

const EXCERPT_MAX_CHARS = 120;

export function buildHistoryReport(deps: HistoryDeps, opts: HistoryOpts): string {
  const ids = deps.listRunIds();
  const entries: { id: string; record: RunRecord; mtime: number }[] = [];
  for (const id of ids) {
    const record = deps.readRecord(id);
    if (!record) continue;
    entries.push({ id, record, mtime: deps.statMtime(id) });
  }

  if (entries.length === 0) {
    return "no run history yet. Spawn a sub-agent with ensemble_spawn or /conductor and it'll show up here.";
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  const total = entries.length;
  const shown = entries.slice(0, Math.max(0, opts.limit));

  const lines: string[] = [];
  lines.push(`run history — showing ${shown.length} of ${total}:`);
  lines.push("");

  for (const e of shown) {
    const r = e.record;
    const glyph = STATUS_GLYPH[r.status] ?? "·";
    const elapsed = elapsedStr(r.startTime, r.finishedAt);
    const usage = formatUsage(r.usage);
    const usagePart = usage ? ` [${usage}]` : "";
    const pinned = deps.isPinned(e.id);
    const archived = deps.isArchived(e.id);
    const markerParts: string[] = [];
    if (pinned) markerParts.push("[P]");
    if (archived) markerParts.push("[A]");
    const markers = markerParts.length > 0 ? ` ${markerParts.join("")}` : "";
    const head = `  ${glyph} ${r.id.padEnd(20)} ${r.persona.padEnd(14)} ${r.status.padEnd(9)} ${elapsed}${usagePart}${markers}`;
    lines.push(head);

    if (archived) {
      lines.push("      (archived; resume creates new transcript)");
    }

    if (r.status === "completed") {
      const final = deps.readFinalText(e.id);
      if (final && final.trim()) {
        const excerpt = truncate(collapseWhitespace(final), EXCERPT_MAX_CHARS);
        lines.push(`      → "${excerpt}"`);
      }
    } else if (r.errorMessage) {
      const excerpt = truncate(collapseWhitespace(r.errorMessage), EXCERPT_MAX_CHARS);
      lines.push(`      → ${excerpt}`);
    }
  }

  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
