/**
 * pi-conductor — Extension entry point.
 *
 * v0.2 (foreground spawn, background spawn, queue, panel, conductor mode):
 *   - persona discovery + resolution (builtin / user / project layering)
 *   - tools: ensemble_list, ensemble_status, ensemble_spawn
 *   - slash commands: /conductor list | show | doctor | on | off | status |
 *                     stop | pause | resume | queue
 *   - ensemble panel (always visible when ≥1 sub-agent active or recently done)
 *   - conductor system prompt addendum, gated on PI_CONDUCTOR_MODE=1
 *     (env var) or `/conductor on` (toggled per session)
 *   - <sub-agent-completed> notification cards posted inline on completion
 *
 * v0.3 will add the focused stream overlay (Ctrl+G).
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
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
import { FocusedStreamOverlay } from "./focused-stream-overlay.ts";
import { forceTerminate, resolveTimeoutMs, sendToRun } from "./runs.ts";
import type { Run } from "./types.ts";

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
        (_tui, _theme, _kb, done) => {
          const overlay = new FocusedStreamOverlay({
            model: focusModel,
            onClose: () => done(undefined),
            onKill: (id: string) => {
              const run = registry.get(id);
              if (run) forceTerminate(run, "killed", registry);
              // Refresh the model so the next render reflects the kill.
              focusModel.refresh();
            },
            onSend: (id: string) => {
              void promptAndSendToRun(id);
            },
          });
          // Re-render whenever a registered run changes state so the live
          // transcript stays current.
          const unsub = registry.onChange(() => {
            // The custom() factory exposes its TUI handle implicitly; the
            // overlay's own invalidate hooks plus the request-render plumbing
            // wired into Component is sufficient here. We keep the listener
            // registered for the lifetime of the overlay and dispose on close.
            void unsub;
          });
          return overlay;
        },
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

  let conductorModeOn =
    process.env.PI_CONDUCTOR_MODE === "1" ||
    process.env.PI_CONDUCTOR_MODE?.toLowerCase() === "true";

  const opts = {
    getCwd: () => cwd,
    getRegistry: () => registry,
    getQueue: () => queue,
    getModel: () => focusModel,
    openFocusedOverlay,
    getConductorMode: () => conductorModeOn,
    setConductorMode: (on: boolean) => {
      conductorModeOn = on;
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
  });

  pi.on("session_shutdown", async () => {
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

  // Bind Ctrl+G to open the focused-stream overlay on the most recently
  // active sub-agent (or no-op when no sub-agents exist).
  pi.registerShortcut(Key.ctrl("g"), {
    description: "pi-conductor: open focused-stream overlay",
    handler: () => {
      openFocusedOverlay();
    },
  });
}
