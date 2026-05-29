/**
 * pi-conductor — Run registry and subprocess spawning.
 *
 * One sub-agent = one `pi --mode json -p --session-dir <runDir>/session/`
 * subprocess on initial spawn, or `pi --mode json -p --session <path>` when
 * resumed via ensemble_send. We stream its JSON events, mutate the Run state,
 * persist transcript + record, and surface live updates to the ensemble panel
 * and (optionally) the parent tool call's onUpdate stream.
 *
 * Foreground vs background:
 *   - foreground: caller awaits spawnRun(). Promise resolves on terminal.
 *   - background: caller does NOT await; on terminal, the registered
 *     onComplete callback is fired (the entry point uses this to push
 *     a <sub-agent-completed> notification card).
 *
 * Concurrency cap: the queue lives in queue.ts. spawnRun() is the entry that
 * may be called either directly (slot available) or by the queue draining.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { RpcStdinQueue } from "./rpc-stdin.ts";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { noteAllocatedId } from "./gc/id-reuse.ts";
import { applyEvent } from "./event-handler.ts";
import { filterParentContext, filterParentContextCompact } from "./context-filter.ts";
import { resolveInheritContext } from "./inherit-context.ts";
import { seedSessionFile } from "./session-seed.ts";
import { isNonSubstantiveFinalMessage } from "./substance-check.ts";
import { resolveOnCompleteHook, type HookCascadeInput } from "./hook-cascade.ts";
import { runHook, defaultKillGroup } from "./hook-runner.ts";
import { loadConfigWithErrors } from "./config.ts";
import { readProcessStartTime } from "./reconcile-startup.ts";
import {
  emptyUsage,
  isTerminal,
  toRunRecord,
  type ConductorConfig,
  type ContextInheritance,
  type HookResult,
  type HookSpec,
  type Persona,
  type PersonaOverride,
  type ResolvedHook,
  type ResolvedSendStrategy,
  type Run,
  type RunStatus,
  type SpawnMode,
  type StreamingBehavior,
  type ThinkingLevel,
} from "./types.ts";

// ── Storage paths ─────────────────────────────────────────────────────

export function runsRoot(): string {
  return join(homedir(), ".pi", "agent", "conductor", "runs");
}

export function runDir(id: string): string {
  return join(runsRoot(), id);
}

// ── Inherited skill paths (PRD #15: inherit_skills frontmatter) ─────

export interface CollectInheritedSkillPathsOptions {
  /** Resolved $HOME (defaults to `homedir()`). Injectable for tests. */
  homeDir?: string;
  /** Sub-agent cwd. Used to find `<cwd>/.pi/skills/`. */
  cwd: string;
  /**
   * Pluggable existence check. Defaults to `existsSync` from node:fs.
   * Tests pass a fake to assert which paths get probed without
   * touching the real filesystem.
   */
  existsFn?: (p: string) => boolean;
}

/**
 * Resolve the parent skill directories that should be inherited by a
 * sub-agent whose persona has `inherit_skills: true`.
 *
 * Walks the standard pi skill discovery locations:
 *   - `~/.pi/agent/skills/` (user-level)
 *   - `<cwd>/.pi/skills/`   (project-level)
 *
 * Returns absolute paths in user-then-project order. Skips entries that
 * do not exist; never throws. The returned list is appended to the
 * sub-agent's argv as repeated `--skill <path>` flags by `buildPiArgs`.
 *
 * Pure (assuming `existsFn` is pure): no fs writes, no subprocess.
 */
export function collectInheritedSkillPaths(
  opts: CollectInheritedSkillPathsOptions,
): string[] {
  const home = opts.homeDir ?? homedir();
  const exists = opts.existsFn ?? existsSync;
  const candidates = [
    join(home, ".pi", "agent", "skills"),
    join(opts.cwd, ".pi", "skills"),
  ];
  return candidates.filter((p) => exists(p));
}

// ── Timeout resolution ──────────────────────────────────────────────

/**
 * Resolve the effective timeout (in ms) for a sub-agent. Override wins,
 * then persona, then the global config default. Used by both spawn and
 * send paths so a user-configured `timeout_minutes` on a persona is honored
 * for follow-up sends, not just the initial spawn.
 */
export function resolveTimeoutMs(
  persona: Pick<Persona, "timeoutMinutes"> | undefined,
  ov: Pick<PersonaOverride, "timeoutMinutes"> | undefined,
  cfg: Pick<ConductorConfig, "defaultTimeoutMinutes">,
): number {
  const minutes =
    ov?.timeoutMinutes ?? persona?.timeoutMinutes ?? cfg.defaultTimeoutMinutes;
  return minutes * 60_000;
}

// ── Session file discovery ────────────────────────────────────────────

/**
 * Find the pi session JSONL file inside a `--session-dir`. Pi creates one
 * file per session; if multiple exist (e.g. after multiple `ensemble_send`
 * invocations on different cwds), pick the most recently modified.
 *
 * Returns `undefined` if the dir doesn't exist or contains no .jsonl files.
 */
export function findSessionFile(sessionDir: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return undefined;
  }
  let bestPath: string | undefined;
  let bestMtime = -Infinity;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join(sessionDir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs > bestMtime) {
      bestMtime = st.mtimeMs;
      bestPath = full;
    }
  }
  return bestPath;
}

/**
 * Populate `run.sessionPath` from `sessionDir` if and only if it is
 * not already set. Shared by the close-handler `finalize` closure on
 * both branches — happy path and the post-`forceTerminate` bail path —
 * so a force-killed/timed-out sub-agent stays resumable via
 * `ensemble_send` (otherwise `validateSendable` rejects it with
 * "sessionPath unset"). `forceTerminate` itself does NOT call this
 * because it is synchronous and runs before pi has had a chance to
 * write the .jsonl file; discovery happens once the close handler
 * fires.
 *
 * No-op when `sessionDir` is undefined, when `run.sessionPath` is
 * already set (never overwrite), or when no `.jsonl` is found.
 */
export function discoverSessionPathIfMissing(
  run: Run,
  sessionDir: string | undefined,
): void {
  if (!sessionDir) return;
  if (run.sessionPath) return;
  const found = findSessionFile(sessionDir);
  if (found) run.sessionPath = found;
}

// ── Id allocation ────────────────────────────────────────────────────

const PRONOUNCEABLE_CHARS = "abcdefghijklmnpqrstuvwxyz0123456789"; // no o, easy to read

function shortHash(): string {
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += PRONOUNCEABLE_CHARS[Math.floor(Math.random() * PRONOUNCEABLE_CHARS.length)];
  }
  return s;
}

/** Generate a stable, human-friendly id like `oracle-7f3a`. Collisions are vanishingly rare; we still re-roll. */
export function allocateRunId(persona: string, registry: Map<string, Run>): string {
  for (let i = 0; i < 32; i++) {
    const id = `${persona}-${shortHash()}`;
    if (!registry.has(id) && !existsSync(runDir(id))) {
      // v0.9 Slice 5 / oracle review R10: surface id-reuse-after-GC for
      // tooling that cites run ids by name (vault notes, dashboards).
      noteAllocatedId(id);
      return id;
    }
  }
  // Last resort — append timestamp for uniqueness.
  return `${persona}-${shortHash()}-${Date.now()}`;
}

// ── pi invocation discovery (lifted from pi-essentials) ──────────────

/**
 * v0.10 A1: build the env a sub-agent pi subprocess inherits. Sets
 * `CONDUCTOR_SUBAGENT=1` so the child's conductor extension knows to
 * skip auto-GC (and any other parent-only side effects) on its own
 * `session_start`. Without this, the child would run a full GC pass
 * and leak its `gc auto: …` summary into stderr — which the parent
 * captures (`runs.ts` stdio=["ignore","pipe","pipe"]) and assigns to
 * `run.errorMessage`.
 *
 * Transitive sub-spawns (a sub-agent's own `bash` calls, or a sub-agent
 * legitimately spawning another `pi --session …` process) inherit the
 * marker, which is the desired behavior — conductor-context propagates.
 */
