import test from "node:test";
import assert from "node:assert/strict";
import { buildOnChainCallback, buildOnRetryCallback } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { DEFAULT_CONFIG, emptyUsage, type Persona, type Run } from "../src/types.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
for (const kind of ["chain", "retry"] as const) {
  test(`B2/M7 exported ${kind} callback never escapes an effort parent; non-effort work still dispatches`, async () => {
    const cwd = tmpDir("effort-callback-"); const calls: any[] = [];
    const registry = new RunRegistry();
    const persona: Persona = { name: "builder", description: "test", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1, systemPrompt: "test", source: "builtin", sourcePath: "/fake", readOnly: false };
    const shared = { cwd, cfg: { ...DEFAULT_CONFIG, worktreeMode: "external" as const }, queue: { enqueueOrSpawn: (o: any) => calls.push(o) } as any, pushNotification: () => {}, getParentMessages: () => [] };
    const callback = kind === "chain" ? buildOnChainCallback({ ...shared, registry, chainEnabled: true, personaName: "builder" })! : buildOnRetryCallback({ ...shared, persona, originalTask: "task" });
    const parent: Run = { id: "builder-parent", persona: "builder", task: "task", status: kind === "chain" ? "completed" : "failed", mode: "background", startTime: 1, lastEventAt: 1, usage: emptyUsage(), messages: [], cwd, recordPath: `${cwd}/record.json`, transcriptPath: `${cwd}/transcript.jsonl`, finalPath: `${cwd}/final.md`, effort: { name: "one", gitRoot: cwd, role: "writer" } };
    await callback(parent);
    if (kind === "chain") assert.equal(calls.length, 0, "M7: no landed integration in this dispatch, so no successor at all");
    else {
      assert.equal(calls.length, 1, "M7: an ordinary failure retries");
      assert.equal(calls[0].effort, "one", "inside its effort, never as base-cwd work"); assert.deepEqual(calls[0].retryOf, [parent.id]); assert.equal(calls[0].cwd, cwd);
    }
    await callback({ ...parent, effort: undefined });
    assert.equal(calls.length, kind === "chain" ? 1 : 2, "non-effort positive control still spawns");
    assert.equal(calls.at(-1).effort, undefined); assert.equal(calls.at(-1).cwd, cwd);
  });
}
