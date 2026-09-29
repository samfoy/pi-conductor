import { readdirSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export interface GroupProcess { pid: number; pgid: number; sid: number; startTime: number; state: string }
export interface OwnedProcessGroup { pid: number; startTime?: number }

/** Unlike kill(0), procfs distinguishes zombies from tasks still capable of executing. */
function linuxProcesses(): GroupProcess[] {
  if (process.platform !== "linux") throw new Error("live group teardown requires readable Linux procfs identity evidence");
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    let raw: string;
    try { raw = readFileSync(`/proc/${name}/stat`, "utf8"); }
    catch (error) {
      if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
      throw error;
    }
    const fields = raw.slice(raw.lastIndexOf(")") + 2).trim().split(/\s+/);
    const member = { pid: Number(name), pgid: Number(fields[2]), sid: Number(fields[3]), startTime: Number(fields[19]), state: fields[0]! };
    if (raw.lastIndexOf(")") < 0 || !/^[A-Za-z]$/.test(member.state) ||
        ![member.pid, member.pgid, member.sid, member.startTime].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error(`unreadable process identity: ${name}`);
    return [member];
  });
}

/** Integration-only teardown. Leader close is not a group-liveness or identity observation. */
export async function stopOwnedProcessGroup(group: OwnedProcessGroup, deps: {
  processes?: () => GroupProcess[];
  signal?: (pid: number, signal: NodeJS.Signals | 0) => unknown;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
} = {}): Promise<void> {
  if (!Number.isSafeInteger(group.pid) || group.pid <= 1) throw new Error("invalid owned process group");
  const signal = deps.signal ?? process.kill;
  const processes = deps.processes ?? linuxProcesses;
  const now = deps.now ?? (() => performance.now());
  const wait = deps.wait ?? delay;
  const known = new Map<number, number>();
  if (group.startTime !== undefined) known.set(group.pid, group.startTime);
  const send = (sig: NodeJS.Signals | 0): boolean => {
    try { signal(-group.pid, sig); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw new Error(`group ${group.pid} signal ${sig} unconfirmed: ${(error as Error).message}`);
    }
  };
  const observe = (): GroupProcess[] => {
    if (!send(0)) return [];
    if (!Number.isSafeInteger(group.startTime) || group.startTime! <= 0) throw new Error("missing owned group start identity");
    const members = processes().filter(p => p.pgid === group.pid);
    if (!members.length) {
      if (!send(0)) return [];
      throw new Error(`group ${group.pid} exists but membership is unknown`);
    }
    if (members.some(p => p.sid !== group.pid || (p.pid === group.pid && p.startTime !== group.startTime)) ||
        !members.some(p => known.get(p.pid) === p.startTime)) throw new Error(`group ${group.pid} identity continuity lost; refusing signal`);
    // Keep an observed PID/start anchor across leader exit; never adopt an unrelated/reused group.
    for (const p of members) known.set(p.pid, p.startTime);
    return members;
  };
  const active = (members: GroupProcess[]) => members.some(p => p.state !== "Z" && p.state !== "X");
  const initial = observe();
  if (!initial.length) return;
  if (active(initial) && !send("SIGTERM")) return;
  const escalationAt = now() + 2000;
  const deadline = escalationAt + 1000;
  let escalated = false;
  let zombies: string | undefined;
  for (;;) {
    const members = observe();
    if (!members.length) return;
    if (!active(members)) {
      const identities = members.map(p => `${p.pid}:${p.startTime}`).sort().join(",");
      if (identities === zombies) return;
      zombies = identities;
    } else {
      zombies = undefined;
      if (!escalated && now() >= escalationAt) {
        if (!send("SIGKILL")) return;
        escalated = true;
      }
    }
    if (now() >= deadline) throw new Error(`group ${group.pid} teardown unconfirmed after TERM/KILL deadline`);
    await wait(25);
  }
}
