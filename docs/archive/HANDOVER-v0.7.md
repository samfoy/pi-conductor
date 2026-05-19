# pi-conductor — Handover (v0.7-era, archived)

> **ARCHIVED 2026-05-19.** This document was the v0.7-era onboarding
> guide. It contains stale defaults (e.g. the `mkdir + ln -s` install
> snippet that produced the legacy-symlink dual-load failure addressed
> in v0.9 — see `docs/v0.9-symlink-investigation.md`). It is preserved
> for historical reference only. For current install / config / status
> guidance, read `README.md` and `PRD.md`.

# pi-conductor — Handover

**Date:** 2026-05-15
**Repo:** `~/scratch/pi-conductor/`  (git-init'd, master branch only, never pushed)
**Author:** Sam Painter (samfp@)
**Last commit:** v0.7 — conductor mode ON by default, §10 proactive delegation triggers in the conductor system prompt, namespace migrated to `@earendil-works/pi-*`. README/PRD/AGENTS docs refreshed in the same wave.
**Test state:** 357 unit + 6 live-gated; unit suite ~4.4s; live integration suite passes (~120s) covering spawn, ensemble_send resume, inherit_context=filtered/full, foreground stream onUpdate flow, and Esc-detach via awaitOrDetach.

This document is a self-contained briefing so a fresh pi session (or a new agent) can pick up the project without losing context. Read this end-to-end before doing any work.

---

## 1. What pi-conductor is

A pi extension that turns the parent pi session into an **orchestrator** ("conductor") which drives a roster of **persona-based sub-agents** with first-class TUI visibility. The novel piece versus existing extensions (`pi-mono/team-mode`, `pi-subagents`) is that the user can drop into any sub-agent's live transcript view inside pi's TUI — no tmux switch, no log file tailing. The orchestrator stays in the chat; the user can focus on any sub-agent at will.

It does **not** replace `pi-essentials/subagent` — that extension stays as the lightweight fire-and-forget background runner. pi-conductor is the heavyweight, conversation-led, fully-observable counterpart for SDLC work.

The user has explicitly excluded Ralph and autoloop from the design space: "ralph is out or not in scope. assume that when we use this ralph/autloop don't exist."

---

## 2. Why each design decision was made (locked decisions)

Read these before proposing alternatives — they're already settled.

| Decision | Choice | Rationale |
|---|---|---|
| Codename | `pi-conductor` | Orchestra metaphor: parent conducts, personas play, audience watches. |
| Default spawn mode | **foreground** | Streams inline; the user wanted to *see* sub-agents work in the TUI. |
| Notification visibility | **Inline visible** | `<sub-agent-completed>` blocks render in the parent conversation. The user sees them; the LLM acts on them. |
| Tool restrictions | **Not implemented.** | Pi has no clean way to whitelist tools in a child subprocess. We document this honestly rather than fake it. **Don't add a `tools:` field to personas.** |
| Pause / resume | **Supported** via SIGSTOP/SIGCONT. | Useful for cost control. |
| Concurrency cap behavior | **Queue (FIFO)** | When `maxConcurrent` is hit, additional spawns are queued. |
| Foreground spawn while queued | **Auto-downgrade to background.** | Returns `status: "queued-as-background"` with the agent_id; the conductor system prompt instructs the LLM not to re-spawn. |
| Filtered context inheritance | **Reimplement.** | Don't depend on pi-subagents' `shared/fork-context.ts`. |
| Persona discovery paths | **`~/.pi` subtree only** + project `.pi/conductor/personas/`. | No XDG, no scattered locations. |
| Foreground cancel UX | **Esc detaches; Ctrl+C kills.** | Esc converts a foreground stream into a background sub-agent. |
| Default model per persona | **Inherit-only.** | Shipped persona files never set `model` or `thinking`. No phase-aware defaults baked in. Users override per-persona in `personaOverrides`. |
| Persona library | 16 starter personas covering full SDLC, **adapted from external role definitions** (autoloop). | `inspector, analyst, cartographer, clarifier, designer, oracle, planner, builder, simplifier, critic, redteam, finalizer, verifier, investigator, profiler, scribe`. |
| Coexistence with `pi-essentials/subagent` | **Side-by-side, namespaced tools.** | `ensemble_*` prefix; the conductor system prompt teaches the LLM when to reach for each. |

Decisions that are deferred (v1.x or v2):
- Resumable session GC policy (when to delete `~/.pi/agent/conductor/runs/<id>/`)
- Worktree-per-persona defaults
- Project-shareable persona library (`/conductor install <url>`)

---

## 3. TDD is the workflow — non-negotiable

The user explicitly asked for TDD as the project standard. The pre-commit hook enforces this by running `npm test` and rejecting red.

**The rule** (from `CONTRIBUTING.md`):
> No code change ships without a test that exercises it. Bug fixes start with a failing test that reproduces the bug. New features start with a failing test that pins the behavior. Refactors keep all existing tests green. Pure documentation edits are the only exception.

**The loop:**
1. **Red.** Write the failing test first. Run `npm test` and confirm it fails for the expected reason.
2. **Green.** Smallest code change that passes.
3. **Refactor.** With tests green, clean up.

**Pre-commit hook** is at `hooks/pre-commit`; activated via `git config core.hooksPath hooks` (already done in this clone). Bypass only with `git commit --no-verify` for true emergencies.

**Test conventions** (see `CONTRIBUTING.md` for full list):
- `node:test` + `tsx`. Run via `npm test`.
- Deterministic. No real `pi` subprocesses, no real network, no `Date.now()` flakes.
- Fixture cleanup in `finally` blocks. Real-HOME-swap pattern for tests that touch `~/.pi`.
- Live integration tests gated on `CONDUCTOR_LIVE_TESTS=1`.
- Target: unit suite under 5s wall time. Currently 2.3s.
- Behavior-focused, not implementation-focused.

**A specific lesson learned** in this session (saved as memory): **never reach for `python3 << 'PYEOF'` heredocs to edit files.** Use the `edit` tool. When dedup fires, verify with `read` first and re-issue with a slightly different `oldText` window, or use `write` for full-file rewrites.

---

## 4. Architecture (current state, v0.7)

```
src/
├── index.ts               — Extension entry. Wires lifecycle, registry,
│                            queue, focus model, ensemble panel widget,
│                            conductor system prompt, Ctrl+G keybinding,
│                            getParentMessages snapshot for inherit_context,
│                            registerForegroundDetach plumbing (per-spawn
│                            ctx.ui.onTerminalInput Esc interception).
├── types.ts               — Persona, Run, RunStatus, Usage, ConductorConfig,
│                            PersonaOverride, EventEffect, isTerminal.
├── personas.ts            — Frontmatter parser + layered loader
│                            (builtin / user / project precedence).
├── config.ts              — loadConfig + loadConfigWithErrors (errors-aware).
├── doctor.ts              — Pure buildDoctorReport(opts): string.
├── runs.ts                — RunRegistry, spawnRun (subprocess + JSON parser),
│                            planSpawnPiArgs (decides fresh vs seeded
│                            resume per inherit_context), forceTerminate,
│                            pauseRun, resumeRun (Signaler-injectable),
│                            sendToRun, formatters (formatTokens,
│                            formatUsage, elapsedStr, getFinalText,
│                            allocateRunId, buildSubAgentPrompt, buildPiArgs).
├── context-filter.ts      — Pure filterParentContext(messages, opts).
│                            Drops ensemble_*/subagent tool calls + results,
│                            ensemble-notification CustomMessages, !!-prefix
│                            bash. Reimplemented per locked PRD decision
│                            (no dep on pi-subagents/shared/fork-context.ts).
├── session-seed.ts        — seedSessionFile(path, messages, cwd): writes
│                            a pi-format JSONL session header + linear
│                            parentId chain so `pi --session <path>` resumes
│                            with the seeded transcript as history.
├── event-handler.ts       — Pure applyEvent(run, event): EventEffect.
│                            Extracted from spawnRun's processLine closure
│                            so every event variant is unit-testable.
├── queue.ts               — SpawnQueue: FIFO + auto-downgrade-on-full.
│                            PendingSpawn snapshots parentMessages at
│                            enqueue time (v0.6).
├── notifications.ts       — formatCompletionNotification(run): string.
├── conductor-prompt.ts    — buildConductorSystemPrompt({ personas,
│                            maxConcurrent }). Includes §10 — proactive
│                            delegation triggers (v0.7).
├── conductor-mode.ts      — Pure resolveInitialConductorMode(env): boolean.
│                            Default: ON. PI_CONDUCTOR_MODE=0/off opts out.
├── history.ts             — Pure buildHistoryReport(deps, opts): string for
│                            /conductor history. I/O is injected.
├── widget.ts              — Ensemble panel (belowEditor; reactive to
│                            registry changes; 8s linger on finished runs).
├── transcript.ts          — Pure renderer for the focused-stream overlay.
│                            renderTranscript / renderHeader / renderFooter.
├── foreground-stream.ts   — Pure helpers for the v0.4 inline-streamed
│                            foreground spawn: renderForegroundStream
│                            (header + collapsed-tool-call body),
│                            renderForegroundSummary (compact 1-3 line
│                            post-completion block), renderForegroundDetachedResult
│                            (for Esc-detach), createUpdateThrottle
│                            (leading + trailing debouncer), awaitOrDetach
│                            (race helper), installPostDetachCompletionListener
│                            (terminal-flip listener with race-guard),
│                            resolveStreamWidth (clamped terminal cols).
├── focused-stream-model.ts — Pure navigation/fold/scroll state for the
│                             focused-stream overlay.
├── focused-stream-overlay.ts — Thin Component layer that consumes the
│                               model + renderer.
├── tools.ts               — ensemble_list, ensemble_status, ensemble_spawn,
│                            ensemble_send, ensemble_pause, ensemble_resume,
│                            ensemble_focus. Foreground branches use
│                            createUpdateThrottle + awaitOrDetach +
│                            installPostDetachCompletionListener.
└── commands.ts            — /conductor list | show | doctor | on | off |
                             status | stop | pause | resume | queue | focus |
                             history.

personas/  — 16 markdown files, one per starter persona. Each has YAML-ish
             frontmatter + system-prompt body + ## Source footer documenting
             lineage from autoloop.

tests/     — 25 test files, 357 unit tests + 6 live-gated. See §6.

tools/                    — maintenance scripts (e.g. rename-pi-namespace.mjs).
hooks/pre-commit          — runs npm test, rejects on red.
scripts/install-hooks.sh  — one-time setup: git config core.hooksPath hooks.
PRD.md                    — Full design doc, decision log, implementation phases.
README.md                 — User-facing summary.
AGENTS.md                 — Agent-facing summary (read this before code work).
CONTRIBUTING.md           — TDD rules, conventions.
```

---

## 5. What works today (v0.7 shipped)

- **Persona discovery + resolution** with builtin/user/project layering
- **16 starter personas** covering full SDLC (see decision-log table)
- **Tools**: `ensemble_list`, `ensemble_status`, `ensemble_spawn`, `ensemble_send`, `ensemble_pause`, `ensemble_resume`, `ensemble_focus`
- **Slash commands**: `/conductor list | show | doctor | on | off | status | stop | pause | resume | queue | focus | history`
- **Spawn**: foreground (default, blocks AND streams the sub-agent's transcript inline in the parent's tool-call card; collapses to a 1–3 line summary on completion) or background (returns immediately, completion arrives via `<sub-agent-completed>` notification message)
- **Inline-streamed foreground transcript (v0.4)** — `ensemble_spawn(foreground=true)` and `ensemble_send(foreground=true)` push the sub-agent's transcript through `onUpdate` on every registry change. The text is composed by `renderForegroundStream` (header + collapsed-tool-calls transcript, reuses `renderHeader` + `renderTranscript` from `transcript.ts`). Updates are coalesced via `createUpdateThrottle` at 50ms granularity; terminal state is force-flushed before the tool result is returned. The result card collapses to `renderForegroundSummary` — status glyph, persona:id, elapsed, usage, optional final-text excerpt, transcript path. The streamed view is tail-truncated at 32K chars to keep pi's tool-card re-render cheap on long runs. **Width tracks the live terminal** (`process.stdout.columns`, clamped to [40, 240]; falls back to 100 in headless contexts).
- **Esc-to-detach (v0.7)** — PRD-locked Foreground cancel UX. Pressing Esc while a foreground sub-agent streams converts the spawn into a background run; the tool returns a `detached-as-background` result so the LLM doesn't re-spawn, and a registry listener pushes the standard `<sub-agent-completed>` notification on terminal status. Implemented via `awaitOrDetach` race + a per-spawn `ctx.ui.onTerminalInput` listener (intercepts bare Esc via `matchesKey`, consumes the keystroke so pi's reserved `app.interrupt` action doesn't also fire). Skipped when an overlay is open or no UI ctx is attached. Ctrl+C continues to kill via the existing `signal?.addEventListener("abort", ...)` path. **Caveat:** `pi.registerShortcut(Key.escape, ...)` cannot be used here — pi's runner reserves `app.interrupt` (default: escape, ctrl+c) and silently drops conflicting extension shortcuts. The onTerminalInput route runs ahead of the keybinding layer in pi-tui's `TUI.handleInput`, so detach intercepts before `app.interrupt` fires.
- **`/conductor history [N]` (v0.7)** — lists past sub-agent runs from `~/.pi/agent/conductor/runs/`, sorted by run-dir mtime DESC, default limit 20. Surfaces persona, run id, status glyph, elapsed, usage, and final-text excerpt (or error message for failures). Pure renderer in `src/history.ts` with injected I/O so it's fully unit-tested.
- **Resumable sessions on disk** — every sub-agent writes to `<runDir>/session/`. `Run.sessionPath` is populated up-front when seeded (v0.6) or on finalize (v0.5). Future `ensemble_send` calls resume via `pi --session <path>`.
- **`ensemble_send`** — continues a finished sub-agent's session with a new user message. Reuses the same `applyEvent` plumbing so the run's messages, usage, and lastToolCall accumulate across the original spawn AND any subsequent sends.
- **`inherit_context: filtered` / `full` (v0.6)** — personas with these settings boot the sub-agent on a seeded JSONL session containing the conductor's transcript. `filtered` drops orchestration noise (`ensemble_*`, `subagent` tool calls + results, `<sub-agent-completed>` cards, `!!`-prefix bash); `full` passes everything verbatim. `none` (default) keeps the existing fresh-spawn behavior. Pure planner `planSpawnPiArgs` decides per-spawn; `filterParentContext` is the pure filter; `seedSessionFile` writes the JSONL.
- **Overlay `s` keybinding** — prompts for a follow-up message and dispatches via `sendToRun`. Footer shows `s send`.
- **Concurrency cap + FIFO queue** with foreground→background auto-downgrade when full. `parentMessages` snapshots flow through `PendingSpawn` so a queued sub-agent inherits the conductor's intent at enqueue time, not at drain time.
- **Pause/resume/stop** via SIGSTOP/SIGCONT/SIGTERM; `stop` works on running OR queued sub-agents; pause/resume also exposed as LLM-callable tools. Happy-path now unit-tested via an injectable `Signaler`.
- **Ensemble panel** (always-visible `belowEditor` widget when ≥1 sub-agent active or recently-finished within 8s)
- **Conductor mode system prompt** injected via `before_agent_start` when `PI_CONDUCTOR_MODE=1` env or `/conductor on`. Documents `ensemble_send` / `ensemble_pause` / `ensemble_resume` for the LLM.
- **Focused stream overlay** (Ctrl+G) — full-screen drilldown of one sub-agent's live transcript with per-agent scroll, global fold flags, kill-from-overlay, send-from-overlay
- **Doctor surfaces malformed config** files via `loadConfigWithErrors`
- **`getPiInvocation`** honors `PI_BIN` and only re-uses `process.argv[1]` when it actually looks like pi's CLI; live integration tests can run under `tsx`.
- **Pre-commit hook** gates every commit on the test suite

What does NOT work yet:
- **Run-record GC** — still no policy; sessions live forever.
- **`inherit_skills: true`** — PRD lists this as a v1 frontmatter field; currently parsed but unused. Would need to port the parent's skill catalog to the child's prompt.

---

## 6. Test layout (357 unit + 6 live-gated, 25 files, ~4.4s)

```
tests/
├── personas.test.ts                  — Frontmatter parser + persona resolver basics
├── builtins.test.ts                  — All 16 shipped personas load cleanly
├── queue.test.ts                     — RunRegistry + SpawnQueue mechanics
├── queue-extra.test.ts               — Queue edge cases + parentMessages snapshot
├── spawn.integration.test.ts         — GATED live tests (CONDUCTOR_LIVE_TESTS=1):
│                                       spawn, ensemble_send, inherit_context=filtered/full,
│                                       foreground stream onUpdate sequence,
│                                       awaitOrDetach against a live spawn (Esc-detach
│                                       race; the keybinding path itself requires hand-test)
├── notifications.test.ts             — formatCompletionNotification
├── conductor-prompt.test.ts          — buildConductorSystemPrompt incl. §10 triggers
├── conductor-mode-default.test.ts    — resolveInitialConductorMode (default ON,
│                                       PI_CONDUCTOR_MODE opt-out tokens)
├── config.test.ts                    — loadConfig defaults + merge
├── config-errors.test.ts             — loadConfigWithErrors error reporting
├── context-filter.test.ts            — filterParentContext: every include/exclude rule
├── doctor.test.ts                    — buildDoctorReport
├── plan-spawn.test.ts                — planSpawnPiArgs: inherit_context matrix
├── runs-helpers.test.ts              — formatTokens, formatUsage, elapsedStr,
│                                       getFinalText, pauseRun/resumeRun (with
│                                       injectable Signaler), forceTerminate
├── event-handler.test.ts             — applyEvent (every event variant)
├── session-seed.test.ts              — seedSessionFile: header shape, parentId
│                                       chain, JSON round-trip
├── transcript.test.ts                — renderTranscript / renderHeader / renderFooter
├── foreground-stream.test.ts         — renderForegroundStream + renderForegroundSummary
│                                       + STREAM_MAX_CHARS truncation
├── foreground-throttle.test.ts       — createUpdateThrottle: leading + trailing,
│                                       flush(), dispose(), cancel pending fire
├── foreground-detach.test.ts         — awaitOrDetach race semantics +
│                                       renderForegroundDetachedResult shape
├── post-detach-listener.test.ts      — installPostDetachCompletionListener:
│                                       4 scenarios (active, terminal-flip-later,
│                                       race-guard already-terminal, manual unsub)
├── resolve-stream-width.test.ts      — resolveStreamWidth: defaults, clamps,
│                                       NaN/negative
├── history.test.ts                   — buildHistoryReport: empty, ordering, limit,
│                                       per-status rendering, truncation
├── focused-stream-model.test.ts      — FocusedStreamModel state machine
├── focused-stream-overlay.test.ts    — FocusedStreamOverlay Component dispatch
├── ensemble-focus.test.ts            — ensemble_focus tool model effect
├── ensemble-send.test.ts             — ensemble_send tool: registration,
│                                       agent_id validation, status gating,
│                                       terminal-state acceptance
├── ensemble-pause-resume.test.ts     — ensemble_pause / ensemble_resume tool
│                                       registration + status gating
└── runs-send.test.ts                 — sendToRun helper: rejection paths
                                        + status flip + terminal-field reset
```

Run all: `npm test`. Run live: `CONDUCTOR_LIVE_TESTS=1 npm test` (needs AWS creds for pi).

---

## 7. Git history (this branch)

```
217fb37 feat(prompt): §10 — proactive delegation triggers
816dfb8 feat(v0.7): conductor mode ON by default
5594e5d chore(deps): migrate to @earendil-works/pi-*
a2cb43c refactor(v0.7): extract installPostDetachCompletionListener helper
422b5ff docs(handover): correct Esc-to-detach implementation note
5ec7dcd fix(v0.7): Esc-to-detach via onTerminalInput, not registerShortcut
968fe41 fix(v0.7): race-guard the post-detach completion-notification listener
66bfa0f test(v0.7): live integration test for Esc-detach + README/HANDOVER updates
4534e9c test(runs): cover pauseRun / resumeRun via injectable Signaler
17aaf68 feat(v0.4): use live terminal width for inline foreground stream
d8d1792 feat(commands): /conductor history lists past sub-agent runs
2d7aea0 feat(v0.7): Esc-to-detach for foreground sub-agent spawns
1c85a1f refactor(v0.4): tighten foreground stream throttle per self-review
1701dd3 docs: mark v0.4 inline-streamed foreground transcript shipped
fad88a4 test(v0.4): live integration test for foreground stream throttle + flush
e451c91 feat(v0.4): stream foreground transcript inline in parent tool-call card
6c259d6 feat(v0.4): add createUpdateThrottle for inline foreground stream
4cf119a feat(v0.4): add renderForegroundStream + renderForegroundSummary helpers
6101e2f docs(handover): mark post-review issues resolved
88d868d feat(prompt+test): document inherit_context + stale snapshots
96d1ccf feat(spawn): prepend <filtered-history> sentinel
c5de692 fix(send): re-inject persona system prompt on ensemble_send resume
... (older v0.5 / v0.6 commits) ...
76357d2 feat(v0.3): focused stream overlay (Ctrl+G)
688ff97 feat: pi-conductor v0.2 — spawn, queue, panel, conductor mode
a1d711b feat: initial pi-conductor v0.1 scaffold
```

Never pushed. No remote configured.

---

## 8. In-flight work as of this handover

None. v0.4 → v0.7 are all on master, green local + live. No outstanding subagents, no pending refactors.

The one open caveat: the **Esc-detach keybinding path** (the `ctx.ui.onTerminalInput` interception) is NOT exercised by any automated test — the live integration test validates `awaitOrDetach` against a real spawn, but the keypress → listener → detach trigger chain requires a real terminal. Hand-test before declaring v0.7 truly done in production use.

---

## 9. What to do next (priority order)

1. **Hand-test v0.7 end-to-end.** Load the extension, foreground-spawn a long-running task, press Esc, watch the spawn convert to background and the `<sub-agent-completed>` card arrive. Try `/conductor history` and `/conductor history 5` to see the recent-runs browser. Verify Ctrl+C still kills (not detaches). The keybinding path is the one piece of v0.7 that automated tests can't cover.
2. **Run-record GC** — open question #12 in the PRD. Sessions accumulate under `~/.pi/agent/conductor/runs/` and never get cleaned up. Decide a policy (e.g. keep last N, or older-than-D days). Implement as a `/conductor gc` slash command + an opt-in startup hook.
3. **`inherit_skills: true`** — PRD lists this as a v1 frontmatter field; currently parsed but unused. Port the parent's skill catalog to the child's prompt at spawn time.
4. **Audit which shipped personas should default to `inherit_context: filtered`.** Currently most personas set `filtered` in frontmatter; now that filtering really runs, walk each persona and confirm whether `filtered` is right (or if read-only specialists should be `none` for less noise).
5. **Worktree per persona** (PRD v2 deferred).

---

## 10. How to load the extension

For development (per session):
```bash
pi -e ~/scratch/pi-conductor/src/index.ts
```

For auto-load every session:
```bash
mkdir -p ~/.pi/agent/extensions/conductor
ln -s ~/scratch/pi-conductor/src/index.ts ~/.pi/agent/extensions/conductor/index.ts
```

Conductor mode is **on by default** at extension load (v0.7). To disable for one session:
```bash
PI_CONDUCTOR_MODE=0 pi -e ~/scratch/pi-conductor/src/index.ts
```

Or `/conductor off` from inside an active session. Toggle back on with `/conductor on`.

Dependencies live under `@earendil-works/` (migrated from `@mariozechner/` in v0.7) and are not on the workplace npm proxy. Install with:
```bash
npm install --registry https://registry.npmjs.org
```

To run the test suite:
```bash
cd ~/scratch/pi-conductor
npm test
```

To run the live integration test:
```bash
cd ~/scratch/pi-conductor
CONDUCTOR_LIVE_TESTS=1 npm test
```

To install the pre-commit hook (one-time per clone):
```bash
cd ~/scratch/pi-conductor
./scripts/install-hooks.sh
# or: git config core.hooksPath hooks
```

---

## 11. Related projects in the user's box

- **`~/scratch/pi-essentials/`** — the user's own pi-essentials package (10+ extensions). Contains the simpler `subagent` extension (`src/subagent.ts`, 690 LOC). pi-conductor coexists with it; they don't compete because the namespaces and use cases are different.
- **`~/scratch/autoloop/`** — autonomous CLI loop tool (separate from pi-conductor). Source of the role definitions adapted into pi-conductor's personas.
- **`~/scratch/ralph/`** — Sam's other in-session orchestration tool. Out of scope for pi-conductor design per the user's directive.
- **`~/.pi/agent/extensions/tool-dedup.ts`** — the over-tuned dedup extension being fixed by the in-flight subagent. Path the dedup-fix agent is working in.
- **`~/.pi/agent/extensions/auto-work-logger.ts`** — daily-note logger; manages the user's daily journal. Unrelated.
- **`/tmp/pi-mono-extensions/`** — reference clone of the team-mode reference. PRD references it; we did not depend on it.
- **`/tmp/pi-subagents/`** — reference clone of the specialist-roster reference. PRD references it; we did not depend on it.

---

## 12. Things to NOT do

From `AGENTS.md`:
- **Don't enable phase-aware default models.** Persona files do not set `model:` or `thinking:`. Decision logged in PRD.
- **Don't add a `tools:` field to personas.** Pi has no tool-restriction mechanism we'd be willing to fake. Decision logged.
- **Don't add discovery paths beyond `~/.pi/agent/conductor/personas/` and `<project>/.pi/conductor/personas/`.** Decision logged.
- **Don't reach into pi-subagents' `shared/fork-context.ts`.** We reimplement filter logic ourselves when v0.6 lands. Decision logged.
- **Don't reach for `python3` heredocs to edit files.** Use `edit` and `write`. Memory lesson.
- **Don't bypass the pre-commit hook with `--no-verify`** unless it's a real emergency.
- **Don't bundle unrelated changes into one commit.** TDD discipline → one logical change per commit.
- **Don't touch `pi-essentials/subagent.ts`** — that's its own package; pi-conductor coexists with it.

---

## 13. Open questions (deferred, not blocking)

From PRD §"Open questions":

12. **Resumable session GC policy.** `ensemble_send` to a finished sub-agent implies resuming via `pi --session`. Should we keep finished sub-agents' sessions alive forever (disk grows) or GC after N days?
13. **Worktree isolation per persona** (v2). When implemented: which personas default `worktree: true`? `builder` and `simplifier` are obvious; read-only personas should always be `false`.
14. **Project-shareable persona library** (v2). A "marketplace" of `.md` persona files — install via `/conductor install <url>`?

Plus issues surfaced by the test sweep that don't block any milestone but are worth tracking:
- ~~`pauseRun` / `resumeRun` happy paths aren't unit-tested.~~ **Fixed in v0.7** via injectable `Signaler` parameter.
- `SpawnQueue.setMaxConcurrent` drain trigger is tested via stubbing `queue.drain` and counting calls — mild implementation-detail. Acceptable.
- Persona override merge is now field-level across user → project. Inside a single layer, fields still don't merge (a single layer's `personaOverrides[oracle]` is one object — nothing to merge). This is fine.
- ~~v0.5 `ensemble_send` may also drop the persona system prompt on resume.~~ **Fixed in `c5de692`.** `Run.systemPrompt` is captured at spawn; `buildResumePiArgs` re-injects it via `--append-system-prompt`.
- ~~Stale parentMessages snapshot for queued spawns.~~ **Flagged to the LLM** in the conductor system prompt's §8 ("Context inheritance").
- ~~Filter false-negative for assistant prose that *quotes* a sub-agent's reply.~~ **Mitigated** via the `<filtered-history>` sentinel.
- **Conductor `model` / `thinking_level` not preserved into the seeded session.** Acceptable today (most personas inherit anyway), worth documenting in the persona reference.
- **Esc-detach keybinding path is not unit-tested.** The live integration test covers `awaitOrDetach` against a real spawn, but the keypress → `ctx.ui.onTerminalInput` listener → detach trigger chain requires a real terminal. Hand-test before declaring v0.7 truly done in production use.

