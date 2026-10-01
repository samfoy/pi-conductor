/**
 * pi-conductor — Tools registered with pi.
 *
 * v0.2 lineup:
 *   - ensemble_list   (read-only, persona registry)
 *   - ensemble_status (live registry view)
 *   - ensemble_spawn  (foreground default, with auto-downgrade-on-queue)
 */

import { openEffort, effortRepository, effortGit } from "./effort/open.ts";
import { readEffort, type EffortRecord } from "./effort/store.ts";
import { EFFORT_NOTICE, effortSummary } from "./effort/policy.ts";
import type { RuntimeKind, RuntimeEnvironment } from "./runtime.ts";
import { describeDelivery, runtimeFor } from "./runtime.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { Persona, PersonaOverride, Run, RunStatus, ThinkingLevel, MergeStrategy } from "./types.ts";
import { CONDUCTOR_LLM_TOOLS, CONDUCTOR_LLM_TOOL_NAMES, FOREIGN_SPAWN_TOOLS, WRITE_CAPABLE_PERSONAS } from "./types.ts";
import { resolvePersonas } from "./personas.ts";
import { loadConfig } from "./config.ts";
import { appendFileEvidence, resultRef } from "./file-evidence.ts";
import { resolveChain, buildChainTask } from "./chain.ts";
import { evaluateChainOutcome } from "./chain.ts";
import { buildRetryTask } from "./retry.ts";
import { scoreForShape, normalizeTaskShape } from "./memory.ts";
import {
  runAutonomous,
  type AutoPlan,
  type AutoStep,
  type StepResult,
  type SpawnedStepResult,
} from "./autonomous.ts";
import { resolveRetryPolicy } from "./retry.ts";
import { collapseSteerableCascade } from "./steerable.ts";
import { prepareSpawnRuntime, prepareSpawnEffort, availableActions, observeRunActions, computeAvailableActions, supportsFocus, validateRunAction, elapsedStr, failBeforeSpawn, forceTerminate, formatUsage, getCompletionText, keptBranchHint, modelRegistryPredicate, pauseRun, resolveTimeoutMs, resumeRun, sendCwd, sendToRun, type RunRegistry, type SpawnOptions, type SendToRunOptions } from "./runs.ts";
import { registerAskOwner } from "./ask-owner.ts";
import { registerDelegate } from "./delegate-tool.ts";
import { isSettled, isTerminal } from "./types.ts";
import { SpawnQueue } from "./queue.ts";
import { resolveMergeStrategy, resolveWorktreeSpec } from "./worktree.ts";
import { formatCwdInfo, resolveCwdArg, type CwdController, type CwdResolution } from "./conductor-cwd.ts";
import { ConductorEventEmitter } from "./conductor-events.ts";
import {
  awaitOrDetach,
  countToolResultMessages,
  createUpdateThrottle,
  installPostDetachCompletionListener,
  renderForegroundDetachedResult,
  renderForegroundStream,
  renderForegroundSummary,
  resolveStreamWidth,
} from "./foreground-stream.ts";
import type { FocusedStreamModel } from "./focused-stream-model.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ThemeFg } from "./transcript-style.ts";

/** Min ms between onUpdate deliveries while a foreground sub-agent
 * streams. Bounds pi's tool-card re-render rate. */
const FOREGROUND_STREAM_INTERVAL_MS = 50;

interface RegisterToolsOpts {
  /** The conductor's default cwd (session cwd or `ensemble_cwd` override). */
  getCwd: () => string;
  /** Backs `ensemble_cwd`. Optional so lightweight test harnesses can omit it. */
  cwdControl?: CwdController;
  getRegistry: () => RunRegistry;
  getQueue: () => SpawnQueue;
  /** Returns the shared FocusedStreamModel (drives the focused-stream overlay). */
  getModel: () => FocusedStreamModel;
  /**
   * Snapshot of the parent conductor's messages at spawn time. Used by
   * inherit_context: filtered/full to seed the sub-agent's session with
   * the parent's relevant history. Returns an empty array when there's
   * nothing to inherit.
   */
  getParentMessages: () => AgentMessage[];
  /**
   * pi session id of THIS conductor host slot
   * (`ctx.sessionManager.getSessionId()`). Stamped onto spawned runs as
   * `parentSessionId` so post-startup reconcile can distinguish sibling
   * slots that share one OS process (pi-dashboard). Returns undefined in
   * headless / non-dashboard contexts (reconcile falls back to pid).
   * Optional so lightweight test harnesses can omit it.
   */
  getSessionId?: () => string | undefined;
  /** Push a `<sub-agent-completed>` notification into the parent conversation. */
  pushCompletionNotification: (run: Run) => void;
  /**
   * Request that the focused-stream overlay open. When `id` is supplied,
   * the model is set to focus that agent first. No-op when there is no
   * UI context (e.g. headless tests).
   */
  openFocusedOverlay: (id?: string) => void;
  /**
   * Register a one-shot detach handler for the currently-active foreground
   * spawn. The handler is called when the user requests detach (Esc).
   * Returns an unregister function the tool calls in finally to release
   * the slot. When no UI is available (headless tests), this can be a
   * no-op that returns a Promise that never resolves.
   *
   * The tool race-awaits the spawn's `done` against this signal: if detach
   * fires first, the foreground tool returns a "detached-as-background"
   * result and the sub-agent keeps running; a registry listener pushes
   * the standard <sub-agent-completed> notification on terminal status.
   */
  registerForegroundDetach: () => {
    detachSignal: Promise<void>;
    unregister: () => void;
  };
  /**
   * Slice 7: theme used to colour the inline-streamed foreground
   * transcript surfaced via the parent's tool-call card. Returns the
   * host's `Theme` instance (re-read on every spawn so theme switches
   * mid-session take effect on the next stream). Returns `undefined`
   * in headless tests, in which case the stream renders plain.
   */
  getTheme?: () => ThemeFg | undefined;
  /** v0.16 event bus adapter — threaded into SpawnOptions/SendToRunOptions. */
  getEvents?: () => ConductorEventEmitter;
}

export function registerTools(pi: ExtensionAPI, opts: RegisterToolsOpts, env: NodeJS.ProcessEnv = process.env): void {
  // Item 14 (`docs/backlog.md`) — env-var gate. When this pi process
  // is itself a conductor sub-agent (`CONDUCTOR_SUBAGENT=1`, set by
  // `buildSubagentEnv` at spawn time), skip-register every
  // `ensemble_*` LLM tool so the sub-agent cannot fan out via
  // `ensemble_spawn` / `ensemble_send` / etc. Strict equality on `"1"`
  // (NOT truthy) so an accidentally-empty env var doesn't silently
  // disable the conductor's own tools in the parent process.
  //
  // Slash commands (`/conductor list | show | doctor | ...`) are
  // registered separately by `registerCommands` and are NOT gated
  // here — they're meta-UI surfaces, not LLM-callable.
  //
  // Witnessed: `builder-k6dc → builder-55a4` chain, 2026-05-28. The
  // outer builder fanned out instead of executing its brief; this
  // gate closes that channel.
  if (env.CONDUCTOR_SUBAGENT === "1") {
    // Only a depth-1 child asks its owner; an unset depth is a legacy depth-1 child.
    // Any other value, including a depth-2 leaf, registers nothing. Only a validated
    // depth-1 delegator env also gets the lead-brokered `delegate`.
    if (env.CONDUCTOR_DEPTH === undefined || env.CONDUCTOR_DEPTH === "1") registerAskOwner(pi, opts.getRegistry, env);
    registerDelegate(pi, env);
    return;
  }

  registerListTool(pi, opts);
  registerStatusTool(pi, opts);
  registerSpawnTool(pi, opts, env);
  registerSendTool(pi, opts);
  registerPauseTool(pi, opts);
  registerResumeTool(pi, opts);
  registerKillTool(pi, opts);
  registerFocusTool(pi, opts);
  registerRecommendTool(pi, opts);
  registerAutoTool(pi, opts, env);
  registerCwdTool(pi, opts);
  registerEffortTool(pi, opts);
}

/** A per-spawn `cwd` arg, resolved against the conductor's default; omitted → the default. */
function resolveSpawnCwd(arg: string | undefined, base: string): CwdResolution {
  return arg === undefined ? { ok: true, cwd: base } : resolveCwdArg(arg, base);
}

const runtimeSchema = Type.Optional(Type.Union([Type.Literal("auto"), Type.Literal("subprocess"), Type.Literal("herdr")], { description: "Runtime selector: per-call > effective persona > project > user > auto. Herdr is unavailable in H2; use subprocess explicitly inside herdr." }));

const SPAWN_CWD_DESCRIPTION =
  "Directory the sub-agent runs in; personas, config, and the git root for worktree isolation resolve from it. " +
  "`~` and relative paths resolve against the conductor's cwd (see ensemble_cwd), which is also the default.";

function registerEffortTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.effort,
    label: "Effort",
    description: `Open or inspect a named effort in the conductor cwd. ${EFFORT_NOTICE}`,
    promptSnippet: "Open or inspect a verified serial effort",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("open"), Type.Literal("status")]),
      effort: Type.String(),
      verify: Type.Optional(Type.String({ description: 'Open override; "" explicitly disables verification.' })),
      land: Type.Optional(Type.Union([Type.Literal("branch"), Type.Literal("base")])),
    }),
    async execute(_id, params): Promise<{ content: { type: "text"; text: string }[]; details: { effort?: EffortRecord; tip?: string; error?: string } }> {
      try {
        if (params.action !== "open" && params.action !== "status") throw new Error("Only effort open/status are supported");
        const cwd = opts.getCwd();
        const effort = params.action === "open"
          ? openEffort(cwd, params.effort, opts.getSessionId?.(), {
              ...(params.verify !== undefined ? { verify: params.verify } : {}),
              ...(params.land !== undefined ? { land: params.land } : {}),
            })
          : readEffort(effortRepository(cwd).gitRoot, params.effort);
        if (!effort) throw new Error("effort not found");
        const tip = effortGit(effort.gitRoot, "rev-parse", "--verify", `${effort.intRef}^{commit}`);
        return { content: [{ type: "text" as const, text: `${EFFORT_NOTICE}\n${!effort.baseline ? "Baseline not verified yet; gated on first integration." : effort.baseline.disabled ? "Effort verify disabled; repository hooks still required." : "Baseline result recorded."}\n${JSON.stringify({ effort, tip }, null, 2)}` }], details: { effort, tip } };
      } catch (e) { return errorResult(`${(e as Error).message}. ${EFFORT_NOTICE}`); }
    },
  });
}

// ── ensemble_cwd ─────────────────────────────────────────────────────

function registerCwdTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.cwd,
    label: "Conductor cwd",
    description:
      "Show or change the conductor's default cwd: where later ensemble_spawn / ensemble_auto sub-agents run " +
      "and where worktree, personas, and config resolve. `path` sets an override (`~` and relative paths resolve " +
      "against the current default); `reset: true` returns to the session's start cwd; no args reports the " +
      "effective cwd and its source. The override survives /reload and resume. Existing runs and ensemble_send " +
      "resumes keep their own cwd.",
    promptSnippet: "Show or change the conductor's default cwd for spawns",
    promptGuidelines: [
      "Prefer a per-call `cwd` on ensemble_spawn for one-off repo work; use ensemble_cwd when a whole stretch of work targets another repo.",
    ],
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "New default cwd. Must be an existing directory." })),
      reset: Type.Optional(Type.Boolean({ description: "true clears the override and returns to the session's start cwd." })),
    }),
    async execute(_id, params) {
      const r = opts.cwdControl?.change({ path: params.path, reset: params.reset }) ?? {
        ok: false as const,
        error: "the conductor cwd override is unavailable in this context",
      };
      const text = r.ok ? formatCwdInfo(r.info) : r.error;
      return {
        content: [{ type: "text" as const, text }],
        details: r.ok ? { ...r.info } : { error: r.error },
      };
    },
  });
}

// ── ensemble_list ────────────────────────────────────────────────────

function registerListTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.list,
    label: "List personas",
    description:
      "List the conductor sub-agent personas available in this workspace. " +
      "Returns each persona's name, one-line description, model/thinking config, " +
      "context-inheritance mode, source (builtin / user / project), and enforced tool policy " +
      "(`tools` allowlist, `exclude_tools` denylist).",
    promptSnippet: "List available conductor sub-agent personas",
    promptGuidelines: [
      "Call ensemble_list when you need to know which personas are installed before spawning one.",
      "The returned descriptions are short — read the persona body via /conductor show <name> if you need the full system prompt.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const cwd = opts.getCwd();
      const cfg = loadConfig(cwd);
      const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
      const personas = [...resolved.personas.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      return {
        content: [{ type: "text" as const, text: formatPersonaListForLLM(personas) }],
        details: {
          count: personas.length,
          personas: personas.map(personaSummary),
          errors: resolved.errors,
        },
      };
    },
  });
}

// ── ensemble_status ──────────────────────────────────────────────────

function registerRecommendTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.recommend,
    label: "Recommend persona",
    description:
      "v0.18 cross-session memory: given a task description, return conductor " +
      "personas ranked by their confidence-weighted, recency-decayed success " +
      "rate on similar tasks (matched by normalized task shape). Advisory only — " +
      "an empty result means no history for this shape yet; use your own judgment.",
    promptSnippet: "Recommend a persona for a task based on past outcomes",
    promptGuidelines: [
      "Call ensemble_recommend before spawning when you're unsure which persona historically succeeds on this kind of task.",
      "The score is a HINT, not a mandate — a persona with no history simply won't appear. Prefer the canonical chain shapes when memory is empty.",
    ],
    parameters: Type.Object({
      task: Type.String({ description: "The task description to score personas for." }),
    }),
    async execute(_id, params) {
      const scores = scoreForShape(params.task);
      const top = scores.slice(0, 8);
      const text = top.length
        ? "Persona recommendations for this task shape (recency-weighted score, higher = better; " +
          "score blends success rate with recency and a small-sample penalty, so it is NOT a raw success %):\n" +
          top
            .map(
              (s) =>
                `  ${s.persona} — score ${s.successRate.toFixed(2)} (n=${s.n})`,
            )
            .join("\n")
        : "No cross-session history for this task shape yet. Use the canonical chain.";
      return {
        content: [{ type: "text" as const, text }],
        details: { taskShape: normalizeTaskShape(params.task), scores: top },
      };
    },
  });
}

function registerStatusTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.status,
    label: "Sub-agent status",
    description:
      "Report status and available_actions for each sub-agent in this session. Use the latest available_actions; each call revalidates.",
    promptSnippet: "Check status of conductor sub-agents",
    promptGuidelines: [
      "Use ensemble_status when you need to know which sub-agents are alive (e.g. before deciding whether to spawn another).",
      "Background sub-agents push completion notifications automatically; you don't need to poll.",
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.String({ description: "Filter to a specific agent_id; omit for all." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const registry = opts.getRegistry();
      const queue = opts.getQueue();
      const all = registry.list();
      const filtered = params?.agent_id ? all.filter((r) => r.id === params.agent_id) : all;

      const groups = groupByStatus(filtered);
      const summaries = new Map(filtered.map(r => [r.id, toStatusSummary(r, supportsFocus(ctx), opts.getSessionId?.(), registry)]));
      const summary = (r: Run) => summaries.get(r.id)!;
      const queueList = queue.list().map((p) => ({
        id: p.id,
        persona: p.spawn.persona.name,
        requestedMode: p.requestedMode,
        enqueuedAt: p.enqueuedAt,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: formatStatusForLLM(groups, queueList.length, summaries),
          },
        ],
        details: {
          integrating: groups.integrating.map(summary),
          blocked: groups.blocked.map(summary),
          running: groups.running.map(summary),
          queued: groups.queued.map(summary),
          paused: groups.paused.map(summary),
          finished: [
            ...groups.completed,
            ...groups.failed,
            ...groups.killed,
            ...groups.timeout,
            ...groups.hook_failed,
            ...groups.merge_conflict,
            ...groups.aborted,
          ].map(summary),
          queueDetail: queueList,
        },
      };
    },
  });
}

/**
 * Resolve a Promise when the run `runId` reaches ANY terminal status.
 *
 * Two settle paths, once-guarded so exactly one wins:
 *   - fast path: the caller wires the returned `settle` into the spawn's
 *     `onComplete` (fires on natural exit + hook terminal);
 *   - backstop: a `registry.onChange` listener catches terminals that do
 *     NOT fire onComplete — operator kills (`ensemble_kill`/`/conductor
 *     kill` → forceTerminate) and queue-cancels. Without this, an
 *     autonomous executor awaiting `onComplete` would hang forever when
 *     the human stops a sub-step (the documented mid-loop guardrail).
 *
 * Also covers the race where the run went terminal between enqueue and
 * subscribe. Exported for unit testing.
 */
export function awaitTerminal(
  registry: Pick<RunRegistry, "onChange" | "list">,
  runId: string,
): { promise: Promise<Run>; settle: (run: Run) => void } {
  let settled = false;
  let resolveFn!: (run: Run) => void;
  let unsub: (() => void) | undefined;
  const settle = (run: Run): void => {
    if (settled) return;
    settled = true;
    unsub?.();
    resolveFn(run);
  };
  const promise = new Promise<Run>((resolve) => {
    resolveFn = resolve;
  });
  unsub = registry.onChange((r) => {
    if (r.id === runId && isSettled(r.status)) settle(r);
  });
  const cur = registry.list().find((r) => r.id === runId);
  if (cur && isSettled(cur.status)) settle(cur);
  return { promise, settle };
}