export function buildSubagentEnv(
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return { ...baseEnv, CONDUCTOR_SUBAGENT: "1" };
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  // Test-friendly override: PI_BIN=<path-to-pi-cli.js> forces a specific
  // pi CLI invocation regardless of how the parent was started.
  const piBinEnv = process.env.PI_BIN;
  if (piBinEnv && existsSync(piBinEnv)) {
    return { command: process.execPath, args: [piBinEnv, ...args] };
  }

  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  // Only re-invoke via process.argv[1] when it looks like pi's own CLI.
  // When the parent is something else (tsx, jest, mocha, a normal node
  // script), this would otherwise spawn `node <foreign-script>` and crash
  // before pi ever loads. Detect by basename + ancestor dir containing
  // "pi-coding-agent".
  if (currentScript && !isBunVirtual && existsSync(currentScript)) {
    const looksLikePi =
      /(^|\/)(pi|cli\.js)$/.test(currentScript) &&
      currentScript.includes("pi-coding-agent");
    if (looksLikePi) {
      return { command: process.execPath, args: [currentScript, ...args] };
    }
  }
  const execName = (process.execPath.split("/").pop() || "").toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

// ── Prompt construction ──────────────────────────────────────────────

const SUBAGENT_NESTING_GUARD = [
  "IMPORTANT: You are running as a pi-conductor sub-agent. Do NOT attempt to spawn",
  "further sub-agents (no calls to ensemble_spawn, subagent, agent, delegate, etc).",
  "Complete the entire task yourself and return your findings.",
].join(" ");

/**
 * Item 13 (docs/backlog.md, 2026-05-28): scope-enforcer block prepended
 * to a read-only persona's `--append-system-prompt` content at spawn
 * time. Closes the silent-scope-drift class witnessed when critic-z8v9
 * shipped a review AND THEN bundled, committed, and pushed v0.12 from
 * inside its own turn (per `AGENTS.md` §11 the close commit + push are
 * the parent conductor's responsibility, NOT a critic's).
 *
 * Wording is character-pinned by
 * `tests/read-only-enforcer.test.ts: READ_ONLY_PERSONA_ENFORCER:
 * enforcer text is character-pinned (W3 string witness)`. Mutating one
 * character of this constant reds that test — update the test in
 * lockstep when intentionally rewording.
 */

/**
 * Backlog item 12 candidate #4 — chain-depth cap for `filtered_compact`
 * auto-downgrade to `none`. When the parent conductor has already spawned
 * ≥ this many sibling runs, `filtered_compact` is too likely to leak
 * orchestration identity signal; downgrade to `none` (no inherited context)
 * instead. Value of 6 chosen as a reasonable threshold: a greenfield chain
 * (oracle → designer → planner → builder → critic → finalizer) has 6 sub-agents;
 * chains deeper than that have accumulated enough orchestration to bleed.
 */
export const FILTERED_COMPACT_CHAIN_DEPTH_CAP = 6;

export const READ_ONLY_PERSONA_ENFORCER = [
  "[READ-ONLY PERSONA ENFORCER]",
  "You are a read-only persona. You MAY: read files, run tests",
  "(orientation), git inspection, run mutations IN-PLACE for",
  "verification (followed by IMMEDIATE restoration via git checkout).",
  "You MUST NOT: edit, write, or otherwise mutate any tracked file",
  "beyond mutation-test-and-restore cycles. You MUST NOT: run",
  "git commit, git add, git push, git merge, git rebase, git tag, or",
  "any operation that changes the repository's tracked state. If your",
  "review concludes you have advice for the parent conductor, RETURN",
  "that advice in your output — do not act on it. Acting beyond your",
  "review scope is the failure mode documented in docs/backlog.md",
  "item 13.",
  "[END READ-ONLY PERSONA ENFORCER]",
].join("\n");

/**
 * Item 13: assemble the spawn-time `--append-system-prompt` content.
 *
 * For read-only personas (`persona.readOnly === true`), prepends
 * {@link READ_ONLY_PERSONA_ENFORCER} + a blank line in front of the
 * persona body. For write-capable personas (or any persona whose
 * `readOnly` field is falsy/undefined defensively), returns the body
 * unchanged.
 *
 * Pure: deterministic on `(persona.readOnly, persona.systemPrompt)`.
 * No I/O. Used by `spawnRun` (fresh spawn) when populating the
 * `Run.systemPrompt` capture and the `planSpawnPiArgs` argv. Resume
 * paths re-read `Run.systemPrompt`, which already contains the
 * enforcer if applicable, so the prepend ships exactly once per
 * lifetime even across `ensemble_send` resumes.
 *
 * W1 mutation witness: the killing test imports this helper directly
 * and pins the prepend formula — see
 * `tests/read-only-enforcer.test.ts: assemblePersonaSystemPrompt:
 * read-only persona prompt begins with the enforcer block`.
 */
export function assemblePersonaSystemPrompt(persona: Persona): string {
  if (persona.readOnly === true) {
    return `${READ_ONLY_PERSONA_ENFORCER}\n\n${persona.systemPrompt}`;
  }
  return persona.systemPrompt;
}

/**
 * Build the prompt sent to the sub-agent.
 *
 * The persona's system prompt body is passed via `pi --system-prompt-replace`
 * (see buildPiArgs). The user-facing prompt here is the task plus a
 * nesting-guard preface and any default_reads instructions.
 */
export function buildSubAgentPrompt(persona: Persona, task: string): string {
  const parts: string[] = [SUBAGENT_NESTING_GUARD, ""];
  if (persona.defaultReads.length > 0) {
    parts.push("Read these files first if they exist (they are part of your context):");
    for (const f of persona.defaultReads) parts.push(`  - ${f}`);
    parts.push("");
  }
  parts.push("## Task");
  parts.push("");
  parts.push(task);
  return parts.join("\n");
}

/**
 * Build the argv passed to `pi --mode json -p`.
 *
 * Two modes:
 *   - `kind: "fresh"`  — starts a new session in `sessionDir`. The persona's
 *     system prompt body is appended via `--append-system-prompt`.
 *   - `kind: "resume"` — continues an existing session at `sessionPath`.
 *     System prompt is NOT re-injected (the existing session already has it).
 *
 * In both modes the prompt becomes the trailing positional argument and is
 * delivered to the sub-agent as a user-role message.
 */
export type PiArgsOptions =
  | {
      kind: "fresh";
      sessionDir: string;
      systemPrompt: string;
      prompt: string;
      model?: string;
      thinking?: ThinkingLevel;
      /**
       * Absolute paths passed as repeated `--skill <path>` flags. Set
       * by spawnRun when the persona has `inherit_skills: true`.
       * Empty/undefined → no `--skill` flags emitted.
       */
      skillPaths?: string[];
      /**
       * v0.12 steering: drives `--mode`. `false` (today's path) emits
       * `--mode json -p` plus the trailing positional prompt;
       * `true` emits `--mode rpc` (no `-p`) and OMITS the trailing
       * prompt positional — the prompt is delivered as the first
       * `RpcCommand` line on stdin via `RpcStdinQueue` (slice 3).
       *
       * Slice 2 wires the argv flip only; no production caller passes
       * `true` yet. Slice 4 stamps `Run.steerable` from the per-call
       * `ensemble_spawn` arg + project/user config cascade.
       *
       * Required (not optional): every caller must declare its mode
       * explicitly so the argv shape is never ambiguous. See
       * `docs/v0.12-steering-design.md` §4.2.
       */
      steerable: boolean;
    }
  | {
      kind: "resume";
      sessionPath: string;
      prompt: string;
      model?: string;
      thinking?: ThinkingLevel;
      /**
       * Optional persona system prompt to re-apply on resume. Pi sessions
       * do NOT persist the system prompt to disk — it must be re-supplied
       * via `--append-system-prompt` on every invocation, otherwise pi
       * boots the sub-agent with its default coding-agent prompt and the
       * persona body is lost. Used by v0.6's seeded-resume path.
       *
       * v0.5's `sendToRun` does NOT pass this (preserves prior behavior).
       */
      systemPrompt?: string;
      /** See fresh-mode `skillPaths` above. Same semantics on resume. */
      skillPaths?: string[];
      /**
       * v0.12 steering: see fresh-mode `steerable` above. Resume-mode
       * RPC spawns are produced by slice 4's `sendToRun` rewrite when
       * the run is RPC-shaped; today's print-mode resume callers pass
       * `false`.
       */
      steerable: boolean;
    };

export function buildPiArgs(opts: PiArgsOptions): string[] {
  // v0.12 steering: argv shape is mode-bifurcated. Print mode
  // (`steerable: false`, today's only path) emits `--mode json -p`
  // and the trailing prompt positional. RPC mode (`steerable: true`)
  // emits `--mode rpc`, omits `-p`, AND omits the prompt positional
  // — the prompt is delivered as the first `RpcCommand` line on
  // stdin (slice 3 wires this; slice 2 only emits the argv).
  // See `docs/v0.12-steering-design.md` §4.2.
  const args: string[] = opts.steerable
    ? ["--mode", "rpc"]
    : ["--mode", "json", "-p"];
  if (opts.kind === "fresh") {
    args.push("--session-dir", opts.sessionDir);
  } else {
    args.push("--session", opts.sessionPath);
  }
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  if (opts.kind === "fresh") {
    // Pi exposes --append-system-prompt for system prompt addenda; we use that
    // for the persona body so pi's own system prompt logic still runs.
    args.push("--append-system-prompt", opts.systemPrompt);
  } else if (opts.systemPrompt) {
    // Resume mode: re-inject the persona body when caller supplies it. Pi
    // doesn't persist system prompts to the session file, so without this
    // a resumed sub-agent boots with pi's default prompt and loses its
    // persona identity.
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  // Inherit_skills (PRD #15): repeated --skill flags after the system
  // prompt and before the trailing positional. Order matches
  // `collectInheritedSkillPaths` (user-then-project) so pi's own
  // collision-handling sees user dir first.
  if (opts.skillPaths && opts.skillPaths.length > 0) {
    for (const p of opts.skillPaths) args.push("--skill", p);
  }
  // Trailing prompt positional. RPC mode injects the prompt over
  // stdin (slice 3); print mode passes it as the final argv slot.
  if (!opts.steerable) {
    args.push(opts.prompt);
  }
  return args;
}

// ── Resume invocation builder (used by ensemble_send) ──────────────────────────────

/**
 * Build the argv passed to `pi` when resuming an existing sub-agent's
 * session via `ensemble_send`. Pure: no I/O, no subprocess.
 *
 * Re-injects `run.systemPrompt` via `--append-system-prompt` so the
 * sub-agent keeps its persona on resume — pi sessions don't persist
 * system prompts to disk. When `run.systemPrompt` is unset (legacy
 * Runs from before this field existed), no system prompt is passed and
 * the sub-agent inherits pi's default coding-agent prompt; the run
 * still resumes correctly, just without persona identity. New runs
 * always populate the field at spawn time.
 */
export function buildResumePiArgs(run: Run, message: string): string[] {
  if (!run.sessionPath) {
    throw new Error(
      `buildResumePiArgs called on run ${run.id} without sessionPath; ` +
        `validateSendable should have rejected this earlier`,
    );
  }
  return buildPiArgs({
    kind: "resume",
    sessionPath: run.sessionPath,
    prompt: message,
    model: run.model,
    thinking: run.thinking,
    systemPrompt: run.systemPrompt,
    // v0.12 steering: spawn-resume on a terminal run is always
    // print-mode by design (§4.4 archived-run compat / Q10 lock).
    // RPC mode is NOT sticky across the original-subprocess boundary
    // — the previous RPC subprocess is gone, so the fresh `pi
    // --session` resume picks the safer print-mode default. A per-call
    // "resume into RPC" is deliberately not exposed in v0.12.
    steerable: false,
  });
}

// ── Spawn invocation planner (inherit_context) ──────────────────────

export interface PlanSpawnOptions {
  /** Persona being spawned. Drives inheritContext mode. */
  persona: Persona;
  /**
   * Snapshot of the parent conductor's conversation at spawn time.
   * Required for inherit_context: filtered / full to take effect.
   * Empty array (or omitted) → behave as inherit_context: none.
   */
  parentMessages?: AgentMessage[];
  /** Where pi should write/read the sub-agent's session file. */
  sessionDir: string;
  /** Persona system-prompt body (used in fresh mode only). */
  systemPrompt: string;
  /** Task prompt — becomes the trailing positional argv. */
  prompt: string;
  /** Sub-agent cwd (used as the seeded session header's cwd). */
  cwd: string;
  model?: string;
  thinking?: ThinkingLevel;
  /**
   * Absolute skill directory paths to be inherited by the sub-agent
   * (one `--skill <path>` flag per entry). Computed by `spawnRun` from
   * `collectInheritedSkillPaths` when the persona has
   * `inherit_skills: true`. Empty/undefined → sub-agent loads no
   * inherited skills (default behavior pre-PRD #15).
   */
  skillPaths?: string[];
  /**
   * v0.12 slice 4 — collapsed cascade-derived steerable value
   * (per-call > project > user > built-in default). Threaded into
   * `buildPiArgs` so the argv shape (`--mode rpc` vs `--mode json -p`)
   * matches the `Run.streamingMode` stamped by the spawn pipeline.
   * Optional for backward-compat with pre-slice-4 callers in tests;
   * defaults to `false` (print mode).
   */
  steerable?: boolean;
  /**
   * Item 12 candidate #3 — per-call `inherit_context` override from
   * `ensemble_spawn`. When set, wins above `persona.inheritContext`
   * (which is already merged with project / user `personaOverrides`
   * upstream). When `undefined`, falls back to `persona.inheritContext`.
   * Resolved via `resolveInheritContext` in `src/inherit-context.ts`.
   * See `docs/backlog.md` item 12 for the witness.
   */
  inheritContextOverride?: ContextInheritance;
  /**
   * Backlog item 12 candidate #4 — number of sibling runs the parent
   * conductor has already spawned this session (terminal + active,
   * excluding this spawn). When ≥ {@link FILTERED_COMPACT_CHAIN_DEPTH_CAP},
   * `filtered_compact` is auto-downgraded to `none` on the theory that
   * a long chain has accumulated too much orchestration signal for
   * compact filtering to reliably strip. `undefined` disables the cap.
   */
  siblingRunCount?: number;
}

export interface PlanSpawnResult {
  mode: "fresh" | "resume";
  piArgs: string[];
  /** Set when we seeded a session file; equals the path passed via --session. */
  seededSessionPath?: string;
}

/**
 * Drop leading entries that aren't a `user` message. Most LLM providers
 * (Anthropic especially) reject a request whose first message is a
 * `toolResult` with no preceding `tool_use`, or an assistant message
 * without a prior user turn. Filtering can leave such a prefix when
 * earlier orchestration turns get pruned, so we trim defensively before
 * seeding.
 */
function trimLeadingNonUser(messages: AgentMessage[]): AgentMessage[] {
  let i = 0;
  while (i < messages.length && (messages[i] as any)?.role !== "user") i++;
  return messages.slice(i);
}

/**
 * Synthetic <filtered-history> sentinel prepended to seeded sessions when
 * `filterParentContext` actually removed parent content.
 *
 * v0.8.1 (b)-strengthen: the body names the role-identity failure mode
 * (third-person prose about the persona) and gives the persona a
 * deterministic anchor (the LAST user message). See
 * docs/v0.8.1-item1-design.md §4.
 *
 * 2026-05-28 strengthen (item 12 candidate #2): the body now opens with
 * an explicit "YOU ARE A FRESH SUB-AGENT" identity declaration and cites
 * the witnessed builder-4gsl failure mode (refused its task entirely
 * after inhaling parent identity from filtered context). See
 * `docs/items-11-12-inspector-map.md` §5.2 + §6 rec 1.
 */
function filteredHistorySentinel(): AgentMessage {
  return {
    role: "user",
    content:
      "<filtered-history>\n" +
      "[YOU ARE A FRESH SUB-AGENT.]\n\n" +
      "The transcript above is your PARENT conductor's history, filtered for " +
      "context. You did not perform any of those file reads, tool calls, or " +
      "commits — they happened before you existed. Your task is the LAST " +
      "user-role message in this transcript; everything before it is background.\n\n" +
      "Sub-agents have inhaled parent identity in the past (witness: " +
      "docs/backlog.md item 12, builder-4gsl 2026-05-27, refused its task " +
      "entirely). If you find yourself thinking \"I already shipped this\" or " +
      "\"I shouldn't be a sub-agent\", STOP. The brief at the bottom IS your " +
      "task. Execute it.\n\n" +
      "Two further notes on the filtered transcript above:\n\n" +
      "1. **Your brief is the LAST user-role message in this transcript.** Earlier " +
      "user-role messages were the parent conductor talking to itself or to its " +
      "user; they are framing, not your task. Treat them as background context.\n\n" +
      "2. **Some assistant prose may discuss YOU in the third person** — sentences " +
      "like \"spawning critic-X to gate Y\" or \"holding the turn while inspector " +
      "runs\". That prose is leftover orchestration narration from the parent. It " +
      "is NOT a quote of your brief, NOT instructions to you, and NOT a " +
      "conversation you are part of. Ignore it; do not meta-comment on it.\n\n" +
      "The following entry types were dropped before you saw this transcript:\n" +
      "  - Orchestration tool calls (ensemble_*, subagent) and their results\n" +
      "  - Sub-agent completion notifications (`<sub-agent-completed>` cards)\n" +
      "  - The conductor's internal reasoning (`thinking` blocks)\n" +
      "  - Bash commands marked with the `!!` excludeFromContext flag\n\n" +
      "If you see a dangling reference to prior orchestration (\"the inspector said " +
      "X\", \"as oracle noted\") and you do not see a matching tool result above, that " +
      "reference is from a dropped turn — treat the claim with skepticism.\n\n" +
      "Now: read your brief (the last user message), do the work, return your result.\n" +
      "</filtered-history>",
    timestamp: 0,
  } as AgentMessage;
}

/**
 * Decide how to invoke pi for a sub-agent spawn based on the persona's
 * `inherit_context` setting and the snapshot of parent messages provided.
 *
 *   inherit_context: "none"     → fresh session (no parent context).
 *   inherit_context: "filtered" → seed a session file with parent prose +
 *                                 file ops (filterParentContext). Falls back
 *                                 to fresh if the filter result is empty.
 *   inherit_context: "filtered_compact" → like filtered, but assistant TEXT
 *                                 blocks are stripped (tool calls/results +
 *                                 user msgs preserved). Use for builder-shaped
 *                                 personas vulnerable to the conductor-prose
 *                                 cascade. See src/context-filter.ts.
 *   inherit_context: "full"     → seed a session file with every parent
 *                                 message verbatim. Falls back to fresh
 *                                 when there are no parent messages.
 *
 * Side effect: writes the seeded JSONL to disk when seeding. Pure with
 * respect to the rest of the spawn pipeline (no subprocess, no registry).
 */
export function planSpawnPiArgs(opts: PlanSpawnOptions): PlanSpawnResult {
  const { persona, parentMessages = [], sessionDir, systemPrompt, prompt, cwd, model, thinking, skillPaths } = opts;
  const steerable = opts.steerable === true;

  // Item 12 candidate #3: per-call inherit_context wins above
  // persona.inheritContext (which already merges project/user
  // personaOverrides upstream via resolvePersonas). resolveInheritContext
  // is a one-liner mirroring resolveKillOnStall / resolveSteerable shape;
  // see src/inherit-context.ts.
  const resolvedInheritContext = resolveInheritContext(
    opts.inheritContextOverride,
    persona,
  );
  // Item 12 candidate #4: auto-downgrade filtered_compact → none when
  // the parent chain is deep. A long chain has accumulated too much
  // orchestration signal for compact filtering to reliably strip identity
  // bleed; falling back to none (no inherited context) is safer.
  const effectiveInheritContext: ContextInheritance =
    resolvedInheritContext === "filtered_compact" &&
    opts.siblingRunCount !== undefined &&
    opts.siblingRunCount >= FILTERED_COMPACT_CHAIN_DEPTH_CAP
      ? "none"
      : resolvedInheritContext;

  let seedMessages: AgentMessage[] | null = null;
  // Did filtering actually remove anything? If yes, prepend a sentinel
  // so the sub-agent knows its transcript is filtered and doesn't trust
  // dangling assistant references to dropped orchestration.
  let dropped = false;
  if (
    (effectiveInheritContext === "filtered" || effectiveInheritContext === "filtered_compact") &&
    parentMessages.length > 0
  ) {
    const filterFn =
      effectiveInheritContext === "filtered_compact"
        ? filterParentContextCompact
        : filterParentContext;
    const filtered = filterFn(parentMessages);
    dropped = filtered.length !== parentMessages.length;
    // Also detect block-level filtering on assistant messages even when
    // the message count matches (e.g. a thinking block was dropped but
    // the assistant prose survived).
    if (!dropped) {
      for (let i = 0; i < parentMessages.length; i++) {
        if ((filtered[i] as any) !== (parentMessages[i] as any)) {
          dropped = true;
          break;
        }
      }
    }
    const trimmed = trimLeadingNonUser(filtered);
    if (trimmed.length > 0) seedMessages = trimmed;
  } else if (effectiveInheritContext === "full" && parentMessages.length > 0) {
    const trimmed = trimLeadingNonUser(parentMessages);
    if (trimmed.length > 0) seedMessages = trimmed;
  }

  if (seedMessages && dropped) {
    seedMessages = [filteredHistorySentinel(), ...seedMessages];
  }

  if (seedMessages) {
    const seededSessionPath = join(sessionDir, "seeded.jsonl");
    seedSessionFile(seededSessionPath, seedMessages, cwd);
    return {
      mode: "resume",
      seededSessionPath,
      piArgs: buildPiArgs({
        kind: "resume",
        sessionPath: seededSessionPath,
        prompt,
        model,
        thinking,
        // Re-inject the persona body — the seeded JSONL has no system
        // prompt entry. Without this the sub-agent boots with pi's
        // default coding-agent prompt and loses its persona identity.
        systemPrompt,
        skillPaths,
        // v0.12 slice 4 — thread the cascade-collapsed steerable
        // through to the argv builder so resume-shaped RPC spawns
        // (seeded session + steerable=true) emit `--mode rpc` and
        // skip the trailing positional prompt.
        steerable,
      }),
    };
  }

  return {
    mode: "fresh",
    piArgs: buildPiArgs({
      kind: "fresh",
      sessionDir,
      systemPrompt,
      prompt,
      model,
      thinking,
      skillPaths,
      // v0.12 slice 4 — cascade-collapsed steerable threaded into the
      // fresh-mode argv builder. `false` (default) preserves today's
      // print-mode behaviour.
      steerable,
    }),
  };
}

// ── Run registry ─────────────────────────────────────────────────────

export type RunListener = (run: Run) => void;

/** Reasons we report when forcing a terminal state externally. */
export type TerminationReason = "killed" | "timeout" | "stalled";

export class RunRegistry {
  private runs = new Map<string, Run>();
  private listeners = new Set<RunListener>();

  list(): Run[] {
    return [...this.runs.values()];
  }

  get(id: string): Run | undefined {
    return this.runs.get(id);
  }

  has(id: string): boolean {
    return this.runs.has(id);
  }

  register(run: Run): void {
    this.runs.set(run.id, run);
    this.notify(run);
  }

  countActive(): number {
    let n = 0;
    for (const r of this.runs.values()) {
      if (!isTerminal(r.status) && r.status !== "queued") n++;
    }
    return n;
  }

  /**
   * v0.9 Item 2(c): count active runs whose persona name is in the given set.
   * Used by SpawnQueue to enforce maxConcurrentWriteCapable.
   */
  countActiveBy(personaNames: ReadonlySet<string>): number {
    let n = 0;
    for (const r of this.runs.values()) {
      if (!isTerminal(r.status) && r.status !== "queued" && personaNames.has(r.persona)) {
        n++;
      }
    }
    return n;
  }

  countQueued(): number {
    let n = 0;
    for (const r of this.runs.values()) {
      if (r.status === "queued") n++;
    }
    return n;
  }

  /** Subscribe to any run state change. Returns an unsubscribe fn. */
  onChange(fn: RunListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(run: Run): void {
    for (const fn of this.listeners) {
      try {
        fn(run);
      } catch {
        // listener errors must never crash the spawner
      }
    }
  }
}

// ── Spawn ────────────────────────────────────────────────────────────

export interface SpawnOptions {
  registry: RunRegistry;
  persona: Persona;
  task: string;
  mode: SpawnMode;
  cwd: string;
  /** Resolved model. Falls back to undefined (inherit). */
  model?: string;
  /** Resolved thinking. Falls back to undefined (inherit). */
  thinking?: ThinkingLevel;
  /** Hard timeout. */
  timeoutMs: number;
  /** Optional pre-allocated id (for queue draining). */
  preAllocatedId?: string;
  /**
   * Snapshot of the parent conductor's conversation at spawn time.
   * When the persona has `inherit_context: filtered` or `full` and this
   * is non-empty, planSpawnPiArgs() seeds a JSONL session file from the
   * (filtered) parent messages and the sub-agent boots resuming that file
   * via `pi --session`. Empty/omitted → fresh session, no parent context.
   */
  parentMessages?: AgentMessage[];
  /** Streamed tool-call hint callback for foreground rendering. */
  onUpdate?: (run: Run) => void;
  /** Fired when the run reaches a terminal status (completed/failed/killed/timeout). */
  onComplete?: (run: Run) => void;
  /**
   * v0.10 watchdog (Slice 3) per-spawn `kill_on_stall` override.
   * Propagated to `Run.killOnStall`. Undefined → conductor default.
   */
  killOnStall?: boolean;
  /**
   * v0.10 watchdog (Slice 3) per-spawn soft-threshold override
   * (seconds). Propagated to `Run.softStallSeconds`. Undefined →
   * conductor default. Must be ≥ 30 if set; tools.ts validates before
   * reaching here.
   */
  softStallSeconds?: number;
  /**
   * v0.12 slice 4 — cascade-collapsed steerable boolean. Stamped
   * onto `Run.steerable` / `Run.streamingMode` at spawn time and
   * threaded into both the argv builder (`--mode rpc` vs
   * `--mode json -p`) and the subprocess `stdio[0]` branch (`pipe`
   * vs `ignore`). Optional for backward-compat with tests; defaults
   * to `false` (print mode).
   *
   * The 4-layer cascade (per-call > project > user > built-in)
   * collapses upstream in `tools.ts: ensemble_spawn` via
   * `collapseSteerableCascade`; this field is the post-collapse
   * boolean.
   */
  steerable?: boolean;
  /**
   * Item 12 candidate #3 — per-call `inherit_context` override from
   * the `ensemble_spawn` LLM tool arg. Wins above the persona's
   * already-merged frontmatter (project / user `personaOverrides`
   * are folded into `persona.inheritContext` upstream by
   * `resolvePersonas`). `undefined` (the default) falls back to
   * `persona.inheritContext`. See `src/inherit-context.ts` for the
   * resolver and `docs/backlog.md` item 12 for the witness.
   */
  inheritContextOverride?: ContextInheritance;
  /**
   * v0.11 on_complete_hook (slice 3) — per-call hook command from the
   * `ensemble_spawn` LLM tool arg. Stamped onto `Run.onCompleteHook` and
   * fed as the per-call layer of {@link resolveCloseHook} at spawn time.
   * Empty string is the explicit-disable sentinel (slice 1b cascade).
   * Undefined falls through to project / user / persona-frontmatter
   * layers.
   */
  onCompleteHook?: string;
  /**
   * v0.11 on_complete_hook (slice 3) — per-call timeout in seconds.
   * Stamped onto `Run.onCompleteHookTimeoutSeconds`. Read paired with
   * `onCompleteHook`; only meaningful when the per-call layer wins.
   */
  onCompleteHookTimeoutSeconds?: number;
}

/**
 * Capture a freshly-spawned ChildProcess on the Run, copying both the
 * proc handle and its pid. The pid is persisted by `toRunRecord` so
 * post-startup reconcile (v0.9.x) can liveness-probe orphaned `running`
 * records via `kill(pid, 0)`.
 *
 * Pure assignment helper — no I/O. Extracted from `spawnRun` so the
 * "capture pid" invariant has a unit-test seam without forking a real
 * pi subprocess. Tolerates `proc.pid === undefined` (rare
 * sync-spawn-failure path); the caller has already validated the spawn
 * succeeded by the time it gets here.
 */
export function recordSpawnedProc(run: Run, proc: ChildProcess): void {
  run.proc = proc;
  run.pid = proc.pid;
}

/**
 * Item 15: re-stamp the per-invocation markers used by the completion
 * envelope to compute per-most-recent-send `<duration>` / `<usage>` /
 * `<cost>`. Called by `sendToRun` BEFORE the new turn fires (RPC steer,
 * RPC follow_up, or spawn-resume) so the next terminal close has a
 * fresh anchor to delta against.
 *
 * Contract:
 *   - `thisInvocationStartedAt` ← `Date.now()` (wall-clock at re-fire)
 *   - `thisInvocationUsageBaseline` ← deep-copy snapshot of the
 *     four delta-relevant fields of `run.usage` AS-OF call time
 *   - `resumeCount` ← `(prev ?? 0) + 1`
 *
 * Cumulative `run.usage` is NOT mutated; the run's lifetime totals
 * stay live and the optional `<lifetime>` block in the envelope reads
 * them directly.
 */
export function snapshotInvocationMarkers(run: Run): void {
  run.thisInvocationStartedAt = Date.now();
  run.thisInvocationUsageBaseline = {
    turns: run.usage.turns,
    input: run.usage.input,
    output: run.usage.output,
    cost: run.usage.cost,
  };
  run.resumeCount = (run.resumeCount ?? 0) + 1;
}

/**
 * v0.12 slice 3 — stamp `Run.steerable` and `Run.streamingMode`
 * immediately after the subprocess spawn returns. Pure helper extracted
 * from `runPiSubprocess` so the smoke pin in
 * `tests/runs-streaming-strategy.test.ts` can verify the post-spawn
 * shape without forking a real `pi --mode rpc` subprocess (slice 6 owns
 * the live integration).
 *
 * Contract:
 *   - `steerable === true`  → `run.steerable = true; run.streamingMode = "rpc"`.
 *   - `steerable === false` → `run.steerable = false; run.streamingMode = "print"`.
 *
 * `Run.streamingMode` is captured here (not derived from `Run.steerable`
 * at read time) because slice 5's reconcile-orphan branch + slice 4's
 * `resolveSendStrategy` both need a frozen post-spawn snapshot
 * unaffected by any later mutation of `Run.steerable`.
 */
export function stampSpawnStreamingMode(run: Run, steerable: boolean): void {
  run.steerable = steerable;
  run.streamingMode = steerable ? "rpc" : "print";
}

/**
 * Capture a freshly-spawned ChildProcess on the Run AND flush the
 * updated record to disk so the pid is visible to any concurrent pi
 * runtime starting up at the same moment.
 *
 * The initial `writeRecord` in `spawnRun` runs before `child_process.spawn()`
 * returns, so without this second flush the on-disk record is briefly
 * `running` with no `pid`. A concurrent pi runtime running
 * `reconcileOrphansAtStartup` during that window would classify the
 * record as `reclassify-pre-schema` (no pid → can't liveness-probe →
 * conservative `killed`) and reclassify a still-live sub-agent. See
 * `src/reconcile-startup.ts` `classifyRecord` and the `"orphaned:
 * pre-pid-schema…"` errorMessage path.
 *
 * Thin helper so the spawn path has one named call site instead of two
 * coupled lines, and so the regression test can pin disk state without
 * forking a real pi subprocess.
 */
export async function attachSpawnedProc(
  run: Run,
  proc: ChildProcess,
): Promise<void> {
  recordSpawnedProc(run, proc);
  await writeRecord(run);
}

/**
 * Spawn a sub-agent. Returns the Run immediately (status="running").
 * Resolves the returned promise when the run reaches a terminal status.
 *
 * Foreground/background semantics are the caller's choice — both run the
 * same subprocess; the difference is only how the caller awaits.
 */
export function spawnRun(opts: SpawnOptions): { run: Run; done: Promise<Run> } {
  const id = opts.preAllocatedId ?? allocateRunId(opts.persona.name, mapFromRegistry(opts.registry));
  const dir = runDir(id);
  mkdirSync(dir, { recursive: true });

  const run: Run = {
    id,
    persona: opts.persona.name,
    task: opts.task,
    model: opts.model,
    thinking: opts.thinking,
    mode: opts.mode,
    status: "running",
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: opts.cwd,
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    sessionPath: undefined,
    // Capture the persona body now so future ensemble_send calls can
    // re-pass it on resume. Pi doesn't persist system prompts to disk.
    // Item 13: assemblePersonaSystemPrompt prepends the read-only
    // enforcer when persona.readOnly is true. Captured ONCE here so
    // resumes re-pass the already-prepended body without doubling it.
    systemPrompt: assemblePersonaSystemPrompt(opts.persona),
    // Item 15: per-invocation markers. Initial spawn IS the start of
    // the (sole, so far) invocation, so:
    //   - thisInvocationStartedAt mirrors startTime
    //   - thisInvocationUsageBaseline is zeros (delta from spawn-time = lifetime)
    //   - resumeCount = 0 (no resumes yet)
    // sendToRun re-stamps these on every resume BEFORE the subprocess fires.
    thisInvocationStartedAt: Date.now(),
    thisInvocationUsageBaseline: { turns: 0, input: 0, output: 0, cost: 0 },
    resumeCount: 0,
    // v0.10 watchdog (Slice 3) per-spawn overrides; undefined falls
    // back to conductor-wide defaults at watchdog dispatch time.
    killOnStall: opts.killOnStall,
    softStallSeconds: opts.softStallSeconds,
    // v0.11 on_complete_hook (slice 3) per-call layer. Stamp onto Run
    // so the spawn-resume path of `ensemble_send` can re-resolve the
    // hook with the same per-call winner unless explicitly replaced.
    onCompleteHook: opts.onCompleteHook,
    onCompleteHookTimeoutSeconds: opts.onCompleteHookTimeoutSeconds,
    // Ownership scoping: persist the conductor host pid (and Linux
    // start-time fingerprint) so sibling pi sessions reading the
    // global runs/ root can skip-foreign records they don't own.
    // Survives /reload (in-process re-import). See
    // `classifyRecord` `skip-foreign` branch.
    parentPid: process.pid,
    parentStartTime: readProcessStartTime(process.pid),
    // v0.12 slice 4 — stamp the cascade-collapsed steerable on the Run
    // BEFORE the spawn pipeline runs. `runPiSubprocess` re-stamps via
    // `stampSpawnStreamingMode` (idempotent) once the subprocess is
    // up; setting it here means resolveSendStrategy and the watchdog
    // see a consistent shape during the brief pre-spawn window.
    steerable: opts.steerable === true,
  };
  opts.registry.register(run);
  void writeRecord(run);

  // Construct prompt + args. When the persona has inherit_context=filtered
  // (or full) and we have a parent-message snapshot, planSpawnPiArgs seeds a
  // session file with the filtered transcript and we boot resuming it.
  const prompt = buildSubAgentPrompt(opts.persona, opts.task);
  const sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  const plan = planSpawnPiArgs({
    persona: opts.persona,
    parentMessages: opts.parentMessages,
    sessionDir,
    // Item 13: prepend read-only enforcer when applicable. Same
    // assembly used at the Run.systemPrompt capture above so the
    // initial spawn argv and resume argv stay byte-identical for
    // a given persona.
    systemPrompt: assemblePersonaSystemPrompt(opts.persona),
    prompt,
    cwd: opts.cwd,
    model: opts.model,
    thinking: opts.thinking,
    // PRD #15: when `inherit_skills: true`, pass the parent's user +
    // project skill dirs to the sub-agent via `--skill <path>`. The
    // flag is consumed at spawn time and not propagated into the
    // sub-agent's env, so a sub-agent spawning a further sub-agent
    // does NOT re-inherit (we discourage that pattern anyway).
    skillPaths: opts.persona.inheritSkills
      ? collectInheritedSkillPaths({ cwd: opts.cwd })
      : undefined,
    // v0.12 slice 4 — thread the cascade-collapsed steerable so the
    // argv shape matches the runPiSubprocess `steerable` we pass
    // below. Both must agree or pi will boot with the wrong stdio.
    steerable: opts.steerable === true,
    // Item 12 candidate #3 — thread the per-call inherit_context
    // override into planSpawnPiArgs so the filter selection (filtered
    // / filtered_compact / full / none) honors the LLM tool's per-call
    // arg above the persona's frontmatter. See src/inherit-context.ts.
    inheritContextOverride: opts.inheritContextOverride,
    // Item 12 candidate #4 — pass the current registry size so
    // planSpawnPiArgs can auto-downgrade filtered_compact → none when
    // the chain is deep. Excludes the run we just registered (it is
    // already in the registry at this point) to count only siblings.
    siblingRunCount: opts.registry.list().length - 1,
  });
  // When we seeded a session, populate run.sessionPath up-front so callers
  // (e.g. ensemble_send mid-run) can find it without waiting for finalize().
  if (plan.seededSessionPath) run.sessionPath = plan.seededSessionPath;

  const done = runPiSubprocess(run, plan.piArgs, {
    registry: opts.registry,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    onUpdate: opts.onUpdate,
    onComplete: opts.onComplete,
    // Only let the subprocess discover a session file when we didn't pre-seed
    // one — in resume mode the path is fixed.
    sessionDir: plan.seededSessionPath ? undefined : sessionDir,
    // v0.12 slice 4 — thread the cascade-collapsed steerable into
    // runPiSubprocess so the subprocess `stdio[0]` branch (`pipe` vs
    // `ignore`) and the post-spawn `Run.streamingMode` stamp match
    // the argv shape produced above. Slice 3 hard-coded `false`; the
    // dead value was a known TODO.
    steerable: opts.steerable === true,
    // v0.12 slice 4 — when steerable, the prompt is delivered as the
    // first `prompt` RPC command on stdin (not as the trailing argv
    // positional, which RPC mode ignores). `runPiSubprocess` enqueues
    // it via `RpcStdinQueue` once the subprocess is up.
    initialPrompt: opts.steerable === true ? prompt : undefined,
    // v0.11 on_complete_hook (slice 2): resolve at spawn time from the
    // current config layers + persona frontmatter. Per-call args land
    // in slice 3; for slice 2 the per-call layer is always undefined.
    // Tests inject `resolvedHook` directly via the spawn-options surface.
    resolvedHook: resolveCloseHook(
      opts.cwd,
      opts.persona.name,
      hookSpecFromOpts(opts.onCompleteHook, opts.onCompleteHookTimeoutSeconds), // per-call (slice 3)
      hookSpecFromPersona(opts.persona),
    ),
  });
  return { run, done };
}

// ── Shared subprocess plumbing ─────────────────────────────────────────

interface RunPiSubprocessOpts {
  registry: RunRegistry;
  cwd: string;
  timeoutMs: number;
  onUpdate?: (run: Run) => void;
  onComplete?: (run: Run) => void;
  /** When provided, finalize() will populate run.sessionPath from this dir. */
  sessionDir?: string;
  /**
   * v0.12 slice 3 — declare the spawn's mode explicitly. Required
   * (not optional) so the argv shape and stdio shape can never
   * diverge: every caller declares its mode and `runPiSubprocess`
   * threads it into both the subprocess `stdio[0]` branch and the
   * post-spawn `Run.streamingMode` stamp.
   *
   * `steerable: false` is today's print-mode default (`--mode json -p`,
   * stdin = "ignore", trailing positional prompt). `steerable: true`
   * is the new RPC path (`--mode rpc`, stdin = "pipe", queue attached,
   * initial prompt injected over stdin).
   *
   * No production caller passes `true` until slice 4's per-call
   * cascade lands on `ensemble_spawn`; slice 3 wires the plumbing.
   */
  steerable: boolean;
  /**
   * v0.12 slice 3 — prompt body to inject as the first RPC `prompt`
   * command on stdin. Required when `steerable: true`; ignored when
   * `steerable: false` (print mode passes the prompt as the trailing
   * argv positional inside `piArgs`).
   */
  initialPrompt?: string;
  /**
   * v0.11 on_complete_hook (slice 2): pre-resolved hook to invoke after
   * a clean (exit-0) natural close. Undefined skips hook execution. The
   * caller resolves via {@link resolveCloseHook} (or directly through
   * {@link resolveOnCompleteHook} for tests). The close handler:
   *   - skips when undefined OR exit !== 0 OR run already terminal,
   *   - sets `run.hookExecuting = true` + `run.hookProc` for the
   *     duration so the watchdog suppresses stall classification and
   *     `forceTerminate` can SIGTERM the hook's process group,
   *   - branches the close terminal to `hook_failed` on non-zero exit,
   *   - uses an idempotency guard so a `forceTerminate`-driven hook
   *     death does not double-flip `run.status`.
   */
  resolvedHook?: ResolvedHook;
}

/**
 * Resolve the {@link ResolvedHook} for a sub-agent at terminal-close time
 * from the four cascade layers documented in `src/hook-cascade.ts`. Slice
 * 2 supplies project + user from the layered config and persona from the
 * resolved persona record; slices 3 and 4 add the per-call and frontmatter
 * layers respectively.
 *
 * Pure (depends only on `loadConfigWithErrors` for the disk read); exposed
 * for tests so they can pin the wiring at the call site without forking
 * subprocesses. Slice 2's wiring path uses it from {@link spawnRun} and
 * {@link sendToRun} alike.
 */
export function resolveCloseHook(
  cwd: string,
  personaName: string,
  perCall?: HookSpec,
  personaFrontmatter?: HookSpec,
): ResolvedHook | undefined {
  const layered = loadConfigWithErrors(cwd);
  const project = hookSpecFromOverride(
    layered.project.personaOverrides[personaName],
  );
  const user = hookSpecFromOverride(
    layered.user.personaOverrides[personaName],
  );
  const input: HookCascadeInput = {
    perCall,
    project,
    user,
    persona: personaFrontmatter,
  };
  return resolveOnCompleteHook(input);
}

function hookSpecFromOverride(
  override: PersonaOverride | undefined,
): HookSpec | undefined {
  if (!override) return undefined;
  if (override.onCompleteHook === undefined) return undefined;
  return {
    command: override.onCompleteHook,
    timeoutSeconds: override.onCompleteHookTimeoutSeconds,
  };
}

function hookSpecFromPersona(persona: Persona): HookSpec | undefined {
  if (persona.onCompleteHook === undefined) return undefined;
  return {
    command: persona.onCompleteHook,
    timeoutSeconds: persona.onCompleteHookTimeoutSeconds,
  };
}

/**
 * v0.11 on_complete_hook (slice 3) helper — build a {@link HookSpec}
 * from the per-call SpawnOptions / SendToRunOptions fields. Returns
 * `undefined` when no per-call command was supplied (so the cascade
 * falls through to project / user / persona). Empty string is a valid
 * command value (the explicit-disable sentinel) and IS forwarded to
 * the resolver, which short-circuits.
 */
function hookSpecFromOpts(
  command: string | undefined,
  timeoutSeconds: number | undefined,
): HookSpec | undefined {
  if (command === undefined) return undefined;
  return { command, timeoutSeconds };
}

/**
 * Spawn `pi` with the supplied argv, attach event handlers that mutate the
 * supplied Run, and return a promise that resolves when the run reaches a
 * terminal status.
 *
 * Used by both `spawnRun` (fresh spawn, with --session-dir) and `sendToRun`
 * (resume, with --session <path>) so both paths share identical event
 * handling, transcript appending, finalize semantics, and timeout logic.
 */
function runPiSubprocess(
  run: Run,
  piArgs: string[],
  opts: RunPiSubprocessOpts,
): Promise<Run> {
  const invocation = getPiInvocation(piArgs);

  // v0.12 slice 3 — stdio[0] branches on steerable. Print mode keeps
  // the pre-v0.12 "ignore" shape; RPC mode opens a writable pipe so
  // the conductor can send commands (initial prompt, steers,
  // follow-ups, ext-ui-cancel envelopes) over stdin via the
  // `RpcStdinQueue`. See `docs/v0.12-steering-design.md` §4.2.
  const stdinKind: "ignore" | "pipe" = opts.steerable ? "pipe" : "ignore";

  let proc: ChildProcess;
  try {
    proc = spawn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      shell: false,
      stdio: [stdinKind, "pipe", "pipe"],
      env: buildSubagentEnv(),
    });
  } catch (e) {
    run.status = "failed";
    run.errorMessage = `spawn failed: ${(e as Error).message}`;
    run.finishedAt = Date.now();
    opts.registry.notify(run);
    void writeRecord(run);
    void writeFinal(run);
    if (opts.onComplete) opts.onComplete(run);
    return Promise.resolve(run);
  }
  void attachSpawnedProc(run, proc);

  // v0.12 slice 3 — stamp streamingMode + steerable on the Run
  // immediately so the resolver and watchdog see a stable post-spawn
  // shape. Slice 4's per-call cascade will set Run.steerable upstream
  // before this point too; stamping again is idempotent.
  stampSpawnStreamingMode(run, opts.steerable === true);

  // v0.12 slice 3 — attach the single-writer stdin queue and inject
  // the initial `prompt` command per design §4.2 "Initial prompt
  // injection" + plan §5 Q1 resolution (immediate write; trust the
  // kernel pipe buffer; v0.5 `sendToRun` precedent at runs.ts:1210).
  // Fire-and-forget enqueue: the response arrives later as a
  // `response` line (slice 4 wires the ack).
  if (opts.steerable === true && proc.stdin) {
    const queue = new RpcStdinQueue(proc.stdin);
    run.rpcStdinQueue = queue;
    if (typeof opts.initialPrompt === "string" && opts.initialPrompt.length > 0) {
      void queue
        .enqueue({
          id: `init-${run.id}`,
          type: "prompt",
          message: opts.initialPrompt,
        })
        .catch(() => {
          // EPIPE / ECANCELED here means the subprocess exited
          // before we delivered the initial prompt. Nothing to
          // recover — the close handler will finalize the run as
          // failed when the subprocess emits its exit code.
        });
    }
  }

  // Hard timeout.
  run.timeoutTimer = setTimeout(() => {
    if (run.status === "running" || run.status === "paused") {
      forceTerminate(run, "timeout", opts.registry, opts.onComplete);
    }
  }, opts.timeoutMs);

  // Stream parsing.
  let buffer = "";
  let stderr = "";
  let finalized = false;
  let donePromiseResolve: (r: Run) => void;
  const done = new Promise<Run>((resolve) => {
    donePromiseResolve = resolve;
  });

  const finalize = async (terminal: RunStatus, exitCode?: number) => {
    if (finalized) return;
    finalized = true;
    if (run.timeoutTimer) {
      clearTimeout(run.timeoutTimer);
      run.timeoutTimer = undefined;
    }
    if (buffer.trim()) processLine(buffer);
    // v0.11 on_complete_hook (slice 2): fire the resolved hook between
    // stream-drain and `applyCloseHandlerTerminal`. Gates are strict:
    // only on natural exit-zero close with a resolved hook AND when
    // forceTerminate hasn't already flipped the run terminal. The
    // helper writes final.md ahead of the spawn (so the hook can read
    // it via env), sets run.hookExecuting/hookProc for the duration,
    // and applies the W7 idempotency guard if forceTerminate fires
    // mid-flight. On hook failure the helper returns "hook_failed";
    // we let the existing applyCloseHandlerTerminal path persist that
    // terminal as the run's official status.
    if (
      terminal === "completed" &&
      exitCode === 0 &&
      opts.resolvedHook &&
      !isTerminal(run.status)
    ) {
      try {
        terminal = await applyHookToTerminal(
          run,
          opts.resolvedHook,
          terminal,
        );
      } catch (e) {
        // Defensive: applyHookToTerminal's own try/finally clears the
        // hook flags even on throw, but a thrown helper means the
        // hook helper itself blew up unexpectedly. Surface as
        // hook_failed so the lifecycle terminates cleanly.
        run.hookResult = {
          passed: false,
          command: opts.resolvedHook.command,
          exitCode: null,
          durationMs: 0,
          logPath: "",
          tailText: `(applyHookToTerminal threw) ${(e as Error).message}`,
          tailBytes: 0,
          tailLines: 0,
          failureKind: "spawn_error",
        };
        terminal = "hook_failed";
      }
    }
    // Race-fix: if `forceTerminate` already settled the run (e.g. the
    // user pressed Ctrl+C, the timeout timer fired, or session_shutdown
    // ran), `applyCloseHandlerTerminal` returns false. The errorMessage
    // fallback, registry.notify, persistence writes, and onComplete all
    // already executed on the forceTerminate path — we skip them.
    //
    // BUT: pi's session-file discovery is owned by the close-handler
    // path, not forceTerminate (sync forceTerminate runs before pi
    // writes the .jsonl). We must still call discoverSessionPathIfMissing
    // here so the force-killed sub-agent stays resumable via
    // ensemble_send. We also clear run.proc and kill() the handle
    // (idempotent; SIGTERM may have been sent already), then resolve
    // `done` with the correct (forceTerminate-set) state.
    if (!applyCloseHandlerTerminal(run, terminal, exitCode)) {
      discoverSessionPathIfMissing(run, opts.sessionDir);
      run.proc = undefined;
      try {
        proc.kill();
      } catch {
        // already dead
      }
      donePromiseResolve(run);
      return;
    }
    if (terminal === "failed" && !run.errorMessage) {
      run.errorMessage = stderr.trim() || `pi subprocess exited with code ${exitCode}`;
    }
    applySubstanceCheck(run, terminal);
    discoverSessionPathIfMissing(run, opts.sessionDir);
    run.proc = undefined;
    opts.registry.notify(run);
    try {
      proc.kill();
    } catch {
      // already dead
    }
    // Persist record + final BEFORE resolving done so callers awaiting
    // result.done can read both files immediately.
    Promise.all([writeRecord(run), writeFinal(run)])
      .catch(() => {})
      .finally(() => {
        if (opts.onComplete) {
          try {
            opts.onComplete(run);
          } catch {
            // never crash the spawner on listener errors
          }
        }
        donePromiseResolve(run);
      });
  };

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    // Append every parseable JSON line to the transcript (fire-and-forget I/O).
    void appendFile(run.transcriptPath, line + "\n").catch(() => {});

    let event: any;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }

    // Pure state-machine logic lives in applyEvent (see src/event-handler.ts).
    // This wrapper handles I/O (transcript append) and listener notification.
    const effect = applyEvent(run, event);
    if (effect.kind === "finalize") {
      void finalize(effect.status, effect.exitCode);
      return;
    }
    if (effect.kind === "updated") {
      opts.registry.notify(run);
      if (opts.onUpdate) opts.onUpdate(run);
    }
  };

  proc.stdout?.on("data", (data: Buffer) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  });

  proc.stderr?.on("data", (data: Buffer) => {
    stderr += data.toString();
  });

  proc.on("close", (code) => {
    if (finalized) return;
    if ((code ?? 0) === 0) void finalize("completed", 0);
    else void finalize("failed", code ?? 0);
  });

  proc.on("error", () => {
    run.errorMessage = "failed to spawn pi process";
    void finalize("failed", 1);
  });

  proc.unref();
  return done;
}

