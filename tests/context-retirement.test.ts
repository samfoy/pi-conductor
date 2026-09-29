import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import conductor from "../src/index.ts";
import { loadConfig, userConfigPath } from "../src/config.ts";
import { renderForegroundSummary } from "../src/foreground-stream.ts";
import { buildCompletionMessage } from "../src/notifications.ts";
import { emptyUsage, toRunRecord, type Run } from "../src/types.ts";
import { reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { RunRegistry, validateSendable } from "../src/runs.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
const marker = "conductor-context-retired";
const entry = (sessionId: string) => ({ type: "custom", customType: marker, data: { sessionId } });
// The mock crosses ExtensionAPI's heterogeneous event union, not production types.
type Handler = (event: any, ctx: any) => any;
function child(t: test.TestContext, childEnv = "1") {
  const prior = process.env.CONDUCTOR_SUBAGENT;
  process.env.CONDUCTOR_SUBAGENT = childEnv;
  t.after(() => { if (prior === undefined) delete process.env.CONDUCTOR_SUBAGENT; else process.env.CONDUCTOR_SUBAGENT = prior; });
  const cwd = tmpDir("a2-child-");
  let sessionId = "child-session";
  const entries: ReturnType<typeof entry>[] = [];
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (name: string, h: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), h]),
    registerFlag() {}, getFlag() {},
    registerTool() {}, registerCommand() {}, registerShortcut() {}, registerMessageRenderer() {},
    appendEntry: (customType: string, data: { sessionId: string }) => entries.push({ type: "custom", customType, data }),
  };
  conductor(pi as any);
  const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getEntries: () => entries } };
  return {
    cwd, entries, pi, setSession: (id: string) => { sessionId = id; },
    async fire(name: string, event: any) {
      let result;
      for (const h of handlers.get(name) ?? []) {
        const next = await h(event, ctx);
        if (next !== undefined) result = next;
        if (next?.messages) event = { ...event, messages: next.messages };
      }
      return result;
    },
  };
}
function config(cwd: string, value: unknown) {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(join(cwd, ".pi/conductor.json"), JSON.stringify({ contextRetirement: value }));
}

test("A2 config: defaults true, boolean user/project precedence, invalid values ignored", () => {
  const cwd = tmpDir("a2-config-");
  assert.equal(loadConfig(cwd).contextRetirement, true);
  const user = userConfigPath();
  mkdirSync(join(user, ".."), { recursive: true });
  writeFileSync(user, JSON.stringify({ contextRetirement: false }));
  try {
    assert.equal(loadConfig(cwd).contextRetirement, false);
    config(cwd, true);
    assert.equal(loadConfig(cwd).contextRetirement, true);
    config(cwd, "false");
    assert.equal(loadConfig(cwd).contextRetirement, false);
  } finally { writeFileSync(user, "{}"); }
});

for (const reason of ["threshold", "overflow", "manual"]) {
  test(`A2 child compaction: ${reason}`, async (t) => {
    const c = child(t);
    const result = await c.fire("session_before_compact", { reason });
    assert.deepEqual(result, reason === "threshold" ? { cancel: true } : undefined);
    assert.deepEqual(c.entries, reason === "manual" ? [] : [entry("child-session")]);
    await c.fire("session_before_compact", { reason });
    assert.equal(c.entries.length, reason === "manual" ? 0 : 1, "marker is idempotent");
  });
}

test("A2 child marker is session-scoped across copied history and survives reload", async (t) => {
  const c = child(t);
  c.entries.push(entry("parent-session"));
  await c.fire("session_before_compact", { reason: "threshold" });
  assert.deepEqual(c.entries, [entry("parent-session"), entry("child-session")]);
  c.setSession("next-child");
  const event = { messages: [] };
  assert.deepEqual((await c.fire("context", event))?.messages ?? [], [], "another session's marker is inert");
  await c.fire("session_before_compact", { reason: "overflow" });
  assert.deepEqual(c.entries.at(-1), entry("next-child"));
});

