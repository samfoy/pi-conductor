/**
 * pi-conductor — Shared types.
 */

import type { ChildProcess } from "node:child_process";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const THINKING_LEVELS: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export type ContextInheritance = "none" | "filtered" | "filtered_compact" | "full";

export const CONTEXT_INHERITANCE: ContextInheritance[] = [
  "none",
  "filtered",
  "filtered_compact",
  "full",
];

export type PersonaSource = "builtin" | "user" | "project";

/**
 * A persona definition resolved from a markdown file with YAML-ish frontmatter.
 * `model` and `thinking` are intentionally optional — when omitted, the
 * sub-agent inherits the parent session's configuration.
 *
 * Note: there is no `tools` field. Pi has no clean way to whitelist tools
 * in a child subprocess, and we don't fake it. Personas describe expected
 * tool boundaries in the prompt body, not via runtime gating.
 */
export interface Persona {
  /** Unique name within the resolved scope (project overrides user overrides builtin). */
  name: string;
  /** One-line description shown in /conductor list and orchestrator prompt. */
  description: string;
  /** Provider-qualified model ID. Omit to inherit from parent session. */
  model?: string;
  /** Thinking level. Omit to inherit from parent session. */
  thinking?: ThinkingLevel;
  /** What slice of parent context the sub-agent receives. */
  inheritContext: ContextInheritance;
  /** Whether the parent's skill catalog is passed to the sub-agent. */
  inheritSkills: boolean;
  /** Files auto-prepended to the launch prompt as context (relative to cwd). */
  defaultReads: string[];
  /** Run the sub-agent in a git worktree (v2 — currently unused, parsed for forward-compat). */
  worktree: boolean;
  /** Hard timeout in minutes. */
  timeoutMinutes: number;
  /** The system prompt body (everything after the frontmatter). */
  systemPrompt: string;
  /** Where this persona was loaded from. */
  source: PersonaSource;
  /** Absolute path to the source file. */
  sourcePath: string;
  /**
   * v0.11 on_complete_hook (slice 1a types): shell command to run after
   * the sub-agent reaches a `completed` terminal. Empty string means
   * explicit-disable (short-circuits the cascade). Undefined means
   * "fall through to next layer". Slice 4 wires the frontmatter parser
   * that populates this field; slice 1b's resolver reads it.
   */
  onCompleteHook?: string;
  /**
   * v0.11 on_complete_hook (slice 1a types): timeout in seconds. Default
   * 300 (resolved by slice 1b's `resolveOnCompleteHook` from the same
   * cascade layer that produced `onCompleteHook`). Slice 4 wires the
   * parser.
   */
  onCompleteHookTimeoutSeconds?: number;
}

export interface PersonaResolution {
  /** Resolved personas keyed by name (project > user > builtin). */
  personas: Map<string, Persona>;
  /** Per-name list of all sources that defined this name (for /conductor doctor). */
  shadowed: Map<string, Persona[]>;
  /** Files that failed to parse, with reasons. */
  errors: PersonaLoadError[];
}

export interface PersonaLoadError {
  path: string;
  reason: string;
}

export interface ConductorConfig {
  defaultTimeoutMinutes: number;
  maxConcurrent: number;
  /**
   * v0.9 Item 2(c): separate cap on concurrently-running write-capable
   * sub-agents (`builder`, `simplifier`). Default 1. Read-only personas
   * are not affected. Set to a number >= maxConcurrent (or any large
   * value) to disable the cap.
   */
  maxConcurrentWriteCapable: number;
  queueOnConcurrencyCap: boolean;
  autoOpenFocusOnSpawn: boolean;
  defaultSpawnMode: "foreground" | "background";
  /**
   * v0.8: pinned conductor-mode default at extension load. Beats the
   * `PI_CONDUCTOR_MODE` env var so users can set "always on" once and
   * forget. Built-in default is `"off"`.
   */
  defaultMode: "on" | "off";
  /**
   * v0.12 steering: project/user-config default for `ensemble_spawn`'s
   * `steerable` arg. Cascade per-call > project > user > built-in
   * default `false`. Mirrors `WatchdogConfigDefaults.defaultKillOnStall`
   * shape exactly (oracle gate 2 ADJUST: cascade-shape isomorphism).
   * Slice 4 wires the per-call layer; slice 1 lands the type plumbing.
   */
  defaultSteerable?: boolean;
  personaOverrides: Record<string, PersonaOverride>;
  conductorPromptPath: string | null;
  /**
   * v0.9 — Run-record garbage collection (capstone). Default-on with
   * conservative thresholds; the auto-on-session-start trigger is
   * debounced and dry-run-logs the plan before reclaiming. See
   * docs/v0.9-gc-design.md (D1–D8) for the policy semantics.
   */
  gc: GcConfig;
  /**
   * v0.10 sub-agent watchdog defaults. Per-spawn arguments override
   * these (slice 3). See docs/v0.10-watchdog-design.md.
   */
  watchdog: WatchdogConfigDefaults;
}