function mapFromRegistry(r: RunRegistry): Map<string, Run> {
  const m = new Map<string, Run>();
  for (const x of r.list()) m.set(x.id, x);
  return m;
}

// ── ensemble_send ───────────────────────────────────────────────────────

export interface SendToRunOptions {
  registry: RunRegistry;
  timeoutMs: number;
  onUpdate?: (run: Run) => void;
  onComplete?: (run: Run) => void;
  /**
   * v0.10 watchdog (Slice 3) per-send override. When provided,
   * replaces the run's existing `killOnStall` for the resumed turn
   * (and onward). Useful if the operator decides mid-flight that a
   * previously-conservative spawn should now auto-kill on stall.
   */
  killOnStall?: boolean;
  /**
   * v0.10 watchdog (Slice 3) per-send soft-threshold override
   * (seconds). When provided, replaces `Run.softStallSeconds`.
   */
  softStallSeconds?: number;
  /**
   * v0.11 on_complete_hook (slice 3) per-send override. When provided,
   * replaces `Run.onCompleteHook` for the resumed terminal (and
   * onward sends, until next override). Empty string is the explicit-
   * disable sentinel — disables for this resume; replace with a fresh
   * non-empty command on a later send to re-arm.
   */
  onCompleteHook?: string;
  /**
   * v0.11 on_complete_hook (slice 3) per-send timeout override
   * (seconds). Replaces `Run.onCompleteHookTimeoutSeconds`.
   */
  onCompleteHookTimeoutSeconds?: number;
  /**
   * v0.12 slice 4 — LLM-facing `streaming_behavior` arg. Drives
   * {@link resolveSendStrategy} to pick `rpc-steer` /
   * `rpc-follow-up` / `spawn-resume` / `rejected`. Default `"auto"`
   * which falls through to `rpc-follow-up` for live RPC runs and
   * `spawn-resume` for terminal runs.
   */
  streamingBehavior?: StreamingBehavior;
}