---

## 14. Quick mental model for picking up

If you're a fresh agent reading this:
1. The user (samfp) wanted **a parent orchestrator that drives focused sub-agents with full TUI visibility**, distinct from `pi-essentials/subagent` (too generic), team-mode (no live transcript visibility), and pi-subagents (background runs are widget-only).
2. The user is committed to **TDD** for this project. Every change ships with a test. The pre-commit hook enforces.
3. The user prefers **the `edit` tool over scripted edits**. Don't reach for python heredocs or `sed -i`.
4. **16 personas** are shipped; their lineage is autoloop; their adaptation rules are in PRD §"Adapting an external role definition to a conductor persona".
5. **v0.7 is live.** v0.1–v0.7 all shipped (read-only scaffold, background spawn, focused-stream overlay, inline-streamed foreground, ensemble_send / pause / resume, filtered context inheritance, Esc-detach + history + on-by-default + §10 delegation triggers). **Next-up: run-record GC, persona inherit_context audit, worktree-per-persona** (v0.8+).
6. **No in-flight work.** master is clean; no subagents running.
7. **PRD.md is the source of truth.** Read it before proposing design changes. The Locked decisions table (v0.7) and the Implementation phases section both reflect actual current state.
8. **Upstream namespace.** All deps live under `@earendil-works/` (since v0.7). If you see `@mariozechner/pi-*` imports anywhere, they're stale — rewrite via `node tools/rename-pi-namespace.mjs`.

---

## 15. Where to put follow-up work

- New code: `~/scratch/pi-conductor/src/`
- New tests: `~/scratch/pi-conductor/tests/`
- New personas: `~/scratch/pi-conductor/personas/<name>.md`
- Decision changes: update PRD.md decision log + locked-decisions table
- Memory of cross-cutting lessons: `memory_remember type=lesson`
- Per-task notes that should outlive this work: `~/vault/Notes/Evergreen/`
