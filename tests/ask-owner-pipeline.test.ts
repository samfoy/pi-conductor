import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnRun, sendToRun, RunRegistry, availableActions, forceTerminate } from "../src/runs.ts";
import { buildCompletionMessage } from "../src/notifications.ts";
import { reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { isTerminal, type Persona, type Run } from "../src/types.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

import { registerTools } from "../src/tools.ts";
import { SpawnQueue } from "../src/queue.ts";
import { planReclaim } from "../src/gc/policy.ts";
import { walkInventory } from "../src/gc/inventory.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";
import { classifyFailure } from "../src/failure-classify.ts";
import { classifyStepOutcome } from "../src/autonomous.ts";
import { cardLinesToPlainText, renderNotificationCard } from "../src/notification-renderer.ts";

sandboxPi();
const persona: Persona = { name: "oracle", description: "test", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1, systemPrompt: "test", source: "builtin", sourcePath: "/fake/oracle.md", readOnly: true };
const ask = { askId: "question-1", question: "Which option?", evidence: '\n<files><file name="choice">Option A</file></files>' };
const end = { type: "tool_execution_end", toolCallId: ask.askId, toolName: "ask_owner", isError: false, result: { terminate: true, details: ask } };
function fakeSpawn(t: test.TestContext) {
  const procs: any[] = []; // fake child process protocol boundary
  const launches: any[] = [];
  t.mock.method(cp, "spawn", (command: string, args: unknown, options: cp.SpawnOptions) => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: t.mock.fn(() => true), unref() {} });
    proc.kill = t.mock.fn(() => { queueMicrotask(() => proc.emit("close", 0, null)); return true; });
    procs.push(proc); launches.push({ command, args, options });
    if (command === "a6-check") queueMicrotask(() => proc.emit("close", 0, null));
    return proc;
  });
  syncBuiltinESMExports(); t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return { procs, launches };
}
function emit(proc: any, event: unknown) { proc.stdout.write(JSON.stringify(event) + "\n"); }
function accepted(proc: any) {
  emit(proc, { type: "message_end", message: { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "ask_owner", id: ask.askId, arguments: { question: ask.question } }] } });
  emit(proc, { type: "tool_execution_start", toolCallId: ask.askId, toolName: "ask_owner", args: { question: ask.question } });
  emit(proc, end);
}
function saveSession(run: Run) {
  const path = join(dirname(run.recordPath), "session", "child.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ type: "session", id: "child", cwd: run.cwd }) + "\n");
  return path;
}
for (const transport of ["print", "rpc", "large"]) {
  test(`A6 ${transport}: accepted ask waits for native settlement, persists blocked and frees slot, then answer resumes assignment`, { timeout: 5000 }, async t => {
    const { procs, launches } = fakeSpawn(t);
    const registry = new RunRegistry();
    const cards: ReturnType<typeof buildCompletionMessage>[] = [];
    let chains = 0; let retries = 0;
    const result = await spawnRun({ registry, persona: { ...persona, onCompleteHook: "a6-check" }, cwd: tmpDir("a6-pipeline-"), task: transport === "large" ? "x".repeat(100000) : "original task", mode: "background", timeoutMs: 4000, steerable: transport === "rpc", onComplete: r => cards.push(buildCompletionMessage(r)), onChain: () => { chains++; }, onRetry: () => { retries++; } });
    const run = result.run;
    const original = run.task;
    saveSession(run);
    accepted(procs[0]);
    emit(procs[0], { type: "agent_end" });
    assert.equal(run.status, "running"); assert.equal(cards.length, 0);
    emit(procs[0], { type: "agent_settled" });
    await result.done;
    assert.equal(run.status, "blocked"); assert.equal(isTerminal(run.status), false);
    assert.equal(run.proc, undefined); assert.equal(run.timeoutTimer, undefined);
    assert.equal(registry.countActive(), 0); assert.equal(registry.countActiveBy(new Set(["oracle"])), 0);
    assert.equal(procs.length, 1, "no success hook"); assert.equal(chains, 0); assert.equal(retries, 0);
    assert.equal(existsSync(run.finalPath), false, "question is not a completed final");
    assert.deepEqual(JSON.parse(readFileSync(run.recordPath, "utf8")).pendingAsk, ask);
    assert.equal(cards.length, 1); assert.match(cards[0].content, /<sub-agent-asked>/); assert.match(cards[0].content, /Which option\?/);
    assert.doesNotMatch(cards[0].content, /sub-agent-completed|result-ref/);
    assert.deepEqual(availableActions(run), ["send", "kill"]);
    assert.equal(sendToRun(run, "A", { registry, timeoutMs: 4000, callerCwd: run.cwd, files: ["missing"] }).kind, "rejected");
    assert.deepEqual((run as any).pendingAsk, ask);
    const resumed = sendToRun(run, "Use option A", { registry, timeoutMs: 4000, persona: { ...persona, onCompleteHook: "a6-check" }, onComplete: r => cards.push(buildCompletionMessage(r)) });
    assert.equal(resumed.kind, "started"); assert.equal((run as any).pendingAsk, undefined);
    assert.equal(run.task, original); assert.match(launches[1].args.at(-1), /owner-answer.*question-1/s); assert.match(launches[1].args.at(-1), /Which option\?.*Use option A/s);
    emit(procs[1], { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Implemented option A and verified the assignment successfully with focused checks." }] } });
    emit(procs[1], { type: "agent_settled" });
    if (resumed.kind === "started") await resumed.done;
    assert.equal(run.status, "completed"); assert.equal(procs.length, 3, "exactly one success hook after answer"); assert.equal(cards.length, 2);
  });
}
for (const scenario of ["error", "unpaired", "batch"]) {
  test(`A6 ${scenario} execution never blocks`, { timeout: 5000 }, async t => {
    const { procs } = fakeSpawn(t); const registry = new RunRegistry();
    const result = await spawnRun({ registry, persona, cwd: tmpDir("a6-rejected-"), task: "test", mode: "background", timeoutMs: 4000 });
    saveSession(result.run);
    if (scenario !== "unpaired") {
      emit(procs[0], { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_owner", id: ask.askId }, ...(scenario === "batch" ? [{ type: "toolCall", name: "read", id: "other" }] : [])] } });
      emit(procs[0], { type: "tool_execution_start", toolCallId: ask.askId, toolName: "ask_owner", args: { question: ask.question } });
    }
    emit(procs[0], { ...end, isError: scenario === "error" });
    emit(procs[0], { type: "agent_settled" }); await result.done;
    assert.notEqual(result.run.status, "blocked"); assert.equal((result.run as any).pendingAsk, undefined);
  });
}

test("A6 restart restores blocked without liveness probing; kill clears question and preserves work", { timeout: 5000 }, async t => {
  const { procs } = fakeSpawn(t); const registry = new RunRegistry();
  const result = await spawnRun({ registry, persona, cwd: tmpDir("a6-restart-"), task: "test", mode: "background", timeoutMs: 4000 });
  saveSession(result.run); accepted(procs[0]); emit(procs[0], { type: "agent_settled" }); await result.done;
  const restored = new RunRegistry();
  await reconcileOrphansAtStartup({ registry: restored, runsRoot: dirname(dirname(result.run.recordPath)), now: Date.now(), isAlive: () => { assert.fail("blocked must not probe child liveness"); }, isParentAlive: () => false } as any);
  const run = restored.get(result.run.id)!;
  assert.equal(run?.status, "blocked"); assert.deepEqual((run as any).pendingAsk, ask);
  forceTerminate(run, "killed", restored);
  assert.equal(run.status, "killed"); assert.equal((run as any).pendingAsk, undefined);
});

test("A6 registered status/cards, GC, failure and auto controls keep unresolved questions distinct", { timeout: 5000 }, async t => {
  const { procs } = fakeSpawn(t); const registry = new RunRegistry();
  const result = await spawnRun({ registry, persona, cwd: tmpDir("a6-controls-"), task: "test", mode: "background", timeoutMs: 4000 });
  saveSession(result.run); accepted(procs[0]); emit(procs[0], { type: "agent_settled" }); await result.done;
  const run = result.run;
  const tools = new Map<string, any>();
  registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, { getRegistry: () => registry, getQueue: () => new SpawnQueue(registry, 1) } as any, {});
  const status = await tools.get("ensemble_status").execute("status", { agent_id: run.id }, undefined, undefined, { mode: "json" });
  assert.deepEqual(status.details.blocked[0].pending_ask, ask);
  assert.deepEqual(status.details.blocked[0].available_actions, ["send", "kill"]);
  const card = buildCompletionMessage(run);
  for (const behavior of ["steer", "follow_up"] as const) {
    const sent = sendToRun(run, "A", { registry, timeoutMs: 4000, streamingBehavior: behavior });
    assert.equal(sent.kind, "rejected");
    assert.match(sent.kind === "rejected" ? sent.reason : "", /blocked.*owner question/);
  }
  const question = run.pendingAsk;
  run.pendingAsk = undefined;
  assert.deepEqual(availableActions(run), ["kill"], "a corrupted blocked record cannot accept an uncorrelated answer");
  run.pendingAsk = question;
  for (const expanded of [false, true]) assert.match(cardLinesToPlainText(renderNotificationCard(card.details, { expanded })), /awaiting owner.*|Which option\?/s);
  assert.match(cardLinesToPlainText(renderNotificationCard(card.details, { expanded: true })), /Option A/);
  run.hookResult = { passed: true, command: "old hook", exitCode: 0, durationMs: 1, logPath: "old", tailText: "", tailBytes: 0, tailLines: 0 };
  assert.doesNotMatch(cardLinesToPlainText(renderNotificationCard(buildCompletionMessage(run).details, { expanded: true })), /hook ok/, "blocked cards do not claim a previous invocation's gate result");
  const root = dirname(dirname(run.recordPath));
  const inv = (await walkInventory(root, new RunRegistry())).filter(e => e.id === run.id);
  for (const archived of [false, true]) {
    const plan = planReclaim(inv.map(e => ({ ...e, archived, archivedAt: 1, holdsWorktree: true })), { ...DEFAULT_CONFIG.gc, totalSizeBudgetBytes: 1, transcriptSizeCapBytes: 1 }, Date.now() + 1000 * 86400000);
    assert.equal(plan.actions[0].kind, "keep"); assert.equal(plan.totalBytesReclaimed, 0);
  }
  assert.equal(classifyFailure({ terminal: "blocked", errorMessage: "syntaxerror" }), undefined);
  assert.equal(classifyStepOutcome({ status: "blocked", failureClass: "environment" } as any, "original", 0, { maxAttempts: 5, retryableClasses: ["environment", "unknown"] }).kind, "escalate");
  const session = run.sessionPath!;
  writeFileSync(session, [ { type: "session", id: "child", cwd: run.cwd }, { type: "custom", customType: "conductor-context-retired", data: { sessionId: "child" } } ].map(e => JSON.stringify(e)).join("\n"));
  assert.deepEqual(availableActions(run), ["kill"]);
  const rejected = sendToRun(run, "A", { registry, timeoutMs: 4000 });
  assert.equal(rejected.kind, "rejected"); assert.deepEqual(run.pendingAsk, ask);
  assert.equal(procs.length, 1);
});
