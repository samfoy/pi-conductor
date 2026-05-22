/**
 * pi-conductor — Extension entry point.
 *
 * Wires up the conductor runtime: persona discovery+resolution
 * (builtin / user / project layers), the ensemble tools
 * (`ensemble_list` / `_status` / `_spawn` / `_send` / `_pause` /
 * `_resume` / `_focus`), the `/conductor …` slash commands, the
 * always-visible ensemble panel, the conductor system-prompt
 * addendum (on by default; `PI_CONDUCTOR_MODE=0|off` opts out;
 * `/conductor on|off` toggles per-session), `<sub-agent-completed>`
 * notification cards posted inline on terminal transitions, the
 * focused-stream overlay (Ctrl+G — routed via
 * `installFocusedOverlayShortcut`), Esc-to-detach for foreground
 * spawns (via `registerForegroundDetach`), foreground-spawn streaming
 * with throttle + post-detach completion listener, and the spawn
 * queue with foreground auto-downgrade at the concurrency cap.
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
import { forceTerminate, reconcileRecord, resolveTimeoutMs, runsRoot, sendToRun, validateSendable } from "./runs.ts";
import { maybeAutoRunGc } from "./gc/index.ts";
import {
  defaultLivenessProbe,
  reconcileOrphansAtStartup,
  type PostStartupReconcileResult,
} from "./reconcile-startup.ts";
import type { Run } from "./types.ts";
import { resolveInitialConductorMode } from "./conductor-mode.ts";
import { installCompactionHook } from "./compaction-hook.ts";
import { installSanitizerHook } from "./sanitizer-hook.ts";
import { handleSessionShutdown } from "./shutdown.ts";
import { Watchdog, resolveKillOnStall } from "./watchdog.ts";
import { formatStallNotification } from "./notifications.ts";
import { executePromptAndSend } from "./prompt-and-send.ts";

export default function (pi: ExtensionAPI): void {
  // ── Mutable session-scoped state ─────────────────────────────────────
  let cwd = process.cwd();
  let ctxRef: ExtensionContext | null = null;
  let widget: EnsembleWidget | null = null;

  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 4, 1);
  const focusModel = new FocusedStreamModel(registry);

  // Track whether an overlay is already open so multiple opens don't stack.
  let overlayOpen = false;
  // Slice 3 (overlay redesign): captured TUI ref so the registry
  // coalescer can call `tui.requestRender()`. `TUI` is reachable only
  // inside `custom`/`setWidget`/`setFooter` factory bodies; we stash
  // it the first time the overlay factory runs. Before the first
  // capture, `requestRender` is a no-op — which is correct, because
  // nothing is rendered yet either. The TUI instance is a
  // process-level singleton so capturing once is sufficient.
  let tuiRef: { requestRender: (force?: boolean) => void } | null = null;
  // Session-scoped unsub for the Ctrl+G focused-overlay shortcut.
  let unsubFocusedShortcut: (() => void) | null = null;

  // v0.9.x post-startup reconcile (slice 3): captured for slice 4's
  // doctor surface and `/conductor reconcile` slash subcommand to read.
  // Updated on every `session_start` after reconcile completes (best-
  // effort — stays `undefined` if reconcile threw).
  let lastReconcile: PostStartupReconcileResult | undefined;

  // v0.10 watchdog: detector + enforcer for sub-agent stalls. Lives
  // here as a session-scoped instance; restarted on session_start,
  // disposed on session_shutdown. See src/watchdog.ts (Slice 2).
  let watchdogDispose: (() => void) | null = null;

  // v0.8.2 (B-4) — toolUse.name sanitizer hook. Owns its own
  // session-scoped warned-set; we hold the handle to call reset() in
  // session_shutdown so a fresh session re-warns about pre-existing
  // wedges on its first turn. See src/sanitizer-hook.ts.
  const sanitizerHook = installSanitizerHook(pi, {
    getCtx: () => ctxRef,
  });

  // v0.8.1 Item 5 — context-inflation compaction. Older
  // `<sub-agent-completed>` envelopes (all but the most-recent
  // KEEP_RECENT_ENVELOPES=2) are rewritten to a `<result-summary>`
  // form on every context flush. The on-disk session JSONL stays full
  // fidelity; only the LLM-facing context is rewritten. See
  // src/compaction-hook.ts.
  installCompactionHook(pi);

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
        (tui, theme, _kb, done) => {
          tuiRef = tui;
          return createFocusedOverlayComponent({
            model: focusModel,
            registry,
            forceTerminate,
            promptAndSendToRun: (id: string) => {
              void promptAndSendToRun(id);
            },
            done,
            theme,
            // Slice 1 (overlay redesign): viewport-height source. `tui`
            // is in scope inside the factory body, so we use its
            // canonical `terminal.rows`. `process.stdout.rows` is the
            // non-TTY fallback. Constant 24 is the last-ditch default
            // matching the historical xterm row count and the design
            // doc §3 fallback chain.
            getViewportHeight: () =>
              tui.terminal.rows ?? process.stdout.rows ?? 24,
          });
        },
        {
          overlay: true,
          // Slice 1 (overlay redesign): anchored modal. Without these
          // options pi-tui sizes the overlay to the full terminal, and
          // tmux + small windows produced scroll-off-page renders.
          // 95×90 with a 1-cell margin gives the eye an obvious
          // "overlay" affordance; minWidth 60 prevents pathological
          // collapse if the user resizes mid-render. NO `visible:`
          // predicate — a `visible:false` would open then suppress and
          // swallow the shortcut-side notify; the threshold guard in
          // `installFocusedOverlayShortcut` is the single source of
          // truth for the 80×20 minimum.
          overlayOptions: {
            width: "95%",
            maxHeight: "90%",
            minWidth: 60,
            anchor: "center",
            margin: 1,
          },
        },
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
   *
   * Slice 7 (overlay redesign): accepts an optional `presuppliedText`.
   * When the focused-stream overlay's split-pane Editor submits, the
   * trimmed buffer is forwarded here and the `ctx.ui.input` modal is
   * skipped. All other steps (validateSendable, persona resolution,
   * resolveTimeoutMs, sendToRun + pushCompletionNotification,
   * rejection notify) are preserved verbatim.
   */
  async function promptAndSendToRun(
    agentId: string,
    presuppliedText?: string,
  ): Promise<void> {
    await executePromptAndSend(
      {
        getCtx: () => ctxRef,
        registry,
        cwd,
        validateSendable,
        loadConfig,
        resolvePersonas: (args) => resolvePersonas(args as any) as any,
        resolveTimeoutMs: (p, ov, cfg) =>
          resolveTimeoutMs(p as any, ov as any, cfg as any),
        sendToRun: (run, message, sendOpts) =>
          sendToRun(run, message, sendOpts) as any,
        pushCompletionNotification: (r: Run) => opts.pushCompletionNotification(r),
      },
      agentId,
      presuppliedText,
    );
  }

  // v0.8: conductor mode defaults to OFF; users opt in via
  // `defaultMode: "on"` in config, `PI_CONDUCTOR_MODE=1` in env, or
  // `/conductor on` per-session. Reading config at extension load
  // (rather than session_start) is fine for the initial value — the
  // user's pinned default doesn't change between session_starts.
  const initialCfg = loadConfig(cwd);
  let conductorModeOn = resolveInitialConductorMode(process.env, {
    defaultMode: initialCfg.defaultMode,
  });

  const opts = {
    getCwd: () => cwd,
    getRegistry: () => registry,
    getQueue: () => queue,
    getModel: () => focusModel,
    /**
     * v0.9.x Slice 4: expose the most-recent post-startup reconcile
     * result so /conductor doctor surfaces it under "## Post-startup
     * reconcile". Stays undefined until session_start finishes its
     * reconcile pass.
     */
    getLastReconcile: () => lastReconcile,
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
     * Slice 7: read the host's current Theme so the foreground stream
     * can colour its rendered transcript. Returns undefined in headless
     * contexts and between session_start cycles — the renderer falls
     * back to plain output in that case.
     */
    getTheme: () => ctxRef?.ui.theme,
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
    widget = mountEnsembleWidget(registry, () => ctxRef, () => {
      // v0.10 Slice 4: feed live watchdog thresholds to the widget so it
      // can render `· STALLED Ns` glyphs that respect per-cwd config.
      const cfg = loadConfig(cwd);
      return {
        softThresholdSeconds: cfg.watchdog.defaultSoftSeconds,
        hardThresholdSeconds: cfg.watchdog.defaultHardSeconds,
        graceSeconds: cfg.watchdog.graceSeconds,
      };
    });
    if (unsubFocusedShortcut) unsubFocusedShortcut();
    unsubFocusedShortcut = installFocusedOverlayShortcut(ctx, {
      openFocusedOverlay: () => openFocusedOverlay(),
      isOverlayOpen: () => overlayOpen,
      // Slice 11 + Slice 3: keep the focus model fresh as the registry
      // mutates AND coalesce the resulting render requests through the
      // shortcut-owned RerenderCoalescer. The `scheduleRender` arg is
      // the coalescer's `schedule()`; production calls it after
      // `focusModel.refresh()` so the model is up to date when the
      // (coalesced) `tui.requestRender()` lands. Lives here
      // (session-scoped) rather than in the overlay factory (per-open)
      // so re-opening the overlay does NOT stack listeners.
      subscribeToRegistry: (scheduleRender) =>
        registry.onChange(() => {
          focusModel.refresh();
          scheduleRender();
        }),
      // Slice 3 (overlay redesign): trigger pi-tui's render scheduler
      // when the coalescer's leading/trailing edges fire. Before the
      // overlay has ever opened (and thus before `tuiRef` is captured)
      // this is a no-op, which is correct — nothing is rendered yet.
      requestRender: () => tuiRef?.requestRender(),
      // Slice 1 (overlay redesign): terminal-size source for the
      // too-small guard. `ExtensionUIContext` does not expose a TUI
      // ref outside `custom`/`setWidget` factory bodies, so we read
      // `process.stdout` here. The threshold (80×20) and notify text
      // live inside the helper.
      getTerminalSize: () => ({
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
      }),
      notify: (message, level) => ctx.ui.notify(message, level),
    });

    // v0.9.x post-startup reconcile (slice 3): walks runs/*\/record.json,
    // re-adopts live `running` records and reclassifies dead orphans
    // BEFORE the v0.9 GC pass so reclassified records are visible to
    // GC's age/budget rules rather than the orphan-TTL fallback.
    // Per design §4: separate setImmediate, fired ahead of GC's
    // setImmediate. Failure here MUST NOT block session bootstrap.
    setImmediate(() => {
      void reconcileOrphansAtStartup({
        runsRoot: runsRoot(),
        registry,
        isAlive: defaultLivenessProbe,
        now: Date.now(),
      })
        .then((result) => {
          lastReconcile = result;
        })
        .catch((err: unknown) => {
          // Best-effort: never let reconcile break session bootstrap.
          console.error(
            `reconcile-startup: failed: ${(err as Error)?.message ?? String(err)}`,
          );
        });
    });

    // v0.9 Slice 5: auto-trigger GC on session_start, debounced + fire-
    // and-forget. Bootstrap MUST NOT block on disk I/O — the orphan
    // sweep + reclaim runs on the next event-loop tick. Per oracle R11
    // the marker lives at <conductorRoot>/.last-gc, NOT under runs/.
    setImmediate(() => {
      const cfg = loadConfig(cwd);
      void maybeAutoRunGc({
        runsRoot: runsRoot(),
        config: cfg.gc,
        registry,
      }).catch((err: unknown) => {
        // Best-effort: never let GC break session bootstrap.
        console.error(`gc auto: failed: ${(err as Error)?.message ?? String(err)}`);
      });
    });

    // v0.10 Slice 2: start the watchdog. Subscribes to registry +
    // ticks every 30s; escalates hard-stalls to forceTerminate when
    // the spawn carries kill_on_stall (slice 3 plumbs per-spawn
    // overrides; until then we read the conductor-wide default).
    if (watchdogDispose) {
      watchdogDispose();
      watchdogDispose = null;
    }
    {
      const cfg = loadConfig(cwd);
      const wd = new Watchdog({
        registry,
        config: {
          softThresholdSeconds: cfg.watchdog.defaultSoftSeconds,
          hardThresholdSeconds: cfg.watchdog.defaultHardSeconds,
          graceSeconds: cfg.watchdog.graceSeconds,
        },
        tickIntervalMs: cfg.watchdog.tickIntervalSeconds * 1000,
        log: {
          warn: (msg, data) => {
            // Surface stall advisories as `<sub-agent-stalled>` cards
            // in the parent's conversation. The advisory is
            // followUp-style (no triggerTurn) so it doesn't yank the
            // user mid-edit; the parent LLM sees it on its next turn.
            const meta = data as
              | { agentId?: string; severity?: "soft" | "hard"; silentSeconds?: number }
              | undefined;
            const run = meta?.agentId ? registry.get(meta.agentId) : undefined;
            if (run && meta?.severity && typeof meta.silentSeconds === "number") {
              const thresholdSeconds =
                meta.severity === "hard"
                  ? cfg.watchdog.defaultHardSeconds
                  : cfg.watchdog.defaultSoftSeconds;
              const text = formatStallNotification(run, {
                severity: meta.severity,
                silentSeconds: meta.silentSeconds,
                thresholdSeconds,
              });
              try {
                pi.sendMessage(
                  {
                    customType: "ensemble-notification",
                    content: text,
                    display: true,
                  },
                  { triggerTurn: false, deliverAs: "followUp" },
                );
              } catch (err) {
                // Best-effort. Fall back to console so the warn isn't lost.
                console.error(`watchdog: ${msg}`);
                void err;
              }
            } else {
              console.error(`watchdog: ${msg}`);
            }
          },
          info: (msg) => {
            // Recovery / A2 abort: log only. No envelope so we don't
            // spam the conversation with "recovered" lines for runs
            // that came back on their own.
            console.error(`watchdog: ${msg}`);
          },
        },
        now: () => Date.now(),
        kill: (run, reason) => {
          forceTerminate(run, reason, registry);
        },
        // v0.10 Slice 3: per-run `kill_on_stall` overrides the
        // conductor-wide default. The lambda delegates to
        // `resolveKillOnStall` (exported, witness-pinned by
        // `tests/watchdog-enforcer.test.ts`) so a regression in the
        // formula is caught by the W1 mutation witness.
        isKillOnStall: (run) => resolveKillOnStall(run, cfg.watchdog.defaultKillOnStall),
        isEnabled: () => cfg.watchdog.enabled,
      });
      watchdogDispose = wd.start();
    }
  });

  pi.on("session_shutdown", async (event) => {
    if (unsubFocusedShortcut) {
      unsubFocusedShortcut();
      unsubFocusedShortcut = null;
    }
    if (widget) {
      widget.dispose();
      widget = null;
    }
    // v0.10: dispose the watchdog. Same lifecycle as the focused-overlay
    // shortcut: re-armed on next session_start.
    if (watchdogDispose) {
      watchdogDispose();
      watchdogDispose = null;
    }
    // Reason-aware tear-down. On `/reload` (reason === "reload") the
    // host re-imports dist/index.js while preserving chat + scratchpad +
    // brief; killing in-flight children would defeat the whole point of
    // a developer hot-reload loop. On any other reason (quit, new,
    // resume, fork) we SIGTERM running/paused sub-agents and reset the
    // sanitizer warning dedup set so a fresh session re-warns about
    // pre-existing wedges. See src/shutdown.ts for the rationale and
    // the unit tests in tests/shutdown.test.ts for the invariants.
    handleSessionShutdown(event, {
      runs: registry.list(),
      resetSanitizer: () => sanitizerHook.reset(),
      // A1: close the orphan-creation window. SIGTERM races the runtime
      // teardown; without this the on-disk record stays "running" until
      // the next session_start runs the GC orphan sweep.
      reconcileRunning: (runs, reason) => {
        const now = Date.now();
        for (const r of runs) {
          void reconcileRecord(r, "killed", `shutdown: ${reason}`, now);
        }
      },
    });
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
      queue.setMaxConcurrentWriteCapable(cfg.maxConcurrentWriteCapable);
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

  // v0.8.2 (B-4) sanitizer hook is installed above (search for
  // installSanitizerHook). Wiring is intentionally co-located with the
  // session-scoped state declaration so its `reset()` handle is captured
  // before any of pi's lifecycle events can fire.

  registerTools(pi, opts);
  registerCommands(pi, opts);
}
