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
import { registerCommands } from "./commands.ts";
import { registerTools } from "./tools.ts";
import { RunRegistry } from "./runs.ts";
import { SpawnQueue } from "./queue.ts";
import { mountEnsembleWidget, type EnsembleWidget } from "./widget.ts";
import { formatCompletionNotification } from "./notifications.ts";
import { buildConductorSystemPrompt } from "./conductor-prompt.ts";
import { resolvePersonas } from "./personas.ts";
import { loadConfig } from "./config.ts";
import type { Run } from "./types.ts";

export default function (pi: ExtensionAPI): void {
  // ── Mutable session-scoped state ─────────────────────────────────────
  let cwd = process.cwd();
  let ctxRef: ExtensionContext | null = null;
  let widget: EnsembleWidget | null = null;

  const registry = new RunRegistry();
  // Initial queue uses a sane default; the per-cwd cap is read at spawn time
  // and the queue.setMaxConcurrent is updated whenever loadConfig surfaces a
  // different value (we re-read inside the `before_agent_start` hook below).
  const queue = new SpawnQueue(registry, 4);

  let conductorModeOn =
    process.env.PI_CONDUCTOR_MODE === "1" ||
    process.env.PI_CONDUCTOR_MODE?.toLowerCase() === "true";

  const opts = {
    getCwd: () => cwd,
    getRegistry: () => registry,
    getQueue: () => queue,
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
}
