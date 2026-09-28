import test from "node:test";
import assert from "node:assert/strict";
import { buildOnChainCallback, buildOnRetryCallback } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { DEFAULT_CONFIG, emptyUsage, type Persona, type Run } from "../src/types.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
for (const kind of ["chain", "retry"] as const) {
  test(`B2 exported ${kind} callback refuses effort parents but still dispatches non-effort work`, async () => {
    const cwd = tmpDir("effort-callback-"); const calls: any[] = [];
    const registry = new RunRegistry();
    const persona: Persona = { name: "builder", description: "test", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1, systemPrompt: "test", source: "builtin", sourcePath: "/fake", readOnly: false };
    const shared = { cwd, cfg: { ...DEFAULT_CONFIG, worktreeMode: "external" as const }, queue: { enqueueOrSpawn: (o: any) => calls.push(o) } as any, pushNotification: () => {}, getParentMessages: () => [] };
    const callback = kind === "chain" ? buildOnChainCallback({ ...shared, registry, chainEnabled: true, personaName: "builder" })! : buildOnRetryCallback({ ...shared, persona, originalTask: "task" });
    const parent: Run = { id: "builder-parent", persona: "builder", task: "task", status: kind === "chain" ? "completed" : "failed", mode: "background", startTime: 1, lastEventAt: 1, usage: emptyUsage(), messages: [], cwd, recordPath: `${cwd}/record.json`, transcriptPath: `${cwd}/transcript.jsonl`, finalPath: `${cwd}/final.md`, effort: { name: "one", gitRoot: cwd, role: "writer" } };
    await callback(parent);
    assert.equal(calls.length, 0, "shared callback must not escape effort into base cwd");
    await callback({ ...parent, effort: undefined });
    assert.equal(calls.length, 1, "non-effort positive control still spawns");
    assert.equal(calls[0].effort, undefined); assert.equal(calls[0].cwd, cwd);
  });
}
