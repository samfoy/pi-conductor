/**
 * pi-conductor — GC inventory.
 *
 * Walks `~/.pi/agent/conductor/runs/` and produces a typed snapshot per
 * run dir for the policy engine. Pure-async: reads files, never mutates.
 *
 * Inventory is the only path in the GC subsystem that consumes `RunRegistry`
 * (the live in-memory state) — `policy.ts` then operates on the entry list
 * alone (consumes `entry.inMemory` if needed). Keeps the policy engine
 * synchronous and side-effect-free per slice 1 acceptance criterion.
 *
 * Spec: docs/v0.9-gc-design.md §3 (architecture); docs/v0.9-gc-plan.md
 * "Slice 1".
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Run,
  type RunRecord,
  type RunStatus,
  isTerminal,
} from "../types.ts";
import type { RunRegistry } from "../runs.ts";

/**
 * One entry per run-dir under `runsRoot`. Includes both the on-disk
 * snapshot AND a reference to the live `Run` from the registry (or
 * `undefined` if no live process is associated). Policy needs both —
 * the active-run gate keys on `inMemory`.
 */
export interface InventoryEntry {
  id: string;
  runDir: string;
  persona: string;
  /** From `record.json`. May be `running` even when no live process exists (orphan). */
  status: RunStatus;
  /** ms epoch from record.startTime. */
  startTime: number;
  /** ms epoch from record.finishedAt; `null` for still-running or missing. */
  finishedAt: number | null;
  /**
   * Mtime of `transcript.jsonl` in ms epoch (best staleness proxy per design D5).
   * `null` when the file is missing or unreadable.
   */
  transcriptMtime: number | null;
  /** Bytes from `stat(transcript.jsonl)`. 0 when missing or unreadable. */
  transcriptSizeBytes: number;
  recordSizeBytes: number;
  finalSizeBytes: number;
  /** Total bytes for this run dir (sum of stat'd files we know about). */
  totalSizeBytes: number;
  /** `<runDir>/.pinned` exists. */
  pinned: boolean;
  /** `<runDir>/.archived` exists. */
  archived: boolean;
  /** Mtime of `<runDir>/.archived` in ms epoch, or `null`. */
  archivedAt: number | null;
  /** `<runDir>/session/` exists and has at least one .jsonl entry — resume signal. */
  sessionPathPresent: boolean;
  /** Live `Run` from the registry, or undefined. */
  inMemory: Run | undefined;
  /** True if `record.json` is missing or unparseable. Other fields are best-effort. */
  malformed: boolean;
}

interface SafeStat {
  size: number;
  mtimeMs: number | null;
}

async function safeStat(path: string): Promise<SafeStat | null> {
  try {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

async function readRecord(runDir: string): Promise<RunRecord | null> {
  try {
    const text = await readFile(join(runDir, "record.json"), "utf-8");
    const parsed = JSON.parse(text) as RunRecord;
    if (typeof parsed.id !== "string" || typeof parsed.persona !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function detectSessionPath(runDir: string): Promise<boolean> {
  const sessionDir = join(runDir, "session");
  if (!existsSync(sessionDir)) return false;
  try {
    const entries = await readdir(sessionDir);
    return entries.some((e) => e.endsWith(".jsonl"));
  } catch {
    return false;
  }
}

/**
 * Walk `runsRoot` and produce one entry per run dir. Skips files at the
 * top level. Never throws on per-run errors; malformed records produce
 * a `{ malformed: true }` entry with whatever was statable.
 */
export async function walkInventory(
  runsRoot: string,
  registry: RunRegistry,
): Promise<InventoryEntry[]> {
  if (!existsSync(runsRoot)) return [];
  let entries: string[];
  try {
    entries = await readdir(runsRoot);
  } catch {
    return [];
  }

  const out: InventoryEntry[] = [];
  for (const id of entries) {
    const runDir = join(runsRoot, id);
    let isDir = false;
    try {
      isDir = (await stat(runDir)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    out.push(await buildEntry(id, runDir, registry));
  }
  return out;
}

async function buildEntry(
  id: string,
  runDir: string,
  registry: RunRegistry,
): Promise<InventoryEntry> {
  const record = await readRecord(runDir);
  const transcriptStat = await safeStat(join(runDir, "transcript.jsonl"));
  const recordStat = await safeStat(join(runDir, "record.json"));
  const finalStat = await safeStat(join(runDir, "final.md"));
  const archivedStat = await safeStat(join(runDir, ".archived"));
  const pinned = existsSync(join(runDir, ".pinned"));
  const sessionPathPresent = await detectSessionPath(runDir);
  const inMemory = registry.get(id);

  const transcriptSizeBytes = transcriptStat?.size ?? 0;
  const recordSizeBytes = recordStat?.size ?? 0;
  const finalSizeBytes = finalStat?.size ?? 0;
  const totalSizeBytes = transcriptSizeBytes + recordSizeBytes + finalSizeBytes;

  if (!record) {
    return {
      id,
      runDir,
      persona: "<unknown>",
      status: "failed",
      startTime: 0,
      finishedAt: null,
      transcriptMtime: transcriptStat?.mtimeMs ?? null,
      transcriptSizeBytes,
      recordSizeBytes,
      finalSizeBytes,
      totalSizeBytes,
      pinned,
      archived: archivedStat !== null,
      archivedAt: archivedStat?.mtimeMs ?? null,
      sessionPathPresent,
      inMemory,
      malformed: true,
    };
  }

  return {
    id,
    runDir,
    persona: record.persona,
    status: record.status,
    startTime: record.startTime,
    finishedAt: record.finishedAt ?? null,
    transcriptMtime: transcriptStat?.mtimeMs ?? null,
    transcriptSizeBytes,
    recordSizeBytes,
    finalSizeBytes,
    totalSizeBytes,
    pinned,
    archived: archivedStat !== null,
    archivedAt: archivedStat?.mtimeMs ?? null,
    sessionPathPresent,
    inMemory,
    malformed: false,
  };
}

/** Helper used by tests + the policy engine. Re-exported so callers don't reimport from types.ts. */
export { isTerminal };
