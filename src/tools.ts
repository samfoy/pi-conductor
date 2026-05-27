/**
 * pi-conductor — Tools registered with pi.
 *
 * v0.2 lineup:
 *   - ensemble_list   (read-only, persona registry)
 *   - ensemble_status (live registry view)
 *   - ensemble_spawn  (foreground default, with auto-downgrade-on-queue)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Persona, PersonaOverride, Run, RunStatus, ThinkingLevel } from "./types.ts";
import { resolvePersonas } from "./personas.ts";
import { loadConfig } from "./config.ts";
import { collapseSteerableCascade } from "./steerable.ts";
import { elapsedStr, forceTerminate, formatUsage, getFinalText, pauseRun, resolveTimeoutMs, resumeRun, sendToRun, type RunRegistry } from "./runs.ts";
import { SpawnQueue } from "./queue.ts";
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
  getCwd: () => string;
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
}

export function registerTools(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  registerListTool(pi, opts);
  registerStatusTool(pi, opts);
  registerSpawnTool(pi, opts);
  registerSendTool(pi, opts);
  registerPauseTool(pi, opts);
  registerResumeTool(pi, opts);
  registerKillTool(pi, opts);
  registerFocusTool(pi, opts);
}

// ── ensemble_list ────────────────────────────────────────────────────

function registerListTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: "ensemble_list",
    label: "List personas",
    description:
      "List the conductor sub-agent personas available in this workspace. " +
      "Returns each persona's name, one-line description, model/thinking config, " +
      "context-inheritance mode, and source (builtin / user / project).",
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

function registerStatusTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: "ensemble_status",
    label: "Sub-agent status",
    description:
      "Report status of currently-running, queued, paused, and recently-finished sub-agents in this session.",
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
    async execute(_id, params) {
      const registry = opts.getRegistry();
      const queue = opts.getQueue();
      const all = registry.list();
      const filtered = params?.agent_id ? all.filter((r) => r.id === params.agent_id) : all;

      const groups = groupByStatus(filtered);
      const queueList = queue.list().map((p) => ({
        id: p.id,
        persona: p.persona.name,
        requestedMode: p.requestedMode,
        enqueuedAt: p.enqueuedAt,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: formatStatusForLLM(groups, queueList.length),
          },
        ],
        details: {
          running: groups.running.map(toStatusSummary),
          queued: groups.queued.map(toStatusSummary),
          paused: groups.paused.map(toStatusSummary),
          finished: [
            ...groups.completed,
            ...groups.failed,
            ...groups.killed,
            ...groups.timeout,
          ].map(toStatusSummary),
          queueDetail: queueList,
        },
      };
    },
  });
}

// ── ensemble_spawn ───────────────────────────────────────────────────

function registerSpawnTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: "ensemble_spawn",
    label: "Spawn sub-agent",
    description:
      "Launch a focused sub-agent using a persona. " +
      "Foreground (default): blocks until the sub-agent completes; result is returned. " +
      "Background: returns immediately; completion arrives as a <sub-agent-completed> user-role message that wakes you. " +
      "When the concurrency cap is reached, foreground spawns auto-downgrade to background.",
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
    ],
    parameters: Type.Object({
      persona: Type.String({
        description: "Persona name. Run ensemble_list to see what's available.",
      }),
      task: Type.String({
        description:
          "Self-contained task prompt for the sub-agent. Include file paths, constraints, and acceptance criteria.",
      }),
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
      steerable: Type.Optional(
        Type.Boolean({
          description:
            "v0.12 steering opt-in. true → launch the sub-agent in `pi --mode rpc` so the conductor can `steer` / `follow_up` it mid-run via ensemble_send. false / omitted → today's `pi --mode json -p` print mode (no steering). Cascade per-call > project > user > built-in default false. Personas using ctx.ui.confirm/select must NOT be spawned with steerable=true (auto-cancelled on the conductor side).",
        }),
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      const tmRange = validateTimeoutMinutes(params.timeout_minutes);
      if (tmRange) return errorResult(tmRange);
      const stallRange = validateStallThresholdSeconds(params.stall_threshold_seconds);
      if (stallRange) return errorResult(stallRange);

      const cwd = opts.getCwd();
      const cfg = loadConfig(cwd);
      const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
      const persona = resolved.personas.get(params.persona);
      if (!persona) {
        return errorResult(
          `persona "${params.persona}" not found. Run ensemble_list to see what's available.`,
        );
      }

      const foreground = params.foreground !== false;
      const mode = foreground ? "foreground" : "background";
      const queue = opts.getQueue();
      const registry = opts.getRegistry();

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
        persona,
        task: params.task,
        mode,
        cwd,
        model,
        thinking,
        timeoutMs,
        // Snapshot parent context at spawn time. Honors inherit_context
        // (filtered/full) inside spawnRun via planSpawnPiArgs.
        parentMessages: opts.getParentMessages(),
        // v0.10 Slice 3: per-spawn watchdog overrides. Undefined →
        // conductor default (off / 120s soft).
        killOnStall: params.kill_on_stall,
        softStallSeconds: params.stall_threshold_seconds,
        steerable,
        onUpdate: foreground ? () => {} : undefined, // foreground uses our own onUpdate below
        onComplete: foreground
          ? undefined
          : (run) => opts.pushCompletionNotification(run),
      });

      if (result.kind === "queued") {
        const p = result.placeholderRun;
        const downgradedNote = result.downgraded
          ? "Foreground spawn auto-downgraded to background because the concurrency cap is full. " +
            "The sub-agent is queued; completion will arrive as a <sub-agent-completed> notification."
          : "Spawn queued; completion will arrive as a <sub-agent-completed> notification.";
        // Fire the completion notification exactly once when this queued
        // run eventually finishes. Using a self-unsubscribing listener so
        // a later ensemble_send on the same run doesn't re-fire this
        // (sendToRun has its own onComplete plumbing).
        const unsub = registry.onChange((run) => {
          if (run.id === p.id && isTerminalStatus(run.status)) {
            unsub();
            opts.pushCompletionNotification(run);
          }
        });
        return {
          content: [
            {
              type: "text" as const,
              text:
                `${result.downgraded ? "queued-as-background" : "queued"}: ${p.id}\n` +
                `persona=${p.persona} queue_position=${result.queuePosition}\n\n` +
                downgradedNote,
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
            result.run.proc?.kill("SIGTERM");
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
            return foregroundFinalResult(outcome.value);
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
              `Spawned in background. Continue with other work; completion will arrive as a <sub-agent-completed> notification.`,
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
    name: "ensemble_send",
    label: "Send to sub-agent",
    description:
      "Continue an existing sub-agent's session with a new user-role message. " +
      "Works on finished sub-agents too (resumes via pi --session). " +
      "Foreground (default): blocks until the sub-agent's reply arrives. " +
      "Background: returns immediately; reply arrives as a <sub-agent-completed> notification.",
    promptSnippet: "Send a follow-up message to an existing sub-agent",
    promptGuidelines: [
      "Use ensemble_send when you want to continue working with a sub-agent that already has the context you care about — don't re-spawn from scratch.",
      "The sub-agent must be in a terminal state (completed/failed/killed/timeout). Running, paused, and queued sub-agents are rejected.",
      "Pass agent_id from a previous ensemble_spawn or ensemble_status result.",
    ],
    parameters: Type.Object({
      agent_id: Type.String({
        description: "agent_id of the sub-agent to send to. Get it from ensemble_spawn or ensemble_status.",
      }),
      message: Type.String({
        description: "User-role message delivered to the sub-agent's existing session.",
      }),
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
              "v0.12 steering. Default 'auto' → follow_up for live RPC sub-agents, spawn-resume for terminal ones. 'steer' interrupts the running turn; 'follow_up' queues for the next turn boundary; 'resume' forces a fresh subprocess via pi --session (terminal runs only). Sub-agent must have been spawned with steerable: true for steer/follow_up to work.",
          },
        ),
      ),
    }),
    async execute(_id, params, signal, onUpdate) {
      const tmRange = validateTimeoutMinutes(params.timeout_minutes);
      if (tmRange) return errorResult(tmRange);
      const stallRange = validateStallThresholdSeconds(params.stall_threshold_seconds);
      if (stallRange) return errorResult(stallRange);

      const cwd = opts.getCwd();
      const cfg = loadConfig(cwd);
      const registry = opts.getRegistry();
      const run = registry.get(params.agent_id);
      if (!run) {
        return errorResult(
          `agent_id "${params.agent_id}" not found. Run ensemble_status to see active sub-agents.`,
        );
      }

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

      const result = sendToRun(run, params.message, {
        registry,
        timeoutMs,
        onComplete: foreground
          ? undefined
          : (r) => opts.pushCompletionNotification(r),
        // v0.10 Slice 3: per-send watchdog overrides. Undefined → keep
        // the run's existing values.
        killOnStall: params.kill_on_stall,
        softStallSeconds: params.stall_threshold_seconds,
        // v0.12 slice 4: drive resolveSendStrategy. Undefined → "auto".
        streamingBehavior: params.streaming_behavior,
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
            result.run.proc?.kill("SIGTERM");
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
            return foregroundFinalResult(outcome.value);
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
              `Send dispatched in background. Continue with other work; completion will arrive as a <sub-agent-completed> notification.`,
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
    name: "ensemble_pause",
    label: "Pause sub-agent",
    description:
      "SIGSTOP a running sub-agent. The process is alive but not consuming tokens. " +
      "Use ensemble_resume to continue. Useful for cost control while the user reviews partial output.",
    promptSnippet: "Pause a running sub-agent",
    promptGuidelines: [
      "Use ensemble_pause to halt token consumption on a long-running sub-agent without killing it.",
      "The sub-agent must be in 'running' status; paused/queued/terminal sub-agents are rejected.",
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
      if (run.status !== "running") {
        const r = errorResult(
          `cannot pause sub-agent ${run.id}: status is ${run.status} (must be 'running').`,
        );
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
    name: "ensemble_resume",
    label: "Resume sub-agent",
    description:
      "SIGCONT a paused sub-agent. The sub-agent must have been paused via ensemble_pause first.",
    promptSnippet: "Resume a paused sub-agent",
    promptGuidelines: [
      "Use ensemble_resume to continue a sub-agent previously paused via ensemble_pause.",
      "The sub-agent must be in 'paused' status; running/queued/terminal sub-agents are rejected.",
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
      if (run.status !== "paused") {
        const r = errorResult(
          `cannot resume sub-agent ${run.id}: status is ${run.status} (must be 'paused').`,
        );
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
    name: "ensemble_kill",
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
      "Killable states: running, paused, queued. Already-terminal sub-agents are no-op success.",
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
      if (run.status === "completed" || run.status === "failed" || run.status === "killed" || run.status === "timeout" || run.status === "hook_failed") {
        return {
          content: [{ type: "text" as const, text: `already ${run.status}: ${run.id} (no-op)` }],
          details: { status: run.status, agent_id: run.id, persona: run.persona } as KillDetails,
        };
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
        content: [{ type: "text" as const, text: `killed: ${run.id}` }],
        details: { status: "killed", agent_id: run.id, persona: run.persona } as KillDetails,
      };
    },
  });
}

// ── ensemble_focus ───────────────────────────────────────────────────

function registerFocusTool(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  pi.registerTool({
    name: "ensemble_focus",
    label: "Focus a sub-agent",
    description:
      "Request the focused-stream overlay open on a specific sub-agent. " +
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
    async execute(_id, params) {
      const model = opts.getModel();
      const id = params?.agent_id;
      type FocusDetails = {
        opened: boolean;
        agent_id?: string;
        error?: string;
      };

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
  };
}

function formatPersonaListForLLM(personas: Persona[]): string {
  if (personas.length === 0) {
    return "No personas resolved. Check ~/.pi/agent/conductor/personas/ and `<cwd>/.pi/conductor/personas/`.";
  }
  const lines: string[] = [`${personas.length} personas:`, ""];
  for (const p of personas) {
    const cfg: string[] = [];
    cfg.push(`source=${p.source}`);
    cfg.push(`model=${p.model ?? "inherited"}`);
    cfg.push(`thinking=${p.thinking ?? "inherited"}`);
    cfg.push(`context=${p.inheritContext}`);
    lines.push(`  ${p.name.padEnd(14)} — ${p.description}`);
    lines.push(`  ${" ".repeat(14)}   [${cfg.join(", ")}]`);
  }
  return lines.join("\n");
}

interface StatusGroups {
  running: Run[];
  queued: Run[];
  paused: Run[];
  completed: Run[];
  failed: Run[];
  killed: Run[];
  timeout: Run[];
  hook_failed: Run[];
}

function groupByStatus(runs: Run[]): StatusGroups {
  const g: StatusGroups = {
    running: [],
    queued: [],
    paused: [],
    completed: [],
    failed: [],
    killed: [],
    timeout: [],
    hook_failed: [],
  };
  for (const r of runs) g[r.status].push(r);
  return g;
}

function toStatusSummary(r: Run) {
  return {
    id: r.id,
    persona: r.persona,
    status: r.status,
    elapsed: elapsedStr(r.startTime, r.finishedAt),
    usage: formatUsage(r.usage),
    lastToolCall: r.lastToolCall,
    transcriptPath: r.transcriptPath,
  };
}

function formatStatusForLLM(g: StatusGroups, queueSize: number): string {
  const lines: string[] = [];
  const counts: string[] = [];
  if (g.running.length) counts.push(`${g.running.length} running`);
  if (g.paused.length) counts.push(`${g.paused.length} paused`);
  if (g.queued.length || queueSize) counts.push(`${g.queued.length} queued`);
  const finished = g.completed.length + g.failed.length + g.killed.length + g.timeout.length + g.hook_failed.length;
  if (finished) counts.push(`${finished} finished`);
  lines.push(counts.length === 0 ? "No sub-agents." : `Sub-agents: ${counts.join(", ")}.`);

  const groupOrder: Array<[string, Run[]]> = [
    ["Running", g.running],
    ["Paused", g.paused],
    ["Queued", g.queued],
    ["Completed", g.completed],
    ["Failed", g.failed],
    ["Killed", g.killed],
    ["Timeout", g.timeout],
    ["Hook failed", g.hook_failed],
  ];
  for (const [label, list] of groupOrder) {
    if (list.length === 0) continue;
    lines.push("");
    lines.push(`${label}:`);
    for (const r of list) {
      const u = formatUsage(r.usage);
      const usagePart = u ? `[${u}]` : "";
      const hint = r.lastToolCall ? ` → ${r.lastToolCall}` : "";
      lines.push(
        `  ${r.id.padEnd(20)} ${r.persona.padEnd(14)} ${elapsedStr(r.startTime, r.finishedAt).padEnd(6)} ${usagePart}${hint}`,
      );
    }
  }
  return lines.join("\n");
}

function foregroundFinalResult(r: Run) {
  const summary = renderForegroundSummary(r);
  if (r.status !== "completed") {
    return {
      content: [{ type: "text" as const, text: summary }],
      details: {
        status: r.status,
        agent_id: r.id,
        persona: r.persona,
        errorMessage: r.errorMessage,
        transcriptPath: r.transcriptPath,
      },
    };
  }
  const finalText = getFinalText(r.messages) || "(no output)";
  return {
    content: [{ type: "text" as const, text: summary }],
    details: {
      status: "completed",
      agent_id: r.id,
      persona: r.persona,
      finalText,
      usage: r.usage,
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

function isTerminalStatus(s: RunStatus): boolean {
  return s === "completed" || s === "failed" || s === "killed" || s === "timeout" || s === "hook_failed";
}
