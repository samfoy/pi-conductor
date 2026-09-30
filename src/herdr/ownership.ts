import { randomUUID } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { publishJson } from "../effort/store.ts";
import { readProcessStartTime } from "../reconcile-startup.ts";
import { isRecord } from "./cli.ts";
import type { Run } from "../types.ts";
import { readControlRecord } from "./inbox.ts";

/** Run-stream authority only. This is deliberately not an EffortOwner. */
export interface HerdrOwner {
  epoch: string; sessionId: string; pid: number; startTime?: number;
  socketPath: string; runId: string; launchNonce: string; at: number; generation: number;
}
export interface HerdrOwnership {
  readonly identity: HerdrOwner;
  assert(): void;
  release(): void;
}
export const herdrModuleEpoch = randomUUID();
const pathFor = (dir: string, n: number) => join(dir, "owner", `${String(n).padStart(6, "0")}.json`);
const same = (a: HerdrOwner | undefined, b: HerdrOwner) => !!a &&
  (["epoch", "sessionId", "pid", "startTime", "socketPath", "runId", "launchNonce", "at", "generation"] as const).every(k => a[k] === b[k]);
export function readHerdrOwner(dir: string): HerdrOwner | undefined {
  let files: string[];
  try { files = readdirSync(join(dir, "owner")).filter(name => /^\d+\.json$/.test(name)).sort((a, b) => Number(a.split(".")[0]) - Number(b.split(".")[0])); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  let owner: HerdrOwner | undefined;
  for (const [generation, file] of files.entries()) {
    try {
      if (file !== `${String(generation).padStart(6, "0")}.json`) throw new Error("gap");
      const v = readControlRecord(pathFor(dir, generation));
      if (!isRecord(v) || v.generation !== generation || ![v.epoch, v.sessionId, v.socketPath, v.runId, v.launchNonce].every(x => typeof x === "string" && x.length > 0 && !x.includes("\0")) ||
        !Number.isSafeInteger(v.pid) || Number(v.pid) <= 1 || !Number.isFinite(v.at) || Number(v.at) < 0 ||
        (v.startTime !== undefined && (!Number.isSafeInteger(v.startTime) || Number(v.startTime) <= 0))) throw new Error("invalid");
      owner = v as unknown as HerdrOwner;
    } catch { throw new Error("invalid herdr owner claim; preserve for inspection"); }
  }
  return owner;
}
function released(dir: string, owner: HerdrOwner): boolean {
  const path = `${pathFor(dir, owner.generation)}.released`;
  if (!existsSync(path)) return false;
  const release = readControlRecord(path);
  if (!isRecord(release) || !same(release as unknown as HerdrOwner, owner)) throw new Error("invalid herdr release claim; preserve for inspection");
  return true;
}
export function probeHerdrOwner(pid: number): { state: "alive" | "gone" | "unknown"; startTime?: number } {
  try { process.kill(pid, 0); return { state: "alive", startTime: readProcessStartTime(pid) }; }
  catch (e) { return { state: (e as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown" }; }
}
export function claimHerdrOwner(dir: string, identity: Omit<HerdrOwner, "generation">,
  options: { platform?: string; now?: () => number; probe?: typeof probeHerdrOwner } = {}): HerdrOwnership {
  const previous = readHerdrOwner(dir);
  if (previous) {
    if (previous.runId !== identity.runId || previous.socketPath !== identity.socketPath) throw new Error("herdr run/socket ownership mismatch");
    if (!released(dir, previous)) {
      const proof = (options.probe ?? probeHerdrOwner)(previous.pid);
      const linux = (options.platform ?? process.platform) === "linux";
      const dead = linux
        ? proof.state === "gone" || (proof.state === "alive" && previous.startTime !== undefined && proof.startTime !== undefined && proof.startTime !== previous.startTime)
        : proof.state === "gone" && (options.now ?? Date.now)() - previous.at >= 90000;
      if (!dead) throw new Error(`herdr owner ${proof.state}; takeover refused`);
    }
  }
  const owner: HerdrOwner = { ...identity, generation: previous ? previous.generation + 1 : 0 };
  const path = pathFor(dir, owner.generation);
  publishJson(path, owner, () => {
    const current = readHerdrOwner(dir);
    if (previous ? !same(current, previous) : current !== undefined) throw new Error("herdr owner claim changed");
  });
  const assert = () => {
    if (!same(readHerdrOwner(dir), owner) || released(dir, owner)) throw new Error("herdr owner generation fenced; work preserved");
  };
  return { identity: owner, assert, release: () => publishJson(`${path}.released`, owner, assert) };
}

export function assertHerdrOwner(run: Pick<Run, "runtime" | "herdr" | "herdrOwnership" | "recordPath" | "effort" | "integration">): void {
  if (run.runtime !== "herdr") return;
  if (run.herdrOwnership) { run.herdrOwnership.assert(); return; }
  if (run.effort && run.integration) return; // M5 owns durable integration; no stream is attached.
  if (run.herdr?.ownerGeneration !== undefined || readHerdrOwner(dirname(run.recordPath))) throw new Error("herdr stream not owned by this runtime");
}
export function ownsHerdrRun(run: Pick<Run, "runtime" | "herdr" | "herdrOwnership" | "recordPath" | "effort" | "integration">): boolean {
  try { assertHerdrOwner(run); return true; } catch { return false; }
}

/** Capture the invocation before an await; a later resume may reuse the same Run object. */
export function herdrEffectFence(run: Run): () => void {
  const ownership = run.herdrOwnership, binding = run.herdr;
  return () => {
    if (run.runtime !== "herdr") return;
    ownership?.assert();
    if (run.herdrOwnership !== ownership || run.herdr !== binding) throw new Error("herdr invocation fenced");
    assertHerdrOwner(run);
  };
}
