/**
 * pi-conductor — v0.18 Slice 5: autonomous executor.
 *
 * Composes S1–S4 into a bounded, self-correcting loop that runs an ordered
 * persona plan to a terminal outcome with minimal human intervention:
 *
 *   for each step:
 *     spawn persona → on terminal:
 *       - classify failure (S1, already stamped on the run)
 *       - retryable + budget remains → re-spawn with diagnostics (S2 pure
 *         pieces, driven in-loop so the executor can AWAIT each retry)
 *       - non-retryable / exhausted → ESCALATE (halt)
 *     succeeded → re-evaluate (S3): proceed | stop
 *     (outcomes are recorded by finalize itself — S4)
 *
 * Guardrails (Metaphor's "invariants enforced by architecture"):
 *   - step cap + optional USD budget
 *   - permission-class failures always escalate, never auto-retry
 *   - the executor drives retries itself and does NOT pass `onRetry` to
 *     its spawns, so there is exactly one retry authority (no double-fire)
 *
 * Design split:
 *   - PURE decision core: `nextAutoAction`, `classifyStepOutcome` — no I/O,
 *     fully unit-tested.
 *   - Thin async driver: `runAutonomous` — injects a `spawnStep` dep so the
 *     loop is testable with fakes and the live path uses the real queue.
 */

import type { FailureClass, RetryPolicy } from "./failure-classify.ts";
import { shouldRetry } from "./failure-classify.ts";
import { buildRetryTask } from "./retry.ts";
import { evaluateChainOutcome, type ChainStep } from "./chain.ts";
import type { RunStatus } from "./types.ts";

// ── Plan + config types ──────────────────────────────────────────────────

export interface AutoStep {
  persona: string;
  task: string;
  /** When true, re-evaluate the parent's output before advancing (S3). */
  reevaluate?: boolean;
}

export interface AutoPlan {
  goal: string;
  steps: AutoStep[];
}

export interface AutoConfig {
  /** Hard cap on total spawns (original + retries). Halts when reached. */
  maxSteps: number;
  /** Optional USD budget across all spawns. Halts when exceeded. */
  budgetUsd?: number;
  /** Retry policy applied per step. */
  retryPolicy: RetryPolicy;
}

// ── Executor state ─────────────────────────────────────────────────────────

export interface StepResult {
  persona: string;
  status: RunStatus;
  failureClass?: FailureClass;
  attempts: number;
  costUsd: number;
}

export type AutoStatus = "running" | "done" | "halted";

export interface AutoState {
  plan: AutoPlan;
  /** Index of the next plan step to spawn. */
  cursor: number;
  /** Total spawns issued (original + retries). */
  stepsRun: number;
  /** Accumulated USD cost. */
  spentUsd: number;
  status: AutoStatus;
  haltReason?: string;
  results: StepResult[];
}

export function initAutoState(plan: AutoPlan): AutoState {
  return {
    plan,
    cursor: 0,
    stepsRun: 0,
    spentUsd: 0,
    status: "running",
    results: [],
  };
}

// ── Pure decision core ─────────────────────────────────────────────────────

export type AutoAction =
  | { kind: "spawn"; step: AutoStep; index: number }
  | { kind: "halt"; reason: string }
  | { kind: "done" };

/**
 * Decide the next executor action from the current state + config. Pure.
 *
 * Order (caps first, so a plan can never run away):
 *   1. already terminal (done/halted) → mirror it
 *   2. step cap reached → halt
 *   3. budget exceeded → halt
 *   4. all plan steps consumed → done
 *   5. otherwise → spawn the step at `cursor`
 *
 * Budget is checked as "already at/over" BEFORE spawning, so the executor
 * never starts a step it has no budget for. `budgetUsd` undefined = no cap.
 */
export function nextAutoAction(state: AutoState, cfg: AutoConfig): AutoAction {
  if (state.status === "done") return { kind: "done" };
  if (state.status === "halted") return { kind: "halt", reason: state.haltReason ?? "halted" };
  if (state.stepsRun >= cfg.maxSteps) {
    return { kind: "halt", reason: `step cap reached (${cfg.maxSteps})` };
  }
  if (cfg.budgetUsd !== undefined && state.spentUsd >= cfg.budgetUsd) {
    return { kind: "halt", reason: `budget exhausted ($${state.spentUsd.toFixed(2)} >= $${cfg.budgetUsd})` };
  }
  if (state.cursor >= state.plan.steps.length) return { kind: "done" };
  return { kind: "spawn", step: state.plan.steps[state.cursor], index: state.cursor };
}

/** Outcome of a single spawned step, before deciding retry vs advance. */
export interface StepOutcome {
  status: RunStatus;
  failureClass?: FailureClass;
}

export type StepDecision =
  | { kind: "success" }
  | { kind: "retry"; task: string }
  | { kind: "escalate"; reason: string };

/**
 * Decide what to do after a step's spawn reaches a terminal status. Pure.
 *
 *   - completed → success
 *   - non-completed + shouldRetry(class, attempt, policy) → retry with a
 *     diagnostic-augmented task (built from the pristine original)
 *   - otherwise → escalate (halt the whole run)
 *
 * `attempt` is 0-indexed (0 = original spawn). `maxSteps`/`budget` caps are
 * enforced separately by `nextAutoAction`; this only decides retry-vs-give-up
 * on failure-class grounds.
 */
