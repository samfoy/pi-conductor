/**
 * pi-conductor — v0.18 Slice 4: confidence-weighted cross-session memory.
 *
 * Records (persona, task-shape) → outcome across sessions, then scores
 * personas for a given task shape so the conductor (and the S5 autonomous
 * executor) can bias spawn/persona selection toward what has worked.
 *
 * Ports Metaphor's MemoryStore weighting: success rate rises with sample
 * size (confidence) and decays with recency (half-life). Privacy: the
 * task shape is a hash of normalized tokens, never the raw task text.
 *
 * Split:
 *   - PURE: normalizeTaskShape, scoreOutcomes  (no I/O, injected `now`)
 *   - I/O:  memoryPath, appendOutcome, loadOutcomes, recordRunOutcome,
 *           scoreForShape  (thin wrappers; best-effort, never throw)
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { RunStatus } from "./types.ts";
import type { FailureClass } from "./failure-classify.ts";

// ── Types ────────────────────────────────────────────────────────────────

export interface OutcomeRecord {
  /** Persona name that ran. */
  persona: string;
  /** Normalized task-shape hash (see normalizeTaskShape). */
  taskShape: string;
  /** Terminal status of the run. */
  status: RunStatus;
  /** Failure class when non-completed (S1). */
  failureClass?: FailureClass;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** Recorded-at epoch ms. */
  ts: number;
}

export interface PersonaScore {
  persona: string;
  taskShape: string;
  /** Confidence-weighted, recency-decayed success rate in [0, 1]. */
  successRate: number;
  /** Number of outcomes contributing to the score. */
  n: number;
}

// ── Pure: task-shape normalization ────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "at",
  "by", "from", "into", "this", "that", "it", "is", "are", "be", "as", "we",
  "you", "i", "please", "run", "make", "get", "then", "so", "if", "when",
]);

/**
 * Normalize a task string into a stable shape hash. Pure.
 *
 * Pipeline: lowercase → strip non-alphanumerics → drop stopwords and very
 * short tokens → dedupe → sort alphabetically (order-independent) → keep
 * the leading K tokens → SHA-256, truncated. The hash (not the tokens) is
 * what's persisted, so raw task text never lands on disk.
 *
 * The match is deliberately COARSE (a hint, not a key): same token SET →
 * same shape regardless of word order or filler; tasks sharing their K
 * alphabetically-leading tokens collide, and tasks with >K tokens drop
 * the later ones. Good enough to bias persona selection; not a precise
 * index.
 */
export function normalizeTaskShape(task: string, topK = 12): string {
  const tokens = task
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  const unique = [...new Set(tokens)].sort();
  const leading = unique.slice(0, topK);
  const basis = leading.join(" ");
  return createHash("sha256").update(basis).digest("hex").slice(0, 16);
}

// ── Pure: scoring ──────────────────────────────────────────────────────────

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Score personas for a task shape from raw outcome records. Pure; `now`
 * injected.
 *
 * Each outcome contributes a recency weight `w = 0.5 ^ (age / halfLife)`
 * (newer = heavier). A completed run counts as success (value 1), any
 * other terminal as failure (value 0). The score is the weighted mean:
 *
 *     successRate = Σ(w_i · success_i) / Σ(w_i)
 *
 * A Laplace-style prior (one pseudo-failure at full weight) shrinks tiny
 * samples toward caution, so a single lucky success doesn't rank a persona
 * above one with a long solid track record. `n` is the raw sample count.
 *
 * Results are filtered to `shape` and sorted by successRate desc, then n
 * desc as a tiebreak.
 */
export function scoreOutcomes(
  records: readonly OutcomeRecord[],
  shape: string,
  now: number,
): PersonaScore[] {
  const byPersona = new Map<string, { wSuccess: number; wTotal: number; n: number }>();
  for (const r of records) {
    if (r.taskShape !== shape) continue;
    const age = Math.max(0, now - r.ts);
    const w = Math.pow(2, -(age / HALF_LIFE_MS)); // 0.5^(age/halfLife) via exp
    const success = r.status === "completed" ? 1 : 0;
    const cur = byPersona.get(r.persona) ?? { wSuccess: 0, wTotal: 0, n: 0 };
    cur.wSuccess += w * success;
    cur.wTotal += w;
    cur.n += 1;
    byPersona.set(r.persona, cur);
  }

  const scores: PersonaScore[] = [];
  for (const [persona, agg] of byPersona) {
    // Laplace prior: one pseudo-failure at unit weight.
    const successRate = agg.wSuccess / (agg.wTotal + 1);
    scores.push({ persona, taskShape: shape, successRate, n: agg.n });
  }
  scores.sort((a, b) => b.successRate - a.successRate || b.n - a.n);
  return scores;
}

// ── I/O (best-effort; never throws) ────────────────────────────────────────

/**
 * Path to the append-only outcomes log. Honors the
 * `CONDUCTOR_MEMORY_PATH` env override so the test suite (and any
 * embedding) can redirect writes away from the real user store. The npm
 * `test` script sets it to a throwaway temp file.
 */
export function memoryPath(): string {
  const override = process.env.CONDUCTOR_MEMORY_PATH;
  if (override && override.trim()) return override;
  return join(homedir(), ".pi", "agent", "conductor", "memory", "outcomes.jsonl");
}

/** Append one outcome. Best-effort: swallows all errors. */
export function appendOutcome(rec: OutcomeRecord, path = memoryPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(rec) + "\n", "utf-8");
  } catch {
    // memory is advisory; never break the finalize path
  }
}

/** Load all outcomes. Best-effort: returns [] on any error; skips bad lines. */
export function loadOutcomes(path = memoryPath()): OutcomeRecord[] {
  if (!existsSync(path)) return [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const out: OutcomeRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as OutcomeRecord;
      if (rec && typeof rec.persona === "string" && typeof rec.taskShape === "string") {
        out.push(rec);
      }
    } catch {
      // skip malformed line
    }
  }
  return out;
}

/**
 * Record a run's outcome. Maps (persona, task, status) → OutcomeRecord and
 * appends. Best-effort. Called from finalize on terminal.
 */
export function recordRunOutcome(
  run: {
    persona: string;
    task: string;
    status: RunStatus;
    failureClass?: FailureClass;
    startTime: number;
    finishedAt?: number;
  },
  now = Date.now(),
  path = memoryPath(),
): void {
  appendOutcome(
    {
      persona: run.persona,
      taskShape: normalizeTaskShape(run.task),
      status: run.status,
      failureClass: run.failureClass,
      durationMs: (run.finishedAt ?? now) - run.startTime,
      ts: now,
    },
    path,
  );
}

/**
 * Score personas for a raw task string (normalizes + loads + scores).
 * Convenience for the recommend surface and the S5 executor.
 */
export function scoreForShape(task: string, now = Date.now(), path = memoryPath()): PersonaScore[] {
  return scoreOutcomes(loadOutcomes(path), normalizeTaskShape(task), now);
}