/**
 * Defaults for the v0.10 watchdog. The runtime detector type lives in
 * `src/watchdog.ts` (`WatchdogConfig`) but ConductorConfig stores the
 * user-tunable defaults plus the spawn default for `kill_on_stall`.
 */
export interface WatchdogConfigDefaults {
  /** Master switch. When false, the watchdog never fires. */
  enabled: boolean;
  /** Default soft-stall threshold (seconds). Per-spawn override allowed. */
  defaultSoftSeconds: number;
  /** Default hard-stall threshold (seconds). Per-spawn override allowed. */
  defaultHardSeconds: number;
  /** Cold-start grace window (seconds). */
  graceSeconds: number;
  /** Detector tick interval (seconds). */
  tickIntervalSeconds: number;
  /**
   * Default `kill_on_stall` for spawns that don't override. OFF by
   * design (advisory-only); autonomous chains opt in.
   */
  defaultKillOnStall: boolean;
}

export interface GcConfig {
  /** Master switch. When false, all GC paths (auto + manual) no-op. */
  enabled: boolean;
  /** Age (days) at which a `completed` run becomes delete-eligible (after cold-archive). */
  completedTtlDays: number;
  /** Age (days) for `failed`/`killed`/`timeout` runs. Diagnostic-gold; kept longer. */
  failedTtlDays: number;
  /** Total disk budget across all runs. Above this, largest non-pinned non-archived runs cold-archive first. */
  totalSizeBudgetBytes: number;
  /** Per-transcript cap. A single transcript exceeding this cold-archives regardless of age. */
  transcriptSizeCapBytes: number;
  /** Orphan-detection age in hours: a `running` record with no live process and stale mtime reconciles to `killed`. */
  orphanReconcileAfterHours: number;
  /** Auto-trigger on `session_start` (debounced). Disable to make GC manual-only. */
  autoOnSessionStart: boolean;
  /** Skip auto-GC if last GC ran within this window. */
  autoDebounceHours: number;
  /** Per-persona TTL override (days). Empty by default. Lets users shorten designer/planner without affecting other personas. */
  perPersonaTtlDays: Record<string, number>;
}

export interface PersonaOverride {
  disabled?: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  timeoutMinutes?: number;
  inheritContext?: ContextInheritance;
  inheritSkills?: boolean;
  /**
   * v0.11 on_complete_hook (slice 1a types): per-persona override of
   * the hook command. Empty string = explicit-disable. Slice 4 wires
   * config plumbing; slice 1b's resolver reads it.
   */
  onCompleteHook?: string;
  /**
   * v0.11 on_complete_hook (slice 1a types): per-persona override of
   * the hook timeout in seconds.
   */
  onCompleteHookTimeoutSeconds?: number;
}