export type SendToRunResult =
  | {
      kind: "started";
      run: Run;
      done: Promise<Run>;
      /**
       * v0.12 slice 4 — RPC ack envelope. Set on the `rpc-steer` /
       * `rpc-follow-up` paths; resolves when the matching `response`
       * line arrives on stdout (within 30s) and rejects on timeout or
       * `RpcStdinQueue` write failure. `undefined` on the
       * `spawn-resume` path (legacy resume-via-`pi --session` has no
       * stdin-side correlation).
       *
       * Callers that want the ack should `await result.ack` after
       * receiving the started envelope. The `done` Promise still
       * resolves on terminal status of the sub-agent, independent of
       * the ack.
       */
      ack?: Promise<{ delivered: boolean; deliveredAt: number }>;
    }
  | { kind: "rejected"; reason: string };

/**
 * Pure pre-check for whether a run can be sent to right now. Returns
 * the same set of rejection reasons {@link sendToRun} would, but
 * without any side effects — callers can use this to short-circuit UI
 * flows (e.g. the overlay's 's' keybinding) before opening an input
 * prompt.
 *
 * v0.12 slice 1: thin shim around {@link resolveSendStrategy} (called
 * with `"auto"`) plus a post-strategy I/O check that the session file
 * is actually present on disk. The pure resolver checks string
 * presence (`run.sessionPath` set/unset); this layer adds the disk
 * check via {@link existsSync}. Callers stay shape-stable; only the
 * underlying decision logic moved into the resolver so the v0.12
 * `streaming_behavior` arg can route through the same matrix.
 */
