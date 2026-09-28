import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { gitTestEnv } from "./helpers/git-env.ts";
import { once } from "node:events";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { RunRegistry, spawnRun, sendToRun, forceTerminate, availableActions, getFinalText } from "../src/runs.ts";
import { buildCompletionMessage } from "../src/notifications.ts";
import { SpawnQueue } from "../src/queue.ts";
import type { Persona, Run } from "../src/types.ts";

const { piBin } = sandboxPi();
writeFileSync(piBin, `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(new URL("./helpers/native-owner-child.ts", import.meta.url).href)});\n`);
const persona: Persona = { name: "inspector", description: "probe", defaultReads: [], systemPrompt: "Probe", inheritContext: "none", inheritSkills: false, worktree: false, timeoutMinutes: 1, readOnly: true, source: "builtin", sourcePath: "test" };
const record = (run: Run) => JSON.parse(readFileSync(run.recordPath, "utf8"));
const events = (run: Run) => readFileSync(run.transcriptPath, "utf8").trim().split("\n").map(s => JSON.parse(s));
function setup(t: test.TestContext) {
  const cwd = tmpDir("a6-correction-native-");
  const registry = new RunRegistry();
  const cards: ReturnType<typeof buildCompletionMessage>[] = [];
  const onComplete = (r: Run) => cards.push(buildCompletionMessage(r));
  t.after(async () => {
    for (const run of registry.list()) if (run.proc) {
      const close = once(run.proc, "close"); forceTerminate(run, "killed", registry); await close;
    }
  });
  return { cwd, registry, cards, onComplete };
}
for (const failure of ["B1_EXIT", "B1_EOF", "B1_REJECT", "B1_HANG"]) {
  test(`B1 native blocked answer ${failure}: rollback preserves correlation and retry completes`, { timeout: 30000 }, async t => {
    const h = setup(t);
    const worktree = failure === "B1_EXIT";
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitTestEnv(), timeout: 5000, stdio: "pipe" });
    if (worktree) {
      git(h.cwd, "init", "-b", "master"); git(h.cwd, "config", "user.name", "Test"); git(h.cwd, "config", "user.email", "test@example.com");
      writeFileSync(join(h.cwd, "base"), "base"); git(h.cwd, "add", "base"); git(h.cwd, "commit", "-m", "test: base");
    }
    const hook = `printf hook >> "${join(h.cwd, "hook-count")}"`;
    const spawned = spawnRun({ ...h, persona, task: "Original assignment", mode: "background", timeoutMs: 12000,
      worktree, mergeStrategy: "squash", onCompleteHook: hook });
    if (worktree) {
      writeFileSync(join(spawned.run.worktreePath!, "change"), "unmerged work");
      git(spawned.run.worktreePath!, "add", "change"); git(spawned.run.worktreePath!, "commit", "-m", "feat: change");
    }
    const run = await spawned.done;
    assert.equal(run.status, "blocked", run.errorMessage);
    const ask = structuredClone(run.pendingAsk);
    const original = { task: run.task, sessionPath: run.sessionPath, cwd: run.cwd, worktreePath: run.worktreePath, worktreeBranch: run.worktreeBranch };
    const message = failure === "B1_REJECT" ? `${failure} ${"x".repeat(100000)}` : failure;
    const sent = sendToRun(run, message, { ...h, timeoutMs: failure === "B1_HANG" ? 2500 : 12000 });
    assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
    const outcome = await sent.done;
    if (failure === "B1_REJECT") {
      const rejection = events(run).find(e => e.type === "response" && e.id === `init-${run.id}` && e.command === "prompt" && e.success === false);
      assert.match(rejection?.error ?? "", /no model selected/i, "native preflight must produce the correlated negative acknowledgement");
    }
    assert.equal(outcome.status, "blocked", "unaccepted answer must not fail the assignment");
    assert.deepEqual(outcome.pendingAsk, ask); assert.deepEqual(record(run).pendingAsk, ask);
    for (const [key, value] of Object.entries(original)) { assert.equal((run as any)[key], value, key); assert.equal(record(run)[key], value, `durable ${key}`); }
    assert.match(run.errorMessage!, /answer.*delivery.*failed/i);
    assert.equal(existsSync(join(h.cwd, "hook-count")), false, "no hook on failed answer delivery");
    if (worktree) { assert.equal(existsSync(join(h.cwd, "change")), false); assert.equal(existsSync(join(run.worktreePath!, "change")), true); }
    assert.equal(run.failureClass, undefined); assert.equal(run.proc, undefined); assert.equal(h.registry.countActive(), 0);
    assert.deepEqual(availableActions(run), ["send", "kill"]); assert.equal(existsSync(run.finalPath), false);
    assert.equal(h.cards.filter(c => c.content.includes("<sub-agent-asked>")).length, 1, "failure is not a duplicate question card");
    assert.match(h.cards.at(-1)!.content, /answer.*delivery.*failed/i);
    assert.doesNotMatch(h.cards.at(-1)!.content, /sub-agent-completed|result-ref/);
    const retry = sendToRun(run, "Use B", { ...h, timeoutMs: 12000 });
    assert.equal(retry.kind, "started"); if (retry.kind !== "started") return;
    assert.equal((await retry.done).status, "completed");
    assert.equal(run.pendingAsk, undefined); assert.equal(record(run).pendingAsk, undefined);
    const receipt = JSON.parse(readFileSync(join(dirname(run.sessionPath!), "receipt.json"), "utf8"));
    assert.match(receipt.message, /owner-answer.*native-ask.*Use A or B\?.*Use B/s);
    assert.equal(h.cards.filter(c => c.content.includes("<sub-agent-completed>")).length, 1);
    assert.equal(run.task, original.task);
    assert.equal(readFileSync(join(h.cwd, "hook-count"), "utf8"), "hook", "exactly one hook after accepted retry");
    if (worktree) assert.equal(readFileSync(join(h.cwd, "change"), "utf8"), "unmerged work");
  });
}
for (const transport of ["print", "explicit-rpc", "large-rpc"]) {
  test(`B1 native acceptance positive control: ${transport}`, { timeout: 30000 }, async t => {
    const h = setup(t);
    const result = spawnRun({ ...h, persona, task: transport === "large-rpc" ? "x".repeat(100000) : "Original assignment", mode: "background", timeoutMs: 12000, steerable: transport === "explicit-rpc" });
    const run = await result.done;
    assert.equal(run.status, "blocked");
    const firstEvents = events(run);
    assert.ok(firstEvents.some(e => e.type === "tool_execution_end" && e.toolName === "ask_owner" && !e.isError));
    const reply = sendToRun(run, transport === "large-rpc" ? `Use B ${"x".repeat(100000)}` : "Use B", { ...h, timeoutMs: 12000 });
    assert.equal(reply.kind, "started"); if (reply.kind !== "started") return;
    assert.deepEqual(run.pendingAsk?.askId, "native-ask", "launch alone cannot clear the ask");
    assert.equal((await reply.done).status, "completed");
    const later = events(run).slice(firstEvents.length);
    assert.ok(later.some(e => e.type === "agent_start"));
    if (transport === "large-rpc") assert.ok(later.some(e => e.type === "response" && e.id === `init-${run.id}` && e.success === true));
    assert.equal(record(run).pendingAsk, undefined);
    assert.equal(h.cards.length, 2);
  });
}
for (const scenario of ["B2_HELD_END", "B2_INFLIGHT", "B2_EXTENSION"]) {
  test(`B2 native ${scenario}: no stale blocked state after actual queued continuation`, { timeout: 30000 }, async t => {
    const h = setup(t);
    const queue = new SpawnQueue(h.registry, 1);
    let sent: ReturnType<typeof sendToRun> | undefined;
    let admissionActions: string[] = [];
    const result = spawnRun({ ...h, persona, task: scenario, mode: "background", timeoutMs: 12000, steerable: true,
      onCompleteHook: `printf hook >> "${join(h.cwd, "hook-count")}"` });
    let finishIndependent!: (r: Run) => void;
    const independent = new Promise<Run>(resolve => { finishIndependent = resolve; });
    const queued = queue.enqueueOrSpawn({ ...h, persona, task: "CONTROL independent work", mode: "background", timeoutMs: 12000, onComplete: finishIndependent });
    assert.equal(queued.kind, "queued");
    const run = result.run;
    let buffer = "";
    run.proc!.stdout!.on("data", chunk => {
      buffer += chunk.toString(); let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const e = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (e.type !== "probe") continue;
        admissionActions = availableActions(run);
        sent = sendToRun(run, "Use B from the racing owner answer", { ...h, timeoutMs: 12000, streamingBehavior: "follow_up" });
        if (sent.kind === "started") void sent.ack?.catch(() => {});
        if (scenario === "B2_HELD_END") {
          const release = () => run.rpcStdinQueue!.enqueue({ type: "release" } as any);
          if (sent.kind === "started") void sent.ack!.then(release, release);
          else void release();
        }
      }
    });
    const finished = await result.done;
    if (scenario === "B2_HELD_END") {
      assert.equal(sent?.kind, "rejected", "unresolved ask execution closes the shared live-send gate");
      assert.deepEqual(admissionActions.filter(a => a === "steer" || a === "follow_up"), []);
      assert.equal(finished.status, "blocked"); assert.equal(record(run).pendingAsk.askId, "native-ask");
      assert.equal(h.cards.length, 1); assert.match(h.cards[0].content, /sub-agent-asked/);
      assert.ok(!events(run).some(e => e.type === "response" && e.command === "follow_up"));
    } else {
      if (scenario === "B2_INFLIGHT") {
        assert.equal(sent?.kind, "started");
        if (sent?.kind === "started") assert.equal((await sent.ack!).delivered, true);
      }
      assert.equal(finished.status, "completed", "consumed native continuation supersedes the earlier stopping question");
      assert.equal(run.pendingAsk, undefined); assert.equal(record(run).pendingAsk, undefined);
      assert.match(getFinalText(run.messages), /Used B/);
      assert.equal(h.cards.length, 1); assert.match(h.cards[0].content, /sub-agent-completed/); assert.doesNotMatch(h.cards[0].content, /sub-agent-asked/);
      const stream = events(run);
      const endIndex = stream.findIndex(e => e.type === "tool_execution_end" && e.toolName === "ask_owner");
      const userIndex = stream.findIndex((e, i) => i > endIndex && e.type === "message_end" && e.message?.role === "user");
      const assistantIndex = stream.findIndex((e, i) => i > userIndex && e.type === "message_end" && e.message?.role === "assistant");
      assert.ok(endIndex >= 0 && userIndex > endIndex && assistantIndex > userIndex, "native order: accepted ask, consumed user, next assistant response");
    }
    assert.equal((await independent).status, "completed", "blocked or completed work frees the queue slot");
    if (scenario === "B2_HELD_END") assert.equal(existsSync(join(h.cwd, "hook-count")), false);
    else assert.equal(readFileSync(join(h.cwd, "hook-count"), "utf8"), "hook", "one hook after truthful completion");
    assert.equal(h.registry.countActive(), 0); assert.equal(queue.size(), 0);
  });
}