function registerAutoTool(pi: ExtensionAPI, opts: RegisterToolsOpts, env: RuntimeEnvironment): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.auto,
    label: "Autonomous run",
    description:
      "v0.18 autonomous mode: run an ordered persona plan to a terminal outcome " +
      "with bounded, self-correcting execution. YOU (the conductor) supply the plan " +
      "as an ordered list of steps; the executor spawns each in turn, classifies " +
      "failures, retries the transient ones with diagnostics, re-evaluates after " +
      "each step, and HALTS + escalates on a non-retryable failure, a stop verdict, " +
      "the step cap, or the USD budget. Outcomes feed cross-session memory. " +
      "Permission-class failures always escalate — never auto-retried.",
    promptSnippet: "Run an ordered persona plan autonomously with retry + re-eval",
    promptGuidelines: [
      "Build the plan yourself (you are the planner): decompose the goal into ordered steps, each a persona + a self-contained task. Then call ensemble_auto once.",
      "Always set max_steps; add budget_usd for cost-sensitive runs. The executor stops at the first non-retryable failure or stop verdict and reports what completed.",
      "Set reevaluate:true on a step whose successor should only run if the step's output doesn't signal a blocker.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "One-line description of the overall goal (for the run summary)." }),
      steps: Type.Array(
        Type.Object({
          persona: Type.String({ description: "Persona name to spawn for this step." }),
          runtime: runtimeSchema,
          files: Type.Optional(Type.Array(Type.String(), { description: "Evidence paths or exact run:<agent_id> result refs; relative to this step's effective cwd. Prepared before any step starts." })),
          task: Type.String({ description: "Self-contained task for this step." }),
          reevaluate: Type.Optional(
            Type.Boolean({ description: "Re-evaluate this step's output before advancing (halt on a stop signal)." }),
          ),
          cwd: Type.Optional(Type.String({ description: SPAWN_CWD_DESCRIPTION })),
        }),
        { minItems: 1, description: "Ordered plan steps." },
      ),
      max_steps: Type.Integer({
        minimum: 1,
        description: "Hard cap on total spawns (original + retries). The executor halts when reached.",
      }),
      budget_usd: Type.Optional(
        Type.Number({ minimum: 0, description: "Optional USD budget across all spawns. Halts when exceeded." }),
      ),
      retry_max_attempts: Type.Optional(
        Type.Integer({ minimum: 1, description: "Per-step retry budget (incl. first attempt). Defaults to at least 2 in auto mode." }),
      ),
    }),
    async execute(_id, params) {
      const baseCwd = opts.getCwd();
      const cfg = loadConfig(baseCwd);
      const halted = (reason: string) => ({
        content: [{ type: "text" as const, text: `Autonomous run HALTED — ${reason}` }],
        details: {
          status: "halted" as const,
          haltReason: reason,
          results: [] as StepResult[],
          stepsRun: 0,
          spentUsd: 0,
        },
      });

      if ("effort" in params || params.steps.some(s => "effort" in s || "touches" in s || "wave" in s)) {
        return halted(`effort auto plans are unsupported. ${EFFORT_NOTICE}`);
      }
      // Validate every step's cwd and persona up front — fail fast before
      // spawning. Personas and config resolve per step cwd.
      const stepCwds: string[] = [];
      for (const [i, s] of params.steps.entries()) {
        const r = resolveSpawnCwd(s.cwd, baseCwd);
        if (!r.ok) return halted(`step ${i + 1}: ${r.error}`);
        stepCwds.push(r.cwd);
      }
      const contexts = new Map<string, { cfg: typeof cfg; personas: Map<string, Persona> }>();
      for (const c of new Set(stepCwds)) {
        const stepCfg = c === baseCwd ? cfg : loadConfig(c);
        const resolved = await resolvePersonas({ cwd: c, personaOverrides: stepCfg.personaOverrides });
        contexts.set(c, { cfg: stepCfg, personas: resolved.personas });
      }
      const unknown = params.steps
        .filter((s, i) => !contexts.get(stepCwds[i]!)!.personas.get(s.persona))
        .map((s) => s.persona);
      if (unknown.length) {
        return halted(
          `unknown persona(s) in plan: ${[...new Set(unknown)].join(", ")}. Run ensemble_list to see available personas.`,
        );
      }

      const stepRuntimes: RuntimeKind[] = [];
      try {
        for (const [i, s] of params.steps.entries()) {
          stepRuntimes.push(prepareSpawnRuntime({ persona: contexts.get(stepCwds[i]!)!.personas.get(s.persona)!, cwd: stepCwds[i]!, runtime: s.runtime, runtimeEnv: env }).runtime);
        }
      } catch (e) { return halted((e as Error).message); }
      const preparedTasks: string[] = [];
      try {
        for (const [i, s] of params.steps.entries()) {
          preparedTasks.push(appendFileEvidence(s.task, s.files, { cwd: stepCwds[i]!, registry: opts.getRegistry(), limit: contexts.get(stepCwds[i]!)!.cfg.inlineAttachmentLimitBytes }));
        }
      } catch (e) { return halted((e as Error).message); }
      const plan: AutoPlan = {
        goal: params.goal,
        steps: params.steps.map(
          (s, i): AutoStep => ({ persona: s.persona, runtime: stepRuntimes[i], task: preparedTasks[i]!, reevaluate: s.reevaluate, cwd: stepCwds[i] }),
        ),
      };

      // Auto mode is more autonomous than a supervised spawn: default to at
      // least one retry unless the caller/config says otherwise.
      const basePolicy = resolveRetryPolicy({
        perCall: params.retry_max_attempts !== undefined ? { maxAttempts: params.retry_max_attempts } : undefined,
        builtin: { maxAttempts: cfg.retry.maxAttempts, retryableClasses: cfg.retry.retryableClasses },
      });
      const retryPolicy =
        params.retry_max_attempts === undefined && basePolicy.maxAttempts < 2
          ? { ...basePolicy, maxAttempts: 2 }
          : basePolicy;

      const queue = opts.getQueue();
      const events = opts.getEvents?.();

      const spawnStep = (a: {
        persona: string;
        task: string;
        retryAttempt: number;
        runtime?: RuntimeKind;
        cwd?: string;
      }): Promise<SpawnedStepResult> => {
        const stepCwd = a.cwd ?? baseCwd;
        const step = contexts.get(stepCwd)!;
        const personaObj = step.personas.get(a.persona)!;
        const ov = step.cfg.personaOverrides[personaObj.name] ?? {};
        const registry = opts.getRegistry();
        let settleRef: (run: Run) => void = () => {};
        const spawned = queue.enqueueOrSpawn({
          persona: personaObj,
          runtime: a.runtime,
          task: a.task,
          mode: "background",
          cwd: stepCwd,
          model: resolveModel(personaObj, ov),
          thinking: resolveThinking(personaObj, ov),
          timeoutMs: resolveTimeoutMs(personaObj, ov, step.cfg),
          parentMessages: opts.getParentMessages(),
          parentSessionId: opts.getSessionId?.(),
          worktree: step.cfg.worktreeMode === "conductor" && personaObj.worktree === true,
          mergeStrategy: resolveSpawnMergeStrategy(step.cfg, personaObj),
          retryAttempt: a.retryAttempt,
          // NO onRetry / onChain: the executor is the sole retry + sequencing
          // authority (avoids double-fire with S2's background retry and the
          // default builder->critic chain).
          onComplete: (run) => {
            opts.pushCompletionNotification(run);
            settleRef(run); // fast path
          },
          events,
        } as SpawnOptions);
        // Backstop: operator kills (ensemble_kill / /conductor kill) and
        // queue-cancels forceTerminate the run WITHOUT firing onComplete,
        // which would hang the executor forever. `awaitTerminal` resolves on
        // ANY terminal status via the registry (forceTerminate + drain-cancel
        // both call registry.notify), once-guarded against the onComplete
        // fast path above.
        const trackedId =
          spawned.kind === "spawned" ? spawned.run.id : spawned.placeholderRun.id;
        const { promise, settle } = awaitTerminal(registry, trackedId);
        settleRef = settle;
        return promise.then((run) => ({
          status: run.status,
          failureClass: run.failureClass,
          costUsd: run.usage.cost ?? 0,
          finalText: getCompletionText(run),
        }));
      };

      const outcome = await runAutonomous(plan, { maxSteps: params.max_steps, budgetUsd: params.budget_usd, retryPolicy }, {
        spawnStep,
      });

      const lines = outcome.results.map(
        (r, i) =>
          `  ${i + 1}. ${r.persona} — ${r.status}${r.failureClass ? ` (${r.failureClass})` : ""}` +
          `${r.attempts > 1 ? ` [${r.attempts} attempts]` : ""}`,
      );
      const header =
        outcome.status === "done"
          ? `Autonomous run COMPLETE — ${outcome.results.length} step(s), $${outcome.spentUsd.toFixed(3)}.`
          : `Autonomous run HALTED — ${outcome.haltReason}. ${outcome.results.length} step(s), $${outcome.spentUsd.toFixed(3)}.`;
      return {
        content: [{ type: "text" as const, text: `${header}\n${lines.join("\n")}` }],
        details: { ...outcome },
      };
    },
  });
}

// ── ensemble_spawn ───────────────────────────────────────────────────