export function validateSendable(
  run: Run,
): { ok: true } | { ok: false; reason: string } {
  const r = resolveSendStrategy(run, "auto");
  if (r.strategy.kind === "rejected") {
    return { ok: false, reason: r.strategy.reason };
  }
  // I/O check after the pure resolver. The disk-existence check stays
  // here because resolveSendStrategy is pure (no fs). Slice 4 may
  // narrow this for true RPC steer/follow_up paths once the live
  // subprocess is the source of truth, not the on-disk session file.
  if (run.sessionPath && !existsSync(run.sessionPath)) {
    return {
      ok: false,
      reason: `sub-agent ${run.id} session file is missing on disk: ${run.sessionPath}`,
    };
  }
  return { ok: true };
}

/**
 * v0.12 steering — pure decision matrix that routes an `ensemble_send`
 * call to one of `rpc-steer`, `rpc-follow-up`, `spawn-resume`, or
 * `rejected`. Pinned by `tests/runs-streaming-strategy.test.ts`.
 *
 * Slice 1 lands the resolver. Slice 2 wires the RPC subprocess
 * plumbing (`--mode rpc`, single-writer stdin queue) that consumes
 * `rpc-steer` / `rpc-follow-up`. Slice 4 wires the upstream cascade
 * that stamps `Run.steerable` / `Run.streamingMode` at spawn time.
 *
 * Pure: no I/O, deterministic on `(run, behavior)`. Reject reasons
 * are character-pinned (W3 string witness) by the corresponding test
 * file so user-visible text drift is detectable.
 *
 * Decision matrix (design §4.3, lines ~571–640):
 *
 *   - `running` AND `streamingMode === "rpc"`:
 *       "auto"      → rpc-follow-up   (safe non-interrupting queue)
 *       "steer"     → rpc-steer
 *       "follow_up" → rpc-follow-up
 *       "resume"    → rejected ("...is currently running; resume is
 *                    for terminal runs only...")
 *
 *   - `running` AND (`streamingMode === "print"` OR undefined):
 *       (any)       → rejected ("...is not steerable; mark steerable:
 *                    true at spawn...")
 *
 *   - `paused` (any streamingMode):
 *       (any)       → rejected ("...is paused; resume it first...")
 *                    Mirrors v0.5 contract; design §4.5 forbids steer-
 *                    while-paused (state-space explosion).
 *
 *   - `queued`:
 *       (any)       → rejected ("...is queued and has not started
 *                    yet...").
 *
 *   - terminal status (`completed` / `failed` / `killed` / `timeout`
 *     / `hook_failed`):
 *       "steer"     → rejected ("...has already finished; cannot
 *                    steer a terminal run...")
 *       "follow_up" → rejected (analogous)
 *       "auto"|"resume" + sessionPath unset → rejected ("...has no
 *                    resumable session on disk...")
 *       "auto"|"resume" + sessionPath set   → spawn-resume
 */