export const DEFAULT_CONFIG: ConductorConfig = {
  defaultTimeoutMinutes: 60,
  maxConcurrent: 4,
  maxConcurrentWriteCapable: 1,
  queueOnConcurrencyCap: true,
  autoOpenFocusOnSpawn: false,
  defaultSpawnMode: "foreground",
  defaultMode: "off",
  personaOverrides: {},
  conductorPromptPath: null,
  gc: {
    enabled: true,
    completedTtlDays: 30,
    failedTtlDays: 60,
    totalSizeBudgetBytes: 5 * 1024 * 1024 * 1024,
    transcriptSizeCapBytes: 100 * 1024 * 1024,
    orphanReconcileAfterHours: 24,
    autoOnSessionStart: true,
    autoDebounceHours: 6,
    perPersonaTtlDays: {},
  },
  watchdog: {
    enabled: true,
    defaultSoftSeconds: 120,
    defaultHardSeconds: 600,
    graceSeconds: 30,
    tickIntervalSeconds: 30,
    defaultKillOnStall: false,
  },
  // v0.12 steering: built-in default OFF — mirrors v0.10 kill_on_stall
  // posture (PRD.md:517). No autonomous-chain field data justifies
  // flipping it. Slice 1 ships the field; slice 4 wires per-call.
  defaultSteerable: false,
};

// ── Run lifecycle types (v0.2) ────────────────────────────────────────

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "killed"
  | "timeout"
  | "hook_failed";

export type SpawnMode = "foreground" | "background";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

/**
 * One sub-agent run.
 *
 * The runtime mutates these fields as the subprocess streams its JSON events.
 * Persistence to disk happens via `runs.ts` — record.json is written on every
 * status change; transcript.jsonl is appended per stream event.
 */
export interface Run {
  /** Stable id, e.g. `oracle-7f3a`. Used by ensemble_send/stop/etc. */
  id: string;
  /** Persona name as resolved at spawn time. */
  persona: string;
  /** The task prompt the LLM gave us. default_reads contents are NOT inlined — they are passed as separate prompt prefix. */
  task: string;
  /** Resolved model id at spawn time (after persona/override resolution). May be undefined when inheriting. */
  model?: string;
  /** Resolved thinking level at spawn time. */
  thinking?: ThinkingLevel;
  /** foreground or background. "queued-as-background" auto-downgrades and lands here as "background". */
  mode: SpawnMode;
  /** Lifecycle status. */
  status: RunStatus;
  /** ms since epoch. */
  startTime: number;
  /** ms since epoch; set when status transitions to a terminal state. */
  finishedAt?: number;
  /**
   * ms since epoch of the most recent event we observed for this run
   * (currently: every push to `messages`). Initialized to `startTime`
   * at run creation. Used by `renderHeader` to derive an idle indicator.
   * Required so consumers don't have to fall back to `startTime`.
   */
  lastEventAt: number;
  /** ms timestamp of last pause; cleared on resume. */
  pausedAt?: number;
  /**
   * v0.10 watchdog: ms-since-epoch the run last crossed a stall
   * threshold (soft or hard). Cleared by the enforcer on recovery or
   * terminal status. Slice 1 only declares the field; Slice 2 writes
   * to it from the watchdog enforcer.
   */
  stalledSince?: number;
  /**
   * v0.10 watchdog (Slice 3) per-spawn override. When `true`, the
   * watchdog auto-kills this run on hard-stall. When undefined, the
   * conductor-wide default `cfg.watchdog.defaultKillOnStall` applies.
   *
   * Set by the spawn pipeline from the `kill_on_stall` LLM tool arg or
   * persona override, never by event handlers. Persists for the
   * lifetime of the run (re-spawned `ensemble_send` calls keep the
   * original spawn's value unless explicitly re-overridden).
   */
  killOnStall?: boolean;
  /**
   * v0.10 watchdog (Slice 3) per-spawn override of the soft threshold,
   * in seconds. The hard threshold scales with the soft override at
   * the same ratio as the conductor defaults
   * (`defaultHardSeconds / defaultSoftSeconds`, typically 5×). When
   * undefined, both thresholds come from
   * `cfg.watchdog.defaultSoftSeconds` / `defaultHardSeconds`.
   *
   * Validated at the tool boundary: must be ≥ 30. Tighter values would
   * fire on legitimate slow operations (npm install, brazil-build)
   * with no user benefit.
   */
  softStallSeconds?: number;

  // ── v0.12 steering (slice 1 types) ───────────────────────────────────────
  // Slice 1 declares these optional fields; slice 2 wires the RPC
  // subprocess plumbing that consumes them; slice 4 wires the
  // upstream cascade-collapse that stamps `steerable` at spawn time.
  // Slice 1 leaves them undefined in production paths.

