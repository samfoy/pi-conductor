/**
 * S1 lead presence records: one bounded private file per exact pi session id
 * (`supervision/leads/<sha256(sessionId)>.json`). A record is presentation
 * evidence for `peer list`, never a capability. Private same-uid files guard
 * against accidents and prompt misbehaviour, not a hostile local process (R10).
 */
import { createHash, randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { publishJson, writeDurableFile } from "../effort/store.ts";
import { isRecord } from "../herdr/cli.ts";
import { readControlRecord } from "../herdr/inbox.ts";
import { probeHerdrOwner } from "../herdr/ownership.ts";
import type { RunStatus } from "../types.ts";

export const LEAD_RECORD_MAX_BYTES = 4096;
export const LEAD_RUNS_BRIEF_MAX = 24;
export const LEAD_SCAN_MAX = 1024;
/** One bound for display name, repo and branch, shared by the builder's clip and the validator. */
const PRESENTATION_MAX_BYTES = 256;
/** Off Linux, a pid that is not ESRCH counts as the lead only while its record is this fresh. */
export const LEAD_FRESH_MS = 90_000;
/** Off Linux, an unproven record this old is swept; on Linux age alone never sweeps. */
export const LEAD_STALE_MS = 600_000;

export interface LeadIdentity { sessionId: string; sessionFile: string; pid: number; pidStartTime?: number; generation: string }
export interface LeadRunBrief { id: string; persona: string; status: RunStatus; parentRunId?: string }
export interface LeadRecord extends LeadIdentity {
  v: 1;
  socketPath: string; paneId: string; tabId?: string; workspaceId?: string;
  cwd: string; repo?: string; branch?: string; displayName: string;
  role: "lead";
  runs: { active: number; blocked: number; total: number };
  runsBrief: LeadRunBrief[];
  updatedAt: number;
}
export type LeadLiveness = "live" | "dead" | "unknown";
export interface LivenessOptions {
  platform?: string;
  now?: () => number;
  probe?: (pid: number) => { state: "alive" | "gone" | "unknown"; startTime?: number };
}

export const supervisionRoot = () => join(homedir(), ".pi", "agent", "conductor", "supervision");
export const leadsDir = () => join(supervisionRoot(), "leads");
const fileName = (sessionId: string) => `${createHash("sha256").update(sessionId).digest("hex")}.json`;
export const leadPath = (sessionId: string) => join(leadsDir(), fileName(sessionId));
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;
const TEMP_FILE = /^[0-9a-f]{64}\.json-[0-9a-f-]{36}\.(claim|tmp|sweep)$/;

const KEYS = new Set(["v", "sessionId", "sessionFile", "generation", "pid", "pidStartTime", "socketPath", "paneId", "tabId", "workspaceId",
  "cwd", "repo", "branch", "displayName", "role", "runs", "runsBrief", "updatedAt"]);
const BRIEF_KEYS = new Set(["id", "persona", "status", "parentRunId"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && Buffer.byteLength(v) <= max && !/[\u0000-\u001f\u007f]/.test(v);
const optional = (v: unknown, max: number) => v === undefined || text(v, max);
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const onlyKeys = (v: Record<string, unknown>, keys: Set<string>) => Object.keys(v).every(k => keys.has(k));

export function validLeadRecord(v: unknown): v is LeadRecord {
  if (!isRecord(v) || !onlyKeys(v, KEYS)) return false;
  const { runs, runsBrief } = v;
  return v.v === 1 && text(v.sessionId, 256) && text(v.sessionFile, 1024) && isAbsolute(v.sessionFile as string) &&
    typeof v.generation === "string" && UUID.test(v.generation) && Number.isSafeInteger(v.pid) && (v.pid as number) > 1 &&
    (v.pidStartTime === undefined || (Number.isSafeInteger(v.pidStartTime) && (v.pidStartTime as number) > 0)) &&
    text(v.socketPath, 1024) && text(v.paneId, 256) && optional(v.tabId, 256) && optional(v.workspaceId, 256) &&
    text(v.cwd, 1024) && isAbsolute(v.cwd as string) && optional(v.repo, PRESENTATION_MAX_BYTES) && optional(v.branch, PRESENTATION_MAX_BYTES) &&
    text(v.displayName, PRESENTATION_MAX_BYTES) &&
    v.role === "lead" && isRecord(runs) && onlyKeys(runs, new Set(["active", "blocked", "total"])) && count(runs.active) && count(runs.blocked) && count(runs.total) &&
    Array.isArray(runsBrief) && runsBrief.length <= LEAD_RUNS_BRIEF_MAX && runsBrief.every(b => isRecord(b) && onlyKeys(b, BRIEF_KEYS) &&
      text(b.id, 128) && text(b.persona, 128) && typeof b.status === "string" && /^[a-z_]{1,32}$/.test(b.status) && optional(b.parentRunId, 128)) &&
    count(v.updatedAt) && Buffer.byteLength(JSON.stringify(v)) <= LEAD_RECORD_MAX_BYTES;
}

/** Control characters become spaces; then at most 128 code points and the validator's byte bound, cut on whole code points. */
function clip(s: string | undefined): string | undefined {
  let kept = "", bytes = 0;
  for (const c of Array.from(s ?? "").slice(0, 128)) {
    const char = /[\u0000-\u001f\u007f]/.test(c) ? " " : c;
    if ((bytes += Buffer.byteLength(char)) > PRESENTATION_MAX_BYTES) break;
    kept += char;
  }
  return kept.trim() || undefined;
}

/** Clips presentation text and drops run briefs until the record fits; identity that cannot fit fails closed. */
export function buildLeadRecord(fields: Omit<LeadRecord, "v" | "role">): LeadRecord {
  let record: LeadRecord = { ...fields, v: 1, role: "lead", displayName: clip(fields.displayName) ?? "lead",
    repo: clip(fields.repo), branch: clip(fields.branch), runsBrief: fields.runsBrief.slice(0, LEAD_RUNS_BRIEF_MAX) };
  while (record.runsBrief.length > 0 && Buffer.byteLength(JSON.stringify(record)) > LEAD_RECORD_MAX_BYTES) {
    record = { ...record, runsBrief: record.runsBrief.slice(0, -1) };
  }
  if (!validLeadRecord(record)) throw new Error("lead record is outside its bounds; presence not published");
  return record;
}

export const sameLeadIdentity = (a: LeadIdentity, b: LeadIdentity) =>
  a.sessionId === b.sessionId && a.sessionFile === b.sessionFile && a.pid === b.pid && a.pidStartTime === b.pidStartTime && a.generation === b.generation;
/** Both parsed from file bytes, so key order is stable: equal means the exact version that was judged. */
export const sameLeadVersion = (a: LeadRecord, b: LeadRecord) => JSON.stringify(a) === JSON.stringify(b);

/** Creates (or, read-only, verifies) the 0700 owner-only directories; anything else fails closed. */
export function ensureLeadsDir(create: boolean): string {
  if (create) mkdirSync(dirname(supervisionRoot()), { recursive: true });
  for (const dir of [supervisionRoot(), leadsDir()]) {
    if (create) {
      try { mkdirSync(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    }
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid !== undefined && stat.uid !== process.getuid())) {
      throw new Error(`supervision directory ${dir} is not a private directory; preserved for inspection`);
    }
  }
  return leadsDir();
}

/** Undefined when absent; throws on anything malformed, oversize, symlinked or multi-linked. */
export function readLeadRecord(path: string): LeadRecord | undefined {
  let value: unknown;
  try { value = readControlRecord(path, LEAD_RECORD_MAX_BYTES); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("invalid lead record; preserved for inspection");
  }
  if (!validLeadRecord(value)) throw new Error("invalid lead record; preserved for inspection");
  return value;
}

/** Create-only: concurrent publishers of one session id cannot both succeed (EEXIST for the loser). */
export function createLeadRecord(record: LeadRecord, fence: () => void): void {
  ensureLeadsDir(true);
  publishJson(leadPath(record.sessionId), record, fence, 0o600);
}

/** A refresh; the caller's fence must prove the current file is its own. */
export function replaceLeadRecord(record: LeadRecord, fence: () => void): void {
  ensureLeadsDir(true);
  writeDurableFile(leadPath(record.sessionId), JSON.stringify(record), fence, 0o600);
}

/**
 * Removes the record only if it still `matches`: rename it aside, verify, then
 * unlink or link it back create-only. A sweep therefore never deletes a record
 * a new owner published after the caller's judgement.
 */
export function removeLeadRecordIf(path: string, matches: (record: LeadRecord) => boolean): boolean {
  const tomb = `${path}-${randomUUID()}.sweep`;
  try { renameSync(path, tomb); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  let record: LeadRecord | undefined;
  try { record = readLeadRecord(tomb); } catch { /* not ours to judge: restore below */ }
  if (record && matches(record)) { unlinkSync(tomb); return true; }
  try { linkSync(tomb, path); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  unlinkSync(tomb);
  return false;
}

/** Linux: dead is ESRCH or a start-time mismatch. Off Linux: dead is ESRCH; live only while fresh. */
export function leadLiveness(record: Pick<LeadRecord, "pid" | "pidStartTime" | "updatedAt">, options: LivenessOptions = {}): LeadLiveness {
  const proof = (options.probe ?? probeHerdrOwner)(record.pid);
  if (proof.state === "gone") return "dead";
  if ((options.platform ?? process.platform) === "linux") {
    if (proof.state !== "alive" || record.pidStartTime === undefined || proof.startTime === undefined) return "unknown";
    return proof.startTime === record.pidStartTime ? "live" : "dead";
  }
  return (options.now ?? Date.now)() - record.updatedAt <= LEAD_FRESH_MS ? "live" : "unknown";
}

export interface LeadScan { leads: { record: LeadRecord; state: "live" | "unknown" }[]; invalid: number; swept: number }

/** Bounded listing of every valid live-or-unknown lead; sweeps the dead and (off Linux) the stale. */
export function scanLeads(options: LivenessOptions = {}): LeadScan {
  const result: LeadScan = { leads: [], invalid: 0, swept: 0 };
  let dir: string;
  try { dir = ensureLeadsDir(false); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return result; throw e; }
  const names = readdirSync(dir);
  if (names.length > LEAD_SCAN_MAX) throw new Error(`lead directory holds ${names.length} entries (cap ${LEAD_SCAN_MAX}); preserved for inspection`);
  const now = (options.now ?? Date.now)();
  const offLinux = (options.platform ?? process.platform) !== "linux";
  for (const name of names.sort()) {
    const path = join(dir, name);
    if (TEMP_FILE.test(name)) {
      // Publication temps live for milliseconds; one this old was abandoned by a crash.
      try { const stat = lstatSync(path); if (stat.isFile() && Date.now() - stat.mtimeMs > LEAD_STALE_MS) unlinkSync(path); } catch { /* raced */ }
      continue;
    }
    if (!RECORD_FILE.test(name)) continue;
    let record: LeadRecord | undefined;
    try { record = readLeadRecord(path); } catch { result.invalid++; continue; }
    if (!record) continue;
    if (fileName(record.sessionId) !== name) { result.invalid++; continue; }
    const state = leadLiveness(record, options);
    if (state === "dead" || (offLinux && now - record.updatedAt > LEAD_STALE_MS)) {
      try { if (removeLeadRecordIf(path, r => sameLeadVersion(r, record))) result.swept++; } catch { result.invalid++; }
      continue;
    }
    result.leads.push({ record, state });
  }
  return result;
}
