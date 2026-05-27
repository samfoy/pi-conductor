# pi-conductor runtime: architecture and UX surfaces

Audience: a future maintainer (likely the author) who wants to modify the
runtime or improve its UX. Not a user-facing introduction. For that, see
`README.md`. For product framing and locked decisions, see `PRD.md`.

HEAD at the time of writing: `876f421`. Current shipped version: v0.10
(see `AGENTS.md:36`).

## 1. Overview

The runtime is the delivery vehicle for the persona library and the
witness-driven-development methodology described in `docs/wdd.md`. Most
of what the parent conductor LLM "feels" — strict-overseer mode, the
ensemble panel, the `<sub-agent-completed>` envelope, the focused-stream
overlay — exists to make it cheap for the conductor to delegate work
without losing track of it.

The runtime owns six concerns:

| Concern              | Owner module(s)                              |
| -------------------- | -------------------------------------------- |
| Persona resolution   | `src/personas.ts`, `src/config.ts`           |
| Spawn lifecycle      | `src/runs.ts`, `src/queue.ts`, `src/tools.ts`|
| Event ingestion      | `src/event-handler.ts`, `src/runs.ts`        |
| Observability (UX)   | `src/widget.ts`, `src/transcript.ts`, `src/foreground-stream.ts`, `src/focused-stream-overlay.ts`, `src/notifications.ts` |
| Stall detection      | `src/watchdog.ts`                            |
| Garbage collection   | `src/gc/`                                    |

Two cross-cutting context-rewriters:

- `src/sanitizer-hook.ts` repairs malformed `toolUse.name` entries so a
  reload doesn't wedge on an old session.
- `src/compaction-hook.ts` rewrites older `<sub-agent-completed>`
  bodies to a `<result-summary>` form on context flush.

Non-goals (per `PRD.md` "Non-goals"): the runtime does not gate tool
access, manage worktrees, build TODO DAGs, or nest coordinators. These
are documented as deliberate omissions, not gaps.

## 2. Module map

For each module: path, one-sentence purpose, key exports, callers, and
any tread-carefully notes.

### `src/index.ts`

The wiring map. Activates the extension and assembles every other
module against pi's lifecycle hooks (`session_start`, `session_shutdown`,
`turn_start`, `before_agent_start`).

- Allocates the session-scoped `RunRegistry`, `SpawnQueue`, and
  `FocusedStreamModel`.
- Mounts the ensemble widget and re-mounts on `session_start`.
- Installs the Ctrl+G shortcut (`installFocusedOverlayShortcut`).
- Spawns the watchdog and disposes it on shutdown.
- Wires the `Esc`-to-detach raw-input listener (one-shot per foreground
  spawn, see `registerForegroundDetach` at `src/index.ts:235`).
- Owns `pushCompletionNotification` (the `pi.sendMessage` envelope
  push) and `getParentMessages` (the `buildSessionContext` snapshot).

Tread carefully: the comment at `src/index.ts:84` is load-bearing — pi
reserves `Esc` and `Ctrl+G`, so neither is registered via
`pi.registerShortcut`; both go through `ctx.ui.onTerminalInput` with
`{ consume: true }`.

### `src/runs.ts`

The spawn pipeline. The single largest module (1316 LOC); skim by
section.

- `RunRegistry` (`runs.ts:566`) — `Map<id, Run>` with a `notify`
  fan-out. Listeners installed by widget, queue, watchdog, foreground
  stream, focus model, and the per-spawn completion-listener pushed
  by `tools.ts`.
- `spawnRun(opts)` (`runs.ts:683`) — creates the `Run`, registers it,
  writes `record.json`, calls `planSpawnPiArgs`, then `runPiSubprocess`.
- `runPiSubprocess` (`runs.ts:778`, internal) — spawns `pi --mode json
  -p`, attaches the line buffer + state machine, sets the hard-timeout
  timer, owns the `finalize` closure.
- `sendToRun` (`runs.ts:1023`) — resume path. Pi-args via
  `buildResumePiArgs`; same `runPiSubprocess` plumbing.
- `forceTerminate` (`runs.ts:1132`) — SIGTERM with 2s SIGKILL chase,
  registry notify, persistence, optional `onComplete`. Only
  externally-driven terminal path; the close-handler path is
  `applyCloseHandlerTerminal`.
