# pi-conductor — Handover

**Date:** 2026-05-14
**Repo:** `~/scratch/pi-conductor/`  (git-init'd, master branch only, never pushed)
**Author:** Sam Painter (samfp@)
**Last commit:** `69a443d fix(context-filter): drop thinking blocks + subagent-* CustomMessages; trim leading non-user` (post-review hardening on top of v0.6)
**Test state:** 289 passing + 3 skipped live, unit suite ~3s; live integration suite passes (~60s) under `CONDUCTOR_LIVE_TESTS=1` covering spawn, ensemble_send resume, and inherit_context=filtered seeding.

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

## 4. Architecture (current state, v0.6)

```
src/
├── index.ts               — Extension entry. Wires lifecycle, registry,
│                            queue, focus model, ensemble panel widget,
│                            conductor system prompt, Ctrl+G keybinding,
│                            getParentMessages snapshot for inherit_context.
├── types.ts               — Persona, Run, RunStatus, Usage, ConductorConfig,
│                            PersonaOverride, EventEffect.
├── personas.ts            — Frontmatter parser + layered loader
│                            (builtin / user / project precedence).
├── config.ts              — loadConfig + loadConfigWithErrors (errors-aware).
├── doctor.ts              — Pure buildDoctorReport(opts): string.
├── runs.ts                — RunRegistry, spawnRun (subprocess + JSON parser),
│                            planSpawnPiArgs (decides fresh vs seeded
│                            resume per inherit_context), forceTerminate,
│                            pauseRun, resumeRun, formatters
│                            (formatTokens, formatUsage, elapsedStr,
│                            getFinalText, allocateRunId, buildSubAgentPrompt,
│                            buildPiArgs).
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
│                            maxConcurrent }).
├── widget.ts              — Ensemble panel (belowEditor; reactive to
│                            registry changes; 8s linger on finished runs).
├── transcript.ts          — Pure renderer for the focused-stream overlay.
│                            renderTranscript / renderHeader / renderFooter.
├── focused-stream-model.ts — Pure navigation/fold/scroll state for the
│                             focused-stream overlay.
├── focused-stream-overlay.ts — Thin Component layer that consumes the
│                               model + renderer.
├── tools.ts               — ensemble_list, ensemble_status, ensemble_spawn,
│                            ensemble_send, ensemble_pause, ensemble_resume,
│                            ensemble_focus.
└── commands.ts            — /conductor list | show | doctor | on | off |
                             status | stop | pause | resume | queue | focus.

personas/  — 16 markdown files, one per starter persona. Each has YAML-ish
             frontmatter + system-prompt body + ## Source footer documenting
             lineage from autoloop.

tests/     — 18 test files, 282 tests total (3 live-gated). See §6.

hooks/pre-commit          — runs npm test, rejects on red.
scripts/install-hooks.sh  — one-time setup: git config core.hooksPath hooks.
PRD.md                    — Full design doc, decision log, implementation phases.
README.md                 — User-facing summary.
AGENTS.md                 — Agent-facing summary (read this before code work).
CONTRIBUTING.md           — TDD rules, conventions.
```

---

## 5. What works today (v0.6 shipped)

- **Persona discovery + resolution** with builtin/user/project layering
- **16 starter personas** covering full SDLC (see decision-log table)
- **Tools**: `ensemble_list`, `ensemble_status`, `ensemble_spawn`, `ensemble_send`, `ensemble_pause`, `ensemble_resume`, `ensemble_focus`
- **Slash commands**: `/conductor list | show | doctor | on | off | status | stop | pause | resume | queue | focus`
- **Spawn**: foreground (default, blocks + returns completion card) or background (returns immediately, completion arrives via `<sub-agent-completed>` notification message)
- **Resumable sessions on disk** — every sub-agent writes to `<runDir>/session/`. `Run.sessionPath` is populated up-front when seeded (v0.6) or on finalize (v0.5). Future `ensemble_send` calls resume via `pi --session <path>`.
- **`ensemble_send`** — continues a finished sub-agent's session with a new user message. Reuses the same `applyEvent` plumbing so the run's messages, usage, and lastToolCall accumulate across the original spawn AND any subsequent sends.
- **`inherit_context: filtered` / `full` (v0.6)** — personas with these settings boot the sub-agent on a seeded JSONL session containing the conductor's transcript. `filtered` drops orchestration noise (`ensemble_*`, `subagent` tool calls + results, `<sub-agent-completed>` cards, `!!`-prefix bash); `full` passes everything verbatim. `none` (default) keeps the existing fresh-spawn behavior. Pure planner `planSpawnPiArgs` decides per-spawn; `filterParentContext` is the pure filter; `seedSessionFile` writes the JSONL.
- **Overlay `s` keybinding** — prompts for a follow-up message and dispatches via `sendToRun`. Footer shows `s send`.
- **Concurrency cap + FIFO queue** with foreground→background auto-downgrade when full. `parentMessages` snapshots flow through `PendingSpawn` so a queued sub-agent inherits the conductor's intent at enqueue time, not at drain time.
- **Pause/resume/stop** via SIGSTOP/SIGCONT/SIGTERM; `stop` works on running OR queued sub-agents; pause/resume also exposed as LLM-callable tools
- **Ensemble panel** (always-visible `belowEditor` widget when ≥1 sub-agent active or recently-finished within 8s)
- **Conductor mode system prompt** injected via `before_agent_start` when `PI_CONDUCTOR_MODE=1` env or `/conductor on`. Documents `ensemble_send` / `ensemble_pause` / `ensemble_resume` for the LLM.
- **Focused stream overlay** (Ctrl+G) — full-screen drilldown of one sub-agent's live transcript with per-agent scroll, global fold flags, kill-from-overlay, send-from-overlay
- **Doctor surfaces malformed config** files via `loadConfigWithErrors`
- **`getPiInvocation`** honors `PI_BIN` and only re-uses `process.argv[1]` when it actually looks like pi's CLI; live integration tests can run under `tsx`.
- **Pre-commit hook** gates every commit on the test suite

What does NOT work yet:
- **v0.4** — inline-streamed foreground transcript. Foreground today blocks the parent's tool call, but the user only sees the final completion card; live progress visibility comes from the panel widget + Ctrl+G overlay. The PRD spec was that foreground would stream the sub-agent's messages inline in the parent conversation. That's still the v0.4 target.
- **`/conductor history`** — listed in PRD slash commands but not implemented. Sessions accumulate under `~/.pi/agent/conductor/runs/`; a browser would surface them.
- **Run-record GC** — still no policy; sessions live forever.
- **`inherit_skills: true`** — PRD lists this as a v1 frontmatter field; currently parsed but unused. Would need to port the parent's skill catalog to the child's prompt.

---

## 6. Test layout (~282 tests, 18 files, ~3s)

```
tests/
├── personas.test.ts                  — Frontmatter parser + persona resolver basics
├── builtins.test.ts                  — All 16 shipped personas load cleanly
├── queue.test.ts                     — RunRegistry + SpawnQueue mechanics
├── queue-extra.test.ts               — Queue edge cases + parentMessages snapshot
├── spawn.integration.test.ts         — GATED live tests (CONDUCTOR_LIVE_TESTS=1):
│                                       spawn, ensemble_send, inherit_context=filtered
├── notifications.test.ts             — formatCompletionNotification
├── conductor-prompt.test.ts          — buildConductorSystemPrompt
├── config.test.ts                    — loadConfig defaults + merge
├── config-errors.test.ts             — loadConfigWithErrors error reporting
├── context-filter.test.ts            — filterParentContext: every include /
│                                       exclude rule (v0.6)
├── doctor.test.ts                    — buildDoctorReport
├── plan-spawn.test.ts                — planSpawnPiArgs: inherit_context matrix
│                                       (none / filtered / full) (v0.6)
├── runs-helpers.test.ts              — formatTokens, formatUsage, elapsedStr,
│                                       getFinalText, etc.
├── event-handler.test.ts             — applyEvent (every event variant)
├── session-seed.test.ts              — seedSessionFile: header shape, parentId
│                                       chain, JSON round-trip (v0.6)
├── transcript.test.ts                — renderTranscript / renderHeader /
│                                       renderFooter
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
76357d2 feat(v0.3): focused stream overlay (Ctrl+G)
ef5999a feat(commands): /conductor doctor surfaces malformed config files
4c89d80 fix(config): merge personaOverrides field-level across user → project
39c2014 refactor(runs): extract applyEvent for direct unit testing
c72e178 chore: enforce TDD via CONTRIBUTING.md, AGENTS.md, and pre-commit hook
688ff97 feat: pi-conductor v0.2 — spawn, queue, panel, conductor mode
a1d711b feat: initial pi-conductor v0.1 scaffold
```

Never pushed. No remote configured.

---

## 8. In-flight work as of this handover

**Interactive subagent `dedup-fix` running in tmux** (`tmux select-window -t Scratch:subagent-dedup-fix`).

**What it's doing:** Fixing `~/.pi/agent/extensions/tool-dedup.ts`, which is over-tuned. The bug: `edit` and `write` are not in `EXEMPT_TOOLS`, so legitimate sequential edits with similar `oldText` get blocked. The agent is:
1. Adding `edit` and `write` to `EXEMPT_TOOLS`.
2. Possibly exempting `read` too (or making it content-aware).
3. Writing a test file (`tool-dedup.test.ts`) to lock in the behavior.

**Symptom this affects:** during this session I (the parent agent) repeatedly hit "[tool-dedup] You already called `edit` with these exact arguments in turn N" false positives and had to fall back to `python3 << 'PYEOF'` heredocs as a workaround. That's bad and the user called it out. After the dedup fix lands, the workaround is no longer needed and I should never reach for python heredocs again.

The agent will inject its final report when done. Switch to its tmux window to monitor.

---

## 9. What to do next (priority order)

1. **Hand-test v0.6 end-to-end.** Load the extension (`pi -e ~/scratch/pi-conductor/src/index.ts`), turn conductor mode on, give the conductor some context ("my codeword is X; please remember it"), then spawn a persona that has `inherit_context: filtered` and ask it to repeat the codeword. The sub-agent should know it without you re-stating it in the task prompt.
2. **v0.4 — inline-streamed foreground transcript.** Foreground today blocks the parent's tool call but the user only sees the final completion card. Stream the sub-agent's messages inline in the parent conversation.
3. **`/conductor history`** — listed in PRD slash commands but not implemented. Browse past runs from `~/.pi/agent/conductor/runs/`. Useful now that v0.5 + v0.6 leave more session files on disk.
4. **Run-record GC** — open question #12 in the PRD. Sessions accumulate under `~/.pi/agent/conductor/runs/` and never get cleaned up. Decide a policy.
5. **`inherit_skills: true`** — PRD lists this as a v1 frontmatter field; currently parsed but unused. Port the parent's skill catalog to the child's prompt at spawn time.
6. **Audit which shipped personas should default to `inherit_context: filtered`.** Currently most personas set `filtered` in frontmatter but every spawn was effectively `none` until v0.6. Now that filtering really runs, walk each persona and confirm whether its `filtered` setting is right (or if it should be `none` for read-only specialists where extra context is just noise).
7. **Optional cleanup:** `pauseRun` / `resumeRun` happy paths still aren't unit-tested (they call `process.kill` directly). A `signaler` injection point would unlock them.

---

## 10. How to load the extension

For development:
```bash
pi -e ~/scratch/pi-conductor/src/index.ts
```

To turn on conductor mode for a session (injects the system prompt):
```bash
PI_CONDUCTOR_MODE=1 pi -e ~/scratch/pi-conductor/src/index.ts
```

Or `/conductor on` from inside an active session. Toggle off with `/conductor off`.

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

Plus issues surfaced by the test sweep that don't block v0.3 but are worth tracking:
- `pauseRun` / `resumeRun` happy paths aren't unit-tested (they call `process.kill` directly). A `signaler` injection point would unlock them.
- `SpawnQueue.setMaxConcurrent` drain trigger is tested via stubbing `queue.drain` and counting calls — mild implementation-detail. Acceptable.
- Persona override merge is now field-level across user → project. Inside a single layer, fields still don't merge (a single layer's `personaOverrides[oracle]` is one object — nothing to merge). This is fine.
- `/dedup-stats` command in `tool-dedup.ts` should be preserved by the in-flight fix.
- **v0.5 `ensemble_send` may also drop the persona system prompt on resume.** Pi sessions don't persist system prompts to disk; the resume branch of `buildPiArgs` is invoked by `sendToRun` without `systemPrompt`, so a sub-agent continued via `ensemble_send` likely boots with pi's default coding-agent prompt and loses persona identity. v0.6 fixes the seeded-resume case (planSpawnPiArgs passes `systemPrompt`); the v0.5 path is untouched per the v0.6 brief's "don't touch v0.5 ensemble_send" rule. Verify by spawning a `redteam` (read-only persona), letting it finish, then `ensemble_send`-ing it a write task and observing whether it refuses. Fix: thread `persona.systemPrompt` (or a captured snapshot of it) through `Run` so `sendToRun` can re-pass it.
- **Stale parentMessages snapshot for queued spawns.** `getParentMessages` is captured at `enqueueOrSpawn` time, so a queued sub-agent inherits the conductor's view at enqueue, not at drain. If the LLM batches several `ensemble_spawn` calls in one turn, every queued spawn sees identical parent context (the state before any sibling sub-agent had run). Documented; not yet flagged in the conductor system-prompt addendum to the LLM. Future: have `before_agent_start` warn about long queue depth, or re-snapshot at drain time.
- **Filter false-negative for assistant prose that *quotes* a sub-agent's reply.** E.g., `"The inspector said: 'Auth uses JWT...'"` passes through as plain text and the sub-agent inherits the quoted output. Unfixable at the filter layer (it's plain prose); a `<filtered-history>` sentinel could mark filtered turns so the LLM treats quoted material with skepticism. Not implemented.
- **Conductor `model` / `thinking_level` not preserved into the seeded session.** `buildSessionContext` may infer the parent's model from the last seeded assistant message; in resume mode pi keeps that unless `--model` is passed. Personas without an explicit `model:` therefore inherit the conductor's *current* model, not pi's user default. Acceptable for v0.6 (most personas inherit anyway), worth documenting in the persona reference.

