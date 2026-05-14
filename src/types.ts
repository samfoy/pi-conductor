/**
 * pi-conductor — Shared types.
 */

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
  personaOverrides: {},
  conductorPromptPath: null,
};