- `applyCloseHandlerTerminal` (`runs.ts:1100`) — terminal flip from the
  subprocess close handler. Returns `false` if `forceTerminate` already
  raced ahead; `finalize` consults this return value to decide whether
  to skip duplicate notify/persist/onComplete (see the comment at
  `runs.ts:817`). **This race-fix is the most subtle thing in the
  module.** Touching either half without re-reading the comment block
  in `finalize` is how regressions land.
- `applySubstanceCheck` (`runs.ts:1123`) — v0.8.1 Item 4, attaches
  `run.nonSubstantiveFinal` for completion notifications.
- `discoverSessionPathIfMissing` (`runs.ts:163`) — looks up pi's
  generated session JSONL on the close path so a force-killed
  sub-agent stays resumable via `ensemble_send`.
- `pauseRun` / `resumeRun` (`runs.ts:1196` / `1215`) — `SIGSTOP` /
  `SIGCONT`. Default signaller is `process.kill`; override is for
  unit tests.

Callers: `src/queue.ts`, `src/tools.ts`, `src/commands.ts`,
`src/index.ts`, `src/watchdog.ts` (kill path), `src/gc/` (read-only,
via `runsRoot`).

### `src/event-handler.ts`

The pure state machine. Maps a parsed pi event to a `Run` mutation +
`EventEffect` (`none` | `updated` | `finalize`).

- `applyEvent(run, event)` (`event-handler.ts:36`) — single seam
  between the wire protocol and run state. No I/O, no registry, no
  fs.