  /**
   * v0.12: per-spawn steerable flag, resolved at spawn time from the
   * 4-layer cascade (per-call > project > user > built-in default
   * `false`) collapsed onto this field, then read by
   * `resolveSteerable(run, defaultSteerable)` in `src/steerable.ts`
   * (one-line `run.steerable ?? defaultSteerable`, mirrors
   * `src/watchdog.ts:287` resolveKillOnStall). Drives:
   *   - `--mode` flag in `buildPiArgs` (rpc vs json -p) (slice 2)
   *   - stdio: ["pipe", "pipe", "pipe"] in spawn opts (slice 2)
   *   - `resolveSendStrategy`'s reject-on-running-print-mode branch
   *     (slice 1)
   * Persisted on RunRecord so post-startup reconcile (v0.9.x) knows
   * which mode the orphan was launched in.
   */
  steerable?: boolean;

  /**
   * v0.12: derived from `steerable`. Either `"print"` (today's
   * default) or `"rpc"`. Stored separately from `steerable` because
   * it captures *what mode the subprocess is actually running in*
   * — useful for diagnostics, doctor surface, and the tiny chance
   * that future cascade layers invalidate `steerable` post-spawn.
   * No production path produces `"rpc"` until slice 2.
   */
  streamingMode?: "print" | "rpc";

  /**
   * Process pid for the spawned pi subprocess. Used by post-startup
   * reconcile (v0.9.x) to liveness-probe orphaned `running` records via
   * `kill(pid, 0)`. Captured by `recordSpawnedProc` immediately after
   * `child_process.spawn` returns. May be `undefined` for re-adopted
   * runs whose original record predates the schema bump, or for runs
   * whose spawn failed before pid was assigned.
   */
  pid?: number;

  /**
   * OS pid of the conductor host process (this pi runtime) at spawn
   * time. Persisted so post-startup reconcile in a *sibling* pi session
   * can distinguish records owned by another live host (skip-foreign)
   * from genuine orphans (parent crashed → readopt). Captured at spawn
   * site as `process.pid`. Survives `pi /reload` because reload is an
   * in-process module re-import, not an exec. Optional for back-compat
   * with records written before this slice.
   */
  parentPid?: number;

  /**
   * Linux-only fingerprint defending against pid reuse: `/proc/<pid>/stat`
   * field 22 (process start time in clock ticks since boot). Compared
   * against a fresh read at reconcile time; mismatch → original parent
   * is gone and a new process happens to share its pid. Undefined on
   * non-Linux (no portable `/proc`); absence degrades to parentPid-only,
   * which has a tiny pid-reuse race that is still strictly better than
   * the pre-fix global readopt.
   */
  parentStartTime?: number;

  /** Exit code of the pi subprocess; set on close. */
  exitCode?: number;
  /** Stop reason from the last assistant message: stop | error | aborted | … */
  stopReason?: string;
  /** First error message we saw on stderr or in an aborted message. */
  errorMessage?: string;

  /** Streamed messages from the sub-agent. */
  messages: AgentMessage[];
  /** Aggregate usage across all of the sub-agent's assistant messages. */
  usage: Usage;
  /** Latest tool-call summary for the live widget (e.g. "$ git diff"). */
  lastToolCall?: string;
  /**
   * Set on `completed`-bound runs whose final assistant message looks
   * non-substantive (no terminal text, < 200 chars, or starts with an
   * orient-yourself preamble). See `src/substance-check.ts`. Surfaced
   * in the `<sub-agent-completed>` envelope as a `<warning>` line.
   * Does NOT block completion — advisory only.
   */
  nonSubstantiveFinal?: { reason: string; message: string };

