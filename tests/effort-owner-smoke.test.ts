import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openEffort, ownedEffort } from "../src/effort/open.ts";
import { effortDir } from "../src/effort/store.ts";
import { registerTools } from "../src/tools.ts";
import { registerCommands } from "../src/commands.ts";
import { executePromptAndSend } from "../src/prompt-and-send.ts";
import { loadConfig } from "../src/config.ts";
import { resolvePersonas } from "../src/personas.ts";
import { buildCompletionMessage } from "../src/notifications.ts";
import { validateSendable, resolveTimeoutMs, availableActions, forceTerminate, RunRegistry, sendToRun, spawnRun } from "../src/runs.ts";
import { reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { toRunRecord, type Persona, type Run } from "../src/types.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
const project = fileURLToPath(new URL("..", import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe" }).trim();
const persona: Persona = { name: "builder", description: "fixture", inheritContext: "filtered", inheritSkills: false, defaultReads: [], worktree: false, timeoutMinutes: 1, readOnly: false, systemPrompt: "fixture", source: "builtin", sourcePath: "/fixture" };
function fixture() {
  const cwd = tmpDir("effort-owner-"); git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  mkdirSync(join(cwd, "pkg")); writeFileSync(join(cwd, "pkg", "file"), "base");
  writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "pkg", ".gitignore"); git(cwd, "commit", "-m", "base");
  const stub = join(tmpDir("effort-answer-stub-"), "pi.mjs");
  writeFileSync(stub, `import { writeFileSync, readFileSync } from "node:fs";
    import { execFileSync } from "node:child_process";
    import { gitTestEnv } from ${JSON.stringify(new URL("./helpers/git-env.ts", import.meta.url).href)};
    const args = process.argv.slice(2);
    const header = JSON.parse(readFileSync(args[args.indexOf("--session") + 1], "utf8").split("\\n")[0]);
    if (process.cwd() !== header.cwd) throw new Error("session/process cwd mismatch");
    const emit = event => console.log(JSON.stringify(event));
    if (args.at(-1).includes("<owner-answer")) {
      writeFileSync("answered", "accepted");
      execFileSync("git", ["add", "answered"], { env: gitTestEnv() });
      execFileSync("git", ["commit", "-m", "answer"], { env: gitTestEnv() });
      emit({ type: "agent_start" });
      emit({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Answered the owner question and completed the original assignment in its preserved worktree." }] } });
    } else {
      const ask = { askId: "choice", question: "Which option?", evidence: "" };
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "ask_owner", id: ask.askId }] } });
      emit({ type: "tool_execution_start", toolCallId: ask.askId, toolName: "ask_owner", args: { question: ask.question } });
      emit({ type: "tool_execution_end", toolCallId: ask.askId, toolName: "ask_owner", isError: false, result: { terminate: true, details: ask } });
    }
    emit({ type: "agent_settled" });`);
  return { cwd, stub };
}
function options(cwd: string, registry: RunRegistry) {
  return { cwd, registry, persona, effort: "one", parentSessionId: "owner", mode: "background" as const, task: "original assignment", timeoutMs: 5000, parentMessages: [{ role: "user" as const, content: "context", timestamp: 0 }] };
}
function snapshot(run: Run) {
  const dir = effortDir(run.effort!.gitRoot, run.effort!.name);
  return { recordState: toRunRecord(run), proc: run.proc, timer: run.timeoutTimer, status: run.status, ask: structuredClone(run.pendingAsk), effort: structuredClone(run.effort), session: run.sessionPath, branch: run.worktreeBranch, path: run.worktreePath, task: run.task,
    record: readFileSync(run.recordPath), sessionBytes: readFileSync(run.sessionPath!), effortBytes: readFileSync(join(dir, "effort.json")), lock: readFileSync(join(dir, "effort.lock")),
    head: git(run.effort!.gitRoot, "rev-parse", "HEAD"), index: readFileSync(join(run.effort!.gitRoot, ".git", "index")), worktrees: git(run.effort!.gitRoot, "worktree", "list", "--porcelain"),
    workHead: git(run.worktreePath!, "rev-parse", "HEAD"), workStatus: git(run.worktreePath!, "status", "--porcelain") };
}

test("B1 separate dead owner: reconcile cannot authorize an effort answer in a new process/session", { timeout: 20000 }, async t => {
  const { cwd, stub } = fixture();
  const source = `import { openEffort } from ${JSON.stringify(new URL("../src/effort/open.ts", import.meta.url).href)};
    import { RunRegistry, spawnRun } from ${JSON.stringify(new URL("../src/runs.ts", import.meta.url).href)};
    openEffort(${JSON.stringify(cwd)}, "one", "owner", { verify: "" });
    const { run, done } = spawnRun({ ...${JSON.stringify(options(join(cwd, "pkg"), new RunRegistry()))}, registry: new RunRegistry() });
    await done; if (run.status !== "blocked") throw new Error(run.errorMessage || run.status);
    console.log(JSON.stringify({ id: run.id, recordPath: run.recordPath, ownerPid: process.pid }));`;
  const owner = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: project, env: gitTestEnv({ PI_BIN: stub }), encoding: "utf8", timeout: 10000 }));
  const saved = process.env.PI_BIN; process.env.PI_BIN = stub;
  t.after(() => { if (saved === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = saved; });
  assert.throws(() => ownedEffort(cwd, "one", "new-session"), /owner|owned/);
  const registry = new RunRegistry();
  await reconcileOrphansAtStartup({ registry, runsRoot: dirname(dirname(owner.recordPath)), now: Date.now(), isAlive: () => assert.fail("blocked must not probe child liveness"), selfSessionId: "new-session" });
  const run = registry.get(owner.id)!;
  assert.equal(run.status, "blocked"); assert.equal(run.parentPid, process.pid, "reconcile reassigns process bookkeeping, not the effort claim");
  assert.notEqual(owner.ownerPid, process.pid);
  t.after(() => { if (run.status === "running") forceTerminate(run, "killed", registry); });
  const before = snapshot(run);
  const advertised = availableActions(run, false, "new-session").includes("send");
  const sent = sendToRun(run, "Use A", { registry, timeoutMs: 5000, sessionId: "new-session" });
  if (sent.kind === "started") await sent.done;
  assert.deepEqual({ advertised, result: sent.kind, answered: existsSync(join(run.effort!.cwd!, "answered")) }, { advertised: false, result: "rejected", answered: false }, "foreign owner must neither advertise nor dispatch send");
  for (const sessionId of [undefined, "owner"]) {
    assert.equal(availableActions(run, false, sessionId).includes("send"), false, "unknown identity or matching session name without matching PID/start is not ownership");
    assert.equal(sendToRun(run, "Use A", { registry, timeoutMs: 5000, sessionId }).kind, "rejected");
  }
  assert.deepEqual(snapshot(run), before, "refusal leaves all assignment and durable bytes untouched");
});

