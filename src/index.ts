/**
 * pi-conductor — Extension entry point.
 *
 * v0.2 (foreground spawn, background spawn, queue, panel, conductor mode):
 *   - persona discovery + resolution (builtin / user / project layering)
 *   - tools: ensemble_list, ensemble_status, ensemble_spawn
 *   - slash commands: /conductor list | show | doctor | on | off | status |
 *                     stop | pause | resume | queue
 *   - ensemble panel (always visible when ≥1 sub-agent active or recently done)
 *   - conductor system prompt addendum, on by default; PI_CONDUCTOR_MODE=0
 *     / off disables it, /conductor on|off toggles per-session
 *   - <sub-agent-completed> notification cards posted inline on completion
 *
 * v0.3 will add the focused stream overlay (Ctrl+G).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { registerCommands } from "./commands.ts";
import { registerTools } from "./tools.ts";
import { RunRegistry } from "./runs.ts";
import { SpawnQueue } from "./queue.ts";
import { mountEnsembleWidget, type EnsembleWidget } from "./widget.ts";
import { formatCompletionNotification } from "./notifications.ts";
import { buildConductorSystemPrompt } from "./conductor-prompt.ts";
import { resolvePersonas } from "./personas.ts";
import { loadConfig } from "./config.ts";
import { FocusedStreamModel } from "./focused-stream-model.ts";
import { createFocusedOverlayComponent } from "./focused-overlay-factory.ts";
import { installFocusedOverlayShortcut } from "./focused-overlay-shortcut.ts";
import { forceTerminate, resolveTimeoutMs, sendToRun, validateSendable } from "./runs.ts";
import type { Run } from "./types.ts";
import { resolveInitialConductorMode } from "./conductor-mode.ts";

export default function (pi: ExtensionAPI): void {
  // ── Mutable session-scoped state ─────────────────────────────────────
  let cwd = process.cwd();
  let ctxRef: ExtensionContext | null = null;
  let widget: EnsembleWidget | null = null;

  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 4);
  const focusModel = new FocusedStreamModel(registry);

  // Track whether an overlay is already open so multiple opens don't stack.
  let overlayOpen = false;
  // Session-scoped unsub for the Ctrl+G focused-overlay shortcut.
  let unsubFocusedShortcut: (() => void) | null = null;

  // Note: we used to bind Key.escape and Key.ctrl("g") via
  // pi.registerShortcut, but pi reserves both (`app.interrupt` for Esc,
  // a built-in for Ctrl+G) and silently drops conflicting extension
  // shortcuts at load. Instead, both are routed through raw terminal
  // input via ctx.ui.onTerminalInput: foreground-detach intercepts Esc
  // for the duration of each foreground spawn (see
  // registerForegroundDetach below), and installFocusedOverlayShortcut
  // intercepts Ctrl+G for the lifetime of the session (see
  // session_start). Both consume the keystroke (`{ consume: true }`)
  // so pi's reserved bindings don't also fire.

  function openFocusedOverlay(agentId?: string): void {
    if (!ctxRef) return;
    if (overlayOpen) {
      // Already open — just shift focus to the requested agent.
      if (agentId) focusModel.focus(agentId);
      return;
    }
    if (agentId) focusModel.focus(agentId);
    overlayOpen = true;
    void ctxRef.ui
      .custom(
        (_tui, _theme, _kb, done) =>
          createFocusedOverlayComponent({
            model: focusModel,
            registry,
            forceTerminate,
            promptAndSendToRun: (id: string) => {
              void promptAndSendToRun(id);
            },
            done,
          }),
        { overlay: true },
      )
      .finally(() => {
        overlayOpen = false;
      });
  }

  /**
   * Prompt the user for a one-shot follow-up message to the focused
   * sub-agent, then dispatch it via sendToRun. Mirrors the behavior of
   * the LLM-callable ensemble_send tool but driven by a TUI keybinding.
   * Result is delivered via a `<sub-agent-completed>` notification card so
   * the conductor (LLM) sees the reply too.
   */
  async function promptAndSendToRun(agentId: string): Promise<void> {
    const ctx = ctxRef;
    if (!ctx) return;
    const run = registry.get(agentId);
    if (!run) {
      ctx.ui.notify(`agent_id "${agentId}" not found.`, "warning");
      return;
    }
    // Pre-check sendability BEFORE opening the input modal so the user
    // doesn't waste typing a message that will be rejected anyway.
    const check = validateSendable(run);
    if (!check.ok) {
      try {
        ctx.ui.notify(check.reason, "warning");
      } catch {
        // ctx may have gone stale
      }
      return;
    }
    let message: string | undefined;
    try {
      message = await ctx.ui.input(
        `Send to ${agentId}`,
        "Type a follow-up message; Esc to cancel.",
      );
    } catch {
      // Stale ctx or user dismissed — silently abort.
      return;
    }
    if (!message || !message.trim()) return;
    const cfg = loadConfig(cwd);
    const ov = cfg.personaOverrides[run.persona] ?? {};
    // Re-resolve the persona registry so a user-configured
    // `timeout_minutes` on the persona is honored.
    const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
    const persona = resolved.personas.get(run.persona);
    const timeoutMs = resolveTimeoutMs(persona, ov, cfg);
    const result = sendToRun(run, message, {
      registry,
      timeoutMs,
      onComplete: (r) => opts.pushCompletionNotification(r),
    });
    if (result.kind === "rejected") {
      try {
        ctx.ui.notify(result.reason, "warning");
      } catch {
        // ctx may have gone stale
      }
    }
  }

  let conductorModeOn = resolveInitialConductorMode(process.env);

  const opts = {
    getCwd: () => cwd,
    getRegistry: () => registry,
    getQueue: () => queue,
    getModel: () => focusModel,
    /**
     * Snapshot the parent conductor's conversation for inherit_context.
     * Walks the current session's tree from leaf to root via
     * buildSessionContext (handles compaction + branch summaries) and
     * returns the resolved AgentMessage[] the LLM would see.
     *
     * Defensive: returns [] when there's no live ctx (e.g. between
     * session_start and first turn) or when the sessionManager API
     * throws.
     */
    getParentMessages: (): AgentMessage[] => {
      try {
        const ctx = ctxRef;
        if (!ctx) return [];
        const sm = ctx.sessionManager;
        if (!sm) return [];
        const entries = sm.getEntries();
        const leafId = sm.getLeafId();
        const result = buildSessionContext(entries, leafId);
        return result.messages ?? [];
      } catch {
        return [];
      }
    },
    openFocusedOverlay,
    getConductorMode: () => conductorModeOn,
    setConductorMode: (on: boolean) => {
      conductorModeOn = on;
    },
    /**
     * One-shot detach slot for the active foreground spawn. Listens to
     * raw terminal input via ctx.ui.onTerminalInput (interactive mode
     * only) and intercepts a bare Esc keystroke, resolving the detach
     * signal. Esc is consumed (`{ consume: true }`) so pi's reserved
     * `app.interrupt` action doesn't also fire — i.e. Esc detaches
     * cleanly without killing. Pi tool calls run sequentially within an
     * assistant turn, so a single slot is enough.
     */
    registerForegroundDetach: () => {
      let resolveDetach: () => void = () => {};
      const detachSignal = new Promise<void>((res) => {
        resolveDetach = res;
      });
      // Wire the raw-input listener if a UI ctx is attached. In headless
      // contexts (e.g. RPC mode) the listener is a no-op and detach
      // simply never fires — the foreground spawn returns its summary
      // when the run completes, exactly as before.
      let unsubInput: (() => void) | null = null;
      const ctx = ctxRef;
      if (ctx && ctx.hasUI) {
        unsubInput = ctx.ui.onTerminalInput((data) => {
          // Don't hijack Esc when an overlay is open — the overlay's
          // own Esc-to-close binding takes priority.
          if (overlayOpen) return undefined;
          if (matchesKey(data, "escape")) {
            resolveDetach();
            return { consume: true };
          }
          return undefined;
        });
      }
      const unregister = () => {
        if (unsubInput) {
          unsubInput();
          unsubInput = null;
        }
        // Resolve the detach signal so any awaiters of the completed
        // branch unblock cleanly. Promise.race semantics make this
        // a no-op when the awaiter has already settled.
        resolveDetach();
      };
      return { detachSignal, unregister };
    },
    pushCompletionNotification: (run: Run) => {
      const text = formatCompletionNotification(run);
      pi.sendMessage(
        {
          customType: "ensemble-notification",
          content: text,
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    },
  };

  // ── Lifecycle ────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    ctxRef = ctx;
    if (widget) widget.dispose();
    widget = mountEnsembleWidget(registry, () => ctxRef);
    if (unsubFocusedShortcut) unsubFocusedShortcut();
    unsubFocusedShortcut = installFocusedOverlayShortcut(ctx, {
      openFocusedOverlay: () => openFocusedOverlay(),
      isOverlayOpen: () => overlayOpen,
    });
  });

  pi.on("session_shutdown", async () => {
    if (unsubFocusedShortcut) {
      unsubFocusedShortcut();
      unsubFocusedShortcut = null;
    }
    if (widget) {
      widget.dispose();
      widget = null;
    }
    // Best-effort: terminate everything still alive.
    for (const r of registry.list()) {
      if (r.status === "running" || r.status === "paused") {
        try {
          r.proc?.kill("SIGTERM");
        } catch {
          // already dead
        }
      }
    }
    ctxRef = null;
  });

  pi.on("turn_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    ctxRef = ctx;
    if (!widget) widget = mountEnsembleWidget(registry, () => ctxRef);
  });

  // Inject the conductor system prompt at every turn start when on.
  pi.on("before_agent_start", async (event) => {
    if (!conductorModeOn) return undefined;
    try {
      const cfg = loadConfig(cwd);
      queue.setMaxConcurrent(cfg.maxConcurrent);
      const resolved = await resolvePersonas({
        cwd,
        personaOverrides: cfg.personaOverrides,
      });
      const personas = [...resolved.personas.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );
      const addendum = buildConductorSystemPrompt({
        personas,
        maxConcurrent: cfg.maxConcurrent,
      });
      const merged = `${event.systemPrompt}\n\n${addendum}`;
      return { systemPrompt: merged };
    } catch {
      // never break the session if persona resolution fails
      return undefined;
    }
  });

  registerTools(pi, opts);
  registerCommands(pi, opts);
}