  /** Path to record.json for this run. */
  recordPath: string;
  /** Path to transcript.jsonl for this run. */
  transcriptPath: string;
  /** Path to final.md (last assistant text). Written on terminal status. */
  finalPath: string;
  /**
   * Absolute path to the pi session JSONL for this sub-agent. Populated when
   * the spawn finalizes (pi creates the file under <runDir>/session/). Used
   * by `ensemble_send` to resume the sub-agent via `pi --session <path>`.
   * `undefined` for runs that were queued but never spawned, or for runs
   * predating v0.5.
   */
  sessionPath?: string;
  /**
   * Persona system-prompt body captured at spawn time. Pi sessions do NOT
   * persist system prompts to disk, so any resume (`pi --session <path>`)
   * needs us to re-pass `--append-system-prompt` or the sub-agent boots
   * with pi's default coding-agent prompt and loses its persona identity.
   * Optional for back-compat with Run records persisted before this field
   * existed.
   */
  systemPrompt?: string;

  /** Working directory of the subprocess. */
  cwd: string;

  /** The subprocess; cleared on close. */
  proc?: ChildProcess;
  /** Hard timeout timer; cleared on close. */
  timeoutTimer?: NodeJS.Timeout;
  /** Watchers (intervals etc) that need cleanup. */
  watcher?: NodeJS.Timeout;

  // ── v0.11 on_complete_hook (slice 1a types) ────────────────────────
  // Slice 1a declares these optional fields; slice 2 mutates them from
  // the hook enforcer in `runs.ts`. They are NOT read by anything in
  // slice 1a — the coherence claim is that the codebase compiles and
  // tests stay green while `hook_failed` is unreachable in production.

  /**
   * The hook subprocess handle when an `on_complete_hook` is currently
   * executing. Cleared after the hook resolves (success, failure, or
   * forced kill). Slice 2 sets and clears this; slice 1a only declares
   * it so `forceTerminate` can dispatch on it without a type widening.
   */
  hookProc?: ChildProcess;

  /**
   * True while the hook subprocess is alive. Read by the watchdog
   * enforcer (slice 2) to skip stall checks during hook execution — the
   * pi process is gone but we don't want to flag the run as stalled.
   */
  hookExecuting?: boolean;

  /**
   * Final result of the hook. Persisted to RunRecord (slice 2). Read by
   * the completion-envelope renderer (slice 5) and history. Undefined
   * for runs whose terminal close did not invoke a hook.
   */
  hookResult?: HookResult;
}

/** Persisted record.json shape (subset of Run, no proc/timer references). */
export interface RunRecord {
  id: string;
  persona: string;
  task: string;
  model?: string;
  thinking?: ThinkingLevel;
  mode: SpawnMode;
  status: RunStatus;
  startTime: number;
  /**
   * Process pid for the spawned pi subprocess. Persisted by
   * `toRunRecord`; consumed by post-startup reconcile (v0.9.x) to
   * liveness-probe orphaned `running` records via `kill(pid, 0)`.
   * Optional for back-compat with records written before slice 1.
   */
  pid?: number;
  /**
   * Conductor host pid at spawn time. See `Run.parentPid`. Used by
   * sibling pi sessions to skip-foreign records owned by a different
   * live host. Optional for back-compat.
   */
  parentPid?: number;
  /**
   * Linux-only `/proc/<pid>/stat` start-time fingerprint to defend
   * against pid reuse. See `Run.parentStartTime`.
   */
  parentStartTime?: number;
  finishedAt?: number;
  pausedAt?: number;
  exitCode?: number;
  stopReason?: string;
  errorMessage?: string;
  usage: Usage;
  cwd: string;
  recordPath: string;
  transcriptPath: string;
  finalPath: string;
  sessionPath?: string;
  systemPrompt?: string;
  /**
   * v0.12 steering: spawn-time steerable flag. See `Run.steerable`.
   * Persisted to record.json so post-startup reconcile (v0.9.x) knows
   * the original mode of an orphaned record.
   */
  steerable?: boolean;
  /**
   * v0.12 steering: actual subprocess mode. See `Run.streamingMode`.
   * Persisted to record.json. Optional for back-compat with pre-v0.12
   * records.
   */
  streamingMode?: "print" | "rpc";
  /**
   * v0.11 on_complete_hook (slice 2): persisted hook outcome on terminal
   * runs whose close handler invoked a hook. Undefined for runs that did
   * not invoke a hook. Read by the completion-envelope renderer (slice 5)
   * and history surfaces.
   */
  hookResult?: HookResult;
}