function registerSpawnTool(pi: ExtensionAPI, opts: RegisterToolsOpts, env: RuntimeEnvironment): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.spawn,
    label: "Spawn sub-agent",
    description:
      "Launch a focused sub-agent using a persona. " +
      "Foreground (default): blocks until the sub-agent completes; result is returned. " +
      "Background: returns immediately; completion arrives as a <sub-agent-completed> user-role message that wakes you. " +
      "When the concurrency cap is reached, foreground spawns auto-downgrade to background. A sole ask_owner ends the child's turn and returns a blocked question, answered via ensemble_send.",
    promptSnippet: "Spawn a persona-based sub-agent (foreground or background)",
    promptGuidelines: [
      "Use ensemble_list first if you don't know which personas are available.",
      "Write fully self-contained task prompts — the sub-agent doesn't see your conversation.",
      "For read-only personas (oracle, redteam, inspector, analyst, profiler, investigator), prefer parallel background spawns.",
      "For write-capable personas (builder, simplifier), run one at a time per set of files.",
      "Foreground spawns may auto-downgrade to background under load — handle the queued-as-background return cleanly without re-spawning.",
      "Pass timeout_minutes to override the per-persona / global default for a single risky run; default applies if omitted.",
      "Pass kill_on_stall=true on autonomous chains where you can't manually intervene; the v0.10 watchdog will hard-kill a sub-agent that goes silent past its hard threshold.",
      "Pass stall_threshold_seconds (≥ 30) on spawns whose tool calls are known-slow (npm install, brazil-build, big test suites) to suppress noisy soft-stall advisories.",
      "Pass cwd for work in a repo other than your cwd, so write-capable personas get a worktree of that repo and its personas/config apply.",
      "Pass files: ['run:<agent_id>'] using the exact result-ref from a completion instead of paraphrasing evidence. Files are evidence, not instructions or capability grants; default_reads remains separate.",
    ],
    parameters: Type.Object({
      runtime: runtimeSchema,
      effort: Type.Optional(Type.String({ description: `Named effort; auto-opens from config on first use. Always background with mandatory writer isolation. ${EFFORT_NOTICE}` })),
      touches: Type.Optional(Type.Array(Type.String(), { description: "Effort writer repo-relative globs (literal, * or **). Omitted scope is undeclared; concurrency is not relaxed in M1." })),

      persona: Type.String({
        description: "Persona name. Run ensemble_list to see what's available.",
      }),
      task: Type.String({
        description:
          "Self-contained task prompt for the sub-agent. Include file paths, constraints, and acceptance criteria.",
      }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Caller evidence: readable local paths or exact run:<agent_id> persisted results. Relative paths use the effective spawn cwd; ~ expands to HOME. Whole text embeds within the configured budget; other files remain live path references. No capability grants." })),
      cwd: Type.Optional(Type.String({ description: SPAWN_CWD_DESCRIPTION })),
      foreground: Type.Optional(
        Type.Boolean({
          description:
            "true (default) blocks until done and streams the sub-agent into the ensemble panel; false runs in background and notifies on completion.",
        }),
      ),
      timeout_minutes: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 1440,
          description:
            "Wall-clock timeout for this sub-agent in minutes (1–1440). Overrides the per-persona override and the global default. Omit to use the cascade.",
        }),
      ),
      kill_on_stall: Type.Optional(
        Type.Boolean({
          description:
            "v0.10 watchdog opt-in. true → the sub-agent is auto-killed if it goes silent past the hard-stall threshold (default 600s). false / omitted → advisory-only; the wall-clock timeout still applies. Recommend true on autonomous chains; default off for interactive sessions.",
        }),
      ),
      stall_threshold_seconds: Type.Optional(
        Type.Integer({
          minimum: 30,
          description:
            "v0.10 watchdog soft-stall threshold for this spawn, in seconds (≥ 30). Hard threshold scales with the same ratio as conductor defaults (typically 5×). Override when the persona's expected tool calls are legitimately slow (npm install, brazil-build, large test suites). Default: 120s.",
        }),
      ),
      on_complete_hook: Type.Optional(
        Type.String({
          description:
            "v0.11 quality-gate hook. Shell command run after the sub-agent reaches a terminal status; non-zero exit flips the run to `hook_failed`. Empty string (`\"\"`) is the explicit-disable sentinel — short-circuits the cascade so this spawn runs no hook even if project / user config or persona frontmatter declares one. Cascade: per-call > project > user > persona-frontmatter.",
        }),
      ),
      on_complete_hook_timeout_seconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "v0.11 quality-gate hook timeout (seconds). Read paired with `on_complete_hook`; a runaway hook past this budget is killed and the run flips to `hook_failed`. Default 300 when omitted.",
        }),
      ),
      merge_strategy: Type.Optional(
        Type.Union(
          [Type.Literal("squash"), Type.Literal("merge"), Type.Literal("none")],
          {
            description:
              "v0.14 worktree auto-merge strategy. When set (and the persona has a worktree), the worktree branch is merged back to the base branch on `completed`. `\"squash\"` squashes all commits into one; `\"merge\"` creates a merge commit; `\"none\"` skips merge-back. Cascade: per-call > project > user > persona-frontmatter > built-in default (`\"squash\"` for builder/simplifier, `\"none\"` for others). Omit to use the cascade.",
          },
        ),
      ),
      steerable: Type.Optional(
        Type.Boolean({
          description:
            "v0.12 steering opt-in. true → launch the sub-agent in `pi --mode rpc` so the conductor can `steer` / `follow_up` it mid-run via ensemble_send. false / omitted → print mode without steering; prompts above 96 KiB automatically use RPC stdin for transport only, still without steering. Cascade per-call > project > user > built-in default false. Personas using ctx.ui.confirm/select must NOT be spawned with steerable=true (auto-cancelled on the conductor side).",
        }),
      ),
      inherit_context: Type.Optional(
        Type.Union(
          [
            Type.Literal("none"),
            Type.Literal("filtered"),
            Type.Literal("filtered_compact"),
            Type.Literal("full"),
          ],
          {
            description:
              "Item 12 candidate #3 — per-call override for the persona's inherit_context frontmatter. Useful when the parent conductor's narration is contaminating the sub-agent's identity (see docs/backlog.md item 12 for the witnessed builder-4gsl bleed). Cascade: per-call > project config persona override > user config persona override > persona frontmatter. Default: persona frontmatter.",
          },
        ),
      ),
      chain: Type.Optional(
        Type.Boolean({
          description:
            "v0.15 chains: set to false to skip automatic chain spawns for this run even if a chain is configured in conductor.json for the persona. Default: true (chains apply when configured).",
        }),
      ),
      retry_max_attempts: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "v0.18 classified retry: total attempts (including the first) for this spawn. 1 = no retry (default). When >1, a non-completed terminal whose failure classifies as retryable (environment/stall/timeout/test by default) auto-respawns the same persona with a diagnostic-augmented task, up to this budget. Deterministic-cause failures (syntax/logic) and permission failures are never retried. Cascade: per-call > project > user > persona-frontmatter > built-in.",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const tmRange = validateTimeoutMinutes(params.timeout_minutes);
      if (tmRange) return errorResult(tmRange);
      const stallRange = validateStallThresholdSeconds(params.stall_threshold_seconds);
      if (stallRange) return errorResult(stallRange);
      const hookTimeoutRange = validateHookTimeoutSeconds(
        params.on_complete_hook_timeout_seconds,
      );
      if (hookTimeoutRange) return errorResult(hookTimeoutRange);

      const spawnCwd = resolveSpawnCwd(params.cwd, opts.getCwd());
      if (!spawnCwd.ok) return errorResult(spawnCwd.error);
      const cwd = spawnCwd.cwd;
      const cfg = loadConfig(cwd);
      const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
      const persona = resolved.personas.get(params.persona);
      if (!persona) {
        return errorResult(
          `persona "${params.persona}" not found. Run ensemble_list to see what's available.`,
        );
      }

      let runtime: RuntimeKind;
      try { runtime = prepareSpawnRuntime({ persona, cwd, runtime: params.runtime, runtimeEnv: env }).runtime; }
      catch (e) { return errorResult((e as Error).message); }

      const foreground = params.foreground !== false && params.effort === undefined;
      const effortNote = params.effort === undefined ? "" : `\n${params.foreground !== false ? "Foreground effort spawn downgraded to background. " : ""}${EFFORT_NOTICE}`;
      const mode = foreground ? "foreground" : "background";
      const queue = opts.getQueue();
      const registry = opts.getRegistry();
      let task: string;
      try { task = appendFileEvidence(params.task, params.files, { cwd, registry, limit: cfg.inlineAttachmentLimitBytes }); }
      catch (e) { return errorResult((e as Error).message); }

      try { prepareSpawnEffort({ persona, cwd, effort: params.effort, touches: params.touches, parentSessionId: opts.getSessionId?.() }); }
      catch (e) { return errorResult(`${(e as Error).message}. ${EFFORT_NOTICE}`); }

      // Per-call `timeout_minutes` arg wins over persona override, which wins
      // over global default. We synthesize a fresh override that layers the
      // tool arg on top of any config-defined persona override.
      const baseOv = cfg.personaOverrides[persona.name] ?? {};
      const ov: PersonaOverride =
        params.timeout_minutes !== undefined
          ? { ...baseOv, timeoutMinutes: params.timeout_minutes }
          : baseOv;
      const model = resolveModel(persona, ov);
      const thinking = resolveThinking(persona, ov);
      const timeoutMs = resolveTimeoutMs(persona, ov, cfg);

      // v0.12 slice 4 — collapse the steerable cascade. `cfg` is
      // already merged (`defaults <- user <- project`), so the merged
      // `defaultSteerable` represents the project/user/default layers
      // collapsed; the per-call layer wins above. No persona-frontmatter
      // layer (oracle fix #1; PRD.md:517).
      const steerable = collapseSteerableCascade({
        perCall: params.steerable,
        project: undefined,
        user: undefined,
        defaultValue: cfg.defaultSteerable ?? false,
      });

      // Wire abort signal to cancel a running sub-agent.
      const result = queue.enqueueOrSpawn({
        runtimeEnv: env,
        runtime,
        effort: params.effort,
        touches: params.touches,
        persona,
        task,
        mode,
        cwd,
        model,
        thinking,
        timeoutMs,
        // Snapshot parent context at spawn time. Honors inherit_context
        // (filtered/full) inside spawnRun via planSpawnPiArgs.
        parentMessages: opts.getParentMessages(),
        // pi-dashboard multi-slot fix: stamp the spawning slot's session
        // id so reconcile can distinguish sibling slots sharing one pid.
        parentSessionId: opts.getSessionId?.(),
        // v0.10 Slice 3: per-spawn watchdog overrides. Undefined →
        // conductor default (off / 120s soft).
        killOnStall: params.kill_on_stall,
        softStallSeconds: params.stall_threshold_seconds,
        // v0.11 on_complete_hook (slice 3) per-call layer.
        onCompleteHook: params.on_complete_hook,
        onCompleteHookTimeoutSeconds: params.on_complete_hook_timeout_seconds,
        steerable,
        // v0.13 worktree-per-persona: collapse from persona frontmatter.
        worktree: cfg.worktreeMode === "conductor" && persona.worktree === true,
        // v0.14 worktree auto-merge: resolve the merge strategy cascade.
        mergeStrategy: resolveSpawnMergeStrategy(cfg, persona, params.merge_strategy as MergeStrategy | undefined),
        // Item 12 candidate #3 — per-call inherit_context override.
        // Wins above persona.inheritContext (which already merges
        // project/user personaOverrides). Resolved in planSpawnPiArgs
        // via resolveInheritContext. See src/inherit-context.ts.
        inheritContextOverride: params.inherit_context,
        onUpdate: foreground ? () => {} : undefined, // foreground uses our own onUpdate below
        onComplete: foreground
          ? undefined
          : (run) => opts.pushCompletionNotification(run),
        // v0.15 chains: resolve the chain step and provide the onChain callback.
        // Not provided when chain: false is passed, preventing the auto-spawn.
        // Chain-spawned runs also don't receive onChain (no chain-of-chains).
        onChain: buildOnChainCallback({
          runtimeEnv: env,
          chainEnabled: params.chain !== false && params.effort === undefined,
          personaName: persona.name,
          cfg,
          queue,
          registry,
          cwd,
          pushNotification: opts.pushCompletionNotification,
          getParentMessages: opts.getParentMessages,
          getSessionId: opts.getSessionId,
          events: opts.getEvents?.(),
        }),
        // v0.18 classified retry: per-call attempt budget + the re-spawn
        // callback. Undefined per-call falls through the cascade to
        // config/persona/built-in (default maxAttempts 1 = no retry).
        retryMaxAttempts: params.retry_max_attempts,
        onRetry: params.effort === undefined ? buildOnRetryCallback({
          originalTask: task,
          persona,
          cfg,
          queue,
          cwd,
          retryMaxAttempts: params.retry_max_attempts,
          mergeStrategy: params.merge_strategy as MergeStrategy | undefined,
          pushNotification: opts.pushCompletionNotification,
          getParentMessages: opts.getParentMessages,
          getSessionId: opts.getSessionId,
          events: opts.getEvents?.(),
        }) : undefined,
        // v0.16 event bus: thread the adapter so emit sites in spawnRun/finalize fire.
        events: opts.getEvents?.(),
      });

      if (result.kind === "queued") {
        const p = result.placeholderRun;
        const downgradedNote = result.downgraded
          ? "Foreground spawn auto-downgraded to background because the concurrency cap is full. " +
            "The sub-agent is queued; completion will arrive as a <sub-agent-completed> notification."
          : "Spawn queued; completion will arrive as a <sub-agent-completed> notification.";
        // A downgraded foreground spawn has no onComplete, so this listener
        // is its one card. A background spawn already carries onComplete
        // through the queue: a listener would double its card and break
        // the tool-kills-are-silent contract. Self-unsubscribes so a later
        // ensemble_send (own onComplete) doesn't re-fire it.
        if (result.downgraded) {
          const unsub = registry.onChange((run) => {
            if (run.id === p.id && isSettled(run.status)) {
              unsub();
              opts.pushCompletionNotification(run);
            }
          });
        }
        return {
          content: [
            {
              type: "text" as const,
              text:
                `${result.downgraded ? "queued-as-background" : "queued"}: ${p.id}\n` +
                `persona=${p.persona} queue_position=${result.queuePosition}\n\n` +
                downgradedNote + effortNote,
            },
          ],
          details: {
            status: result.downgraded ? "queued-as-background" : "queued",
            agent_id: p.id,
            queue_position: result.queuePosition,
            persona: p.persona,
          },
        };
      }

      // result.kind === "spawned"
      if (params.effort !== undefined && result.run.status === "failed") return errorResult(result.run.errorMessage ?? `effort failed to start. ${EFFORT_NOTICE}`);
      if (foreground) {
        // Stream the sub-agent's transcript inline in the parent's
        // tool-call card. Throttled so a fast event stream doesn't flood
        // pi with re-renders. Terminal status flushes unconditionally
        // before the summary is returned.
        const streamWidth = resolveStreamWidth(process.stdout?.columns);
        const streamTheme = opts.getTheme?.();
        const throttle = createUpdateThrottle<Run>((r: Run) => {
          if (!onUpdate) return;
          onUpdate({
            content: [
              {
                type: "text" as const,
                text: renderForegroundStream(r, streamWidth, streamTheme),
              },
            ],
            details: {
              agent_id: r.id,
              status: r.status,
              lastToolCall: r.lastToolCall,
            },
          });
        }, { intervalMs: FOREGROUND_STREAM_INTERVAL_MS });
        // Initial render so the card isn't blank before the first
        // registry change fires.
        throttle.push(result.run);
        let lastToolResultCount = countToolResultMessages(result.run);
        const unsub = registry.onChange((r) => {
          if (r.id !== result.run.id) return;
          // Bypass the throttle when a new toolResult lands so the user
          // sees the ↳ ✓/✗ outcome glyph without waiting out the trailing
          // edge (would otherwise show ↳ … for up to FOREGROUND_STREAM_INTERVAL_MS).
          const c = countToolResultMessages(r);
          if (c > lastToolResultCount) {
            lastToolResultCount = c;
            throttle.pushImmediate(r);
          } else {
            throttle.push(r);
          }
        });

        // Honor abort.
        signal?.addEventListener("abort", () => {
          try {
            void runtimeFor(result.run).stopProcess(result.run);
          } catch {
            // already dead
          }
        });

        try {
          const detach = opts.registerForegroundDetach();
          try {
            const outcome = await awaitOrDetach(result.done, detach.detachSignal);
            if (outcome.kind === "detached") {
              // The sub-agent is still running. Install the post-detach
              // completion listener (handles terminal-flip + race-guard
              // + ignores other run ids; covered by post-detach-listener
              // unit tests).
              installPostDetachCompletionListener(
                result.run,
                registry,
                opts.pushCompletionNotification,
              );
              return renderForegroundDetachedResult(result.run);
            }
            // outcome.kind === "completed"
            // The registry's terminal notify already pushed the final state
            // into the throttle (either fired or pending). Force any pending
            // payload through so the last visible streamed frame matches
            // reality before the tool-call card collapses to the summary.
            throttle.flush();
            return foregroundFinalResult(outcome.value, supportsFocus(ctx), undefined, opts.getSessionId?.(), registry);
          } finally {
            detach.unregister();
          }
        } finally {
          throttle.dispose();
          unsub();
        }
      }

      // background path
      return {
        content: [
          {
            type: "text" as const,
            text:
              `running: ${result.run.id}\n` +
              `persona=${result.run.persona} mode=background\n\n` +
              `Spawned in background. Continue with other work; completion will arrive as a <sub-agent-completed> notification.` +
              effortNote,
          },
        ],
        details: {
          status: "running",
          agent_id: result.run.id,
          mode: "background",
          persona: result.run.persona,
        },
      };
    },
  });
}

