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

export type ContextInheritance = "none" | "filtered" | "full";

export const CONTEXT_INHERITANCE: ContextInheritance[] = ["none", "filtered", "full"];

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
  queueOnConcurrencyCap: boolean;
  autoOpenFocusOnSpawn: boolean;
  defaultSpawnMode: "foreground" | "background";
  /**
   * v0.8: pinned conductor-mode default at extension load. Beats the
   * `PI_CONDUCTOR_MODE` env var so users can set "always on" once and
   * forget. Built-in default is `"off"`.
   */
  defaultMode: "on" | "off";
  personaOverrides: Record<string, PersonaOverride>;
  conductorPromptPath: string | null;
}

export interface PersonaOverride {
  disabled?: boolean;
  model?: string;
  thinking?: ThinkingLevel;
  timeoutMinutes?: number;
  inheritContext?: ContextInheritance;
  inheritSkills?: boolean;
}

export const DEFAULT_CONFIG: ConductorConfig = {
  defaultTimeoutMinutes: 30,
  maxConcurrent: 4,
  queueOnConcurrencyCap: true,
  autoOpenFocusOnSpawn: false,
  defaultSpawnMode: "foreground",
  defaultMode: "off",
  personaOverrides: {},
  conductorPromptPath: null,
};

// ── Run lifecycle types (v0.2) ────────────────────────────────────────

export type RunStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "killed"
  | "timeout";

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
  /** ms timestamp of last pause; cleared on resume. */
  pausedAt?: number;

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
  };
}

export const TERMINAL_STATUSES: RunStatus[] = ["completed", "failed", "killed", "timeout"];
export function isTerminal(s: RunStatus): boolean {
  return TERMINAL_STATUSES.includes(s);
}