export function toRunRecord(r: Run): RunRecord {
  return {
    id: r.id,
    persona: r.persona,
    task: r.task,
    model: r.model,
    thinking: r.thinking,
    mode: r.mode,
    status: r.status,
    startTime: r.startTime,
    pid: r.pid,
    parentPid: r.parentPid,
    parentStartTime: r.parentStartTime,
    finishedAt: r.finishedAt,
    pausedAt: r.pausedAt,
    exitCode: r.exitCode,
    stopReason: r.stopReason,
    errorMessage: r.errorMessage,
    usage: r.usage,
    cwd: r.cwd,
    recordPath: r.recordPath,
    transcriptPath: r.transcriptPath,
    finalPath: r.finalPath,
    sessionPath: r.sessionPath,
    systemPrompt: r.systemPrompt,
    steerable: r.steerable,
    streamingMode: r.streamingMode,
    hookResult: r.hookResult,
  };
}

// ── v0.11 on_complete_hook types (slice 1a) ─────────────────────
// Slice 1a declares these types; slice 1b's pure resolver consumes
// `HookSpec` / `ResolvedHook` / `HookSource`; slice 2's enforcer
// produces `HookResult`. No production path emits these in slice 1a.

/** Where in the cascade a resolved hook came from. */
export type HookSource = "per-call" | "project" | "user" | "persona";

/**
 * A hook input (pre-resolution). The per-call layer of the cascade
 * carries this shape; project/user config and persona frontmatter
 * provide the same data via their own typed fields.
 *
 * Empty string `command` is the explicit-disable sentinel — short-
 * circuits the cascade. Undefined `command` means "fall through".
 */
export interface HookSpec {
  command?: string;
  timeoutSeconds?: number;
}

/**
 * A fully-resolved hook ready for execution. Slice 2's enforcer takes
 * one of these (or `undefined` for "no hook") and spawns the
 * subprocess.
 */
export interface ResolvedHook {
  /** Non-empty shell command. Empty string never appears here — the cascade short-circuits. */
  command: string;
  /** Timeout in seconds (default 300, applied by the resolver). */
  timeoutSeconds: number;
  /** Layer the resolved values came from — surfaced in doctor and the `<hook>` envelope. */
  source: HookSource;
}

/**
 * Outcome of a single hook execution. Persisted to `RunRecord` (slice 2)
 * and rendered into the completion envelope's `<hook>` block (slice 5).
 */
export interface HookResult {
  passed: boolean;
  command: string;
  /** Null when the hook was killed by signal or failed to spawn. */
  exitCode: number | null;
  durationMs: number;
  /** Absolute path to runDir(id)/hook.log. */
  logPath: string;
  /** Last 50 lines / 4 KB of stdout+stderr, captured for the envelope. */
  tailText: string;
  tailBytes: number;
  tailLines: number;
  failureKind?: "exited" | "timeout" | "spawn_error" | "signal" | "runaway_output";
}

export const TERMINAL_STATUSES: RunStatus[] = [
  "completed",
  "failed",
  "killed",
  "timeout",
  "hook_failed",
];
export function isTerminal(s: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}

// ── v0.12 steering — send-strategy resolver types ──────────────────────
//
// Pinned by `tests/runs-streaming-strategy.test.ts` (slice 1).
// Production resolver lives in `src/runs.ts: resolveSendStrategy`.
// `validateSendable` becomes a 3-line shim around
// `resolveSendStrategy(run, "auto")` plus a post-strategy I/O check
// for session-file existence on disk.

/** LLM-facing arg on `ensemble_send`. Slice 4 wires the tool param. */
export type StreamingBehavior = "auto" | "steer" | "follow_up" | "resume";

/**
 * Output of `resolveSendStrategy`. Tagged union so the caller can
 * dispatch on `kind` without re-checking status/streamingMode.
 */
export interface ResolvedSendStrategy {
  strategy:
    | { kind: "rpc-steer" }
    | { kind: "rpc-follow-up" }
    | { kind: "spawn-resume" }
    | { kind: "rejected"; reason: string };
}