// ── ensemble_send ─────────────────────────────────────────────────────────

function registerSendTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.send,
    label: "Send to sub-agent",
    description:
      "Continue an existing sub-agent's session with a new user-role message, or answer its outstanding ask_owner question. " +
      "send relaunches a saved session on its recorded backend; steer/follow_up deliver through live RPC or a proven attached herdr child. " +
      "Live sends await input acknowledgement, not execution. Unconfirmed delivery must not be blindly retried. " +
      "Use the latest available_actions; each call revalidates. " +
      "Foreground (default): blocks until the sub-agent's reply arrives. " +
      "Background: returns immediately; completion or a blocking owner question arrives automatically.",
    promptSnippet: "Send a follow-up message to an existing sub-agent",
    promptGuidelines: [
      "Use ensemble_send when you want to continue working with a sub-agent that already has the context you care about — don't re-spawn from scratch.",
      "Use the latest available_actions; each call revalidates. Retired sessions need a fresh child with the handoff.",
      "Pass agent_id from a previous ensemble_spawn or ensemble_status result.",
      "Use files: ['run:<agent_id>'] to forward a full persisted result instead of a lossy paraphrase. A retired run's handoff can be attached to a fresh child.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({
        description: "agent_id of the sub-agent to send to. Get it from ensemble_spawn or ensemble_status.",
      }),
      message: Type.String({
        description: "User-role message delivered to the sub-agent's existing session.",
      }),
      files: Type.Optional(Type.Array(Type.String(), { description: "Evidence paths or exact run:<agent_id> results. Relative paths use the CALLER's effective conductor cwd (ensemble_cwd), not the target session cwd. ~ expands to HOME. Prepared before send/resume effects; reference-only paths stay live." })),
      foreground: Type.Optional(
        Type.Boolean({
          description:
            "true (default) blocks until the sub-agent finishes its reply; false runs in background and notifies on completion.",
        }),
      ),
      timeout_minutes: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 1440,
          description:
            "Wall-clock timeout for this resumed turn in minutes (1–1440). Overrides per-persona and global defaults. Send arms a fresh budget per call.",
        }),
      ),
      kill_on_stall: Type.Optional(
        Type.Boolean({
          description:
            "v0.10 watchdog opt-in for the resumed turn. true → auto-kill on hard-stall. Replaces the original spawn's value and persists for subsequent sends. Omit to keep the existing setting.",
        }),
      ),
      stall_threshold_seconds: Type.Optional(
        Type.Integer({
          minimum: 30,
          description:
            "v0.10 watchdog soft-stall threshold for the resumed turn, in seconds (≥ 30). Hard threshold scales with the same ratio as conductor defaults. Replaces the original spawn's value.",
        }),
      ),
      on_complete_hook: Type.Optional(
        Type.String({
          description:
            "v0.11 quality-gate hook for the resumed turn. Replaces the original spawn's per-call hook (and persists for subsequent sends until next override). Empty string disables for this resume only.",
        }),
      ),
      on_complete_hook_timeout_seconds: Type.Optional(
        Type.Integer({
          minimum: 1,
          description:
            "v0.11 quality-gate hook timeout (seconds) for the resumed turn. Replaces the original spawn's per-call timeout.",
        }),
      ),
      streaming_behavior: Type.Optional(
        Type.Union(
          [
            Type.Literal("auto"),
            Type.Literal("steer"),
            Type.Literal("follow_up"),
            Type.Literal("resume"),
          ],
          {
            description:
              "auto selects live follow_up or saved-session send. steer delivers a course correction before the next model call; follow_up queues until the agent finishes. resume means the available_actions token send (new process via pi --session), NOT ensemble_resume (SIGCONT). Use the latest available_actions; each call revalidates.",
          },
        ),
      ),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const tmRange = validateTimeoutMinutes(params.timeout_minutes);
      if (tmRange) return errorResult(tmRange);
      const stallRange = validateStallThresholdSeconds(params.stall_threshold_seconds);
      if (stallRange) return errorResult(stallRange);

      const registry = opts.getRegistry();
      const run = registry.get(params.agent_id);
      if (!run) {
        return errorResult(
          `agent_id "${params.agent_id}" not found. Run ensemble_status to see active sub-agents.`,
        );
      }
      const cwd = sendCwd(run, opts.getCwd());
      const cfg = loadConfig(cwd);

      const foreground = params.foreground !== false;
      // Per-persona timeout takes precedence over the global default.
      // Re-resolve the persona registry so a user-configured
      // `timeout_minutes` on the persona is honored for sends, not just
      // for the initial spawn. A per-call `timeout_minutes` arg layers on
      // top of that — same precedence chain as ensemble_spawn.
      const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
      const persona = resolved.personas.get(run.persona);
      const baseOv = cfg.personaOverrides[run.persona] ?? {};
      const ov: PersonaOverride =
        params.timeout_minutes !== undefined
          ? { ...baseOv, timeoutMinutes: params.timeout_minutes }
          : baseOv;
      const timeoutMs = resolveTimeoutMs(persona, ov, cfg);

      const answering = run.pendingAsk;
      const result = sendToRun(run, params.message, {
        sessionId: opts.getSessionId?.(),
        files: params.files,
        callerCwd: opts.getCwd(),
        registry,
        timeoutMs,
        onComplete: foreground
          ? undefined
          : (r) => opts.pushCompletionNotification(r),
        // v0.10 Slice 3: per-send watchdog overrides. Undefined → keep
        // the run's existing values.
        killOnStall: params.kill_on_stall,
        softStallSeconds: params.stall_threshold_seconds,
        // v0.11 on_complete_hook (slice 3) per-send override. Undefined →
        // keep the run's existing per-call hook (set at spawn time).
        onCompleteHook: params.on_complete_hook,
        onCompleteHookTimeoutSeconds: params.on_complete_hook_timeout_seconds,
        // v0.12 slice 4: drive resolveSendStrategy. Undefined → "auto".
        streamingBehavior: params.streaming_behavior,
        // v0.16 event bus: thread through for emitSteered / emitCompleted / emitFailed.
        events: opts.getEvents?.(),
        isRegisteredModel: modelRegistryPredicate(ctx?.modelRegistry),
        currentModelProvider: ctx?.model?.provider,
        persona,
      });

      if (result.kind === "rejected") {
        return errorResult(result.reason);
      }

      // v0.12 slice 4 — RPC steer/follow_up path: await the ack and
      // build the envelope from the delivered/timeout/EPIPE outcome.
      // The sub-agent stays alive across sends, so we don't wait for
      // a terminal status here — the steer is fire-and-forget-with-ack
      // semantics. `foreground` is honored only on the spawn-resume
      // path below.
      if (result.ack !== undefined) {
        try {
          const ackResult = await result.ack;
          if (run.runtime === "herdr") return {
            content: [{ type: "text" as const, text: `${run.id}: ${describeDelivery(ackResult)}` }],
            details: { status: ackResult.delivered ? "accepted-input" : ackResult.definite ? "rejected" : "unconfirmed", agent_id: run.id, persona: run.persona, ...ackResult },
          };
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `delivered: ${result.run.id}\n` +
                  `persona=${result.run.persona} mode=steering (RPC ack received)\n\n` +
                  `The sub-agent acknowledged the message at ${new Date(ackResult.deliveredAt).toISOString()}. It continues running; reply will land on its next message_end.`,
              },
            ],
            details: {
              status: "delivered",
              agent_id: result.run.id,
              persona: result.run.persona,
              delivered: ackResult.delivered,
              delivered_at: ackResult.deliveredAt,
            },
          };
        } catch (e) {
          // 30s ack timeout OR EPIPE-after-enqueue (race where the
          // subprocess exited between enqueue and our await).
          return errorResult((e as Error).message);
        }
      }

      if (foreground) {
        // Stream the sub-agent's transcript inline in the parent's
        // tool-call card while the resumed session runs. Same throttle
        // shape as the spawn path.
        const streamWidth = resolveStreamWidth(process.stdout?.columns);
        const streamTheme = opts.getTheme?.();
        const throttle = createUpdateThrottle<Run>((r: Run) => {
          if (!onUpdate) return;
          onUpdate({
            content: [
              {
                type: "text" as const,
                text: renderForegroundStream(r, streamWidth, streamTheme),
              },
            ],
            details: {
              agent_id: r.id,
              status: r.status,
              lastToolCall: r.lastToolCall,
            },
          });
        }, { intervalMs: FOREGROUND_STREAM_INTERVAL_MS });
        throttle.push(result.run);
        let lastToolResultCount2 = countToolResultMessages(result.run);
        const unsub = registry.onChange((r) => {
          if (r.id !== result.run.id) return;
          const c = countToolResultMessages(r);
          if (c > lastToolResultCount2) {
            lastToolResultCount2 = c;
            throttle.pushImmediate(r);
          } else {
            throttle.push(r);
          }
        });

        // Honor abort.
        signal?.addEventListener("abort", () => {
          try {
            void runtimeFor(result.run).stopProcess(result.run);
          } catch {
            // already dead
          }
        });

        try {
          const detach = opts.registerForegroundDetach();
          try {
            const outcome = await awaitOrDetach(result.done, detach.detachSignal);
            if (outcome.kind === "detached") {
              installPostDetachCompletionListener(
                result.run,
                registry,
                opts.pushCompletionNotification,
              );
              return renderForegroundDetachedResult(result.run);
            }
            // Force any pending payload so the last visible streamed frame
            // matches reality before the tool-call card collapses.
            throttle.flush();
            return foregroundFinalResult(outcome.value, supportsFocus(ctx), answering, opts.getSessionId?.(), registry);
          } finally {
            detach.unregister();
          }
        } finally {
          throttle.dispose();
          unsub();
        }
      }

      // background path
      return {
        content: [
          {
            type: "text" as const,
            text:
              `running: ${result.run.id}\n` +
              `persona=${result.run.persona} mode=background (resumed)\n\n` +
              (answering ? `Answer dispatched for question ${answering.askId}: ${answering.question}\n` : "") +
              `Send dispatched in background. Continue with other work; completion or another owner question will arrive automatically.`,
          },
        ],
        details: {
          status: "running",
          agent_id: result.run.id,
          mode: "background",
          persona: result.run.persona,
        },
      };
    },
  });
}