export function resolveSendStrategy(
  run: Run,
  behavior: StreamingBehavior = "auto",
): ResolvedSendStrategy {
  // running
  if (run.status === "running") {
    const isRpc = run.streamingMode === "rpc";
    if (!isRpc) {
      return {
        strategy: {
          kind: "rejected",
          reason: `sub-agent ${run.id} is not steerable; mark steerable: true at spawn to send messages while the subprocess is alive. (Currently running; wait for it to finish before sending again.)`,
        },
      };
    }
    // running + rpc
    if (behavior === "steer") return { strategy: { kind: "rpc-steer" } };
    if (behavior === "follow_up" || behavior === "auto") {
      return { strategy: { kind: "rpc-follow-up" } };
    }
    // behavior === "resume"
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} is currently running; resume is for terminal runs only. Use streaming_behavior=steer or follow_up to send to the live subprocess.`,
      },
    };
  }

  // paused
  if (run.status === "paused") {
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} is paused; resume it first via /conductor resume ${run.id}.`,
      },
    };
  }

  // queued
  if (run.status === "queued") {
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} is queued and has not started yet; wait for it to start before sending.`,
      },
    };
  }

  // terminal — explicit steer/follow_up never makes sense.
  if (behavior === "steer") {
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} has already finished; cannot steer a terminal run. Send without streaming_behavior to spawn a fresh subprocess.`,
      },
    };
  }
  if (behavior === "follow_up") {
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} has already finished; cannot follow_up a terminal run. Send without streaming_behavior to spawn a fresh subprocess.`,
      },
    };
  }

  // terminal + auto/resume — sessionPath must be present for spawn-resume.
  if (!run.sessionPath) {
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} has no resumable session on disk (sessionPath unset).`,
      },
    };
  }
  return { strategy: { kind: "spawn-resume" } };
}

/**
 * v0.12 slice 4 — 30 seconds. Hard cap on how long we wait for the
 * sub-agent to ack a `steer` / `follow_up` command. Real-world ack
 * RTTs from `[pi-dist] modes/rpc/rpc-mode.js` are sub-second; 30s is
 * generous. Pinned for the faked-clock test in
 * `tests/ensemble-send.test.ts: running steerable + ack timeout`.
 */
export const RPC_ACK_TIMEOUT_MS = 30_000;

let rpcSendCounter = 0;

/**
 * v0.12 slice 4 — enqueue a `steer` or `follow_up` RPC command on a
 * live steerable run and register a `pendingAcks` entry so the matching
 * `response` line on stdout resolves the returned ack promise.
 *
 * Lifecycle:
 *   - allocates a fresh `id` (`send-<runId>-<counter>`) so
 *     `routeRpcResponse` can correlate stdout responses to the ack.
 *   - sets up a 30s timeout timer that, on fire, removes the entry
 *     from `run.pendingAcks` and rejects the ack promise.
 *   - calls `RpcStdinQueue.enqueue` and waits for the kernel-write
 *     ack. On EPIPE / queue-destroyed / non-RPC subprocess, returns
 *     `{kind: "epipe", reason}`.
 *   - on successful enqueue, returns `{kind: "queued", ack}` where
 *     `ack` resolves to `{delivered, deliveredAt}` on response and
 *     rejects on timeout.
 *
 * Pure with respect to the rest of the spawn pipeline (no
 * subprocess, no registry mutation — the caller flips run.status).
 */
