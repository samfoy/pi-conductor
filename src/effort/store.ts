import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { EffortPolicy } from "./policy.ts";
import { validateEffortName } from "./policy.ts";

export interface EffortOwner { sessionId: string; pid: number; startTime: number }
export interface EffortRecord {
  schema: 1;
  name: string;
  gitRoot: string;
  baseBranch: string;
  baseOid: string;
  intRef: string;
  owner: EffortOwner;
  policy: EffortPolicy;
  members: string[];
  createdAt: number;
  updatedAt: number;
}
export function effortsRoot(): string { return join(homedir(), ".pi", "agent", "conductor", "efforts"); }
export function effortDir(gitRoot: string, name: string): string {
  validateEffortName(name);
  return join(effortsRoot(), `${name}-${createHash("sha256").update(gitRoot).digest("hex")}`);
}
export function readEffort(gitRoot: string, name: string): EffortRecord | undefined {
  const path = join(effortDir(gitRoot, name), "effort.json");
  if (!existsSync(path)) return undefined;
  const r = JSON.parse(readFileSync(path, "utf8")) as EffortRecord;
  if (r.schema !== 1 || r.gitRoot !== gitRoot || r.name !== name || r.intRef !== `refs/heads/conductor-int/${name}` || !Array.isArray(r.members)) {
    throw new Error("conflicting effort record identity; ownership unresolved");
  }
  return r;
}
export function assertEffortOwner(record: EffortRecord, owner: EffortOwner): void {
  const lock = JSON.parse(readFileSync(join(effortDir(record.gitRoot, record.name), "effort.lock"), "utf8"));
  for (const key of ["sessionId", "pid", "startTime"] as const) {
    if (record.owner[key] !== owner[key] || lock[key] !== owner[key]) throw new Error(`effort owned by another session or unresolved owner; takeover is unavailable in M1`);
  }
}
/** The claim is permanent in M1: stale or incomplete ownership needs human review, not takeover. */
export function claimEffort(gitRoot: string, name: string, owner: EffortOwner): void {
  const dir = effortDir(gitRoot, name);
  mkdirSync(dir, { recursive: true });
  try { writeFileSync(join(dir, "effort.lock"), JSON.stringify(owner), { flag: "wx" }); }
  catch { throw new Error(`effort "${name}" already claimed; ownership unresolved (no M1 takeover)`); }
}
export function writeEffort(record: EffortRecord): void {
  assertEffortOwner(record, record.owner);
  const dir = effortDir(record.gitRoot, record.name);
  const temp = join(dir, `effort-${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, JSON.stringify(record, null, 2), { flag: "wx" });
    assertEffortOwner(record, record.owner);
    renameSync(temp, join(dir, "effort.json"));
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
export function addEffortMember(record: EffortRecord, id: string): void {
  const current = readEffort(record.gitRoot, record.name);
  if (!current) throw new Error("effort record missing; refusing spawn");
  assertEffortOwner(current, record.owner);
  if (!current.members.includes(id)) writeEffort({ ...current, members: [...current.members, id], updatedAt: Date.now() });
}
export function listEfforts(gitRoot: string): EffortRecord[] {
  if (!existsSync(effortsRoot())) return [];
  const result: EffortRecord[] = [];
  for (const dir of readdirSync(effortsRoot())) {
    const path = join(effortsRoot(), dir, "effort.json");
    if (!existsSync(path)) continue;
    const r = JSON.parse(readFileSync(path, "utf8")) as EffortRecord;
    if (r.gitRoot === gitRoot) result.push(readEffort(gitRoot, r.name)!);
  }
  return result;
}
