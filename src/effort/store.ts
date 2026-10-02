import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { EffortPolicy } from "./policy.ts";
import { processIdentityState } from "./process-group.ts";
import { validateEffortName } from "./policy.ts";

export interface EffortOwner { sessionId: string; pid: number; startTime: number; generation?: number }
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
  queue?: string[];
  status?: "open" | "paused";
  pausedReason?: string;
  pausedRun?: string;
  gatedTip?: string;
  baseline?: { oid: string; result?: import("../types.ts").HookResult; disabled?: boolean };
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
export function sameOwner(a: EffortOwner, b: EffortOwner): boolean {
  return a.sessionId === b.sessionId && a.pid === b.pid && a.startTime === b.startTime && (a.generation ?? 0) === (b.generation ?? 0);
}
const claimPath = (root: string, name: string) => join(effortDir(root, name), "effort.lock");
const generationPath = (path: string, generation: number) => generation ? `${path}.${generation}` : path;
/** Append-only generations avoid unlink/recreate ABA; incomplete claims fail closed. */
export function readClaim(path: string): EffortOwner | undefined {
  let owner: EffortOwner | undefined;
  for (let n = 0; ; n++) {
    let raw: string;
    try { raw = readFileSync(generationPath(path, n), "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return owner; throw e; }
    const parsed = JSON.parse(raw);
    owner = { ...parsed, sessionId: parsed.sessionId ?? parsed.token } as EffortOwner;
    if ((owner.generation ?? 0) !== n || !owner.sessionId || !Number.isInteger(owner.pid) || !Number.isFinite(owner.startTime)) throw new Error("invalid ownership claim; preserve for inspection");
  }
}
export function assertClaim(path: string, owner: EffortOwner): void {
  const current = readClaim(path);
  if (!current || !sameOwner(current, owner) || existsSync(`${generationPath(path, owner.generation ?? 0)}.released`)) throw new Error("owner generation fenced; work preserved");
}
export function acquireClaim(path: string, identity: EffortOwner, reuse = false): EffortOwner {
  const previous = readClaim(path);
  const released = previous && existsSync(`${generationPath(path, previous.generation ?? 0)}.released`);
  if (previous && !released) {
    if (reuse && sameOwner({ ...identity, generation: previous.generation }, previous)) return previous;
    const state = processIdentityState(previous);
    if (state !== "dead") throw new Error(`owner ${state}; takeover refused`);
  }
  const owner = { ...identity, generation: previous ? (previous.generation ?? 0) + 1 : 0 };
  publishJson(generationPath(path, owner.generation), owner, () => {
    const current = readClaim(path);
    if (previous ? !current || !sameOwner(current, previous) : current !== undefined) throw new Error("owner claim changed");
  });
  return owner;
}
export function releaseClaim(path: string, owner: EffortOwner): void {
  publishJson(`${generationPath(path, owner.generation ?? 0)}.released`, {}, () => assertClaim(path, owner));
}
export function assertEffortOwner(record: EffortRecord, owner: EffortOwner): void {
  if (!sameOwner(record.owner, owner)) throw new Error("effort owned by another session or generation");
  assertClaim(claimPath(record.gitRoot, record.name), owner);
}
export function claimEffort(gitRoot: string, name: string, owner: EffortOwner): void {
  const path = claimPath(gitRoot, name);
  if (readClaim(path)) throw new Error(`effort "${name}" already claimed; ownership unresolved`);
  publishJson(path, owner, () => { if (readClaim(path)) throw new Error("effort already claimed"); });
}
/** Only explicit recovery adopts; ordinary open/spawn still requires the existing owner. */
export function adoptEffort(record: EffortRecord, identity: EffortOwner): EffortRecord {
  const owner = acquireClaim(claimPath(record.gitRoot, record.name), identity, true);
  const current = readEffort(record.gitRoot, record.name);
  if (!current) throw new Error("effort record missing; preserve claim");
  const updated = { ...current, owner, updatedAt: Date.now() };
  writeEffort(updated);
  return updated;
}
/** Link publishes complete fsynced bytes create-only, unlike writing directly into a wx claim. */
export function publishJson(path: string, value: unknown, fence: () => void, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}-${randomUUID()}.claim`;
  try {
    fence();
    const file = openSync(temp, "wx", mode);
    try { writeFileSync(file, JSON.stringify(value)); fsyncSync(file); } finally { closeSync(file); }
    fence(); linkSync(temp, path);
    const fd = openSync(dirname(path), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } finally { if (existsSync(temp)) unlinkSync(temp); }
}
/** A successful return acknowledges file contents and the rename, including directory metadata. */
export function writeDurableJson(path: string, value: unknown, fence: () => void): void {
  writeDurableFile(path, JSON.stringify(value, null, 2), fence);
}
export function writeDurableFile(path: string, contents: string, fence: () => void, mode?: number): void {
  const temp = `${path}-${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fence();
    fd = openSync(temp, "wx", mode);
    writeFileSync(fd, contents);
    fsyncSync(fd); closeSync(fd); fd = undefined;
    fence();
    renameSync(temp, path);
    fd = openSync(dirname(path), "r");
    fsyncSync(fd); closeSync(fd); fd = undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function writeEffort(record: EffortRecord): void {
  writeDurableJson(join(effortDir(record.gitRoot, record.name), "effort.json"), record, () => assertEffortOwner(record, record.owner));
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

export function assertRunEffortOwner(run: Pick<import("../types.ts").Run, "effort" | "parentPid" | "parentStartTime" | "parentSessionId">): void {
  if (!run.effort) return;
  const record = readEffort(run.effort.gitRoot, run.effort.name);
  if (!record) throw new Error("effort record missing");
  const owner = run.effort.owner ?? { sessionId: run.parentSessionId!, pid: run.parentPid!, startTime: run.parentStartTime! };
  assertEffortOwner(record, owner);
}