function enqueueRpcSendWithAck(
  run: Run,
  type: "steer" | "follow_up",
  message: string,
):
  | { kind: "queued"; ack: Promise<{ delivered: boolean; deliveredAt: number }> }
  | { kind: "epipe"; reason: string } {
  const queue = run.rpcStdinQueue;
  if (!queue) {
    return {
      kind: "epipe",
      reason: `sub-agent ${run.id} finished before steer was delivered (stdin queue gone).`,
    };
  }
  // Lazy-init the correlation Map.
  if (!run.pendingAcks) run.pendingAcks = new Map();
  rpcSendCounter += 1;
  const id = `send-${run.id}-${rpcSendCounter}`;
  const ackPromise = new Promise<{ delivered: boolean; deliveredAt: number }>(
    (resolve, reject) => {
      const timer = setTimeout(() => {
        // Self-removal from the Map: the timeout fires and the entry
        // must clean itself up so a late-arriving `response` no-ops in
        // routeRpcResponse instead of double-firing.
        run.pendingAcks?.delete(id);
        reject(
          new Error(
            `ack timeout — sub-agent may have received the message; check via ensemble_status`,
          ),
        );
      }, RPC_ACK_TIMEOUT_MS);
      run.pendingAcks!.set(id, {
        resolve: (delivered: boolean) =>
          resolve({ delivered, deliveredAt: Date.now() }),
        reject,
        timer,
      });
    },
  );
  // Fire-and-forget: the enqueue Promise resolves on kernel-write; if
  // the pipe died (EPIPE), the queue rejects. Either way we surface
  // through the ack promise (timeout) or via this catch (EPIPE).
  let epipeFlag: { msg: string } | null = null;
  void queue.enqueue({ id, type, message }).catch((err: Error) => {
    // Sub-agent finished before steer was delivered. Clean up the
    // pendingAcks entry and reject the ack promise with the Q3 lock
    // wording.
    const entry = run.pendingAcks?.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      run.pendingAcks?.delete(id);
      entry.reject(
        new Error(
          `sub-agent ${run.id} finished before steer was delivered (${err.message}).`,
        ),
      );
    }
    epipeFlag = { msg: err.message };
  });
  // Detection of synchronous EPIPE — if the queue rejected
  // synchronously (already-destroyed queue, etc.), the .catch above
  // fired this tick. Surface as an `epipe` result so the caller can
  // turn the started envelope back into a rejection without ever
  // flipping run.status to running.
  if (epipeFlag) {
    return {
      kind: "epipe",
      reason: `sub-agent ${run.id} finished before steer was delivered.`,
    };
  }
  return { kind: "queued", ack: ackPromise };
}

/**
 * Continue an existing sub-agent's pi session with a new user-role message.
 *
 * Spawns a fresh `pi` subprocess pointed at the run's `sessionPath` via
 * `pi --mode json -p --session <path>` and reuses the same event-loop
 * plumbing as `spawnRun` so the run's messages, usage, and lastToolCall
 * accumulate across the original spawn AND any subsequent sends.
 *
 * v0.12 slice 4: if the run is alive in RPC mode
 * ({@link resolveSendStrategy} returns `rpc-steer` or `rpc-follow-up`),
 * enqueues the command on the live subprocess via `Run.rpcStdinQueue`
 * and returns an ack promise that resolves on the matching `response`
 * line. The legacy `spawn-resume` path is unchanged for terminal runs.
 *
 * Returns synchronously:
 *   - `{ kind: "started", run, done, ack? }` on success. The Run is
 *     mutated in place: status flips back to "running", terminal
 *     fields are cleared, and the registry is notified. `done`
 *     resolves when the subprocess reaches terminal (or for RPC paths,
 *     resolves with the current run on the next terminal). `ack` is
 *     set on the RPC paths and `undefined` on `spawn-resume`.
 *   - `{ kind: "rejected", reason }` if {@link resolveSendStrategy}
 *     rejects (running-print, paused, queued, terminal-without-session)
 *     OR if RPC enqueue surfaces a synchronous EPIPE.
 */
export function sendToRun(
  run: Run,
  message: string,
  opts: SendToRunOptions,
): SendToRunResult {
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      kind: "rejected",
      reason: `cannot send an empty message to sub-agent ${run.id}.`,
    };
  }
  const behavior: StreamingBehavior = opts.streamingBehavior ?? "auto";
  const decision = resolveSendStrategy(run, behavior);
  if (decision.strategy.kind === "rejected") {
    return { kind: "rejected", reason: decision.strategy.reason };
  }

  // RPC paths: enqueue on the live subprocess; do NOT respawn.
  if (
    decision.strategy.kind === "rpc-steer" ||
    decision.strategy.kind === "rpc-follow-up"
  ) {
    const cmdType = decision.strategy.kind === "rpc-steer" ? "steer" : "follow_up";
    // v0.10 watchdog (Slice 3) per-send overrides apply on RPC paths
    // too: a steer can be the moment the operator decides to
    // re-arm `kill_on_stall`. Status stays "running" — the
    // subprocess is alive throughout.
    if (opts.killOnStall !== undefined) run.killOnStall = opts.killOnStall;
    if (opts.softStallSeconds !== undefined) run.softStallSeconds = opts.softStallSeconds;
    // v0.11 on_complete_hook (slice 3) per-send overrides apply on
    // RPC paths too: when this RPC turn eventually terminates, the
    // close handler reads the latest values.
    if (opts.onCompleteHook !== undefined) run.onCompleteHook = opts.onCompleteHook;
    if (opts.onCompleteHookTimeoutSeconds !== undefined)
      run.onCompleteHookTimeoutSeconds = opts.onCompleteHookTimeoutSeconds;
    // Item 15: re-stamp per-invocation markers BEFORE we touch the
    // queue. RPC steering re-uses the same subprocess but the
    // operator still expects per-most-recent-send accounting in the
    // completion envelope when the run eventually terminates.
    snapshotInvocationMarkers(run);
    const result = enqueueRpcSendWithAck(run, cmdType, trimmed);
    if (result.kind === "epipe") {
      return { kind: "rejected", reason: result.reason };
    }
    // The run's `done` Promise was returned at spawn time and is no
    // longer accessible here. Synthesise a Promise that resolves on
    // the run's NEXT terminal status transition so callers that
    // `await result.done` get a meaningful signal. The registry's
    // change listener does the work.
    const done = new Promise<Run>((resolve) => {
      const unsub = opts.registry.onChange((r) => {
        if (r.id === run.id && isTerminal(r.status)) {
          unsub();
          resolve(r);
        }
      });
    });
    return { kind: "started", run, done, ack: result.ack };
  }

  // spawn-resume: legacy fresh-subprocess path on a terminal run.
  // Validate the session file exists on disk (validateSendable's
  // post-strategy check, preserved verbatim from pre-slice-4).
  if (run.sessionPath && !existsSync(run.sessionPath)) {
    return {
      kind: "rejected",
      reason: `sub-agent ${run.id} session file is missing on disk: ${run.sessionPath}`,
    };
  }

  // Reset terminal state so listeners and the panel see this as a fresh run.
  run.status = "running";
  run.finishedAt = undefined;
  run.exitCode = undefined;
  run.errorMessage = undefined;
  run.stopReason = undefined;
  run.lastToolCall = undefined;
  // Reseed watchdog timing so the next tick doesn't compute silentMs
  // against the *previous turn's* lastEventAt (resume-race bug fix).
  run.lastEventAt = Date.now();
  run.stalledSince = undefined;
  // Item 15: re-stamp per-invocation markers BEFORE the new pi
  // subprocess fires. The completion envelope reads these to compute
  // per-most-recent-send <duration> / <usage> / <cost>.
  snapshotInvocationMarkers(run);
  // v0.10 watchdog (Slice 3) per-send overrides. Replace prior values
  // when provided; leave the spawn-time values alone otherwise.
  if (opts.killOnStall !== undefined) run.killOnStall = opts.killOnStall;
  if (opts.softStallSeconds !== undefined) run.softStallSeconds = opts.softStallSeconds;
  // v0.11 on_complete_hook (slice 3) per-send overrides. Replace the
  // run's stored per-call layer when provided; leave the spawn-time
  // values alone otherwise (§4.6: per-call winner persists across
  // terminals unless explicitly replaced).
  if (opts.onCompleteHook !== undefined) run.onCompleteHook = opts.onCompleteHook;
  if (opts.onCompleteHookTimeoutSeconds !== undefined)
    run.onCompleteHookTimeoutSeconds = opts.onCompleteHookTimeoutSeconds;
  opts.registry.notify(run);

  // resolveSendStrategy guarantees sessionPath is set on spawn-resume,
  // but TS can't see through a free-function call — capture it.
  const sessionPath = run.sessionPath as string;

  const piArgs = buildResumePiArgs(run, trimmed);

  const done = runPiSubprocess(run, piArgs, {
    registry: opts.registry,
    cwd: run.cwd,
    timeoutMs: opts.timeoutMs,
    onUpdate: opts.onUpdate,
    onComplete: opts.onComplete,
    // Re-discover sessionPath on finalize — the file path is stable but the
    // mtime updates, which lets future sends still find it.
    sessionDir: dirname(sessionPath),
    // v0.12 steering: spawn-resume on a terminal run is always
    // print-mode by design (§4.4 archived-run compat / Q10 lock).
    // The live RPC paths (`rpc-steer` / `rpc-follow-up`) ride the
    // existing subprocess via `Run.rpcStdinQueue` and never hit this
    // branch — see the early-return in `sendToRun` above. This
    // argument is hard-coded `false` because `pi --session` resume
    // does not promise to re-enter RPC mode (the original subprocess
    // is gone; no stickiness across the boundary).
    steerable: false,
    initialPrompt: undefined,
    // v0.11 on_complete_hook (slice 2): re-resolve at every terminal
    // transition so config changes between spawn and re-fire are
    // honored (§4.6: each terminal is a fresh gate). Per-call layer
    // (slice 3) reads from `Run.onCompleteHook` — stamped at spawn time
    // by `spawnRun` and replaceable by per-send overrides above.
    resolvedHook: resolveCloseHook(
      run.cwd,
      run.persona,
      hookSpecFromOpts(run.onCompleteHook, run.onCompleteHookTimeoutSeconds),
    ),
  });
  return { kind: "started", run, done };
}

// ── Termination helpers ──────────────────────────────────────────────

/**
 * Race-fix helper used by the closure-local `finalize` inside
 * `runPiSubprocess` (the `proc.on("close")` path).
 *
 * The conductor has two paths that can settle a Run to a terminal
 * state:
 *
 *   1. The subprocess's natural exit, observed by `proc.on("close")`,
 *      which routes through the `finalize` closure.
 *   2. An external `forceTerminate(run, "killed"|"timeout", …)` called
 *      from `runStop`, the timeout timer, or `session_shutdown`.
 *
 * If (2) ran first, the SIGTERM (and the SIGKILL fallback) issued by
 * forceTerminate eventually causes (1) to fire with a non-zero exit
 * code (typically 143 for SIGTERM, 137 for SIGKILL). Without a guard,
 * the close handler would call `finalize("failed", 143)` and silently
 * regress `run.status` from "killed" back to "failed", while
 * double-firing the registry listeners and the `<sub-agent-completed>`
 * notification.
 *
 * This helper applies the terminal transition only when the run is
 * not already terminal. Returns true if it mutated state, false if it
 * bailed because the run was already settled. The closure body uses
 * the return value to gate the rest of finalize's work (errorMessage
 * fallback, session-file discovery, persistence writes, onComplete).
 */
export function applyCloseHandlerTerminal(
  run: Run,
  terminal: RunStatus,
  exitCode: number | undefined,
): boolean {
  if (isTerminal(run.status)) return false;
  run.status = terminal;
  run.exitCode = exitCode;
  run.finishedAt = Date.now();
  return true;
}

/**
 * v0.8.1 Item 4: when a run is about to flip to `completed`, run the
 * substance heuristic against its message stream and stash any warning
 * on `run.nonSubstantiveFinal` for the completion notification to
 * surface. No-op for non-completed terminals (failed/killed/timeout
 * already have an error story; the heuristic would create noisy false
 * positives) and idempotent (won't overwrite an existing flag).
 *
 * Exported for unit-test access; production callsite is the `finalize`
 * closure inside `attachLifecycleHandlers`.
 */