// ── ensemble_pause / ensemble_resume ───────────────────────────────────────

function registerPauseTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.pause,
    label: "Pause sub-agent",
    description:
      "SIGSTOP a running sub-agent. The process is alive but not consuming tokens. " +
      "Use ensemble_resume to continue. Useful for cost control while the user reviews partial output.",
    promptSnippet: "Pause a running sub-agent",
    promptGuidelines: [
      "Use ensemble_pause to halt token consumption on a long-running sub-agent without killing it.",
      "Use the latest available_actions; each call revalidates.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "agent_id of the sub-agent to pause." }),
    }),
    async execute(_id, params) {
      const registry = opts.getRegistry();
      const run = registry.get(params.agent_id);
      type PauseDetails = { error?: string; status?: string; agent_id?: string; persona?: string };
      if (!run) {
        const r = errorResult(
          `agent_id "${params.agent_id}" not found. Run ensemble_status to see active sub-agents.`,
        );
        return r as { content: typeof r.content; details: PauseDetails };
      }
      const blocker = validateRunAction(run, "pause");
      if (blocker) {
        const r = errorResult(blocker);
        return r as { content: typeof r.content; details: PauseDetails };
      }
      const ok = pauseRun(run, registry);
      if (!ok) {
        const r = errorResult(
          `pause failed for ${run.id}: process handle missing or signal rejected.`,
        );
        return r as { content: typeof r.content; details: PauseDetails };
      }
      return {
        content: [{ type: "text" as const, text: `paused: ${run.id}` }],
        details: { status: "paused", agent_id: run.id, persona: run.persona } as PauseDetails,
      };
    },
  });
}

function registerResumeTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.resume,
    label: "Resume sub-agent",
    description:
      "SIGCONT a paused sub-agent (available_actions token resume), not a new saved-session process. Use the latest available_actions; each call revalidates.",
    promptSnippet: "Resume a paused sub-agent",
    promptGuidelines: [
      "Use ensemble_resume to continue a sub-agent previously paused via ensemble_pause.",
      "Use the latest available_actions; each call revalidates.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "agent_id of the sub-agent to resume." }),
    }),
    async execute(_id, params) {
      const registry = opts.getRegistry();
      const run = registry.get(params.agent_id);
      type ResumeDetails = { error?: string; status?: string; agent_id?: string; persona?: string };
      if (!run) {
        const r = errorResult(
          `agent_id "${params.agent_id}" not found. Run ensemble_status to see active sub-agents.`,
        );
        return r as { content: typeof r.content; details: ResumeDetails };
      }
      const blocker = validateRunAction(run, "resume");
      if (blocker) {
        const r = errorResult(blocker);
        return r as { content: typeof r.content; details: ResumeDetails };
      }
      const ok = resumeRun(run, registry);
      if (!ok) {
        const r = errorResult(
          `resume failed for ${run.id}: process handle missing or signal rejected.`,
        );
        return r as { content: typeof r.content; details: ResumeDetails };
      }
      return {
        content: [{ type: "text" as const, text: `resumed: ${run.id}` }],
        details: { status: "running", agent_id: run.id, persona: run.persona } as ResumeDetails,
      };
    },
  });
}

// ── ensemble_kill ────────────────────────────────────────────────────

function registerKillTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.kill,
    label: "Kill sub-agent",
    description:
      "Force-terminate a running, paused, or queued sub-agent by `agent_id`. " +
      "SIGTERM-then-SIGKILL on processes; queued sub-agents are removed from the queue. " +
      "Use to stop a sub-agent that has run too long, gone off-track, or that you want to " +
      "abort before completion. The sub-agent's run record is preserved for inspection " +
      "(transcript, final.md). Idempotent — calling on an already-terminated sub-agent is a " +
      "no-op success. Killing via tool never triggers a follow-up turn (consistent with the " +
      "existing pi convention that tool-initiated kills are silent).",
    promptSnippet: "Force-terminate a sub-agent",
    promptGuidelines: [
      "Use ensemble_kill to abort a sub-agent that is misbehaving, off-track, or no longer needed.",
      "Use the latest available_actions; each call revalidates. Already-terminal sub-agents remain no-op success.",
      "Run records (transcript, final.md) are preserved for post-mortem inspection.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({
        description: "agent_id of the sub-agent to terminate.",
      }),
    }),
    async execute(_id, params) {
      const registry = opts.getRegistry();
      const queue = opts.getQueue();
      const run = registry.get(params.agent_id);
      type KillDetails = { error?: string; status?: string; agent_id?: string; persona?: string };
      if (!run) {
        const r = errorResult(
          `agent_id "${params.agent_id}" not found. Run ensemble_status to see active sub-agents.`,
        );
        return r as { content: typeof r.content; details: KillDetails };
      }
      // Idempotent: if already-terminal, return current status as success.
      // Matches the brief's "calling on an already-terminated sub-agent is a no-op success".
      if (isTerminal(run.status)) {
        return {
          content: [{ type: "text" as const, text: `already ${run.status}: ${run.id} (no-op)` }],
          details: { status: run.status, agent_id: run.id, persona: run.persona } as KillDetails,
        };
      }
      const blocker = validateRunAction(run, "kill");
      if (blocker) {
        const r = errorResult(blocker);
        return r as { content: typeof r.content; details: KillDetails };
      }
      // Queued runs need to be removed from the pending list AND have their
      // placeholder Run flipped to terminal. SpawnQueue.removeQueued does both
      // (it splices pending and calls forceTerminate on the placeholder).
      if (run.status === "queued") {
        queue.removeQueued(run.id);
      } else {
        // running / paused — forceTerminate handles SIGTERM/SIGKILL on the
        // process handle (best-effort idempotent), flips status to "killed",
        // and persists record + final. We deliberately do NOT pass an
        // onComplete: tool-initiated kills are silent (no follow-up turn).
        forceTerminate(run, "killed", registry);
      }
      return {
        content: [{ type: "text" as const, text: run.runtime === "herdr"
          ? `termination requested: ${run.id}; logical status=${run.status}. Child exit requires proof; pane/worktree cleanup is not implied. Inspect conductor doctor for retained resources.`
          : `killed: ${run.id}` }],
        details: { status: "killed", agent_id: run.id, persona: run.persona } as KillDetails,
      };
    },
  });
}

// ── ensemble_focus ───────────────────────────────────────────────────

function registerFocusTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: CONDUCTOR_LLM_TOOLS.focus,
    label: "Focus a sub-agent",
    description:
      "Request the focused-stream overlay open on a specific sub-agent. " +
      "Use the latest available_actions; each call revalidates. " +
      "When agent_id is omitted, opens the overlay on the currently-focused " +
      "(most recently active) sub-agent. The user controls the overlay with " +
      "Esc (close), Tab/Shift+Tab (cycle), arrows (scroll), c (collapse tool " +
      "calls), t (thinking visibility), k (kill).",
    promptSnippet: "Open the focused-stream overlay on a sub-agent",
    promptGuidelines: [
      "Use ensemble_focus when you want to draw the user's attention to a particular sub-agent's live transcript.",
      "Pass agent_id when you have a specific sub-agent in mind; omit it to open the overlay on the most recently active one.",
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.String({ description: "agent_id of the sub-agent to focus on (omit for most-recent)." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const model = opts.getModel();
      const id = params?.agent_id;
      type FocusDetails = {
        opened: boolean;
        agent_id?: string;
        error?: string;
      };

      const target = id ? opts.getRegistry().get(id) : model.focused();
      if (target) {
        const blocker = validateRunAction(target, "focus", supportsFocus(ctx));
        if (blocker) return { content: [{ type: "text" as const, text: blocker }], details: { opened: false, agent_id: target.id, error: blocker } as FocusDetails };
      }
      if (id) {
        const ok = model.focus(id);
        if (!ok) {
          const details: FocusDetails = { opened: false, agent_id: id, error: "agent_id not found" };
          return {
            content: [
              {
                type: "text" as const,
                text: `agent_id "${id}" not found. Run ensemble_status to see active sub-agents.`,
              },
            ],
            details,
          };
        }
        opts.openFocusedOverlay(id);
        const details: FocusDetails = { opened: true, agent_id: id };
        return {
          content: [{ type: "text" as const, text: `Focused stream opened on ${id}.` }],
          details,
        };
      }

      const focused = model.focused();
      if (!focused) {
        const details: FocusDetails = { opened: false };
        return {
          content: [{ type: "text" as const, text: "No sub-agents to focus on." }],
          details,
        };
      }
      opts.openFocusedOverlay(focused.id);
      const details: FocusDetails = { opened: true, agent_id: focused.id };
      return {
        content: [{ type: "text" as const, text: `Focused stream opened on ${focused.id}.` }],
        details,
      };
    },
  });
}

