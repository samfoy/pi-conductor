# pi-conductor — PRD

**Status:** v0.8 shipped (drafted v0.2).
**Owner:** samfp
**Created:** 2026-05-14
**Last updated:** 2026-05-15

## Locked decisions (v0.7–0.8)

| Decision | Choice | Rationale |
|---|---|---|
| Name | `pi-conductor` | Orchestra metaphor: parent conducts, personas play, audience watches. |
| Tool restrictions | **Not implemented.** | Pi has no clean way to whitelist tools in a child subprocess. Persona `tools:` field dropped from frontmatter. Personas guide tool use via prompt only — no false security. |
| Default spawn mode | **foreground** | Streams inline in the parent conversation as it runs. Background mode still available via explicit `foreground: false`. |
| Notification visibility | **Inline visible** | `<sub-agent-completed>` blocks render in the parent conversation as a folded summary card with persona, status, duration, usage, transcript path, and final result. The user sees them; the LLM acts on them. |
| Pause / resume | **Supported in v1.** | `ensemble_pause` (SIGSTOP) / `ensemble_resume` (SIGCONT). Useful for cost control while the user thinks. |
| Concurrency cap | **Queue.** | When `maxConcurrent` is hit, additional `ensemble_spawn` calls are queued FIFO and start as slots free. The orchestrator gets a `queued` status back so it can choose to wait or proceed. |
| Persona library | Curated 16 starter personas covering the full SDLC, **adapted from external role definitions.** | Each carries the lineage of a battle-tested role (narrow scope, explicit "Do not X" rules, evidence-over-assertion, fresh-eyes framing) but stripped of event-protocol baggage. |
| Foreground-spawn-while-queued | **Auto-downgrade to background.** | When `maxConcurrent` is hit, foreground spawns return `{ status: "queued-as-background", agent_id }` and complete via the standard `<sub-agent-completed>` notification card. The conductor system prompt notes this can happen. |
| Filtered context inheritance | **Reimplement.** | Don't depend on pi-subagents' `shared/fork-context.ts`. Filtering rules are short and stable; owning the implementation is worth the cost. |
| Persona discovery paths | **`~/.pi` subtree only (and project `.pi/`).** | User personas at `~/.pi/agent/conductor/personas/`; project at `<project>/.pi/conductor/personas/`. No XDG, no autoloop-style scattered locations. |
| Foreground cancel UX | **Esc detaches; Ctrl+C kills.** | Implemented via per-spawn `ctx.ui.onTerminalInput` listener (intercepts bare Esc before pi's reserved `app.interrupt` action fires). `awaitOrDetach` race converts a foreground spawn into a background run; Ctrl+C SIGTERMs via the existing `signal.aborted` path. |
| Default model per persona | **Inherit-only.** | Every persona inherits the parent's model and thinking unless explicitly overridden in the persona's frontmatter or in `personaOverrides`. No phase-aware defaults baked in. Install never references a model the user hasn't configured. |
| Conductor mode at extension load | **OFF by default (v0.8).** Was ON in v0.7. | The strict-overseer §1 addendum is intentionally prescriptive ("you are not the implementer"); injecting it without an explicit signal would surprise every loaded session. Conductor mode is now opt-in via `defaultMode: "on"` in config (`~/.pi/agent/extensions/conductor/config.json`), `PI_CONDUCTOR_MODE=1` in env, or `/conductor on` per-session. Precedence: project config > user config > env var > built-in default `off`. |
| Foreground stream width | **Live terminal columns**, clamped to [40, 240], default 100. | Width is captured once at spawn start and frozen for the duration of the spawn (no SIGWINCH-induced flicker). The focused-stream overlay (Ctrl+G) is the source of truth for full live-resizable viewing. |

## TL;DR

A pi extension that turns the parent pi session into an **orchestrator** which drives a roster of **persona-based sub-agents** covering the full SDLC — from clarification and design through planning, implementation, review, and verification. The novel piece versus existing extensions (`pi-mono/team-mode`, `pi-subagents`) is **first-class TUI visibility**: the user can watch any sub-agent stream live inside pi — no tmux switch, no "ssh into the worker," no log file tailing. The orchestrator stays in the chat, the user can drop into any sub-agent's live view at will, and personas are markdown files with configurable model, thinking, and system prompt.

It does **not** replace `pi-essentials/subagent` — that extension stays as the lightweight fire-and-forget background runner. `pi-conductor` is the heavyweight, conversation-led, fully-observable counterpart for SDLC work.

## Why

Today's options each leave a gap:

| Tool | Gap |
|---|---|
| `pi-essentials/subagent` (current) | Generic — no personas, no orchestration, transcript only via final return string |
| `pi-mono/team-mode` | Excellent coordination, but worker visibility is final-message-only; you watch *progress*, not *thought* |
| `pi-subagents` | Foreground streams in chat (good) but background runs are status-widget-only; no way to *focus* on one sub-agent |

The user's goal: **see exactly what each subagent is doing, when they're doing it, without leaving pi's TUI.** That visibility is the differentiator. Everything else (personas, model config, full-SDLC roster) follows the patterns the reference extensions have already validated.

## Goals

1. **Orchestrator-as-conversation** — the parent pi session is the conductor. The user talks to the conductor; the conductor decides when to spawn personas.
2. **Full-SDLC persona library** — markdown files with frontmatter (`model`, `thinking`, `system_prompt`, `inherit_context`, `worktree`). Project-level + user-level layering. Coverage from clarification → design → plan → build → review → finalize, plus specialist callouts (oracle, redteam, profiler, investigator, scribe, etc.).
3. **Live, in-TUI sub-agent visibility** — three modes: a multi-agent dashboard widget (always-visible), a per-agent focused stream view (drilldown), and a transcript browser (history).
4. **Configurable, not opinionated workflows** — personas are pluggable; orchestration is up to the LLM + user. The conductor system prompt suggests common shapes (`clarifier → designer → planner → builder → critic → finalizer` for greenfield work; `investigator → strategist → fixer → verifier` for debugging) but does not enforce them.
5. **Coexist with `pi-essentials/subagent`** — different tool names, different mental model, no collision.

## Non-goals

- Not replacing Ralph (in-session hat choreography) or autoloop (overnight CLI loops).
- Not a TODO-DAG / shared task graph (team-mode does that). Conductor's coordination is via natural-language synthesis between waves, not formal dependencies. (Could add later.)
- Not a quality-gate hook framework (team-mode's `taskCompletedHook`). Could add later.
- Not a worktree manager. Worktree support per persona may come in v2; v1 runs in cwd.
- Not multi-coordinator / nested ensembles. One conductor, one ensemble.
- **Not enforcing tool restrictions.** Personas describe expected tool usage in their prompts; the runtime does not gate access. (Pi's extension API doesn't expose this cleanly. Documented honestly rather than faked.)

## Personas

### File format

```
~/.pi/agent/conductor/personas/<name>.md   # user-level
<project>/.pi/conductor/personas/<name>.md # project-level (overrides user)
```

Project overrides user. Names must be unique within scope. **No other discovery paths.**

```markdown
---
name: oracle
description: Second-opinion / drift-check before committing to an approach
model: anthropic/claude-sonnet-4
thinking: high
inherit_context: filtered                  # none | filtered | full
inherit_skills: false
default_reads:                             # files auto-read on launch (relative to cwd)
  - plan.md
  - progress.md
worktree: false
timeout_minutes: 60
---

You are the oracle: a high-context decision-consistency subagent.
…full system prompt body…
```

Frontmatter fields (v1):

| Field | Type | Default | Notes |
|---|---|---|---|
| `name` | string | — | Required, unique per scope |
| `description` | string | — | Shown in `/conductor list`, used by orchestrator prompt |
| `model` | string | **parent's model (inherited)** | Provider-qualified ID, e.g. `anthropic/claude-sonnet-4`. Omit to inherit. |
| `thinking` | enum | **parent's thinking (inherited)** | `off|minimal|low|medium|high|xhigh`. Omit to inherit. |
| ~~`tools`~~ | — | — | **Removed.** Pi has no clean way to whitelist tools in a child subprocess. Persona prompts may describe tool boundaries but they are not enforced. |
| `inherit_context` | enum | `filtered` | `none` (fresh), `filtered` (parent prose, no orchestration tool calls), `full` |
| `inherit_skills` | bool | `false` | Pass parent's skill catalog to child |
| `default_reads` | list | `[]` | Files auto-prefixed to the launch prompt as context |
| `worktree` | bool | `false` | v2 |
| `timeout_minutes` | number | 60 | Hard kill |

### Built-in starter personas (shipped with the extension)

**16 personas covering the full SDLC**, organized by phase. Each carries the lineage of a battle-tested role definition (narrow scope, explicit "Do not X" rules, evidence-over-assertion, fresh-eyes framing) but stripped of event-protocol baggage (`emit X.ready`, `STATE_DIR/progress.md` shared files) so they work as one-shot callouts the conductor synthesizes between.

#### Discovery / pre-work

| Persona | Lineage | Purpose |
|---|---|---|
| `inspector` | autoideas/scanner | Broad codebase recon — survey files, prioritize areas, find entry points. Read-only. |
| `analyst` | autoideas/analyst | Deep-dive one area; produces structured suggestions (What/Where/Why/How/Risk/Counterargument/Confidence). Read-only. |
| `cartographer` | autospec/clarifier + researcher | Builds `context.md` + `meta-prompt.md` for a downstream task. Writes only those artifacts. |

#### Specification / design

| Persona | Lineage | Purpose |
|---|---|---|
| `clarifier` | autospec/clarifier | Turn a vague request into concrete acceptance criteria; surface ambiguity before design. |
| `designer` | autospec/designer | System design and architecture decisions before implementation. Writes a design document. |
| `oracle` | autospec/critic + new framing | Decision-consistency check / drift detector. Reviews a plan or proposed approach. No edits. |

#### Implementation

| Persona | Lineage | Purpose |
|---|---|---|
| `planner` | autocode/planner | Break an approved design into ordered, atomic slices. Writes plan, no code. |
| `builder` | autocode/build | Implement exactly one slice with verification + commit. Returns evidence. |
| `simplifier` | autosimplify/simplifier + scoper | Apply small, safe, scoped simplifications. May edit. |

#### Review / verification

| Persona | Lineage | Purpose |
|---|---|---|
| `critic` | autocode/critic | Per-slice review with **novel verification + smoke test**. Default to rejection when evidence is incomplete. No edits. |
| `redteam` | autoreview/checker | Adversarial review of a diff or proposal — try to break it, demand evidence. No edits. |
| `finalizer` | autocode/finalizer | Whole-task completeness gate. Stricter than critic about end-to-end outcome and clean repo state. |
| `verifier` | autosimplify/verifier | Independent verification of a claimed change — re-runs strongest available checks plus one novel check. |

#### Debugging

| Persona | Lineage | Purpose |
|---|---|---|
| `investigator` | autodebug/investigator | Bug root-cause hunt: Phase 0 (reframe "why doesn't X work" into concrete bug statement) → Phase 1 (reproduce + trace) → Phase 2 (pattern analysis). No fixes. |

#### Other

| Persona | Lineage | Purpose |
|---|---|---|
| `profiler` | autoperf/profiler | Identify performance hot paths and baseline measurements. No optimization, no edits. |
| `scribe` | autodoc/writer | Documentation drafting (READMEs, docstrings, PRDs). |

### Suggested orchestration shapes (not enforced)

The conductor system prompt teaches — but does not require — these shapes:

```
Greenfield feature
  clarifier → (cartographer | inspector) → designer → oracle →
    planner → [builder → critic]×N → finalizer

Bugfix
  investigator → oracle → builder → critic → verifier

Large refactor
  inspector → analyst → designer → oracle →
    planner → [simplifier → critic]×N → finalizer

Review-only
  redteam | critic | oracle  (often in parallel)

Perf work
  profiler → oracle → builder → verifier
```

The LLM picks the shape; the user can override.

### Persona families NOT yet adapted (mineable for v1.x)

If you want a persona we don't ship, the source persona files are in `<autoloop>/presets/<preset>/roles/*.md` (or write new ones). Confirmed easy to mine:

- **Debugging:** `strategist` (hypothesis-and-testing), `fixer` (Phase-4 fix), `verifier` (Phase-5 quality gate)
- **Security:** `scanner`, `analyst`, `hardener`, `reporter`
- **Performance:** `measurer`, `optimizer`, `judge` (full perf loop beyond just `profiler`)
- **Docs:** `auditor`, `checker`, `publisher`
- **Review extras:** `reader`, `suggester`, `summarizer`
- **Spec extras:** dedicated `researcher` (we folded researcher into cartographer)
- **Ideas:** `synthesizer` (compile findings across analysts)

Use the adaptation guide below; add to `~/.pi/agent/conductor/personas/` and they show up in `/conductor list`.

### Adapting an external role definition to a conductor persona

Adapting a role definition (e.g. one of the autoloop roles in §"Persona families NOT yet adapted") to a conductor persona is mechanical:

1. **Strip event emissions.** Replace `emit tasks.ready` / `emit review.passed` etc. with "return your findings as a final message" or "write to `<output_file>` and return a summary."
2. **Strip `STATE_DIR/*.md` references.** Either replace with `default_reads:` frontmatter (so the file is auto-prepended on launch) or scope the persona to single-shot work that doesn't need persistent shared state.
3. **Strip topology / handoff rules.** Conductor personas don't hand off to other personas — they return to the conductor, which decides what to call next.
4. **Keep the role discipline.** The "Do not investigate. Do not implement. Do not skip the failing test." framing is the value prop. Preserve it verbatim where possible.
5. **Keep the verification rigor.** Phrases like *"Default to rejection when evidence is incomplete"*, *"Perform at least one verification the builder did NOT perform"*, *"Working as designed is almost never the correct conclusion"* are gold — port them.
6. **Adjust the emit-only-this-event final rule** to a return-format spec: e.g. "Return your review as `## Review` followed by `Correct/Fixed/Blocker/Note` bullets with file paths and line numbers."

Document the adaptation in a `## Source` footer in each persona file so users can trace lineage and pick up upstream improvements:

```markdown
## Source
Adapted from a role definition with the following changes: dropped event emissions,
dropped shared-state-file conventions, kept the role discipline and verification rigor.
```

## Tools the conductor exposes

```
ensemble_spawn(persona, task, [foreground])
  → returns { agent_id, status }
  - persona: string (must exist in resolved persona registry)
  - task: string (the prompt; default_reads are auto-prepended)
  - foreground: bool (default TRUE)
      true  → block parent; stream sub-agent into the chat as it runs
      false → run in background; live-update the ensemble panel
  - status return values: "running" | "queued" (when maxConcurrent is hit) | "failed-to-start"

ensemble_send(agent_id, message)
  → continue an existing sub-agent's session (full prior context).
    Works for finished sub-agents too — resumes via pi --session.

ensemble_status([agent_id])
  → poll-style status for the orchestrator (dashboard auto-updates anyway)

ensemble_pause(agent_id)
  → SIGSTOP the sub-agent process; record paused timestamp.
    Useful for cost control while the user reviews partial output.

ensemble_resume(agent_id)
  → SIGCONT the sub-agent process; clear paused timestamp.

ensemble_focus(agent_id)
  → orchestrator-side hint to switch the user's TUI into the focused view
    (the user can do this themselves via keybinding; this lets the LLM suggest)

ensemble_stop(agent_id)
  → kill a running sub-agent

ensemble_list()
  → list available personas with descriptions
```

### Spawn lifecycle

- **Foreground (default):** parent blocks. Sub-agent JSON stream is rendered inline in the conversation as it arrives. On exit, the inline rendering is replaced with a folded `<sub-agent-completed>` summary card the user can expand. The conductor's turn continues with the sub-agent's final result available as the tool's return value.
  - **Esc** during streaming: detach to background. The inline stream collapses to a status line ("→ detached to background, watch in ensemble panel"); the sub-agent keeps running; completion arrives as the standard background notification card.
  - **Ctrl+C** during streaming: SIGTERM the sub-agent. The inline stream collapses to a `killed` notification card; the parent's turn ends. The LLM sees the killed status and reacts.
- **Background (`foreground: false`):** parent does not block. Sub-agent runs; ensemble panel updates live. On exit, a `<sub-agent-completed>` user-role message is pushed via `pi.sendMessage({ triggerTurn: true })` (team-mode's pattern), waking the conductor.
- **Queued (concurrency cap hit):**
  - For **background** spawns: returns `{ status: "queued", queue_position: N, agent_id }` immediately. Sub-agent is enqueued FIFO. When a slot opens, it starts and emits the standard completion notification.
  - For **foreground** spawns: **auto-downgrades to background.** Returns `{ status: "queued-as-background", queue_position: N, agent_id }` immediately. The conductor's turn continues; when a slot opens, the sub-agent runs; completion arrives as a notification card. The conductor system prompt explicitly notes this auto-downgrade can happen and instructs the LLM to handle it gracefully (no second spawn, no panic).
- **Paused:** sub-agent is alive but not consuming tokens. Pause/resume is reflected in the ensemble panel as `⏸ paused` and counts against `maxConcurrent` (it's still a running sub-agent, just stopped).
- **`ensemble_send` bypasses the concurrency cap.** A send is a *resume*, not a new spawn — queueing it would hang the conductor's foreground tool call until an unrelated sub-agent finishes, which is worse UX than just running it. The conductor system prompt instructs the LLM not to fan out parallel sends to the same sub-agent. Sends still respect status gating (running/paused/queued sub-agents are rejected).

## TUI surface (the differentiator)

Three coordinated views. All powered by `ctx.ui.custom()` overlays + `ctx.ui.setWidget()` panels.

### 1. Ensemble panel (always visible when ≥1 sub-agent is active)

`belowEditor` widget. Compact one-line-per-sub-agent rendering:

```
● oracle           45s   ↻ reading src/auth/validate.ts          [3t ↑12k ↓2k $0.04]
● redteam          1m22s ↻ running git diff --stat               [5t ↑18k ↓3k $0.06]
○ inspector (done) 3m04s ✓ returned                              [8t ↑44k ↓6k $0.18]
```

- Status glyph: `●` running, `○` done, `✗` failed, `⏸` paused
- Live activity hint: latest tool call shortened (current `subagent.ts` already does this)
- Usage: turns / tokens / cost
- Keybinding hint at bottom: `Ctrl+E` open ensemble overlay · `Ctrl+G` go to focused view

### 2. Focused stream overlay (Ctrl+G or `ensemble_focus`)

Full-screen overlay that shows **the live transcript of one sub-agent** as if you were running pi directly in that session. Renders the same stream pi normally renders for the parent: assistant text, tool calls (collapsed by default, expandable), tool results, thinking blocks (toggleable).

Controls inside the overlay:
- `Tab` cycle to next sub-agent
- `Esc` return to parent conversation
- `s` send a one-shot message to this sub-agent (equivalent to `ensemble_send`)
- `k` kill this sub-agent
- `↑/↓ PgUp/PgDn` scroll transcript
- `c` collapse/expand all tool calls
- `t` toggle thinking blocks visibility

Implementation: each sub-agent's JSON stream from `pi --mode json -p` is parsed not just for status but also rendered as a Component. Same parser as `pi-essentials/subagent.ts` already has — we just keep the messages around and render them.

### 3. Ensemble overlay / dashboard (Ctrl+E)

Multi-agent dashboard. List of running and recently-finished sub-agents with selectable rows. Selecting a row opens that sub-agent's focused stream view (#2). Also shows aggregate cost, total tokens, total elapsed.

Controls:
- `↑/↓` move selection
- `Enter` open focused view for selected sub-agent
- `r` rerun a finished sub-agent (with same prompt)
- `Esc` close

### 4. Inline completion card (always visible to user)

When any sub-agent ends — foreground or background — a folded summary card renders inline in the parent conversation. Collapsed by default; click/key to expand.

**Collapsed view:**
```
┌─ ✓ oracle (2m14s)  3t  ↑12k ↓2k  $0.04 ────────────────────┐
│ Recommended: defer the migration; current trajectory will  │
│ violate the CSDR2 invariant. [expand]                      │
└────────────────────────────────────────────────────────────┘
```

**Expanded view:**
```xml
<sub-agent-completed>
  <agent-id>oracle-7f3a</agent-id>
  <persona>oracle</persona>
  <status>completed</status>
  <duration>2m14s</duration>
  <usage><turns>3</turns><input>12000</input><output>2000</output><cost>0.04</cost></usage>
  <result>
    …final assistant text from the sub-agent…
  </result>
  <transcript>~/.pi/agent/conductor/runs/oracle-7f3a/transcript.jsonl</transcript>
</sub-agent-completed>
```

- **For background sub-agents:** the card is injected via `pi.sendMessage({ triggerTurn: true })` so the conductor reacts. The user sees the same card.
- **For foreground sub-agents:** the inline streaming output is replaced with the card on exit. The conductor's turn continues; the result is also returned as the tool call's return value so the LLM has it without re-parsing the XML.

Identical XML shape to team-mode's `<task-notification>`. The user has validated this pattern works for keeping the LLM aware of completions; we just additionally render it as a visible card instead of as raw XML.

## Orchestrator behavior

When the extension is loaded **and** the env var `PI_CONDUCTOR_MODE=1` is set (or a slash command `/conductor on` is run), the parent session receives an additional system prompt that teaches it:

1. The personas available, their descriptions, and when to reach for each.
2. That `ensemble_spawn` is fire-and-forget by default — after launching, end the turn; results arrive as `<sub-agent-completed>` messages.
3. To synthesize sub-agent findings rather than restating them.
4. To prefer parallel fan-out for read-only personas (`inspector`, `oracle`, `redteam`) and serial for write-capable personas.
5. Never to call sub-agents for trivial work the conductor can do directly.

The prompt is loaded from `<extension>/prompts/conductor.md` and is overridable at user/project level.

Without `PI_CONDUCTOR_MODE=1`, the tools are still available but no system prompt is injected — manual mode for users who want pi to call `ensemble_spawn` only when explicitly asked.

## Persistence

```
~/.pi/agent/conductor/
├── personas/                       # user-level personas
│   └── <name>.md
├── runs/<agent-id>/
│   ├── record.json                 # persona, prompt, status, usage, timestamps
│   ├── transcript.jsonl            # full streamed JSON events from pi --mode json
│   └── final.md                    # final assistant text
└── settings.json                   # default model overrides, persona disables
```

Transcripts live forever (until manually cleaned). Useful for `/conductor history` browsing.

## Slash commands

```
/conductor on | off              # toggle PI_CONDUCTOR_MODE for this session
/conductor list                  # list personas (with resolution: user vs project vs builtin)
/conductor show <persona>        # cat the persona file
/conductor spawn <persona> ...   # equivalent to ensemble_spawn (manual)
/conductor status                # all running + last 5 finished
/conductor focus <agent-id>      # open focused stream view
/conductor pause  <agent-id|all> # SIGSTOP
/conductor resume <agent-id|all> # SIGCONT
/conductor stop   <agent-id|all> # kill
/conductor queue                 # show the spawn queue
/conductor history               # browse past runs
/conductor doctor                # health check (parsable persona files, models resolvable)
```

## Keybindings

| Keys | Action |
|---|---|
| `Ctrl+E` | Open ensemble overlay |
| `Ctrl+G` | Open focused stream view (defaults to most-recently-active sub-agent) |
| `Ctrl+Shift+S` | Quick spawn (interactive picker: persona → prompt) |

All overridable via the standard pi keybindings file.

## Settings

`~/.pi/agent/extensions/conductor/config.json` (or project `.pi/conductor.json`):

```jsonc
{
  // defaultModel / defaultThinking are reserved for a future milestone.
  // The shipped default is to inherit from the parent session.
  "defaultMode": "off",                  // v0.8: "on" | "off". Pinned
                                         // conductor mode at extension load.
                                         // Beats PI_CONDUCTOR_MODE env var.
  "defaultTimeoutMinutes": 60,
  "maxConcurrent": 4,
  "queueOnConcurrencyCap": true,         // false = reject instead
  "autoOpenFocusOnSpawn": false,
  "defaultSpawnMode": "foreground",      // "foreground" | "background"
  "personaOverrides": {
    "redteam": { "disabled": true },
    "oracle":  { "model": "anthropic/claude-opus-4-1", "thinking": "high" }
  },
  "conductorPromptPath": null
}
```

## Coexistence rules

- Tool names are namespaced `ensemble_*` to avoid collision with `pi-essentials/subagent`'s `subagent` tool.
- `pi-essentials/subagent` remains the right choice for one-off "go investigate this in the background while I keep coding" calls — no persona, no overhead.
- Conductor is the right choice when you want a *bench* of named experts you'll likely call multiple times in a session, with full visibility into each.

Both can be loaded simultaneously. The orchestrator system prompt explicitly notes both tools exist and explains when to reach for each.

## Architecture

### Process model

- **Sub-agents are subprocesses** spawned with `pi --mode json -p [--session <path>]`.
- Background mode: parent gets a streaming JSON parser, accumulates messages in memory, writes them to disk (transcript.jsonl), updates ensemble panel state, on exit pushes the `<sub-agent-completed>` notification.
- Foreground mode: same subprocess, but parent blocks and streams JSON events through a transformer that emits them as if they were the parent's own output, then unblocks at exit.

### Why subprocess, not in-process

- Same as team-mode's reasoning: separate context windows, can use different models per persona, pi already supports `--mode json -p` cleanly, and crash isolation.
- A `transient` (in-process via `createAgentSession()`) mode is a v2 option for very fast read-only personas (`inspector`).

### Stream parser

Reuse the JSON event parser from `pi-essentials/subagent.ts` (`turn_start`, `tool_call_start`, `tool_call_complete`, `assistant_message`, etc.). Keep messages in a per-agent `Message[]` so the focused-view renderer can display them. The renderer is a TUI Component implementing `render(width)`.

### Context inheritance (`filtered` mode)

When `inherit_context: filtered`, before launching the sub-agent we serialize a filtered slice of the parent's session:

- **Include:** user prose, assistant prose, file reads/writes (so the sub-agent doesn't re-read what's already known), the explicit task prompt.
- **Exclude:** prior `ensemble_*` tool calls and their results, `subagent` tool calls, slash commands, control notices, status messages, any `<sub-agent-completed>` cards.
- **Exclude (defensive):** anything tagged `parent-only` in metadata; the conductor system-prompt block.

**We reimplement this filter rather than depending on `pi-subagents/shared/fork-context.ts`.** Filtering rules are short and stable; owning the implementation avoids a dependency that may diverge. Spec'd as a pure function `filterParentContext(messages: Message[], opts) → Message[]` with unit tests covering each include/exclude rule.

### Tool restriction in personas

*Not implemented.* Pi has no clean way to whitelist tools in a child subprocess; faking it would mislead users. Persona prompts may describe tool boundaries but they are not enforced.

## Implementation phases

### v0.1 — Skeleton (this PRD + extension scaffold) — _shipped_
- Extension scaffold (TypeScript, single file or small module set).
- Persona file loader (frontmatter + body parser).
- `ensemble_list`, `ensemble_status` tools.
- Ensemble panel (read-only, no spawn yet).

### v0.2 — Background spawning — _shipped_
- `ensemble_spawn(foreground=false)` only.
- Live ensemble panel updates from JSON stream.
- `<sub-agent-completed>` notifications.
- `/conductor list`, `/conductor status`, `/conductor doctor`.
- 16 built-in personas as markdown files.

### v0.3 — TUI focused view — _shipped_
- Focused stream overlay (Ctrl+G).
- Transcript rendering (assistant text, tool calls collapsed, thinking toggleable).
- `ensemble_focus`, `/conductor focus`.

### v0.4 — Foreground spawning — _shipped_
- `ensemble_spawn(foreground=true)` streams inline in parent conversation via throttled `onUpdate`.
- Auto-collapse on completion to a compact 1–3 line summary block.
- Live terminal width (`process.stdout.columns`, clamped to [40, 240]).

### v0.5 — Send / continue / kill — _shipped_
- `ensemble_send` (continue any sub-agent's session, including finished ones via `pi --session`).
- `s` keybinding inside focused view to send.
- `ensemble_pause` / `ensemble_resume` (SIGSTOP / SIGCONT) as LLM-callable tools.
- Resumable sessions on disk.

### v0.6 — Context inheritance — _shipped_
- `inherit_context: filtered` (reimplemented in-tree, not ported from pi-subagents).
- `inherit_context: full` for whole-transcript handoff.
- `<filtered-history>` sentinel when the seeded transcript is filtered.

### v0.7 — Cancel UX + history + on-by-default — _shipped_
- Esc detaches a foreground spawn into the background (PRD-locked Foreground cancel UX). Implemented via per-spawn `ctx.ui.onTerminalInput` listener; pi's reserved `app.interrupt` keybinding cannot be overridden.
- `/conductor history [N]` browses past runs from `~/.pi/agent/conductor/runs/`.
- Conductor mode ON by default at extension load (`PI_CONDUCTOR_MODE=0` is the new opt-out). _Reversed in v0.8._
- Conductor system prompt addendum gains §10 — proactive delegation triggers.

### v0.8 — Strict-overseer mode + default off — _shipped_
- **Conductor mode OFF by default** at extension load (overrides v0.7's ON-by-default).
- New config field `defaultMode: "on" | "off"` (default `"off"`) in `~/.pi/agent/extensions/conductor/config.json` and project `.pi/conductor.json`.
- Precedence: project config > user config > `PI_CONDUCTOR_MODE` env var > built-in default `off`.
- System-prompt addendum §1 rewritten as **strict-overseer** mode: explicit "you are not the implementer", banned tools list (no `edit`/`write`/non-orientation `bash`), narrow exceptions enumerated, slip-detection check.
- §10 reframed as "delegation playbook" — pattern→persona mapping, fan-out vs chain guidance, slip antipattern callout.
- Slash commands `/conductor on|off`, env var `PI_CONDUCTOR_MODE=1|0`, persona resolution, queue, panel, tools — all unchanged.

### v0.9 — Run-record GC capstone — _shipped_
- Two-tier reclaim (cold-archive then delete) gated by D1–D8 (see decision log).
- Triggers: auto on `session_start` (debounced 6h), manual `/conductor gc [--dry-run] [--force] [--persona=<name>] [--verbose]`, pre-shutdown reconcile of orphaned `running` records.
- User-pinning sidecar (`.pinned`) opts runs out of both tiers; doctor disk-usage surface; history annotations (`pinned` / `archived`).
- 8 slice commits `4f68833..fa5aff0`; design `docs/v0.9-gc-design.md`. Closes open-question #12.

### v0.10 — Sub-agent watchdog — _shipped_
- Pure detector (`src/watchdog.ts`) with two thresholds expressed as one primitive: soft (default 120s) emits `<sub-agent-stalled>` advisory; hard (default 600s) escalates to `forceTerminate` only when `kill_on_stall: true` was set on the spawn (default OFF). Tick interval 30s. Detector ignores paused / terminal / queued runs and respects an initial grace window.
- Per-spawn args `kill_on_stall: bool` and `stall_threshold_seconds: int` on `ensemble_spawn` and `ensemble_send` (cascade: per-call > project config > user config > built-in default; persona-frontmatter layer deferred). `Run.stalledSince` is in-memory only (not persisted to `record.json`).
- UX surfaces: ensemble-panel `· STALLED Ns` glyph, `/conductor watchdog status` slash subcommand, doctor surface lists active stalls + thresholds + tick interval.
- 4 slice commits `c8623cb..4734298`; design `docs/v0.10-watchdog-design.md`. Closes the witnessed `critic-yjsn` / `builder-z98m` / orchestrator-`npm test` hang class.

### v0.9.x — Post-startup reconcile of orphaned `running` records — _shipped_
- Detection: `classifyRecord(record, isAlive, now)` 5-branch decision (`skip-terminal` / `readopt` / `reclassify-killed` / `reclassify-failed-queued` / `reclassify-pre-schema`). Liveness via `kill(pid, 0)` (`defaultLivenessProbe`); EPERM treated as alive.
- Schema bump: `pid?: number` on `Run` and `RunRecord`. Captured at `spawnRun`, persisted via `toRunRecord`.
- Lifecycle: `setImmediate(reconcileOrphansAtStartup)` runs at `session_start` ahead of GC's existing `setImmediate(maybeAutoRunGc)` per design §4.
- Reuses existing `killed` `RunStatus` with `errorMessage` prefix `"orphaned: ..."` as discriminator (design Q1) — no new RunStatus value, avoids consumer-audit churn.
- UX: `## Post-startup reconcile` doctor section, `/conductor reconcile [--dry-run]` slash subcommand, `⎘ orphaned:` glyph in history rendering.
- 4 slice commits `d5583be..1f9604a`; design `docs/v0.9.x-post-startup-reconcile-design.md`. Closes the witnessed `critic-my33` orphaning class from pi-dashboard restart during v0.11 slice 2.

### v0.10+ — v2 ideas — _planned_
- Run-record GC (open question #12).
- `inherit_skills: true` (port parent skill catalog into child prompt).
- Worktree per persona (`worktree: true` in frontmatter).
- Quality gates (`on_complete_hook` per persona).
- Transient (in-process) runtime for read-only personas.
- Project-shareable persona library (a "marketplace" of `.md` files).
- Sub-agent → conductor mid-run messaging (analogous to pi-intercom).

## Open questions

All release-blocking questions through v0.7 are resolved. Remaining items are v1.x decisions that don't gate any current milestone.

1. ~~Naming.~~ **Resolved:** `pi-conductor`.
2. ~~Tool restriction enforcement.~~ **Resolved:** dropped; pi has no clean mechanism, and we don't fake it.
3. ~~Foreground vs background default.~~ **Resolved:** foreground default.
4. ~~Notification rendering.~~ **Resolved:** inline visible folded card.
5. ~~Persona tool inheritance.~~ **Resolved (moot):** no tool restrictions.
6. ~~Pause / resume.~~ **Resolved:** shipped in v0.5 via SIGSTOP/SIGCONT, exposed as `ensemble_pause` / `ensemble_resume` tools and `/conductor pause` / `resume` slash commands.
7. ~~Foreground spawn that gets queued.~~ **Resolved:** auto-downgrade to background.
8. ~~Filtered context inheritance — port or reimplement?~~ **Resolved:** reimplement; shipped in v0.6.
9. ~~Persona discovery paths.~~ **Resolved:** `~/.pi/agent/conductor/personas/` and project `.pi/conductor/personas/` only.
10. ~~Foreground cancellation UX.~~ **Resolved + shipped (v0.7):** Esc detaches via per-spawn `onTerminalInput`; Ctrl+C kills via `signal.aborted`.
11. ~~Default model per persona phase — phase-aware or inherit?~~ **Resolved:** inherit-only. Shipped persona files never set `model` or `thinking`; users override per-persona in `personaOverrides`. No phase-aware defaults baked into the package.
12. ~~**Resumable sessions for finished sub-agents.**~~ **Resolved (v0.9, 2026-05-19):** Two-tier reclaim shipped — cold-archive (`unlink transcript.jsonl`, keep `record.json` / `final.md` / `session/`) preserves `ensemble_send` resumability for the `gc.completedTtlDays` window (default 30); full-delete frees the `runs/<id>/` dir after the window AND already-archived AND unpinned. Triggers: auto on `session_start` (debounced 6h), manual `/conductor gc [--dry-run] [--force] [--persona=<name>] [--verbose]`, and pre-shutdown reconcile of orphaned `running` records. User-pinning sidecar (`.pinned`) opts a run out of both tiers. Doctor surface (`d77afbf`) and dry-run plan (`e0fb122`) make eviction predictable. See `docs/v0.9-gc-design.md` and decision log entries D1–D8 below.
13. **Worktree isolation per persona** (deferred to v2). When implemented: which personas default `worktree: true`? `builder` and `simplifier` are the obvious ones (write-capable, can run in parallel). Read-only personas should always be `false`.
14. **Project-shareable persona library.** A vault-style "marketplace" of `.md` persona files — install via `/conductor install <url>`? *v2.*
15. **`inherit_skills: true`.** Currently parsed from frontmatter but unused. Implementation would port the parent's skill catalog into the child's prompt at spawn time. *Open — v0.8+.*
16. ~~**Persona `inherit_context` audit.**~~ **Resolved (v0.8.1, commit `423f500`):** 7 read-only specialists flipped to `inherit_context: none` (`oracle`, `redteam`, `inspector`, `analyst`, `profiler`, `scribe`, `verifier`); 9 trajectory-needers stayed `filtered` (`clarifier`, `cartographer`, `designer`, `planner`, `builder`, `simplifier`, `critic`, `finalizer`, `investigator`). Audit table pinned by `tests/personas.test.ts`. See `docs/v0.8.1-item1-design.md` §5 for per-persona rationale.
17. **Conductor `model` / `thinking_level` not preserved into seeded sessions.** Acceptable today (most personas inherit anyway). Worth documenting in the persona reference.

## Validation plan

1. **Smoke test**: spawn `inspector` on the Rosie codebase, watch the panel update, see the final report land as `<sub-agent-completed>`.
2. **Parallel fan-out**: ask the conductor to run `inspector` + `oracle` + `redteam` on a proposed change. Verify all three appear in the panel; verify Ctrl+G drilldown works for each; verify completions arrive in any order without confusing the conductor.
3. **Persona override**: define a project-local `oracle` that overrides the user-level one with a different model. Verify resolution.
4. **Coexistence**: load both `pi-essentials/subagent` and `pi-conductor`; verify the LLM picks the right tool for "investigate X in the background" (subagent) vs "have oracle review my plan" (conductor).
5. **Long-running survival**: spawn a 20-minute `cartographer` run, do other work in the parent, verify panel updates throughout, verify completion lands cleanly.

## Risks

- **TUI complexity.** The focused-stream overlay is the centerpiece and the most complex piece of code. Mitigation: lift the stream parser from `pi-essentials/subagent.ts`, lift the rendering primitives from pi's own message renderer.
- **Context inheritance bugs.** Filtering parent context to send to the child is subtle (pi-subagents has a whole module for this). Mitigation: in v0.6, start with `inherit_context: none`, add filtered later.
- **Tool restriction may be prompt-only.** See open question #2. If so, document clearly and don't pretend it's a security boundary.
- **Cost surprises.** Multiple sub-agents in parallel with `thinking: high` can rack up cost fast. Mitigation: ensemble panel shows running cost; settings cap `maxConcurrent`; doctor warns if all personas use high-thinking large models.

## Decision log

- 2026-05-14 — Codename `pi-conductor` confirmed.
- 2026-05-14 — Will not replace `pi-essentials/subagent`; coexistence via `ensemble_*` tool namespace.
- 2026-05-14 — Sub-agents are subprocesses (subprocess pi --mode json -p); transient/in-process is a v2 option.
- 2026-05-14 — **Foreground by default** (was background). Background via `foreground: false`.
- 2026-05-14 — **Tool restrictions dropped.** Pi has no clean enforcement; persona `tools:` field removed; personas describe expected tool boundaries in prompt only.
- 2026-05-14 — **Pause/resume supported in v1** via SIGSTOP/SIGCONT.
- 2026-05-14 — **Concurrency cap = queue (FIFO)**, not reject. Foreground-while-queued behavior still TBD (open Q #7).
- 2026-05-14 — **Inline-visible folded completion cards** for both foreground and background sub-agents. User sees them; LLM acts on them.
- 2026-05-14 — Starter persona library = 16 personas covering the full SDLC, organized by phase: discovery (inspector, analyst, cartographer); spec/design (clarifier, designer, oracle); implementation (planner, builder, simplifier); review/verification (critic, redteam, finalizer, verifier); debugging (investigator); other (profiler, scribe). Adaptation rules and unadopted families documented in §Personas.
- 2026-05-14 — **Foreground spawn that gets queued auto-downgrades to background** (returns `queued-as-background` with `agent_id`; completion arrives as standard notification card).
- 2026-05-14 — **Filtered context = reimplemented**, not ported from `pi-subagents/shared/fork-context.ts`.
- 2026-05-14 — **Persona discovery limited to `~/.pi` subtree** (user) and project `.pi/conductor/personas/`. No XDG / no scattered locations.
- 2026-05-14 — **Foreground cancel UX:** Esc → detach to background; Ctrl+C → kill.
- 2026-05-14 — **Default model per persona = inherit-only.** Shipped persona files never set `model` or `thinking`; phase-aware defaults rejected to keep installs portable across provider configs. Users override per-persona in `personaOverrides`.
- 2026-05-15 — **v0.4 + v0.5 + v0.6 shipped.** Inline-streamed foreground transcript (throttled `onUpdate`), `ensemble_send` / `pause` / `resume`, filtered context inheritance.
- 2026-05-15 — **v0.7 cancel UX implemented via `ctx.ui.onTerminalInput`**, not `pi.registerShortcut(Key.escape, ...)`. Pi's runner reserves `app.interrupt` (default: escape, ctrl+c) and silently drops conflicting extension shortcuts at load. The onTerminalInput route runs ahead of the keybinding layer in pi-tui's `TUI.handleInput`, so Esc is intercepted and consumed before pi's interrupt action sees it.
- 2026-05-15 — **`/conductor history`** shipped as a pure renderer + injected I/O (`src/history.ts`); ordering by `record.json` mtime, not directory mtime, so ext4 dir-mtime semantics don't reorder by creation time.
- 2026-05-15 — **Conductor mode ON by default at extension load.** Anyone who installs pi-conductor wants the system-prompt addendum. `PI_CONDUCTOR_MODE=0` / `off` is preserved as an explicit per-session opt-out; `/conductor on \| off` unchanged. _Reversed in v0.8 — see entry below._
- 2026-05-15 — **§10 — proactive delegation triggers** added to the conductor system-prompt addendum. §1 ("don't delegate work you can handle") was producing too-conservative behavior; §10 lists seven concrete triggers that should make the LLM reach for personas (parallel review, pre-mortem, about-to-commit, fresh mental model, multi-phase work, heavy parent context, verb-to-persona mapping) and a counter-balancing "don't delegate when" list.
- 2026-05-15 — **Upstream namespace migration:** `@mariozechner/pi-*` → `@earendil-works/pi-*` (v0.70.2 → v0.74.0). API surfaces unchanged. Mechanical rename across all imports + `package.json` swap; auditable via `tools/rename-pi-namespace.mjs`.
- 2026-05-15 — **v0.8 reverses v0.7's ON-by-default to OFF-by-default.** v0.7 made conductor mode ON by default reasoning "anyone who installs pi-conductor wants the addendum." In dogfood the parent agent still slipped into doing implementation work itself (reading library typedefs to plan a fix instead of spawning a `builder`). The user's directive: "we start with conductor mode off but if its on you become an overseer/delegation coordinator. the manager." v0.8 flips the default to OFF and rewrites §1 of the addendum to be prescriptive ("you are not the implementer") with a banned-tools list (no `edit`/`write`/non-orientation `bash`) and a narrow allowed list (meta-docs, orientation bash, ≤3 source-file reads per turn). New config field `defaultMode` lets users pin "always on" without an env var. Slash-command and env-var override paths unchanged. Single-commit revertable.
- 2026-05-15 — **Filtered-context inheritance: structural drop of orchestration assistant turns + strengthened sentinel** (v0.8.1 Item 1, commit `423f500`). When a parent assistant message contains an `ensemble_*` / `subagent` toolCall, the entire message is dropped from the filtered slice — including any prose the parent wrote on the same turn. Replaces the previous rewrite-keep-prose path that leaked orchestration narration into sub-agent contexts and caused two role-confusion failures in 2026-05-15 dogfood (`critic` and `oracle` both produced meta-commentary on their briefs instead of executing them). Also strengthens the `<filtered-history>` sentinel in `src/runs.ts` with explicit role-identity guidance: "your brief is the LAST user-role message; earlier user-role messages are framing." Regex-based mitigation (a) deferred to v0.8.2+ pending corpus collection. See `docs/v0.8.1-item1-design.md`.
- 2026-05-15 — **Persona `inherit_context` audit closed** (v0.8.1, commit `423f500`). See open-question #16 for resolution and per-persona breakdown.
- 2026-05-19 — **v0.8.3 Item 3 — foreground transcript view + Ctrl+G overlay UX redesign** (16 implementation commits `6793a5a..c7b1340` + closure `5827dc0`). Three architectural conventions land:
  1. **Component-layer styling (Option A).** Pure renderers in `src/transcript.ts` stay monochrome string-emitters. A pure `classifyLine` helper (`src/transcript-classify.ts`) discriminates each line's kind (`header` / `tool` / `thinking` / `turnSep` / `text` / `footer`); a pure `applyTheme(line, kind, theme)` (`src/transcript-style.ts`) consumes the host `Theme.fg(slot, text)` and is invoked from the Component layer (`FocusedStreamOverlay.render`, `renderForegroundStream`). This preserves snapshot-test cheapness (renderer snapshots stay ANSI-free) and keeps width primitives unaware of escape sequences. Future styling lives in `transcript-style.ts`; renderers must not emit ANSI.
  2. **Thinking-block summary by default + `t` toggle.** Hidden thinking blocks render a one-line `· thinking (N chars / M lines)` summary (commit `36302a0`). The Ctrl+G overlay's existing `t` keybind unfolds the body; the foreground stream renders the summary unconditionally because it has no input loop and thus no model toggle to consult. Refines the original v0.4 "thinking blocks toggleable" design at PRD line 285.
  3. **`Run.lastEventAt` convention** (commit `95c8258`). Every event-handler push to `run.messages` also writes `Run.lastEventAt = Date.now()`; `renderHeader` consumes it to derive a live activity field (`· thinking` / `· $ <bash>` / `· read <path>` / `· responding` / `· idle Ns`) replacing the prior constant `Working...`. Idle threshold ≥5s. Future header live-status work reads from this field.
  
  Width primitives also migrated to pi-tui's `wrapTextWithAnsi` / `truncateToWidth` / `visibleWidth` (commit `6793a5a`) so tabs and ANSI bytes are measured correctly — was an off-script pre-fix during slice 0 that pre-paid debt for the Component-layer fork. See `docs/v0.8.3-item3-design.md` (architectural fork rationale, §3) and `docs/v0.8.3-item3-finalizer.md` (full closure ledger).
- 2026-05-19 — **v0.9 run-record GC capstone — locked decisions D1–D8** (8 slice commits `4f68833..fa5aff0`; design `docs/v0.9-gc-design.md`).
  - **D1 — Dual retention model: age TTL + size cap, with per-persona overrides.** Pure-age loses bursty-day budget control; pure-size LRU loses temporal contracts. Dual policy gives both. Per-persona TTL overrides let users keep `inspector` runs short and `oracle` reviews long. Implementation: `src/gc/policy.ts` (slice 1, `4f68833`).
  - **D2 — Default values: 30d completed-age, 60d failed/killed-age, 5 GB total cap, 100 MB per-transcript cap.** Conservative dogfood values; `gc.autoOnSessionStart: true`, 6h debounce, `gc.orphanReconcileAfterHours: 24`. Aggressive 7d/1GB rejected (deletes history before users notice the tradeoff). See `docs/v0.9-gc-design.md` D2 table.
  - **D3 — Tier ladder: cold-archive then delete.** Cold-archive `unlink`s `transcript.jsonl` (~98% of bytes) but keeps `record.json` / `final.md` / `session/<...>.jsonl` and writes a `.archived` sidecar timestamp; the run remains resumable via `ensemble_send` and listable via `/conductor history`. Full-delete `rm -rf`s the run-dir only when age > full TTL AND already cold-archived AND unpinned. Option A (delete-only) rejected as too destructive; Option C (gzip-in-place) deferred to v1.0 — breaks the "transcript path is what I tell you" contract. Implementation: `src/gc/executor.ts` (slice 3, `c613461`).
  - **D8 — Two-gate active-run safety.** A run is reclaim-eligible only when both (a) `record.status` is terminal on disk (`completed` / `failed` / `killed` / `timeout`) AND (b) no in-memory `Run` exists in the registry, OR the in-memory `Run.status` is also terminal. If either gate fails, the entry is skipped with reason `"active"` in the dry-run plan. Disk state lags in-memory state; requiring agreement is the safe direction — a healthy run gets reclaimed one cycle later, an unhealthy run never gets corrupted. Pinned by `gc-policy.test.ts` and `gc-executor.test.ts`.
- 2026-05-20 — **v0.10 sub-agent watchdog — locked decisions Q1–Q5** (4 slice commits `c8623cb..4734298`; design `docs/v0.10-watchdog-design.md`).
  - **Q1 — `kill_on_stall` default OFF.** No autonomous-chain dogfood data yet; advisory-only by default avoids surprising kills on legitimately slow workloads (npm install, brazil-build, large test suites). Per-spawn opt-in via `kill_on_stall: true` LLM tool arg. Hard escalation to `forceTerminate` only fires when the flag is set. Reference `docs/v0.10-watchdog-design.md` §7 Q1.
  - **Q2 — Soft threshold default 120s, hard threshold default 600s, tick interval 30s.** Empirical witness — the three observed pre-v0.10 hangs (`critic-yjsn`, `builder-z98m`, orchestrator `npm test`) all sat silent for >5 min; 120/600 catches that band with the soft tier as advisory and the hard tier as the kill threshold (when opted-in). Tick interval 30s is the sweet spot between detection lag and conductor wake-up cost (60s sluggish for a 120s soft, 10s excessive given the 4-slot concurrency cap). Tunable via `cfg.watchdog.{defaultSoftSeconds, defaultHardSeconds, tickIntervalSeconds}`; field-data tuning tracked in `docs/v0.8.2-backlog.md` §"v0.10 Slice 3 follow-ups".
  - **Q3 — Soft advisory ships `triggerTurn: false`, `deliverAs: "followUp"`** (reversed from the original §7 Q3 recommendation of `triggerTurn: true`). The advisory is injected as system context the conductor sees on its next natural turn rather than yanking the user mid-edit with an immediate triggered turn. Reversed at slice-2 implementation time (`b7a36a9`, `src/index.ts:374`); slice-3 + slice-4 dogfooding validated the call. Soft advisories fire on legitimately slow operations (e.g. `npm test` stability loops, slow LLM thinking turns where `tool_execution_update` partials don't bump `lastEventAt`) that under `triggerTurn: true` would have produced spurious conductor turns for non-stalls. Widget glyph (slice 4) provides synchronous visual surfacing; the conductor still observes the advisory on its next action. Hard-threshold escalation (when `kill_on_stall` is set) and user-initiated abort handle the genuine-stall case. Reference `src/index.ts:374`, `docs/v0.10-watchdog-design.md` §7 Q3.
  - **Q4 — `Run.stalledSince` is in-memory only.** The field is meaningful only while the run is live; on terminal status it's irrelevant. Persisting would force a `RunRecord` schema bump and add restart-time invariants (do we re-derive on session_start? snapshot at shutdown?) for a field with no off-line use. Reference §7 Q4. Implementation: `src/types.ts` `Run.stalledSince` is unset on `RunRecord`; the watchdog re-derives state from `lastEventAt` on each tick.
  - **Q5 — `watchdog_silence` per-spawn flag DEFERRED.** Speculative knob with no field data justifying it (zero advisory cry-wolf escalations observed at slice-3 close). Build-on-demand: when ≥1 persona reliably trips advisories during legitimate work, add the per-spawn opt-out + a persona-frontmatter cascade entry (also deferred — see `docs/v0.8.2-backlog.md` §"v0.10 Slice 3 follow-ups"). Reference §7 Q5 and §7 "Deferred from Slice 3".
  - Also locked: detector ignores paused (`Run.pausedAt !== undefined`) / terminal / queued runs and respects an initial grace window before first soft-fire (slice 1, `c8623cb`); pre-kill recheck inside the enforcer (slice 2, `b7a36a9`) re-evaluates stall freshness immediately before `forceTerminate` to defeat the recover-between-detector-and-kill race (design A2); W1 mutation witness imports `resolveKillOnStall` from `src/watchdog.ts` directly per `docs/wdd.md` parallel-formula rule rather than reconstructing the production lambda inline (slice 3, `9bed244` + parallel-formula doc `2999fca`). Test count: 953 → 972 (+19) across the v0.10 chain.
- 2026-05-21 — **v0.9.x post-startup reconcile — locked decisions D1–D5** (4 slice commits `d5583be..1f9604a`; design `docs/v0.9.x-post-startup-reconcile-design.md`).
  - **D1 — Reuse `killed` status with errorMessage prefix instead of adding a new `RunStatus`.** New status `crashed` would have forced an audit of every consumer (8 readers in v0.11 slice 1a alone). The `errorMessage` prefix `"orphaned: ..."` discriminates without enum churn. Backward compatible with existing `RunStatus` consumers; history rendering surfaces the prefix as a `⎘ orphaned:` glyph.
  - **D2 — `kill(pid, 0)` for liveness; EPERM treated as alive.** Pid 1 and other privileged processes raise EPERM but exist; the conservative call is to treat them as alive rather than reclassify a possibly-still-running orphan. ESRCH is the only signal of a dead process. Pinned by `tests/reconcile-startup-classifier.test.ts: EPERM treated as alive`.
  - **D3 — `setImmediate(reconcile) → setImmediate(GC)` ordering at `session_start`.** Reconcile must run before GC so GC sees the reclassified-killed records, not orphan-running ones. Both fire as deferred microtasks so the extension's `session_start` handler returns synchronously; ordering is by registration order in `src/index.ts`. Pinned by `tests/reconcile-startup-resume.test.ts`.
  - **D4 — One-shot per startup, no debounce.** Unlike GC's 6h debounce, reconcile is cheap (single readdir + N JSON parses) and idempotent (same-tree second pass produces empty `readopted`/`reclassified`). Manual re-run via `/conductor reconcile`.
  - **D5 — `--dry-run` via `dryRun: true` deps flag, not a separate preview function.** Single branch in `reconcileOrphansAtStartup` skips the 4 mutation sites; same result envelope shape as the live path. Avoids duplicating the classification arithmetic between live and preview code paths.