export function applySubstanceCheck(run: Run, terminal: RunStatus): void {
  if (terminal !== "completed") return;
  if (run.nonSubstantiveFinal) return;
  const check = isNonSubstantiveFinalMessage(run.messages);
  if (check.warn && check.reason && check.message) {
    run.nonSubstantiveFinal = { reason: check.reason, message: check.message };
  }
}

/**
 * v0.11 on_complete_hook (slice 2). Spawn the resolved hook between
 * stream-drain and `applyCloseHandlerTerminal`, await its exit, and
 * return the (possibly-overridden) terminal status.
 *
 * Lifecycle invariants pinned by `tests/runs-hook-integration.test.ts`:
 *   - `final.md` is written BEFORE the hook spawn so
 *     `CONDUCTOR_FINAL_TEXT_PATH` resolves at hook startup.
 *   - `run.hookExecuting = true` while the hook is in flight; cleared
 *     in `finally` even on synchronous throw.
 *   - `run.hookProc` is set (via `runHook`'s `onProc` callback) the
 *     moment the child process exists; cleared in the same `finally`.
 *   - **Idempotency guard (W7):** if `forceTerminate` flipped
 *     `run.status` to a terminal value while the hook was in flight,
 *     the hook result is dropped — no `run.hookResult` mutation, no
 *     terminal flip. The forceTerminate-set status wins.
 *
 * Pure-ish: mutates the passed-in `Run` (the caller owns the lifecycle)
 * and writes `final.md` / `hook.log` files. The actual subprocess spawn
 * is delegated to `runHook` (test-injectable via `deps.runHookImpl`).
 *
 * Caller contract — only call when ALL of:
 *   - `terminal === "completed"` (hooks gate exit-zero only)
 *   - `exitCode === 0` (natural pi close)
 *   - `resolvedHook` is non-undefined (the cascade produced a hook)
 *   - `!isTerminal(run.status)` (forceTerminate hasn't already run)
 */
export async function applyHookToTerminal(
  run: Run,
  resolvedHook: ResolvedHook,
  terminal: RunStatus,
  deps: { runHookImpl?: typeof runHook } = {},
): Promise<RunStatus> {
  // Pre-write final.md so CONDUCTOR_FINAL_TEXT_PATH resolves at hook
  // spawn time. writeFinal is best-effort; a write failure is rare and
  // the hook can still introspect transcript via
  // CONDUCTOR_TRANSCRIPT_PATH.
  try {
    await writeFinal(run);
  } catch {
    // best-effort
  }

  const runHookImpl = deps.runHookImpl ?? runHook;
  run.hookExecuting = true;
  try {
    const hookResult = await runHookImpl({
      resolved: resolvedHook,
      runId: run.id,
      persona: run.persona,
      runDir: dirname(run.finalPath),
      finalPath: run.finalPath,
      transcriptPath: run.transcriptPath,
      parentCwd: run.cwd,
      onProc: (proc) => {
        run.hookProc = proc;
      },
    });
    // W7 idempotency guard: forceTerminate may have flipped status
    // during the hook's lifetime. Drop the result; the
    // forceTerminate-set terminal wins.
    if (isTerminal(run.status)) {
      return run.status;
    }
    run.hookResult = hookResult;
    if (!hookResult.passed) {
      return "hook_failed";
    }
    return terminal;
  } finally {
    run.hookExecuting = false;
    run.hookProc = undefined;
  }
}

export function forceTerminate(
  run: Run,
  reason: TerminationReason,
  registry: RunRegistry,
  onComplete?: (r: Run) => void,
  killGroup: (pid: number, signal: NodeJS.Signals) => void = defaultKillGroup,
): void {
  if (isTerminal(run.status)) return;
  // Defense-in-depth against the post-startup-reconcile foreign-adoption
  // bug: if this run is owned by a different live conductor host
  // (parentPid !== process.pid), refuse the entire operation. We have
  // no proc handle for it anyway (foreign children are spawned in the
  // sibling session), so SIGTERM/SIGKILL would no-op; the real harm
  // would be the writeRecord/registry.notify side effects corrupting
  // the owner's state. Records with `parentPid === undefined` are
  // legacy/unscoped — fall through to the existing path.
  if (run.parentPid !== undefined && run.parentPid !== process.pid) {
    // eslint-disable-next-line no-console
    console.warn(
      `forceTerminate: refusing to mutate foreign run id=${run.id} ownerPid=${run.parentPid} selfPid=${process.pid}`,
    );
    return;
  }
  if (run.timeoutTimer) {
    clearTimeout(run.timeoutTimer);
    run.timeoutTimer = undefined;
  }

  // v0.12 slice 5 — RPC stdin cleanup BEFORE SIGTERM (design §4.6 +
  // plan §5 critic gate 3). For steerable runs:
  //   1. Reject every pendingAcks entry with cause "force-terminate"
  //      (clears its timer, calls reject()).
  //   2. Destroy the rpcStdinQueue — rejects in-flight + queued
  //      stdin writes with the same cause.
  //   3. Clear the Map so a second forceTerminate (W7 idempotency)
  //      sees an empty Map. The W7 isTerminal-guard above means we
  //      never re-enter this branch on a double-kill, but clearing
  //      defends against any future code path that bypasses the
  //      guard.
  // SIGTERM ladder below is unchanged (Q6 lock).
  if (run.streamingMode === "rpc") {
    if (run.pendingAcks) {
      const err = new Error(`RpcStdinQueue destroyed: force-terminate`);
      for (const entry of run.pendingAcks.values()) {
        clearTimeout(entry.timer);
        try {
          entry.reject(err);
        } catch {
          // The reject callback shouldn't throw; defend against test
          // stubs / future surprises.
        }
      }
      run.pendingAcks.clear();
    }
    if (run.rpcStdinQueue) {
      try {
        run.rpcStdinQueue.destroy("force-terminate");
      } catch {
        // destroy is itself idempotent + non-throwing, but defend.
      }
    }
  }
  if (run.proc) {
    try {
      run.proc.kill("SIGTERM");
    } catch {
      // already dead
    }
    // Force-kill after 2s if it hasn't exited.
    setTimeout(() => {
      try {
        run.proc?.kill("SIGKILL");
      } catch {
        // already dead
      }
    }, 2000).unref();
  }
  // v0.11 on_complete_hook (slice 2): if a hook subprocess is in-flight
  // when the parent forceTerminates, SIGTERM its process group so the
  // hook helper's close listener fires and unwinds cleanly. We negate
  // the pid in `defaultKillGroup` (uses `process.kill(-pid, sig)`); the
  // injection seam observes the positive pid so tests can pin the
  // contract without forking real subprocesses. The hook helper's
  // close-listener will resolve with whatever exit code the kill
  // produced, but the close handler's idempotency guard
  // (`applyHookToTerminal`) drops that result because
  // `isTerminal(run.status)` is now true. A 2s SIGKILL fallback
  // mirrors the existing run.proc kill ladder.
  if (run.hookProc?.pid !== undefined) {
    const hookPid = run.hookProc.pid;
    try {
      killGroup(hookPid, "SIGTERM");
    } catch {
      // defaultKillGroup already swallows ESRCH/EPERM; this guards
      // against test stubs that throw unexpectedly.
    }
    setTimeout(() => {
      try {
        killGroup(hookPid, "SIGKILL");
      } catch {
        // already dead / test stub
      }
    }, 2000).unref();
    // Clear immediately so the close handler's `finally` block in
    // `applyHookToTerminal` is a no-op and W5's assertion holds.
    run.hookProc = undefined;
  }
  run.status =
    reason === "timeout" ? "timeout" :
    reason === "stalled" ? "killed" :
    "killed";
  // v0.10 watchdog: stalled hard-kills are reported via run.errorMessage
  // (status stays "killed" so existing UI/persistence paths don't grow a
  // new branch; the reason is surfaced in the completion envelope and
  // history annotation). Same shape as v0.8.1's nonSubstantiveFinal
  // advisory — informational, not a new lifecycle state.
  if (reason === "stalled" && !run.errorMessage) {
    run.errorMessage = "watchdog: hard-stalled (no events past hard threshold)";
  }
  run.finishedAt = Date.now();
  registry.notify(run);
  void writeRecord(run);
  void writeFinal(run);
  if (onComplete) {
    try {
      onComplete(run);
    } catch {
      // ignore
    }
  }
}

/**
 * Send a Unix signal to a pid. Defaults to `process.kill` but accepts an
 * injectable mock so pauseRun / resumeRun happy-path tests don't have to
 * fork real processes. forceTerminate uses `run.proc.kill(...)` directly
 * via the ChildProcess handle and is exercised by the existing
 * state-machine tests.
 */
export type Signaler = (pid: number, signal: NodeJS.Signals | number) => void;

const defaultSignaler: Signaler = (pid, signal) => {
  process.kill(pid, signal);
};

export function pauseRun(
  run: Run,
  registry: RunRegistry,
  signaler: Signaler = defaultSignaler,
): boolean {
  if (run.status !== "running") return false;
  if (!run.proc?.pid) return false;
  try {
    signaler(run.proc.pid, "SIGSTOP");
  } catch {
    return false;
  }
  run.status = "paused";
  run.pausedAt = Date.now();
  registry.notify(run);
  void writeRecord(run);
  return true;
}

export function resumeRun(
  run: Run,
  registry: RunRegistry,
  signaler: Signaler = defaultSignaler,
): boolean {
  if (run.status !== "paused") return false;
  if (!run.proc?.pid) return false;
  try {
    signaler(run.proc.pid, "SIGCONT");
  } catch {
    return false;
  }
  run.status = "running";
  run.pausedAt = undefined;
  registry.notify(run);
  void writeRecord(run);
  return true;
}

// ── Persistence ──────────────────────────────────────────────────────

/**
 * Public best-effort wrapper that mutates a `Run` to a terminal state
 * and persists `record.json`. Used by
 * `src/shutdown.ts.handleSessionShutdown`'s A1 reconcile path — the
 * orphan-creation window where SIGTERM has fired but no other code
 * path will call `writeRecord` before the runtime tears down.
 *
 * Idempotent and exception-swallowing per the rest of the
 * lifecycle's persistence semantics. Returns the `Promise` from
 * `writeRecord` so callers may await if they want, but the
 * convention is fire-and-forget (`void reconcileRecord(...)`).
 */
export async function reconcileRecord(
  run: Run,
  status: RunStatus,
  errorMessage: string,
  finishedAt: number,
): Promise<void> {
  run.status = status;
  run.finishedAt = finishedAt;
  run.errorMessage = errorMessage;
  await writeRecord(run);
}

async function writeRecord(run: Run): Promise<void> {
  try {
    await mkdir(dirname(run.recordPath), { recursive: true });
    await writeFile(run.recordPath, JSON.stringify(toRunRecord(run), null, 2));
  } catch {
    // best-effort
  }
}

async function writeFinal(run: Run): Promise<void> {
  try {
    await mkdir(dirname(run.finalPath), { recursive: true });
    await writeFile(run.finalPath, getFinalText(run.messages) || "(no output)");
  } catch {
    // best-effort
  }
}

// ── Helpers (lifted/adapted from pi-essentials) ──────────────────────

export function getFinalText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant" && Array.isArray((msg as any).content)) {
      const texts: string[] = [];
      for (const part of (msg as any).content) {
        if ((part as any).type === "text") texts.push((part as any).text);
      }
      if (texts.length > 0) return texts.join("").trim();
    }
  }
  return "";
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatUsage(u: { turns: number; input: number; output: number; cost: number }): string {
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns}t`);
  if (u.input) parts.push(`↑${formatTokens(u.input)}`);
  if (u.output) parts.push(`↓${formatTokens(u.output)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(3)}`);
  return parts.join(" ");
}

export function elapsedStr(start: number, end?: number): string {
  const s = ((end || Date.now()) - start) / 1000;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}