- Recognized events: `agent_end` (terminal), `turn_end` (terminal iff
  no toolCall and stopReason isn't error/aborted), `message_end`,
  `tool_result_end`. All others return `none`.
- **`run.lastEventAt` is updated on `message_end` and
  `tool_result_end` only** (`event-handler.ts:64`, `:97`); not on
  in-flight `message_update`. This is the watchdog's silence signal.

Callers: `runs.ts:processLine` (the I/O wrapper).

### `src/queue.ts`

FIFO concurrency cap. Two independent caps: `maxConcurrent` (default
4) and `maxConcurrentWriteCapable` (default 1, applies to `builder` /
`simplifier`).

- `enqueueOrSpawn` (`queue.ts:96`) — spawns now, or enqueues with a
  pre-allocated id and a `Run { status: "queued" }` placeholder so the
  widget shows the queued sub-agent immediately.
- Foreground spawns are auto-downgraded to `background` on enqueue
  (`effectiveMode` field). The LLM-facing tool-result text says
  `queued-as-background` (`tools.ts:317`).
- `drain` (`queue.ts:170`) is idempotent and walks pending in FIFO
  order; a blocked write-capable entry does not block a later
  read-only entry, since the two caps are independent.
- Subscribed to `registry.onChange` at construction so any terminal
  flip drains pending.

Callers: `src/tools.ts:ensemble_spawn`. Single caller.

### `src/watchdog.ts`

The v0.10 stall detector + enforcer (slice 1: pure detector; slice 2:
ticker + kill path; slice 3: per-spawn config; slice 4: widget glyph).
Reference: `docs/v0.10-watchdog-design.md` §1, §4.

- `evaluateRun(run, prevState, config, now)` (`watchdog.ts:108`) —
  pure detector. Returns `{ transition, nextState }`.
- `Watchdog` class (`watchdog.ts:342`) — the enforcer. Subscribes to
  `registry.onChange` plus a 30s `setInterval`; calls
  `forceTerminate(run, "stalled", ...)` when state transitions to
  `hard` and `resolveKillOnStall(run, default)` is true.
- `effectiveConfig(run, defaults)` (`watchdog.ts:243`) — applies the
  per-spawn `softStallSeconds` override; the hard threshold scales at
  the same `defaultHardSeconds / defaultSoftSeconds` ratio.
- `classifyStall(run, now, cfg)` (`watchdog.ts:297`) — pure render-
  helper for the widget's `· STALLED Ns` glyph.
- `resolveKillOnStall(run, default)` (`watchdog.ts:275`) — exported so
  `tests/watchdog-enforcer.test.ts` can pin the precedence formula
  with a mutation witness (W1 in the slice-3 critic).

Callers: `src/index.ts` (lifecycle), `src/widget.ts` (glyph),
`src/commands.ts` (status command).

### `src/widget.ts`

Always-on ensemble panel rendered `belowEditor`. One row per active
or recently-finished run.

- `mountEnsembleWidget(registry, getCtx, getWatchdogConfig?)`
  (`widget.ts:36`) — subscribes to `registry.onChange`, manages an 8s
  linger window for finished rows (`FINISHED_LINGER_MS`), schedules
  re-renders for linger expiry.
- `formatStallSegment` (`widget.ts:152`) — exported pure helper for
  the `· STALLED Ns` / `· STALLED Ns!` segment, witness-pinned.
- Hides itself when there are zero active and zero linger rows
  (`widget.ts:60`).

Callers: `src/index.ts` only.

### `src/foreground-stream.ts`

Pure helpers for the inline-streamed foreground spawn.

- `renderForegroundStream(run, width, theme?)` — the multi-line text
  pi displays in the parent's tool-call card while a foreground sub-
  agent runs. Tail-truncates at `STREAM_MAX_CHARS` (32 KB) so a long
  transcript doesn't melt the TUI.
- `renderForegroundSummary(run)` — the compact post-completion summary
  returned as the tool result.
- `awaitOrDetach(done, detach)` — `Promise.race` with a tagged outcome
  (`completed` | `detached`).
- `createUpdateThrottle(fire, opts)` — leading + trailing-edge
  debouncer; `pushImmediate` bypasses the trailing edge for high-
  priority events (new tool result), `flush()` is called on terminal.
- `installPostDetachCompletionListener(run, registry, push)` — wires
  the `<sub-agent-completed>` envelope after Esc-to-detach. Has a
  microtask race-guard for the case where the run reached terminal
  between the detach race resolving and the listener installing.

Callers: `src/tools.ts:ensemble_spawn` (foreground branch).

### `src/commands.ts`

The `/conductor` slash command. Single command, dispatched via a
switch on the first whitespace token.

- `registerCommands(pi, opts)` (`commands.ts:76`) — installs the
  command and its argument-completion provider.
- Subcommands handled: `list`, `show`, `doctor`, `on`, `off`, `status`,
  `stop`, `pause`, `resume`, `queue`, `focus`, `history`, `pin`,
  `unpin`, `watchdog`. (See section 6 for the full inventory.)
- `runGcCmd` (`commands.ts:691`) — exported and fully implemented.

**Tread carefully:** `gc` appears in `SUBCOMMANDS` (`commands.ts:72`)
and in `GC_HELP_TEXT` (`commands.ts:538`), but the switch in
`registerCommands` does **not** dispatch it — `case "gc":` is missing.
A user typing `/conductor gc` falls through to the `unknown
subcommand` default. The command is fully tested via direct calls to
`runGcCmd` in `tests/commands-gc.test.ts`. Verified at HEAD `876f421`.
This is a real bug; flagged in `Out-of-band notes`.

### `src/personas.ts`

Persona file loader. Builtin (`personas/`) < user
(`~/.pi/agent/conductor/personas/`) < project
(`<cwd>/.pi/conductor/personas/`). No other discovery paths (locked
in `PRD.md`).

- `resolvePersonas` (`personas.ts:327`) — composes the three layers,
  records shadowed entries for `/conductor doctor`, returns
  `PersonaResolution`.
- `parseFrontmatter` (`personas.ts:111`) — hand-rolled YAML-ish parser
  to avoid a runtime dependency.
- `WRITE_CAPABLE_PERSONAS = { "builder", "simplifier" }`
  (`personas.ts:43`) — the set the queue checks against. **The
  harness owns this set; persona frontmatter does not opt in/out.**

Callers: `src/index.ts:before_agent_start`, `src/tools.ts`,
`src/commands.ts`.

### `src/transcript.ts`

Pure renderer for the focused-stream overlay (and reused by
`foreground-stream.ts`).

- `renderHeader(run, width)` — top ruler + status line (with
  watchdog-aware activity segment).
- `renderTranscript(run, opts)` — body. Honors `collapseToolCalls`
  and `showThinking`.
- `deriveActivity(run, now)` (`transcript.ts:86`) — single-segment
  activity descriptor; width-discipline order-of-precedence pinned in
  tests.

Callers: `src/foreground-stream.ts`, `src/focused-stream-overlay.ts`.

### `src/gc/`

v0.9 garbage collector. Read-only review here; design lives in
`docs/v0.9-gc-design.md`.

- `gc/index.ts:runGc` — orchestrator (inventory → plan → reconcile →
  execute).
- `gc/policy.ts:planReclaim` — pure planning.
- `gc/executor.ts:executeReclaim` — disk mutation, two-gate safety
  (active id set + record-read recheck).
- `gc/inventory.ts`, `gc/reconcile.ts`, `gc/last-gc.ts`,
  `gc/pinning.ts`, `gc/id-reuse.ts` — supporting.
- `maybeAutoRunGc` is fired from `session_start` via `setImmediate`
  so bootstrap never blocks on disk I/O (`src/index.ts:316`).

Callers: `src/index.ts`, `src/commands.ts:runGcCmd`.

### `src/notifications.ts`

Pure formatters for the two envelopes the runtime emits.

- `formatCompletionNotification(run)` — `<sub-agent-completed>` body.
  Markdown header + fenced XML block. Embeds `<error>`, `<warning>`
  (substance-check), and `<result>` when present.
- `formatCompletionNotificationCompact(run)` — same, with `<result>`
  rewritten to `<result-summary>` (≤ 200 chars). Used by tests; the
  live runtime emits full envelopes and lets the compaction hook
  rewrite older ones at context flush.
- `formatStallNotification(run, args)` — `<sub-agent-stalled>` body
  for the watchdog soft/hard advisories.

Callers: `src/index.ts` only (via `pushCompletionNotification` and
the watchdog log adapter).

## 3. Lifecycle

A single sub-agent's path from `ensemble_spawn` to terminal record.
File:line references throughout.

```
ensemble_spawn (LLM)
  └─ tools.ts:execute (validate, resolve persona)
      └─ queue.enqueueOrSpawn
          ├─ canSpawnNow → spawnRun
          └─ else        → enqueue + queued placeholder Run

spawnRun (runs.ts:683)
  ├─ allocate id, mkdir runDir
  ├─ build Run, registry.register, writeRecord
  ├─ buildSubAgentPrompt + planSpawnPiArgs (seeds session if inherit_context)
  └─ runPiSubprocess
      ├─ child_process.spawn  (pi --mode json -p ...)
      ├─ start hard-timeout timer
      ├─ stdout: line-buffer → processLine → applyEvent
      │     ├─ updated   → registry.notify, onUpdate?(run)
      │     └─ finalize  → finalize(status, exitCode)
      ├─ stderr: collect into `stderr` buffer
      ├─ close: finalize(completed|failed)
      └─ error: finalize(failed)

finalize (runs.ts:817, internal)
  ├─ clearTimeout
  ├─ applyCloseHandlerTerminal → if false, forceTerminate already won
  │   ├─ true:  applySubstanceCheck, discoverSessionPath, notify,
  │   │         writeRecord+writeFinal, then onComplete
  │   └─ false: discoverSessionPath, kill handle, resolve `done`
  └─ resolve `done`

(LLM, later) onComplete fires:
  └─ pushCompletionNotification(run)        index.ts:274
      └─ pi.sendMessage(envelope, { triggerTurn: true, deliverAs: "followUp" })
```

Foreground branch divergence (`tools.ts:333`):

- A throttled `onUpdate` is wired so the parent's tool-call card
  shows `renderForegroundStream(run, width, theme)` on every coalesced
  event.
- A `pushImmediate` bypass fires on each new `toolResult` so the
  `↳ ✓/✗` outcome glyph isn't held back by the trailing edge.
- The await is `awaitOrDetach(done, detach.detachSignal)`. On
  `detached`, `installPostDetachCompletionListener` keeps the
  envelope path alive; the tool returns
  `renderForegroundDetachedResult(run)` (a `queued-as-background`-
  shaped result so the LLM doesn't re-spawn).
- Throttle is `flush()`ed on terminal so the final frame is visible
  before the card collapses to `renderForegroundSummary(run)`.

The `<sub-agent-completed>` envelope is what wakes the parent. It is
posted via `pi.sendMessage` with `triggerTurn: true`, `deliverAs:
"followUp"`. The conductor's next turn sees the envelope as a
followup user message and reads the `<result>`, `<warning>`, or
`<error>` block. Older envelopes are rewritten to `<result-summary>`
form on context flush by `installCompactionHook`.

Foreground vs background only diverge in how the tool result is
delivered — the underlying subprocess and event handling are
identical. Foreground returns `renderForegroundSummary` synchronously
to the LLM; background returns `running: <id>` immediately and lets
the envelope arrive later.

## 4. Event flow

Adding a new derived field on `Run`, or hooking a new observer, is a
4-step exercise.

```
pi subprocess (json mode)
  │ writes one JSON event per line on stdout
  ▼
runs.ts:processLine               (I/O wrapper: line split + transcript append)
  │
  ▼
event-handler.ts:applyEvent       (PURE state machine, mutates run)
  │
  ├─ kind="finalize"  → runs.ts:finalize → registry.notify + writeRecord/Final
  └─ kind="updated"   → registry.notify + onUpdate?(run)

registry.onChange listeners (registered by):
  - widget.ts:mountEnsembleWidget
  - queue.ts:SpawnQueue ctor (drains pending)
  - watchdog.ts:Watchdog.start (state Map + tick coordination)
  - foreground-stream throttle wiring (tools.ts:347)
  - focused-overlay-shortcut (subscribeToRegistry → focusModel.refresh)
  - per-spawn one-shot completion listener (tools.ts:303 for queued
    spawns; foreground-stream's installPostDetachCompletionListener
    for detached spawns)
```

Key invariants:

- `lastEventAt` updates only on `message_end` and `tool_result_end`
  (`event-handler.ts:64, :97`), not on in-flight `message_update`.
  This is the watchdog's silence signal — moving it would change
  stall semantics.
- `applyEvent` is pure. No I/O, no registry calls, no fs. The single
  seam between wire protocol and state. Adding a new event type:
  edit `applyEvent` only; let `processLine` discover it via the
  effect.
- `RunRegistry.notify` swallows listener errors (`runs.ts:625`).
  Listener authors do not need to defensively catch.

To add a new derived field on `Run`:

1. Add the field to the `Run` interface in `src/types.ts`.
2. Initialize it in `spawnRun` (`runs.ts:688`) and the queue
   placeholder (`queue.ts:120`).
3. Mutate it from `applyEvent` (or from an external source like the
   watchdog).
4. Render it from the appropriate observer (widget, transcript,
   notifications). Pin with a unit test on the renderer.

## 5. Configuration cascade

Two cascades. Both follow per-call > project > user > built-in
default, with persona-frontmatter slotted between persona-override
and built-in-default for some fields.

### Spawn options (`timeout_minutes`, `kill_on_stall`,
`stall_threshold_seconds`)

Resolution at `tools.ts:ensemble_spawn`:

1. **Per-call tool arg** (`params.timeout_minutes`,
   `params.kill_on_stall`, `params.stall_threshold_seconds`).
2. **Project config persona override**
   (`<cwd>/.pi/conductor.json:personaOverrides[<name>].timeoutMinutes`).
3. **User config persona override**
   (`~/.pi/agent/extensions/conductor/config.json:personaOverrides[<name>]`).
4. **Persona frontmatter** (`Persona.timeoutMinutes` from
   `personas/<name>.md`). Read by `resolveTimeoutMs`
   (`runs.ts:103`).
5. **Built-in default** (`DEFAULT_CONFIG.defaultTimeoutMinutes`).

Watchdog overrides (`kill_on_stall`, `stall_threshold_seconds`) skip
the persona-frontmatter layer at HEAD — frontmatter does not yet
declare watchdog fields. Deferred at slice 3; see
`docs/backlog.md`. Today: per-call > config > built-in
default only.

### `defaultMode` (whether conductor mode is on at session start)

Resolution at `conductor-mode.ts:resolveInitialConductorMode`:

1. **Project config** (`<cwd>/.pi/conductor.json:defaultMode`)
2. **User config**
   (`~/.pi/agent/extensions/conductor/config.json:defaultMode`)
3. **`PI_CONDUCTOR_MODE` env var**
4. **Built-in default = `"off"`**

Note: project + user are merged before the resolver runs, so the
resolver sees a single `defaultMode` value — they are effectively one
layer at the call site. The env var and built-in default are the
remaining layers. **Three layers in practice, not four.** Section 7
flags this as a candidate for simplification.

`/conductor on` and `/conductor off` flip a session-scoped flag at
runtime (`opts.setConductorMode`); they do not persist.

## 6. UX surfaces inventory

Every user-visible surface the runtime emits, with honest annotations.
Maintenance status is calibrated against the analyst-l6mi finding from
2026-05-20: roughly 30% of the runtime's observability is load-
bearing; roughly 10% is speculative. The user has personally exercised
the load-bearing surfaces this session.

### 1. Ensemble panel widget

- **What it shows.** One row per active or recently-finished run:
  status glyph, persona:id, elapsed, last tool-call hint, optional
  `· STALLED Ns` segment, usage. 8 s linger window after terminal.
- **Where.** `src/widget.ts:36`. Mounted from `src/index.ts:288, :467`.
- **Status.** Load-bearing. Persistent peripheral awareness of what's
  in flight; observed in active use.
- **Improvement candidates.** The linger window (8 s, hardcoded
  `FINISHED_LINGER_MS`) might benefit from being config-driven for
  long-running terminal-heavy chains.

### 2. Inline foreground tool-call streaming

- **What it shows.** The sub-agent's transcript, throttled, rendered
  inside the parent's tool-call card. Header + body via
  `renderForegroundStream`.
- **Where.** `src/foreground-stream.ts:67`, wired in
  `src/tools.ts:333`.
- **Status.** Load-bearing. The conductor's primary signal for
  whether to detach or wait.
- **Improvement candidates.** `STREAM_MAX_CHARS = 32 KB` tail-
  truncation is silent; consider a one-line ruler ("…earlier output
  truncated") at the truncation boundary so the operator knows.

### 3. Focused-stream overlay (Ctrl+G)

- **What it shows.** Full-screen drilldown on a single sub-agent.
  Header + transcript + key-hint footer (`Esc` close, `Tab` cycle,
  `↑↓` scroll, `s` send, `c` collapse, `t` thinking, `k` kill).
- **Where.** `src/focused-stream-overlay.ts`,
  `src/focused-overlay-shortcut.ts`. Bindings in `FOOTER_BINDINGS`
  (`focused-stream-overlay.ts:136`).
- **Status.** Load-bearing.
- **Improvement candidates.** The `s` (send) binding mirrors
  `ensemble_send`; verify whether keyboard-driven sends are used
  enough to justify the prompt detour through `ctx.ui.input`.

### 4. `<sub-agent-completed>` envelope

- **What it shows.** Markdown header + fenced XML block with id,
  persona, status, duration, usage, optional error/warning, result
  body, transcript path.
- **Where.** `src/notifications.ts:18`. Pushed from
  `src/index.ts:274` and `src/tools.ts:303`.
- **Status.** Load-bearing. The envelope is how the parent LLM
  observes terminal state for background spawns.
- **Improvement candidates.** The compaction hook
  (`src/compaction-hook.ts`) already tames context growth, but the
  envelope's verbose XML chrome is human-targeted; a denser shape
  could halve the envelope footprint without losing structure.

### 5. `<sub-agent-stalled>` envelope

- **What it shows.** Header + fenced XML block with severity
  (soft/hard), silent-seconds, threshold, last tool, transcript path.
- **Where.** `src/notifications.ts:121`. Pushed by the watchdog log
  adapter in `src/index.ts:362` with `triggerTurn: false`.
- **Status.** Supporting. Useful for the user when present, but soft-
  stall fires often and `triggerTurn: false` means the LLM only sees
  it on its next natural turn.
- **Improvement candidates.** Verify the soft-stall fire rate over a
  sample of sessions; if it dominates the conversation, raise the
  default threshold or suppress soft envelopes when the run resumed
  on its own.

### 6. `/conductor` subcommands

| Subcommand                  | What it does                                          | Where                  | Status        |
| --------------------------- | ----------------------------------------------------- | ---------------------- | ------------- |
| `list` (or empty)           | List resolved personas (project > user > builtin).    | `commands.ts:152`      | Load-bearing  |
| `show <persona>`            | Print the resolved persona file.                      | `commands.ts:185`      | Supporting    |
| `doctor`                    | Health check; surfaces config + persona errors.       | `commands.ts:227`, `src/doctor.ts` | Supporting |
| `on` / `off`                | Toggle conductor-mode flag for this session.          | `commands.ts:101–112`  | Load-bearing  |
| `status`                    | Snapshot of active runs.                              | `commands.ts:240`      | Supporting    |
| `stop <id\|all>`            | `forceTerminate` SIGTERM+SIGKILL chase.               | `commands.ts:261`      | Load-bearing  |
| `pause <id\|all>`           | SIGSTOP.                                              | `commands.ts:289`      | Speculative — verify usage. |
| `resume <id\|all>`          | SIGCONT.                                              | `commands.ts:308`      | Speculative — verify usage. |
| `queue`                     | List pending spawns.                                  | `commands.ts:327`      | Supporting    |
| `focus [id]`                | Open the focused-stream overlay.                      | `commands.ts:344`      | Supporting (Ctrl+G shortcut is the dominant entry path). |
| `history [N]`               | List past sub-agent runs from disk.                   | `commands.ts:374`, `src/history.ts` | Speculative — verify usage. |
| `pin <id>` / `unpin <id>`   | Protect a run from GC.                                | `commands.ts:457, :488` | Supporting   |
| `gc [flags]`                | Reclaim disk used by run records.                     | `commands.ts:691` (UNWIRED, see §2 caveat) | Supporting in design; broken at HEAD. |
| `watchdog [status]`         | Watchdog status report.                               | `commands.ts:753, :816` | Supporting    |

### 7. `ensemble_focus` LLM tool

- **What it does.** Lets the conductor LLM open the focused overlay
  on a specified or most-recent sub-agent.
- **Where.** `src/tools.ts:787`.
- **Status.** Speculative. Low observed call rate. Ctrl+G + `Tab` is
  the dominant way the user navigates focus, not LLM-driven calls.
- **Improvement candidates.** Either tighten the trigger doc in
  `personas/conductor.md` so the LLM actually reaches for it on user
  cues like "show me what builder is doing", or deprecate.

### 8. Conductor mode prompt addendum

- **What it does.** Injects a strict-overseer system prompt at every
  turn start when `conductorModeOn` is true. Teaches the LLM what
  personas exist, the queue auto-downgrade behavior, and the hands-
  off rules.
- **Where.** `src/conductor-prompt.ts:buildConductorSystemPrompt`,
  injected from `src/index.ts:before_agent_start`.
- **Status.** Load-bearing. The strict-overseer rules in §1.5 are the
  reason the conductor reliably delegates instead of editing in-place.
- **Improvement candidates.** The addendum is verbose (~250 LOC of
  prompt). Worth measuring its token cost over a representative
  session and deciding whether the persona enumeration alone is the
  load-bearing piece.

### 9. Auto-downgrade-when-queued tool result + prompt warning

- **What it does.** When `ensemble_spawn` hits the concurrency cap,
  foreground requests auto-downgrade to background. The tool result
  text begins `queued-as-background:` (`tools.ts:317`) and the
  conductor prompt has a paragraph warning the LLM to handle this
  cleanly without re-spawning.
- **Status.** Speculative — fire rate unknown. The two-paragraph
  warning text in the prompt suggests we're paying a token cost
  every turn for an event that may rarely happen.
- **Improvement candidates.** Telemetry: log the
  `result.kind === "queued"` rate per N sessions. If it fires
  rarely, trim the prompt warning to one sentence.

### 10. Sanitizer warning notify

- **What it does.** When `installSanitizerHook` repairs malformed
  `toolUse.name` entries, it emits one `ctx.ui.notify(... "warning")`
  per fresh `toolCallId` so the user knows their session was wedged.
- **Where.** `src/sanitizer-hook.ts`.
- **Status.** Supporting. Fires only on already-broken sessions;
  invisible otherwise.

## 7. Known speculative or underused features

Promotion of section 6 annotations into actionable v0.11 planning
candidates, with concrete validation thresholds. The intent is to
shrink the runtime by removing what isn't load-bearing.

### `ensemble_focus` LLM tool

- **Symptom.** Low observed call rate; Ctrl+G + `Tab` covers the use
  case.
- **Validate by.** Grep `~/.pi/sessions/` and the conductor's own
  recent transcripts for `ensemble_focus` tool calls over the last
  20 sessions.
- **Decide.** If < 1 call per 10 sessions, deprecate the tool;
  document Ctrl+G as the canonical path. If usage is healthy,
  improve the trigger doc in `personas/conductor.md` instead.

### Auto-downgrade-when-queued ceremony

- **Symptom.** The conductor prompt has two paragraphs warning about
  `queued-as-background`; observed fire rate is unknown.
- **Validate by.** Add a counter-style log in
  `queue.ts:enqueueOrSpawn` for the `kind: "queued"` path; tally
  over N sessions.
- **Decide.** If < 5 firings per 10 sessions, trim the prompt to one
  sentence and raise `maxConcurrent` default from 4 to 6 to make
  queuing rarer still.

### `defaultMode` cascade complexity

- **Symptom.** Brief specifies four layers; code has three
  (config-merged, env, built-in default). Per-project + per-user
  `defaultMode` is collapsed before the resolver runs. In practice
  the only layer that has ever mattered is the persona-frontmatter
  layer, which **does not actually exist for `defaultMode`** — it
  governs spawn options like `timeoutMinutes`.
- **Validate by.** Grep for `defaultMode` in any `~/.pi/agent/.../
  config.json` and `<cwd>/.pi/conductor.json` files; measure how
  many configurations actually set it.
- **Decide.** If only the env var and built-in default are used in
  practice, simplify `resolveInitialConductorMode` to two layers and
  drop the config field. Document `PI_CONDUCTOR_MODE` as the single
  pinning mechanism.

### `/conductor history`

- **Symptom.** Listed in subcommands, no observed usage in this
  session. The on-disk run records are also reachable via the
  focused overlay (which can show terminal runs while their linger
  is alive) and via the GC inventory.
- **Validate by.** Search the user's recent shell history and pi
  session transcripts for `conductor history`. If absent across 30
  days, drop.
- **Decide.** Trim if unused; the GC system already knows how to
  walk the runs root.

### `/conductor pause` and `/conductor resume`

- **Symptom.** SIGSTOP/SIGCONT bindings shipped for the case where a
  user wants to halt token consumption while reviewing partial
  output. Whether anyone has used this in production is uncertain.
- **Validate by.** Same shell-history grep.
- **Decide.** If unused, deprecate. The same effect can be achieved
  by `/conductor stop` followed by `ensemble_send` (resume from
  session file) when the user is ready.

### `/conductor gc` is unwired

- **Symptom.** `case "gc":` is missing from the switch in
  `registerCommands` (verified at HEAD `876f421`); `runGcCmd` is
  fully implemented but unreachable via the slash command. Auto-GC
  on `session_start` and direct-test paths are unaffected.
- **Validate by.** No validation needed; this is a defect, not a
  speculative feature.
- **Decide.** Land a one-line fix in a follow-up: add `case "gc":
  await runGcCmd(opts, ctx, subRest); return;` and a regression test
  that drives the slash command end-to-end.

### Speculative item the brief asked to verify: Ctrl+E ensemble dashboard

- **Verified.** No Ctrl+E binding exists. The widget is render-only;
  there is no associated keybinding. The Ctrl+G focused-stream
  overlay is the only TUI shortcut owned by the runtime.

## 8. Pointers — where to look for common changes

- **Add a new event the runtime should react to.** Edit `applyEvent`
  in `src/event-handler.ts`. Pin with a test in
  `tests/event-handler.test.ts`. The I/O wrapper in
  `runs.ts:processLine` will dispatch the new effect for free.

- **Add a new slash subcommand.** Add the case to the switch in
  `src/commands.ts:registerCommands` (`commands.ts:91`). Add the
  string to the `SUBCOMMANDS` array (`commands.ts:55`) so completion
  picks it up. Reuse `STATUS_GLYPH` and `formatRunRow` for output.

- **Change widget rendering.** Edit `src/widget.ts`. Keep
  `formatStallSegment` pure so `tests/widget.test.ts` can pin it.

- **Plumb a new per-spawn config.** Touch four files: `src/types.ts`
  (Run + ConductorConfig), `src/tools.ts` (parameter + validation),
  `src/runs.ts` (`SpawnOptions`, `spawnRun`), and
  `src/index.ts:opts` if a session-scoped lookup is needed. Mirror
  the v0.10 `kill_on_stall` plumbing (commit `9bed244`).

- **Wire a new envelope.** Format in `src/notifications.ts`; emit
  via `pi.sendMessage` in `src/index.ts`. Decide on `triggerTurn`
  intent: completion = `true`, advisory = `false`. Add a compaction
  rule to `src/compaction-hook.ts` if it grows large.

- **Add a new persona.** Drop a markdown file in `personas/<name>.md`
  with the YAML-ish frontmatter and a system-prompt body.
  `resolvePersonas` finds it at runtime with no further wiring. If
  the persona mutates the working tree, add it to
  `WRITE_CAPABLE_PERSONAS` in `src/personas.ts` so it counts against
  the write-capable concurrency cap.

- **Adjust watchdog defaults.** Edit `DEFAULT_CONFIG.watchdog` in
  `src/types.ts` (or `DEFAULT_WATCHDOG_CONFIG` in `src/watchdog.ts`
  for the detector-only path). The widget glyph picks up the new
  thresholds via `getWatchdogConfig`.

- **Change the strict-overseer prompt.** Edit
  `src/conductor-prompt.ts`. The prompt is composed at every
  `before_agent_start` so changes are picked up on the next turn
  with no reload.

- **Find a sub-agent's session file for resume.** Pi writes the
  session JSONL inside the spawn's `--session-dir`;
  `discoverSessionPathIfMissing` (`runs.ts:163`) finds it on the
  close path. `Run.sessionPath` is the canonical handle thereafter.
