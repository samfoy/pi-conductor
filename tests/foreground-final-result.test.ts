/**
 * The foreground `ensemble_spawn` tool result carries the kept-worktree hint
 * (v0.20 W4 follow-up) in its text and in `details.worktreeKept`, on both the
 * completed and the non-completed branch. A capture queue stands in for the
 * real one and hands back an already-terminal Run, so no subprocess is forked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { emptyUsage, type Run, type RunStatus } from "../src/types.ts";

const HINT =
  "worktree kept with any partial work: /r/.worktrees/conductor-wt/oracle-1 (branch conductor-wt/oracle-1); " +
  "keep it with cd /r && git merge conductor-wt/oracle-1";

async function foregroundSpawnResult(status: RunStatus): Promise<any> {
  const root = mkdtempSync(join(tmpdir(), "conductor-fg-final-"));
  const saved = { HOME: process.env.HOME, CONDUCTOR_SUBAGENT: process.env.CONDUCTOR_SUBAGENT };
  process.env.HOME = join(root, "home");
  mkdirSync(process.env.HOME, { recursive: true });
  delete process.env.CONDUCTOR_SUBAGENT;
  try {
    const reg = new RunRegistry();
    const queue = {
      enqueueOrSpawn(o: any) {
        const run: Run = {
          id: `${o.persona.name}-1`,
          persona: o.persona.name,
          task: "t",
          mode: "foreground",
          status,
          startTime: 1,
          lastEventAt: 1,
          finishedAt: 2,
          messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] } as any],
          usage: emptyUsage(),
          cwd: root,
          recordPath: join(root, "record.json"),
          transcriptPath: join(root, "transcript.jsonl"),
          finalPath: join(root, "final.md"),
          worktreeKept: HINT,
        };
        reg.register(run);
        return { kind: "spawned" as const, run, done: Promise.resolve(run) };
      },
    };
    const tools = new Map<string, { execute: (id: string, p: unknown) => Promise<any> }>();
    registerTools({ registerTool: (t: any) => void tools.set(t.name, t) } as any, {
      getCwd: () => root,
      getRegistry: () => reg,
      getQueue: () => queue as any,
      getModel: () => new FocusedStreamModel(reg),
      getParentMessages: () => [],
      openFocusedOverlay: () => {},
      registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
      pushCompletionNotification: () => {},
    });
    return await tools.get("ensemble_spawn")!.execute("c1", { persona: "oracle", task: "t", chain: false });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

for (const status of ["killed", "completed"] as const) {
  test(`ensemble_spawn foreground: a ${status} run's result carries the kept-worktree hint`, async () => {
    const res = await foregroundSpawnResult(status);
    assert.equal(res.details.status, status);
    assert.equal(res.details.worktreeKept, HINT);
    assert.ok(res.content[0].text.includes("(branch conductor-wt/oracle-1)"), res.content[0].text);
  });
}