test("B1 same-owner linked-checkout answer works; changed claim invalidates an earlier action snapshot", { timeout: 15000 }, async t => {
  const { cwd, stub } = fixture(); const caller = tmpDir("effort-answer-linked-"); git(cwd, "worktree", "add", "-b", "caller", caller);
  const saved = process.env.PI_BIN; process.env.PI_BIN = stub;
  t.after(() => { if (saved === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = saved; });
  openEffort(join(caller, "pkg"), "one", "owner", { verify: "" });
  const registry = new RunRegistry(); const { run, done } = spawnRun(options(join(caller, "pkg"), registry));
  t.after(() => { if (run.status === "running") forceTerminate(run, "killed", registry); });
  await done; assert.equal(run.status, "blocked");
  assert.ok(availableActions(run, false, "owner").includes("send"));
  assert.equal(availableActions(run).includes("send"), false, "missing current identity fails closed");
  const lock = join(effortDir(cwd, "one"), "effort.lock"); const original = readFileSync(lock);
  for (const change of [{ sessionId: "changed-session" }, { pid: process.pid + 1 }, { startTime: 0 }]) {
    writeFileSync(lock, JSON.stringify({ ...JSON.parse(original.toString()), ...change }));
    const before = snapshot(run);
    const refused = sendToRun(run, "A", { registry, timeoutMs: 5000, sessionId: "owner" });
    if (refused.kind === "started") await refused.done;
    assert.equal(refused.kind, "rejected", "execution rechecks session, pid and start identity in the current claim");
    assert.deepEqual(snapshot(run), before);
  }
  writeFileSync(lock, original);
  const branch = run.worktreeBranch; const path = run.worktreePath;
  const sent = sendToRun(run, "A", { registry, timeoutMs: 5000, sessionId: "owner" });
  assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
  await sent.done;
  assert.equal(run.status, "completed"); assert.equal(run.worktreeBranch, branch); assert.equal(run.worktreePath, path); assert.equal(run.task, "original assignment");
  assert.equal(readFileSync(join(path!, "pkg", "answered"), "utf8"), "accepted");
});

for (const surface of ["tool", "slash", "overlay"] as const) {
  test(`B1 ${surface} threads actual current identity for refusal and same-owner answer`, { timeout: 15000 }, async t => {
    const { cwd, stub } = fixture(); const saved = process.env.PI_BIN; process.env.PI_BIN = stub;
    t.after(() => { if (saved === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = saved; });
    openEffort(cwd, "one", "owner", { verify: "" });
    const registry = new RunRegistry(); const { run, done } = spawnRun(options(join(cwd, "pkg"), registry));
    t.after(() => { if (run.status === "running") forceTerminate(run, "killed", registry); });
    await done; assert.equal(run.status, "blocked");
    let currentSession = "foreign"; const getSessionId = () => currentSession;
    const notes: string[] = [];
    const ctx = { mode: "json", ui: { notify: (m: string) => notes.push(m), input: async () => "A" } };
    const opts = { getCwd: () => cwd, getSessionId, getRegistry: () => registry, getQueue: () => ({ list: () => [] }), getParentMessages: () => [], pushCompletionNotification: () => {}, registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }) };
    const tools = new Map<string, any>(); let command: any;
    registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, opts as any, {});
    registerCommands({ registerCommand: (_name: string, c: any) => { command = c; } } as any, opts as any);
    const dispatch = async () => {
      if (surface === "tool") return tools.get("ensemble_send").execute("send", { agent_id: run.id, message: "A", foreground: true }, undefined, undefined, ctx);
      if (surface === "slash") return command.handler(`send ${run.id} A`, ctx);
      return executePromptAndSend({ getCtx: () => ctx, getSessionId, registry, cwd, validateSendable, loadConfig, resolvePersonas: args => resolvePersonas(args as any), resolveTimeoutMs: (p, o, c) => resolveTimeoutMs(p as any, o as any, c as any), sendToRun: sendToRun as any, pushCompletionNotification: () => {} }, run.id, "A");
    };
    const before = snapshot(run);
    const status = await tools.get("ensemble_status").execute("status", { agent_id: run.id }, undefined, undefined, ctx);
    assert.equal(status.details.blocked[0].available_actions.includes("send"), false);
    await dispatch();
    assert.deepEqual(snapshot(run), before, "foreign surface invocation preserves assignment and durable bytes");
    currentSession = "owner";
    const ownedStatus = await tools.get("ensemble_status").execute("status", { agent_id: run.id }, undefined, undefined, ctx);
    assert.ok(ownedStatus.details.blocked[0].available_actions.includes("send"));
    assert.ok(buildCompletionMessage(run, false, getSessionId()).details.available_actions!.includes("send"));
    const completed = new Promise<void>(resolve => { const off = registry.onChange(r => { if (r.id === run.id && r.status === "completed") { off(); resolve(); } }); t.after(off); });
    await dispatch();
    assert.notEqual(run.status, "blocked", notes.join("\n"));
    await completed;
    assert.equal(readFileSync(join(run.worktreePath!, "pkg", "answered"), "utf8"), "accepted");
    assert.equal(run.task, "original assignment");
  });
}
