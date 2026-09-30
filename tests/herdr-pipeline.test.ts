import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { sandboxPi } from "./helpers/tmp.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { createRunPipeline } from "../src/run-pipeline.ts";
sandboxPi();

test("H7 fast readiness/settle race feeds native pipeline exactly once without parent transcript writes", { timeout: 5000 }, async () => {
  const h = herdrFixture(); let callbacks = 0; const seen: unknown[] = [];
  const done = createRunPipeline(h.run, [], { ...h.opts, onComplete: () => callbacks++, onEvent: (_run, event) => seen.push(event) });
  await done;
  assert.equal(h.run.status, "completed"); assert.equal(callbacks, 1); assert.equal(h.run.usage.turns, 1); assert.equal(h.run.usage.input, 12);
  assert.match(readFileSync(h.run.finalPath, "utf8"), /漢🙂/);
  assert.equal(seen.filter((e: any) => e.type === "agent_settled").length, 1);
  assert.equal(readFileSync(h.run.transcriptPath, "utf8").trim().split("\n").length, 6, "child is sole transcript writer");
  assert.deepEqual(h.signals, []); assert.equal(h.calls.filter(c => c === "pane close").length, 0);
});
for (const mode of ["crash", "partial"]) test(`H7 ${mode} without complete native settle fails environment, not success`, { timeout: 5000 }, async () => {
  const h = herdrFixture(mode); await createRunPipeline(h.run, [], h.opts);
  assert.equal(h.run.status, "failed"); assert.equal(h.run.failureClass, "environment"); assert.match(h.run.errorMessage!, /exited before settling/);
});
test("H7 held child exit prevents hook execution and completion", { timeout: 5000 }, async () => {
  const h = herdrFixture("held"); let waited = false;
  h.onSleep(() => { assert.equal(h.run.hookResult, undefined, "unsafe hook before child exit"); assert.equal(existsSync(h.run.finalPath), false); waited = true; h.exit(); });
  await createRunPipeline(h.run, [], { ...h.opts, resolvedHook: { command: "true", timeoutSeconds: 5, source: "per-call" } });
  assert.equal(waited, true); assert.equal(h.run.hookResult?.passed, true); assert.equal(h.run.status, "completed");
});
test("H7 unproven exit preserves worktree and never executes hook", { timeout: 5000 }, async () => {
  const h = herdrFixture("stubborn"); h.run.worktreePath = "/preserved/worktree"; h.run.worktreeBranch = "preserved";
  await createRunPipeline(h.run, [], { ...h.opts, resolvedHook: { command: "true", timeoutSeconds: 5, source: "per-call" } });
  assert.equal(h.run.hookResult, undefined, "unsafe hook without exit proof"); assert.equal(h.run.worktreePath, "/preserved/worktree");
  assert.equal(h.run.status, "failed"); assert.match(h.run.errorMessage!, /exit unconfirmed/);
});

test("H7 projected A6 ask blocks only after child exit, without hook/final/retry", { timeout: 5000 }, async () => {
  const h = herdrFixture("ask"); let callbacks = 0;
  h.onSleep(() => { assert.equal(h.run.status, "running"); assert.equal(callbacks, 0); assert.equal(existsSync(h.run.finalPath), false); h.exit(); });
  await createRunPipeline(h.run, [], { ...h.opts, resolvedHook: { command: "false", timeoutSeconds: 1, source: "per-call" }, onComplete: () => { callbacks++; assert.equal(h.gone(), true); }, onRetry: () => assert.fail("blocked cannot retry") });
  assert.equal(h.run.status, "blocked"); assert.deepEqual(h.run.pendingAsk, { askId: "question", question: "Choose?", evidence: "original evidence" });
  assert.equal(h.run.hookResult, undefined); assert.equal(existsSync(h.run.finalPath), false); assert.equal(callbacks, 1);
});
for (const mode of ["preaccept-death", "healthy"]) test(`H7 saved owner answer ${mode} retains question until ack plus correlated start`, { timeout: 5000 }, async () => {
  const { seedSessionFile } = await import("../src/session-seed.ts");
  const { dirname, join } = await import("node:path");
  const h = herdrFixture(mode), ask = { askId: "original", question: "Choose?", evidence: "Original evidence" };
  const path = join(dirname(h.run.recordPath), "session", "original.jsonl"); seedSessionFile(path, [], h.run.cwd);
  h.run.pendingAsk = ask; h.run.sessionPath = path;
  const done = createRunPipeline(h.run, [], { ...h.opts, core: { kind: "resume", sessionPath: path, systemPrompt: "probe" }, answer: { ask, cwd: h.run.cwd } });
  assert.deepEqual(h.run.pendingAsk, ask);
  await done;
  assert.equal(h.run.sessionPath, path); assert.equal(h.run.status, mode === "healthy" ? "completed" : "blocked");
  assert.deepEqual(h.run.pendingAsk, mode === "healthy" ? undefined : ask);
});
test("H7 post-readiness death drains current transcript and fails independently of watchdog", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = herdrFixture("running");
  const done = createRunPipeline(h.run, [], { ...h.opts, timeoutMs: 60000 });
  assert.ok(h.run.transport?.kind === "herdr"); await h.run.transport.ready;
  h.exit(); h.advance(5000); t.mock.timers.tick(5000);
  await done;
  assert.equal(h.run.status, "failed"); assert.equal(h.run.failureClass, "environment"); assert.equal(h.run.usage.turns, 1);
  const count = h.calls.length; h.advance(30000); t.mock.timers.tick(30000); assert.equal(h.calls.length, count, "no postterminal CLI churn");
});
test("H7 hard timeout proves stop, resolves done, and retains requested status", { timeout: 5000 }, async () => {
  const h = herdrFixture("running"); let callbacks = 0;
  await createRunPipeline(h.run, [], { ...h.opts, timeoutMs: 100, onComplete: () => callbacks++ });
  assert.equal(h.run.status, "timeout"); assert.equal(h.gone(), true); assert.equal(callbacks, 1); assert.deepEqual(h.signals, ["SIGTERM"]);
  assert.equal(h.run.herdrExitUnconfirmed, undefined);
  assert.match(readFileSync(h.run.finalPath, "utf8"), /Final verified evidence/, "proven forced exit still publishes its final");
});
