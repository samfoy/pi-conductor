/**
 * v0.18-S3 — wiring test for the chain re-evaluation gate in
 * buildOnChainCallback. Uses a queue spy + real resolvePersonas (builtin
 * `critic`) to witness that `reevaluate` actually gates the spawn.
 *
 * Witnesses:
 *   W1: reevaluate + explicit stop signal in final → NO spawn
 *   W2: reevaluate + clean final → spawns the `then` persona
 *   W3: no reevaluate + stop-signal final → spawns unconditionally
 *       (v0.15 regression pin — re-eval must be opt-in)
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildOnChainCallback } from "../src/tools.ts";
import { DEFAULT_CONFIG, emptyUsage, type Run, type ConductorConfig } from "../src/types.ts";

function makeParent(finalText: string, dir: string): Run {
  const finalPath = join(dir, "final.md");
  writeFileSync(finalPath, finalText);
  return {
    id: "builder-p",
    persona: "builder",
    task: "original task",
    mode: "background",
    status: "completed",
    startTime: 1,
    lastEventAt: 1,
    messages: [],
    usage: emptyUsage(),
    cwd: dir,
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath,
  } as Run;
}

function cfgWithChain(reevaluate: boolean): ConductorConfig {
  return {
    ...DEFAULT_CONFIG,
    chains: { builder: { then: "critic", reevaluate } },
  };
}

function makeArgs(cfg: ConductorConfig, captured: any[]) {
  return {
    chainEnabled: true,
    personaName: "builder",
    cfg,
    queue: { enqueueOrSpawn: (o: any) => captured.push(o) } as any,
    cwd: process.cwd(),
    pushNotification: () => {},
    getParentMessages: () => [],
  };
}

async function run(reevaluate: boolean, finalText: string): Promise<any[]> {
  const dir = join(tmpdir(), `s3-wire-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    const captured: any[] = [];
    const cb = buildOnChainCallback(makeArgs(cfgWithChain(reevaluate), captured));
    assert.ok(cb, "callback should be built when a chain is configured");
    const parent = makeParent(finalText, dir);
    await cb!(parent);
    return captured;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("S3-W1: reevaluate + stop signal → no spawn", async () => {
  const captured = await run(true, "BLOCKED: upstream schema is undefined, cannot proceed");
  assert.equal(captured.length, 0);
});

test("S3-W2: reevaluate + clean final → spawns the then persona", async () => {
  const captured = await run(true, "All checks pass; ready for review.");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].persona.name, "critic");
});

test("S3-W3: no reevaluate + stop-signal final → spawns unconditionally (v0.15 pin)", async () => {
  const captured = await run(false, "BLOCKED: this would halt if re-eval were on");
  assert.equal(captured.length, 1);
  assert.equal(captured[0].persona.name, "critic");
});
