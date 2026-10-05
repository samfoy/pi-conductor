// S3 concurrency witness: one real process per would-be chief of the same exact
// socket. Every child claims at the same release instant; only the winner releases.
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readProcessStartTime } from "../../src/reconcile-startup.ts";
import { claimChiefLease, releaseChiefLease, type ChiefClaim } from "../../src/supervision/lease.ts";

const [dir, socket, index] = process.argv.slice(2) as [string, string, string];
const startTime = readProcessStartTime(process.pid);
const identity = { sessionId: `lead-${index}`, sessionFile: `/sessions/lead-${index}.jsonl`, pid: process.pid, ...(startTime !== undefined ? { startTime } : {}), epoch: randomUUID() };
writeFileSync(join(dir, `ready-${index}`), String(process.pid));
while (!existsSync(join(dir, "go"))) { /* spin: claim as close together as the scheduler allows */ }
let claim: ChiefClaim | undefined;
try {
  claim = claimChiefLease(socket, identity);
  writeFileSync(join(dir, `result-${index}.json`), JSON.stringify({ won: true, claim }));
} catch (e) { writeFileSync(join(dir, `result-${index}.json`), JSON.stringify({ won: false, error: (e as Error).message })); }
while (!existsSync(join(dir, "release"))) await new Promise(r => setTimeout(r, 10));
if (claim) releaseChiefLease(claim);
