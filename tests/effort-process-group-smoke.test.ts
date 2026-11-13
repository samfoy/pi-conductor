import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { linuxProcesses, stopOwnedProcessGroup } from "../src/effort/process-group.ts";

const iterations = Number(process.env.CONDUCTOR_PG_RACE_ITERATIONS ?? 5);
const LOOP = "while :; do /bin/true; done";
const executing = (pgid: number) => linuxProcesses().filter(p => p.pgid === pgid && p.sid === pgid && p.state !== "Z" && p.state !== "X");
const ownLoop = (pid: number) => {
  const p = linuxProcesses().find(q => q.pid === pid);
  return p && p.pgid === pid && p.sid === pid ? p : undefined;
};

async function forkingGroup() {
  const reaper = spawn("bash", ["-c", `setsid bash -c 'echo $$; ${LOOP}' & wait`], { stdio: ["ignore", "pipe", "ignore"] });
  const reaped = once(reaper, "exit");
  let pid: number | undefined;
  try {
    const [chunk] = await Promise.race([once(reaper.stdout!, "data") as Promise<[Buffer]>,
      delay(10000).then(() => { throw new Error("the fork loop never reported its pid"); })]);
    pid = Number(String(chunk).trim());
    const leader = ownLoop(pid);
    assert.ok(leader, "the fork loop leads its own session and group");
    return { reaper, reaped, group: { pid, startTime: leader.startTime } };
  } catch (error) {
    if (pid !== undefined && ownLoop(pid)) process.kill(-pid, "SIGKILL");
    reaper.kill("SIGKILL");
    throw error;
  }
}

test(`a group whose leader forks constantly and is reaped by another parent stops cleanly (${iterations} iterations)`, { skip: process.platform !== "linux", timeout: 30000 + iterations * 500 }, async () => {
  for (let i = 0; i < iterations; i++) {
    const { reaper, reaped, group } = await forkingGroup();
    try {
      await delay(20 + Math.random() * 40);
      await stopOwnedProcessGroup(group);
      assert.deepEqual(executing(group.pid), [], `iteration ${i}: no member of the group still executes`);
    } finally {
      if (executing(group.pid).length) process.kill(-group.pid, "SIGKILL");
      if (!await Promise.race([reaped.then(() => true), delay(5000).then(() => false)])) reaper.kill("SIGKILL");
    }
  }
});
