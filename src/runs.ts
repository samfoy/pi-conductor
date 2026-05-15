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
import { dirname, join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { applyEvent } from "./event-handler.ts";
import { filterParentContext } from "./context-filter.ts";
import { seedSessionFile } from "./session-seed.ts";
import {
  emptyUsage,
  isTerminal,
  toRunRecord,
  type ConductorConfig,
  type Persona,
  type PersonaOverride,
  type Run,
  type RunStatus,
  type SpawnMode,
  type ThinkingLevel,
} from "./types.ts";

// ── Storage paths ─────────────────────────────────────────────────────

export function runsRoot(): string {
  return join(homedir(), ".pi", "agent", "conductor", "runs");
}

export function runDir(id: string): string {
  return join(runsRoot(), id);
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
    if (!registry.has(id) && !existsSync(runDir(id))) return id;
  }
  // Last resort — append timestamp for uniqueness.
  return `${persona}-${shortHash()}-${Date.now()}`;
}

// ── pi invocation discovery (lifted from pi-essentials) ──────────────

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
    };

export function buildPiArgs(opts: PiArgsOptions): string[] {
  const args: string[] = ["--mode", "json", "-p"];
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
  args.push(opts.prompt);
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
 * `filterParentContext` actually removed parent content. Tells the
 * sub-agent that its inherited transcript is incomplete, so it shouldn't
 * trust dangling references like "the inspector said X" without a
 * matching tool result — those orchestration calls were dropped.
 */
function filteredHistorySentinel(): AgentMessage {
  return {
    role: "user",
    content:
      "<filtered-history>\n" +
      "The transcript above and below this note is a FILTERED slice of a parent " +
      "conductor's conversation. The following entry types were dropped before " +
      "you saw this transcript:\n" +
      "  - Orchestration tool calls (ensemble_*, subagent) and their results\n" +
      "  - Sub-agent completion notifications (`<sub-agent-completed>` cards)\n" +
      "  - The conductor's internal reasoning (`thinking` blocks)\n" +
      "  - Bash commands marked with the `!!` excludeFromContext flag\n\n" +
      "If you see assistant prose that references prior orchestration (\"I spawned " +
      "X\", \"the inspector reported Y\", etc.) treat those statements with " +
      "skepticism — you do NOT have the actual tool calls or results to verify " +
      "them. Focus on the user's prose, file reads/writes you can see, and the " +
      "task prompt below.\n" +
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
 *   inherit_context: "full"     → seed a session file with every parent
 *                                 message verbatim. Falls back to fresh
 *                                 when there are no parent messages.
 *
 * Side effect: writes the seeded JSONL to disk when seeding. Pure with
 * respect to the rest of the spawn pipeline (no subprocess, no registry).
 */
export function planSpawnPiArgs(opts: PlanSpawnOptions): PlanSpawnResult {
  const { persona, parentMessages = [], sessionDir, systemPrompt, prompt, cwd, model, thinking } = opts;

  let seedMessages: AgentMessage[] | null = null;
  // Did filtering actually remove anything? If yes, prepend a sentinel
  // so the sub-agent knows its transcript is filtered and doesn't trust
  // dangling assistant references to dropped orchestration.
  let dropped = false;
  if (persona.inheritContext === "filtered" && parentMessages.length > 0) {
    const filtered = filterParentContext(parentMessages);
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
  } else if (persona.inheritContext === "full" && parentMessages.length > 0) {
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
    }),
  };
}

// ── Run registry ─────────────────────────────────────────────────────

export type RunListener = (run: Run) => void;

/** Reasons we report when forcing a terminal state externally. */
export type TerminationReason = "killed" | "timeout";

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
    messages: [],
    usage: emptyUsage(),
    cwd: opts.cwd,
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    sessionPath: undefined,
    // Capture the persona body now so future ensemble_send calls can
    // re-pass it on resume. Pi doesn't persist system prompts to disk.
    systemPrompt: opts.persona.systemPrompt,
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
    systemPrompt: opts.persona.systemPrompt,
    prompt,
    cwd: opts.cwd,
    model: opts.model,
    thinking: opts.thinking,
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

  let proc: ChildProcess;
  try {
    proc = spawn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
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
  run.proc = proc;

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

  const finalize = (terminal: RunStatus, exitCode?: number) => {
    if (finalized) return;
    finalized = true;
    if (run.timeoutTimer) {
      clearTimeout(run.timeoutTimer);
      run.timeoutTimer = undefined;
    }
    if (buffer.trim()) processLine(buffer);
    run.status = terminal;
    run.exitCode = exitCode;
    run.finishedAt = Date.now();
    if (terminal === "failed" && !run.errorMessage) {
      run.errorMessage = stderr.trim() || `pi subprocess exited with code ${exitCode}`;
    }
    // Discover the pi session file pi created in <runDir>/session/. Used by
    // ensemble_send to resume this sub-agent later via `pi --session <path>`.
    if (opts.sessionDir && !run.sessionPath) {
      const found = findSessionFile(opts.sessionDir);
      if (found) run.sessionPath = found;
    }
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
      finalize(effect.status, effect.exitCode);
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
    if ((code ?? 0) === 0) finalize("completed", 0);
    else finalize("failed", code ?? 0);
  });

  proc.on("error", () => {
    run.errorMessage = "failed to spawn pi process";
    finalize("failed", 1);
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
}

export type SendToRunResult =
  | { kind: "started"; run: Run; done: Promise<Run> }
  | { kind: "rejected"; reason: string };

/**
 * Pure pre-check for whether a run can be sent to right now. Returns the
 * same set of rejection reasons sendToRun would, but without any side
 * effects — callers can use this to short-circuit UI flows (e.g. the
 * overlay's 's' keybinding) before opening an input prompt.
 */
export function validateSendable(
  run: Run,
): { ok: true } | { ok: false; reason: string } {
  if (run.status === "running") {
    return {
      ok: false,
      reason: `sub-agent ${run.id} is currently running; wait for it to finish before sending.`,
    };
  }
  if (run.status === "paused") {
    return {
      ok: false,
      reason: `sub-agent ${run.id} is paused; resume it first via /conductor resume ${run.id}.`,
    };
  }
  if (run.status === "queued") {
    return {
      ok: false,
      reason: `sub-agent ${run.id} is queued and has not started yet; wait for it to start before sending.`,
    };
  }
  if (!run.sessionPath) {
    return {
      ok: false,
      reason: `sub-agent ${run.id} has no resumable session on disk (sessionPath unset).`,
    };
  }
  if (!existsSync(run.sessionPath)) {
    return {
      ok: false,
      reason: `sub-agent ${run.id} session file is missing on disk: ${run.sessionPath}`,
    };
  }
  return { ok: true };
}

/**
 * Continue an existing sub-agent's pi session with a new user-role message.
 *
 * Spawns a fresh `pi` subprocess pointed at the run's `sessionPath` via
 * `pi --mode json -p --session <path>` and reuses the same event-loop
 * plumbing as `spawnRun` so the run's messages, usage, and lastToolCall
 * accumulate across the original spawn AND any subsequent sends.
 *
 * Returns synchronously:
 *   - `{ kind: "started", run, done }` on success. The Run is mutated in
 *     place: status flips back to "running", terminal fields are cleared,
 *     and the registry is notified. `done` resolves when the new
 *     subprocess reaches a terminal status.
 *   - `{ kind: "rejected", reason }` if the run is in a state that can't
 *     be sent to (running, paused, queued) or has no resumable session.
 */
export function sendToRun(
  run: Run,
  message: string,
  opts: SendToRunOptions,
): SendToRunResult {
  const check = validateSendable(run);
  if (!check.ok) {
    return { kind: "rejected", reason: check.reason };
  }
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      kind: "rejected",
      reason: `cannot send an empty message to sub-agent ${run.id}.`,
    };
  }

  // Reset terminal state so listeners and the panel see this as a fresh run.
  run.status = "running";
  run.finishedAt = undefined;
  run.exitCode = undefined;
  run.errorMessage = undefined;
  run.stopReason = undefined;
  run.lastToolCall = undefined;
  opts.registry.notify(run);

  // validateSendable guarantees sessionPath is set, but TS can't see
  // through a free-function call — capture it explicitly.
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
  });
  return { kind: "started", run, done };
}

// ── Termination helpers ──────────────────────────────────────────────

export function forceTerminate(
  run: Run,
  reason: TerminationReason,
  registry: RunRegistry,
  onComplete?: (r: Run) => void,
): void {
  if (isTerminal(run.status)) return;
  if (run.timeoutTimer) {
    clearTimeout(run.timeoutTimer);
    run.timeoutTimer = undefined;
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
  run.status = reason === "timeout" ? "timeout" : "killed";
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
 * injectable mock so pauseRun / resumeRun / forceTerminate happy-path
 * tests don't have to fork real processes.
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