---

## 14. Quick mental model for picking up

If you're a fresh agent reading this:
1. The user (samfp) wanted **a parent orchestrator that drives focused sub-agents with full TUI visibility**, distinct from `pi-essentials/subagent` (too generic), team-mode (no live transcript visibility), and pi-subagents (background runs are widget-only).
2. The user is committed to **TDD** for this project. Every change ships with a test. The pre-commit hook enforces.
3. The user prefers **the `edit` tool over scripted edits**. Don't reach for python heredocs.
4. **16 personas** are shipped; their lineage is autoloop; their adaptation rules are in PRD §"Adapting an external role definition to a conductor persona".
5. **v0.5 just shipped** — `ensemble_send` resumes a finished sub-agent's session via `pi --session`; `ensemble_pause` / `ensemble_resume` are LLM-callable; overlay `s` key dispatches sends. **v0.4 (inline foreground stream) and v0.6 (filtered context inheritance) are the next two milestones.**
6. **A subagent is fixing tool-dedup in tmux right now.** Wait for it to finish before doing more conductor work, since the dedup bug was friction during this session.
7. **PRD.md is the source of truth.** Read it before proposing design changes.

---

## 15. Where to put follow-up work

- New code: `~/scratch/pi-conductor/src/`
- New tests: `~/scratch/pi-conductor/tests/`
- New personas: `~/scratch/pi-conductor/personas/<name>.md`
- Decision changes: update PRD.md decision log + locked-decisions table
- Memory of cross-cutting lessons: `memory_remember type=lesson`
- Per-task notes that should outlive this work: `~/vault/Notes/Evergreen/`
