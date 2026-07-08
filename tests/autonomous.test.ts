/**
 * v0.18-S5 — autonomous executor: pure decision core + fake-driven loop.
 *
 * The pure core (nextAutoAction, classifyStepOutcome) is exhaustively
 * tested; the async driver (runAutonomous) is tested with an injected
 * fake spawnStep so the full compose-loop is covered WITHOUT a real
 * subprocess (the real spawn path is a thin queue call).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  nextAutoAction,
  classifyStepOutcome,
  runAutonomous,
  initAutoState,
  type AutoPlan,
  type AutoConfig,
  type SpawnedStepResult,
} from "../src/autonomous.ts";
import type { RetryPolicy } from "../src/failure-classify.ts";

const POLICY: RetryPolicy = { maxAttempts: 3, retryableClasses: ["environment", "stall", "timeout", "test"] };
const CFG: AutoConfig = { maxSteps: 20, retryPolicy: POLICY };

function plan(...personas: string[]): AutoPlan {
  return { goal: "g", steps: personas.map((p) => ({ persona: p, task: `task for ${p}` })) };
}

// ── nextAutoAction ──────────────────────────────────────────────────────

test("nextAutoAction: spawns the step at cursor", () => {
  const st = initAutoState(plan("a", "b"));
  const act = nextAutoAction(st, CFG);
  assert.equal(act.kind, "spawn");
  if (act.kind === "spawn") {
    assert.equal(act.index, 0);
    assert.equal(act.step.persona, "a");
  }
});

test("nextAutoAction: done when cursor past end", () => {
  const st = initAutoState(plan("a"));
  st.cursor = 1;
  assert.equal(nextAutoAction(st, CFG).kind, "done");
});

test("nextAutoAction: halt at step cap", () => {
  const st = initAutoState(plan("a", "b"));
  st.stepsRun = 20;
  const act = nextAutoAction(st, CFG);
  assert.equal(act.kind, "halt");
  if (act.kind === "halt") assert.match(act.reason, /step cap/);
});

test("nextAutoAction: halt at budget", () => {
  const st = initAutoState(plan("a"));
  st.spentUsd = 5;
  const act = nextAutoAction(st, { ...CFG, budgetUsd: 5 });
  assert.equal(act.kind, "halt");
  if (act.kind === "halt") assert.match(act.reason, /budget/);
});

test("nextAutoAction: mirrors terminal state", () => {
  const st = initAutoState(plan("a"));
  st.status = "halted";
  st.haltReason = "x";
  assert.equal(nextAutoAction(st, CFG).kind, "halt");
  st.status = "done";
  assert.equal(nextAutoAction(st, CFG).kind, "done");
});

// ── classifyStepOutcome ──────────────────────────────────────────────────

test("classifyStepOutcome: completed → success", () => {
  assert.deepEqual(classifyStepOutcome({ status: "completed" }, "t", 0, POLICY), { kind: "success" });
});

test("classifyStepOutcome: retryable class + budget → retry with augmented task", () => {
  const d = classifyStepOutcome({ status: "failed", failureClass: "environment" }, "orig", 0, POLICY);
  assert.equal(d.kind, "retry");
  if (d.kind === "retry") {
    assert.match(d.task, /orig/);
    assert.match(d.task, /## Retry/);
  }
});

test("classifyStepOutcome: non-retryable class → escalate", () => {
  const d = classifyStepOutcome({ status: "failed", failureClass: "logic" }, "t", 0, POLICY);
  assert.equal(d.kind, "escalate");
});

test("classifyStepOutcome: exhausted attempts → escalate", () => {
  const d = classifyStepOutcome({ status: "failed", failureClass: "environment" }, "t", 2, POLICY);
  assert.equal(d.kind, "escalate");
});

test("classifyStepOutcome: permission never retries", () => {
  const d = classifyStepOutcome({ status: "killed", failureClass: "permission" }, "t", 0, POLICY);
  assert.equal(d.kind, "escalate");
});

// ── runAutonomous (fake spawnStep) ───────────────────────────────────────

function fakeSpawner(script: Record<string, SpawnedStepResult[]>) {
  const calls: { persona: string; task: string; retryAttempt: number }[] = [];
  const cursors: Record<string, number> = {};
  const spawnStep = async (a: { persona: string; task: string; retryAttempt: number }) => {
    calls.push(a);
    const seq = script[a.persona] ?? [{ status: "completed", failureClass: undefined, costUsd: 0.1, finalText: "ok" }];
    const i = Math.min(cursors[a.persona] ?? 0, seq.length - 1);
    cursors[a.persona] = (cursors[a.persona] ?? 0) + 1;
    return seq[i];
  };
  return { spawnStep, calls };
}

const ok = (cost = 0.1, finalText = "ok"): SpawnedStepResult => ({ status: "completed", costUsd: cost, finalText });

test("runAutonomous: all steps succeed → done", async () => {
  const { spawnStep, calls } = fakeSpawner({ a: [ok()], b: [ok()], c: [ok()] });
  const out = await runAutonomous(plan("a", "b", "c"), CFG, { spawnStep });
  assert.equal(out.status, "done");
  assert.equal(out.results.length, 3);
  assert.equal(calls.length, 3);
  assert.ok(Math.abs(out.spentUsd - 0.3) < 1e-9);
});

test("runAutonomous: transient failure then success (in-loop retry)", async () => {
  const { spawnStep, calls } = fakeSpawner({
    a: [
      { status: "failed", failureClass: "environment", costUsd: 0.1, finalText: "" },
      ok(0.2),
    ],
    b: [ok()],
  });
  const out = await runAutonomous(plan("a", "b"), CFG, { spawnStep });
  assert.equal(out.status, "done");
  // a spawned twice (fail + retry-success), b once
  assert.equal(calls.filter((c) => c.persona === "a").length, 2);
  // second 'a' call carries the retry attempt + augmented task
  const aCalls = calls.filter((c) => c.persona === "a");
  assert.equal(aCalls[1].retryAttempt, 1);
  assert.match(aCalls[1].task, /## Retry/);
});

test("runAutonomous: non-retryable failure → halt + escalate", async () => {
  const { spawnStep } = fakeSpawner({
    a: [{ status: "failed", failureClass: "logic", costUsd: 0.1, finalText: "" }],
    b: [ok()],
  });
  const out = await runAutonomous(plan("a", "b"), CFG, { spawnStep });
  assert.equal(out.status, "halted");
  assert.match(out.haltReason ?? "", /logic/);
  // b never ran
  assert.equal(out.results.length, 1);
});

test("runAutonomous: step cap halts a runaway retry loop", async () => {
  // 'a' always fails retryably; cap forces a halt after maxSteps spawns.
  const { spawnStep, calls } = fakeSpawner({
    a: [{ status: "failed", failureClass: "environment", costUsd: 0.1, finalText: "" }],
  });
  const out = await runAutonomous(plan("a"), { maxSteps: 2, retryPolicy: { maxAttempts: 99, retryableClasses: ["environment"] } }, { spawnStep });
  assert.equal(out.status, "halted");
  assert.match(out.haltReason ?? "", /step cap/);
  assert.equal(calls.length, 2); // never exceeds the cap
});

test("runAutonomous: budget halts before an over-budget spawn", async () => {
  const { spawnStep, calls } = fakeSpawner({ a: [ok(0.6)], b: [ok(0.6)], c: [ok()] });
  const out = await runAutonomous(plan("a", "b", "c"), { maxSteps: 20, budgetUsd: 1.0, retryPolicy: POLICY }, { spawnStep });
  assert.equal(out.status, "halted");
  assert.match(out.haltReason ?? "", /budget/);
  // a ($0.6) + b ($0.6) run → spent 1.2 ≥ 1.0 → c never spawns
  assert.equal(calls.length, 2);
});

test("runAutonomous: reevaluate stop signal halts before advancing", async () => {
  const p: AutoPlan = {
    goal: "g",
    steps: [
      { persona: "a", task: "ta", reevaluate: true },
      { persona: "b", task: "tb" },
    ],
  };
  const { spawnStep, calls } = fakeSpawner({
    a: [{ status: "completed", costUsd: 0.1, finalText: "BLOCKED: upstream missing, cannot proceed" }],
    b: [ok()],
  });
  const out = await runAutonomous(p, CFG, { spawnStep });
  assert.equal(out.status, "halted");
  assert.match(out.haltReason ?? "", /re-eval/);
  assert.equal(calls.filter((c) => c.persona === "b").length, 0); // b gated out
});

test("runAutonomous: onStep hook fires per spawn", async () => {
  const { spawnStep } = fakeSpawner({ a: [ok()], b: [ok()] });
  const seen: string[] = [];
  const out = await runAutonomous(plan("a", "b"), CFG, { spawnStep, onStep: (r) => seen.push(r.persona) });
  assert.equal(out.status, "done");
  assert.deepEqual(seen, ["a", "b"]);
});