// ── Formatting / helpers ─────────────────────────────────────────────

/**
 * v0.14 merge strategy for a spawn, or undefined when it gets no worktree.
 * Cascade: per-call > project > user > persona-frontmatter > class default.
 * ensemble_spawn, ensemble_auto steps and classified retries all use it:
 * a worktree run without a strategy lost its branch unmerged (v0.20 B1).
 */
function resolveSpawnMergeStrategy(
  cfg: ReturnType<typeof loadConfig>,
  persona: Persona,
  perCall?: MergeStrategy,
): MergeStrategy | undefined {
  if (cfg.worktreeMode !== "conductor" || persona.worktree !== true) return undefined;
  return resolveMergeStrategy({
    perCall,
    projectOverride: (cfg.personaOverrides[persona.name] as { mergeStrategy?: MergeStrategy } | undefined)?.mergeStrategy,
    userOverride: undefined, // user config merged into cfg.personaOverrides at load time
    personaFrontmatter: (persona as { mergeStrategy?: MergeStrategy }).mergeStrategy,
    personaName: persona.name,
  });
}

function resolveModel(p: Persona, ov: PersonaOverride): string | undefined {
  return ov.model ?? p.model;
}
function resolveThinking(p: Persona, ov: PersonaOverride): ThinkingLevel | undefined {
  return ov.thinking ?? p.thinking;
}

function personaSummary(p: Persona): Record<string, unknown> {
  return {
    name: p.name,
    description: p.description,
    model: p.model ?? "<inherited>",
    thinking: p.thinking ?? "<inherited>",
    inheritContext: p.inheritContext,
    inheritSkills: p.inheritSkills,
    timeoutMinutes: p.timeoutMinutes,
    source: p.source,
    tools: p.tools ?? "<default>",
    excludeTools: p.excludeTools ?? [],
    agents: p.agents ?? [],
  };
}

export function formatPersonaListForLLM(personas: Persona[]): string {
  if (personas.length === 0) {
    return "No personas resolved. Check ~/.pi/agent/conductor/personas/ and `<cwd>/.pi/conductor/personas/`.";
  }
  const lines: string[] = [
    `${personas.length} personas:`,
    `(every sub-agent also runs with the conductor tools excluded: ${CONDUCTOR_LLM_TOOL_NAMES.join(", ")}; and the foreign spawn tools: ${FOREIGN_SPAWN_TOOLS.join(", ")})`,
    "",
  ];
  for (const p of personas) {
    const cfg: string[] = [];
    cfg.push(`source=${p.source}`);
    cfg.push(`model=${p.model ?? "inherited"}`);
    cfg.push(`thinking=${p.thinking ?? "inherited"}`);
    cfg.push(`context=${p.inheritContext}`);
    cfg.push(`tools=${p.tools ? p.tools.join(",") : "default"}`);
    if (p.excludeTools && p.excludeTools.length > 0) {
      cfg.push(`exclude_tools=${p.excludeTools.join(",")}`);
    }
    if (p.agents && p.agents.length > 0) cfg.push(`agents=${p.agents.join(",")}`);
    lines.push(`  ${p.name.padEnd(14)} — ${p.description}`);
    lines.push(`  ${" ".repeat(14)}   [${cfg.join(", ")}]`);
  }
  return lines.join("\n");
}

interface StatusGroups {
  integrating: Run[];
  blocked: Run[];
  running: Run[];
  queued: Run[];
  paused: Run[];
  completed: Run[];
  failed: Run[];
  killed: Run[];
  timeout: Run[];
  hook_failed: Run[];
  merge_conflict: Run[];
  aborted: Run[]; // v0.17
}

function groupByStatus(runs: Run[]): StatusGroups {
  const g: StatusGroups = {
    integrating: [],
    blocked: [],
    running: [],
    queued: [],
    paused: [],
    completed: [],
    failed: [],
    killed: [],
    timeout: [],
    hook_failed: [],
    merge_conflict: [],
    aborted: [],
  };
  for (const r of runs) g[r.status].push(r);
  return g;
}

function toStatusSummary(r: Run, canFocus: boolean, sessionId?: string, registry?: RunRegistry) {
  const observed = observeRunActions(r, canFocus, sessionId, registry);
  return {
    id: r.id,
    available_actions: computeAvailableActions(r, observed),
    wait_reason: r.waitReason ?? observed.effortAdmissionError,
    persona: r.persona,
    status: r.status,
    pending_ask: r.pendingAsk,
    runtime: r.runtime === undefined ? "subprocess" : r.runtime,
    effort: r.effort,
    integration: r.integration,
    landedCommit: r.landedCommit,
    mergeResult: r.mergeResult,
    elapsed: elapsedStr(r.startTime, r.finishedAt),
    usage: formatUsage(r.usage),
    lastToolCall: r.lastToolCall,
    transcriptPath: r.transcriptPath,
  };
}

function formatStatusForLLM(g: StatusGroups, queueSize: number, summaries: Map<string, ReturnType<typeof toStatusSummary>>): string {
  const lines: string[] = [];
  const counts: string[] = [];
  if (g.integrating.length) counts.push(`${g.integrating.length} integrating`);
  if (g.blocked.length) counts.push(`${g.blocked.length} blocked`);
  if (g.running.length) counts.push(`${g.running.length} running`);
  if (g.paused.length) counts.push(`${g.paused.length} paused`);
  if (g.queued.length || queueSize) counts.push(`${g.queued.length} queued`);
  const finished = g.completed.length + g.failed.length + g.killed.length + g.timeout.length + g.hook_failed.length + g.merge_conflict.length + g.aborted.length;
  if (finished) counts.push(`${finished} finished`);
  lines.push(counts.length === 0 ? "No sub-agents." : `Sub-agents: ${counts.join(", ")}.`);

  const groupOrder: Array<[string, Run[]]> = [
    ["Integrating", g.integrating],
    ["Blocked (awaiting owner)", g.blocked],
    ["Running", g.running],
    ["Paused", g.paused],
    ["Queued", g.queued],
    ["Completed", g.completed],
    ["Failed", g.failed],
    ["Killed", g.killed],
    ["Timeout", g.timeout],
    ["Hook failed", g.hook_failed],
    ["Merge conflict", g.merge_conflict],
    ["Aborted", g.aborted],
  ];
  for (const [label, list] of groupOrder) {
    if (list.length === 0) continue;
    lines.push("");
    lines.push(`${label}:`);
    for (const r of list) {
      // v0.17-S6: show ⟳N/M when maxTurns defined, plain N otherwise.
      const turnPart = r.usage.turns > 0
        ? r.maxTurns !== undefined
          ? `⟳${r.usage.turns}/${r.maxTurns}`
          : `⟳${r.usage.turns}`
        : "";
      const tokenPart = formatUsage({ turns: 0, input: r.usage.input, output: r.usage.output, cost: r.usage.cost });
      const usageStr = [turnPart, tokenPart].filter(Boolean).join(" ");
      const usagePart = usageStr ? `[${usageStr}]` : "";
      const waitReason = summaries.get(r.id)!.wait_reason;
      const hint = (waitReason ? ` ${waitReason}` : "") + (r.lastToolCall ? ` → ${r.lastToolCall}` : "") + (r.effort ? ` effort=${effortSummary(r)}` : "");
      lines.push(
        `  ${r.id.padEnd(20)} ${r.persona.padEnd(14)} ${elapsedStr(r.startTime, r.finishedAt).padEnd(6)} ${usagePart}${hint} runtime=${r.runtime === undefined ? "subprocess" : r.runtime} available_actions=${summaries.get(r.id)!.available_actions.join(",") || "(none)"}`,
      );
    }
  }
  return lines.join("\n");
}

function foregroundFinalResult(r: Run, canFocus: boolean, answering?: { askId: string; question: string }, sessionId?: string, registry?: RunRegistry) {
  const actions = availableActions(r, canFocus, sessionId, registry);
  const ref = resultRef(r);
  const answerNotice = answering ? `${r.status === "blocked" && r.errorMessage ? "Answer delivery failed for" : "Answered"} question ${answering.askId}: ${answering.question}\n` : "";
  const summary = answerNotice + renderForegroundSummary(r, actions) + (ref ? `\n  result-ref: ${ref} — pass files: ['${ref}'] for the full evidence.` : "");
  if (r.status === "blocked") return {
    content: [{ type: "text" as const, text: `${summary}\nQuestion ${r.pendingAsk?.askId}: ${r.pendingAsk?.question}${r.pendingAsk?.evidence ?? ""}\nAnswer via ensemble_send; the original assignment is unresolved.` }],
    details: { status: r.status, agent_id: r.id, pending_ask: r.pendingAsk, available_actions: actions },
  };
  if (r.status !== "completed") {
    return {
      content: [{ type: "text" as const, text: summary }],
      details: {
        available_actions: actions,
        result_ref: ref,
        status: r.status,
        agent_id: r.id,
        persona: r.persona,
        errorMessage: r.errorMessage,
        worktreeKept: r.worktreeKept,
        transcriptPath: r.transcriptPath,
      },
    };
  }
  const finalText = getCompletionText(r) || "(no output)";
  return {
    content: [{ type: "text" as const, text: summary }],
    details: {
      available_actions: actions,
      result_ref: ref,
      status: "completed",
      agent_id: r.id,
      persona: r.persona,
      finalText,
      usage: r.usage,
      worktreeKept: r.worktreeKept,
      transcriptPath: r.transcriptPath,
    },
  };
}

function errorResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { error: text },
  };
}

/**
 * Validate a per-call `timeout_minutes` tool argument. Returns an error
 * message string when out of range, undefined when valid (or absent).
 * The schema declares Type.Integer({minimum:1, maximum:1440}); this is the
 * defensive runtime check for hosts that don't enforce the schema.
 */
function validateTimeoutMinutes(tm: number | undefined): string | undefined {
  if (tm === undefined) return undefined;
  if (!Number.isFinite(tm) || !Number.isInteger(tm) || tm < 1 || tm > 1440) {
    return `timeout_minutes must be an integer in [1, 1440]; got ${tm}`;
  }
  return undefined;
}

/**
 * Validate a per-call `stall_threshold_seconds` tool argument. Mirrors
 * {@link validateTimeoutMinutes}; minimum is 30 (tighter watchdogs fire
 * on legitimate slow operations like `npm install` / `brazil-build`).
 */
function validateStallThresholdSeconds(s: number | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (!Number.isFinite(s) || !Number.isInteger(s) || s < 30) {
    return `stall_threshold_seconds must be an integer ≥ 30; got ${s}`;
  }
  return undefined;
}