export function classifyStepOutcome(
  outcome: StepOutcome,
  originalTask: string,
  attempt: number,
  policy: RetryPolicy,
): StepDecision {
  if (outcome.status === "completed") return { kind: "success" };
  const cls: FailureClass = outcome.failureClass ?? "unknown";
  if (shouldRetry(cls, attempt, policy)) {
    return {
      kind: "retry",
      task: buildRetryTask({
        originalTask,
        failureClass: cls,
        attempt,
        maxAttempts: policy.maxAttempts,
        errorMessage: undefined,
      }),
    };
  }
  return { kind: "escalate", reason: `step failed with non-retryable class '${cls}'` };
}

// ── Thin async driver ────────────────────────────────────────────────────

/** A spawned step's terminal snapshot, returned by the injected spawner. */
export interface SpawnedStepResult {
  status: RunStatus;
  failureClass?: FailureClass;
  costUsd: number;
  /** Final output text (for S3 re-evaluation). */
  finalText: string;
}

export interface AutoDeps {
  /**
   * Spawn one persona on a task and resolve when it reaches a terminal
   * status. `retryAttempt` is threaded for observability. The driver never
   * passes an onRetry callback — the executor is the sole retry authority.
   */
  spawnStep: (args: {
    persona: string;
    task: string;
    retryAttempt: number;
  }) => Promise<SpawnedStepResult>;
  /** Optional progress hook (per spawn terminal). */
  onStep?: (result: StepResult, state: AutoState) => void;
}

export interface AutoOutcome {
  status: "done" | "halted";
  haltReason?: string;
  results: StepResult[];
  stepsRun: number;
  spentUsd: number;
}

/**
 * Run an autonomous plan to a terminal outcome. Thin: all decisions defer
 * to the pure core; this only sequences spawns, awaits them, threads the
 * S3 re-eval, and accumulates caps.
 *
 * Retry is driven IN-LOOP (awaited), not via S2's background `onRetry`, so
 * the executor stays linear and every retry counts against `maxSteps`.
 */
export async function runAutonomous(
  plan: AutoPlan,
  cfg: AutoConfig,
  deps: AutoDeps,
): Promise<AutoOutcome> {
  const state = initAutoState(plan);

  while (true) {
    const action = nextAutoAction(state, cfg);
    if (action.kind === "done") {
      state.status = "done";
      break;
    }
    if (action.kind === "halt") {
      state.status = "halted";
      state.haltReason = action.reason;
      break;
    }

    // Spawn the step, retrying in-loop until success / escalate / cap.
    const step = action.step;
    let attempt = 0;
    let task = step.task;
    let stepDone = false;
    while (!stepDone) {
      // Re-check caps before each (re-)spawn so retries can't run away.
      const gate = nextAutoAction(state, cfg);
      if (gate.kind !== "spawn") {
        // Cap hit mid-retry: reflect it and stop the whole run.
        state.status = gate.kind === "halt" ? "halted" : "done";
        if (gate.kind === "halt") state.haltReason = gate.reason;
        return finalize(state);
      }

      const res = await deps.spawnStep({ persona: step.persona, task, retryAttempt: attempt });
      state.stepsRun += 1;
      state.spentUsd += res.costUsd;

      const decision = classifyStepOutcome(
        { status: res.status, failureClass: res.failureClass },
        step.task, // always the pristine original — no preamble stacking
        attempt,
        cfg.retryPolicy,
      );

      if (decision.kind === "retry") {
        const stepResult: StepResult = {
          persona: step.persona,
          status: res.status,
          failureClass: res.failureClass,
          attempts: attempt + 1,
          costUsd: res.costUsd,
        };
        state.results.push(stepResult);
        deps.onStep?.(stepResult, state);
        task = decision.task;
        attempt += 1;
        continue;
      }

      const stepResult: StepResult = {
        persona: step.persona,
        status: res.status,
        failureClass: res.failureClass,
        attempts: attempt + 1,
        costUsd: res.costUsd,
      };
      state.results.push(stepResult);
      deps.onStep?.(stepResult, state);

      if (decision.kind === "escalate") {
        state.status = "halted";
        state.haltReason = `step ${action.index} (${step.persona}): ${decision.reason}`;
        return finalize(state);
      }

      // decision.kind === "success" → S3 re-evaluation before advancing.
      if (step.reevaluate) {
        const chainStep: ChainStep = { then: "", reevaluate: true };
        const verdict = evaluateChainOutcome({
          parentFinal: res.finalText,
          parentFailureClass: res.failureClass,
          step: chainStep,
        });
        if (verdict.kind === "stop") {
          state.status = "halted";
          state.haltReason = `re-eval after step ${action.index} (${step.persona}): ${verdict.reason}`;
          return finalize(state);
        }
      }

      state.cursor += 1;
      stepDone = true;
    }
  }

  return finalize(state);
}

function finalize(state: AutoState): AutoOutcome {
  return {
    status: state.status === "done" ? "done" : "halted",
    haltReason: state.haltReason,
    results: state.results,
    stepsRun: state.stepsRun,
    spentUsd: state.spentUsd,
  };
}