test("A2 request-local hidden guidance preserves input and never persists a message", async (t) => {
  const c = child(t);
  c.entries.push(entry("child-session")); // reload: no in-memory retirement flag
  const messages = [{ role: "user", content: "task", timestamp: 1 }];
  const before = structuredClone(messages);
  for (let i = 0; i < 3; i++) {
    const result = await c.fire("context", { messages });
    assert.equal(result?.messages.length, 2, "one finalization instruction per request");
    const guidance = result.messages[1];
    assert.equal(guidance.role, "custom");
    assert.equal(guidance.display, false);
    assert.match(guidance.content, /coherent operation/i);
    assert.match(guidance.content, /no new objectives/i);
    assert.match(guidance.content, /essential validation/i);
    for (const term of ["handoff", "completed", "current state", "files", "checks", "unresolved", "next steps"]) assert.match(guidance.content, new RegExp(term, "i"));
    assert.match(guidance.content, /not.*complet/i, "retirement does not imply completion");
    const repeated = await c.fire("context", { messages: result.messages });
    assert.equal(repeated.messages.length, 2, "even an already transformed request has one instruction");
  }
  assert.deepEqual(messages, before);
  assert.deepEqual(c.entries, [entry("child-session")]);
});

test("A2 persistence failure never cancels threshold or injects retirement guidance", async (t) => {
  const c = child(t);
  c.pi.appendEntry = () => { throw new Error("disk full"); };
  await assert.rejects(c.fire("session_before_compact", { reason: "threshold" }), /disk full/);
  assert.deepEqual((await c.fire("context", { messages: [] }))?.messages ?? [], []);
});

for (const scope of ["parent", "disabled"]) {
  test(`A2 ${scope} bypasses compaction and prior retirement markers`, async (t) => {
    const c = child(t, scope === "parent" ? "0" : "1");
    if (scope === "disabled") config(c.cwd, false);
    c.entries.push(entry("child-session"));
    for (const reason of ["manual", "threshold", "overflow"]) assert.equal(await c.fire("session_before_compact", { reason }), undefined);
    assert.deepEqual((await c.fire("context", { messages: [] }))?.messages ?? [], []);
    assert.deepEqual(c.entries, [entry("child-session")]);
  });
}

function runFixture(): Run {
  const cwd = join(tmpDir("a2-record-"), "oracle-retired");
  mkdirSync(cwd);
  return { id: "oracle-retired", persona: "oracle", task: "test", mode: "background", status: "completed", startTime: 1, lastEventAt: 2, finishedAt: 2, cwd,
    messages: [], usage: emptyUsage(), recordPath: join(cwd, "record.json"), transcriptPath: join(cwd, "transcript.jsonl"), finalPath: join(cwd, "final.md"), sessionPath: join(cwd, "session.jsonl"), contextRetired: true };
}

test("A2 record roundtrip and startup reconcile retain retirement before send validation", async () => {
  const run = runFixture();
  writeFileSync(run.sessionPath!, JSON.stringify({ type: "session", id: "child-session" }) + "\n");
  const record = toRunRecord(run);
  assert.equal(record.contextRetired, true);
  writeFileSync(run.recordPath, JSON.stringify({ ...record, status: "running", pid: 999999 }));
  const registry = new RunRegistry();
  await reconcileOrphansAtStartup({ runsRoot: join(run.cwd, ".."), registry, isAlive: () => false, now: 3 });
  const restored = registry.get(run.id)!;
  assert.ok(restored);
  assert.equal(restored.contextRetired, true);
  assert.equal(validateSendable(restored).ok, false);
  config(run.cwd, false);
  assert.equal(validateSendable(restored).ok, true, "disabled setting permits prior retired sessions");
});

test("A2 foreground and background output say retired, fresh child, handoff without changing status", () => {
  const run = runFixture();
  for (const text of [renderForegroundSummary(run), buildCompletionMessage(run).content, JSON.stringify(buildCompletionMessage(run).details)]) {
    assert.match(text, /session retired/i);
    assert.match(text, /fresh child/i);
    assert.match(text, /handoff/i);
  }
  assert.equal(run.status, "completed");
  run.contextRetired = undefined;
  assert.doesNotMatch(renderForegroundSummary(run), /session retired/i);
  assert.doesNotMatch(buildCompletionMessage(run).content, /session retired/i);
});

test("A2 isolated children resolve retirement config from the spawning project, not an unconfigured worktree", async (t) => {
  const c = child(t);
  const sourceCwd = tmpDir("a2-source-config-");
  config(sourceCwd, false);
  const previous = process.env.CONDUCTOR_CONFIG_CWD;
  process.env.CONDUCTOR_CONFIG_CWD = sourceCwd;
  t.after(() => { if (previous === undefined) delete process.env.CONDUCTOR_CONFIG_CWD; else process.env.CONDUCTOR_CONFIG_CWD = previous; });
  c.entries.push(entry("child-session"));
  assert.equal(await c.fire("session_before_compact", { reason: "threshold" }), undefined);
  assert.deepEqual((await c.fire("context", { messages: [] }))?.messages ?? [], []);
});