/**
 * v0.11 slice 3 — validate a per-call `on_complete_hook_timeout_seconds`
 * tool argument. Mirrors {@link validateStallThresholdSeconds}; minimum is
 * 1 (the cascade resolver's default kicks in when the field is omitted, not
 * when it's zero — a zero value would be a degenerate hook that times out
 * before it could run).
 */
function validateHookTimeoutSeconds(s: number | undefined): string | undefined {
  if (s === undefined) return undefined;
  if (!Number.isFinite(s) || !Number.isInteger(s) || s < 1) {
    return `on_complete_hook_timeout_seconds must be a positive integer; got ${s}`;
  }
  return undefined;
}


// ── v0.15 chains ─────────────────────────────────────────────────────────

export interface OnChainCallbackOpts {
  runtimeEnv?: RuntimeEnvironment;
  chainEnabled: boolean;
  personaName: string;
  cfg: ReturnType<typeof import("./config.ts").loadConfig>;
  queue: SpawnQueue;
  /** Where a refused successor is recorded (see failBeforeSpawn). */
  registry: RunRegistry;
  cwd: string;
  pushNotification: (run: Run) => void;
  getParentMessages: () => AgentMessage[];
  /** Spawning slot's pi session id; stamped as `parentSessionId`. */
  getSessionId?: () => string | undefined;
  events?: ConductorEventEmitter;
}

/**
 * Build the `onChain` callback for an `ensemble_spawn` call.
 *
 * Returns `undefined` when:
 *   - `chainEnabled` is false (per-call `chain: false` opt-out)
 *   - no chain step is configured for the persona in `cfg.chains`
 *   - the target persona doesn’t exist in the resolved persona list
 *
 * Chain-spawned runs receive `onChain: undefined` to prevent
 * chain-of-chains (depth-1 cap).
 */
export function buildOnChainCallback(
  args: OnChainCallbackOpts,
): ((run: Run) => void) | undefined {
  if (!args.chainEnabled) return undefined;
  const step = resolveChain(args.personaName, args.cfg.chains);
  if (!step) return undefined;

  return async (parentRun: Run) => {
    if (parentRun.effort) return;
    const chainCwd = parentRun.cwd;
    const chainCfg = loadConfig(chainCwd);

    // v0.18 plans-as-hypotheses: when the step opts into re-evaluation,
    // consult the verdict before spawning. `stop` halts the chain;
    // `adapt`/`insert` retarget the successor (only the LLM-backed
    // verdict in S5 emits those — the deterministic layer emits
    // proceed/stop only).
    let targetPersonaName = step.then;
    let overrideTask: string | undefined;
    if (step.reevaluate) {
      let parentFinal = "";
      if (existsSync(parentRun.finalPath)) {
        try {
          parentFinal = readFileSync(parentRun.finalPath, "utf-8");
        } catch {
          // best-effort; empty final → proceed
        }
      }
      const verdict = evaluateChainOutcome({
        parentFinal,
        parentFailureClass: parentRun.failureClass,
        step,
      });
      if (verdict.kind === "stop") {
        process.stderr.write(
          `[conductor] chain re-eval: STOP after ${parentRun.id} — ${verdict.reason}; not spawning "${step.then}"\n`,
        );
        return;
      }
      if (verdict.kind === "adapt" || verdict.kind === "insert") {
        targetPersonaName = verdict.persona;
        overrideTask = verdict.task;
      }
    }

    const chainResolved = await resolvePersonas({
      cwd: chainCwd,
      personaOverrides: chainCfg.personaOverrides,
    });
    const chainPersona = chainResolved.personas.get(targetPersonaName);
    if (!chainPersona) {
      process.stderr.write(
        `[conductor] chain: persona "${targetPersonaName}" not found — skipping auto-spawn after ${parentRun.id}\n`,
      );
      return;
    }
    const task =
      overrideTask ??
      buildChainTask(step.taskTemplate, {
        persona: parentRun.persona,
        runId: parentRun.id,
        task: parentRun.task,
        finalPath: parentRun.finalPath,
        worktreeBranch: parentRun.worktreeBranch,
        baseBranch: parentRun.worktreeBaseBranch,
        mergeStrategy: parentRun.mergeStrategy,
      });
    const baseOv = chainCfg.personaOverrides[chainPersona.name] ?? {};
    const chainTimeoutMs = step.timeoutMinutes
      ? step.timeoutMinutes * 60 * 1000
      : resolveTimeoutMs(chainPersona, baseOv, chainCfg);
    let preparedTask: string;
    try { preparedTask = appendFileEvidence(task, step.files, { cwd: chainCwd, registry: args.registry, limit: chainCfg.inlineAttachmentLimitBytes }); }
    catch (e) {
      process.stderr.write(`[conductor] chain after ${parentRun.id} rejected: ${(e as Error).message}\n`);
      return;
    }
    let runtime: RuntimeKind;
    try { runtime = prepareSpawnRuntime({ persona: chainPersona, cwd: chainCwd, runtimeEnv: args.runtimeEnv }).runtime; }
    catch (e) { process.stderr.write(`[conductor] chain after ${parentRun.id} rejected: ${(e as Error).message}\n`); return; }
    const spawn = {
      runtime,
      persona: chainPersona,
      task: preparedTask,
      mode: "background" as const,
      cwd: chainCwd,
      model: resolveModel(chainPersona, baseOv),
      thinking: resolveThinking(chainPersona, baseOv),
      timeoutMs: chainTimeoutMs,
      parentMessages: args.getParentMessages(),
      parentSessionId: args.getSessionId?.(),
      // ensemble_spawn's worktree decision. A merged parent's work is on
      // HEAD by now, which is where the successor's worktree branches from.
      worktree: chainCfg.worktreeMode === "conductor" && chainPersona.worktree === true,
      mergeStrategy: resolveSpawnMergeStrategy(chainCfg, chainPersona),
      onComplete: (run: Run) => args.pushNotification(run),
      // no onChain: depth-1 cap (chain-spawned runs do not chain further)
      events: args.events,
    };
    const refusal = WRITE_CAPABLE_PERSONAS.has(chainPersona.name) ? keptParentRefusal(parentRun, chainPersona.name) : undefined;
    if (refusal) {
      failBeforeSpawn({ ...spawn, registry: args.registry }, refusal);
      return;
    }
    args.queue.enqueueOrSpawn(spawn as SpawnOptions);
  };
}

/**
 * Why a write-capable successor can't start after `parent`: the parent's
 * branch was kept unmerged (mergeStrategy none), so a worktree from HEAD
 * would lack its work. Undefined when the work is on HEAD or never branched.
 */
function keptParentRefusal(parent: Run, successor: string): string | undefined {
  const branch = parent.worktreeBranch;
  if (!branch || parent.mergeResult?.success === true) return undefined;
  const base = parent.worktreeBaseBranch ?? "its base branch";
  const gitRoot = parent.worktreePath
    ? dirname(dirname(dirname(parent.worktreePath)))
    : (resolveWorktreeSpec(parent.cwd, parent.id)?.gitRoot ?? parent.cwd);
  const hint = parent.worktreeKept ?? keptBranchHint(gitRoot, branch);
  return (
    `chain: ${successor} not started after ${parent.id}: its work is on the kept branch ${branch}, ` +
    `not merged into ${base}, and a ${successor} branched from ${base} would lack it. ` +
    `${hint}; then spawn ${successor} again.`
  );
}

// ── v0.18 classified retry ───────────────────────────────────────────────

export interface OnRetryCallbackOpts {
  /** Pristine first-attempt task — never a previously-augmented one. */
  originalTask: string;
  persona: import("./types.ts").Persona;
  cfg: ReturnType<typeof import("./config.ts").loadConfig>;
  queue: SpawnQueue;
  cwd: string;
  /** Per-call retry budget (highest cascade layer); threaded to the re-spawn. */
  retryMaxAttempts?: number;
  /** Per-call merge strategy (highest cascade layer); re-resolved for the re-spawn. */
  mergeStrategy?: MergeStrategy;
  pushNotification: (run: Run) => void;
  getParentMessages: () => AgentMessage[];
  /** Spawning slot's pi session id; stamped as `parentSessionId`. */
  getSessionId?: () => string | undefined;
  events?: ConductorEventEmitter;
}

/**
 * Build the `onRetry` callback for an `ensemble_spawn` call.
 *
 * Fired by `finalize`/`applyRetryIfNeeded` when a non-completed terminal
 * is retryable under the run's resolved policy. Re-spawns the SAME persona
 * with a diagnostic-augmented task (built from the pristine original, so
 * preambles never stack) and `retryAttempt = failedAttempt + 1`.
 *
 * The re-spawn carries THIS SAME callback as its `onRetry`, so successive
 * failures keep retrying until `shouldRetry` caps out at `maxAttempts`.
 * Re-spawns run in the background and notify on completion (the original
 * may have been foreground; a retry is always background).
 */
export function buildOnRetryCallback(
  args: OnRetryCallbackOpts,
): (run: Run) => void {
  const self = (failedRun: Run): void => {
    if (failedRun.effort) return;
    const failedAttempt = failedRun.retryAttempt ?? 0;
    const maxAttempts = failedRun.retryPolicy?.maxAttempts ?? 1;
    const ov = args.cfg.personaOverrides[args.persona.name] ?? {};
    const task = buildRetryTask({
      originalTask: args.originalTask,
      failureClass: failedRun.failureClass ?? "unknown",
      attempt: failedAttempt,
      maxAttempts,
      errorMessage: failedRun.errorMessage,
    });
    args.queue.enqueueOrSpawn({
      persona: args.persona,
      runtime: failedRun.runtime === undefined ? "subprocess" : failedRun.runtime,
      task,
      mode: "background",
      cwd: args.cwd,
      model: resolveModel(args.persona, ov),
      thinking: resolveThinking(args.persona, ov),
      timeoutMs: resolveTimeoutMs(args.persona, ov, args.cfg),
      parentMessages: args.getParentMessages(),
      parentSessionId: args.getSessionId?.(),
      // Preserve worktree isolation across retries for write-capable personas.
      worktree: args.cfg.worktreeMode === "conductor" && args.persona.worktree === true,
      mergeStrategy: resolveSpawnMergeStrategy(args.cfg, args.persona, args.mergeStrategy),
      // Carry the incremented attempt + the same per-call budget so the
      // re-spawned run resolves the same policy and can retry again.
      retryAttempt: failedAttempt + 1,
      retryMaxAttempts: args.retryMaxAttempts,
      onRetry: self,
      onComplete: (run) => args.pushNotification(run),
      events: args.events,
    } as SpawnOptions);
  };
  return self;
}
