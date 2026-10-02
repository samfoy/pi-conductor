# pi-conductor — PRD

**Status:** v0.8 shipped (drafted v0.2).
**Owner:** samfp
**Created:** 2026-05-14
**Last updated:** 2026-05-15

## Locked decisions (v0.7–0.8)

| Decision | Choice | Rationale |
|---|---|---|
| Name | `pi-conductor` | Orchestra metaphor: parent conducts, personas play, audience watches. |
| Tool restrictions | **Enforced by pi's own flags (2026-09-24).** Was not implemented. | Persona frontmatter `tools` (allowlist → `pi --tools`) and `exclude_tools` (denylist → `pi --exclude-tools`); every spawn and resume also excludes the conductor's own `ensemble_*` tools and the foreign spawn tools `subagent` / `agent`. Read-only builtins exclude `edit`/`write`/`insert_before`/`insert_after`. **Partial enforcement:** `bash` stays available unless a persona excludes it, so this is not a sandbox. See the 2026-09-24 decision-log entry. |
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
- **Not a sandbox.** Persona `tools` / `exclude_tools` are enforced by pi, but `bash` remains available unless excluded, so a read-only persona can still mutate files through the shell. The prompt-level read-only enforcer covers that gap by instruction, not mechanism.

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
| `tools` | list | pi's default set | Allowlist passed as `pi --tools <csv>`; replaces the child's default active set (builtin and extension tools). Block-list syntax only; an empty list is rejected. |
| `exclude_tools` | list | `[]` | Denylist passed as `pi --exclude-tools <csv>`, unioned with the conductor's `ensemble_*` tools and the foreign spawn tools (`subagent`, `agent`). |
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
ensemble_spawn(persona, task, [foreground], [files])
  → returns { agent_id, status }
  - persona: string (must exist in resolved persona registry)
  - task: string (the prompt; default_reads are auto-prepended)
  - foreground: bool (default TRUE)
      true  → block parent; stream sub-agent into the chat as it runs
      false → run in background; live-update the ensemble panel
  - status return values: "running" | "queued" (when maxConcurrent is hit) | "failed-to-start"

ensemble_send(agent_id, message, [files])
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
- **Non-effort `ensemble_send` bypasses the concurrency cap.** M4 effort owner answers instead recheck global/effort execution limits and footprint ownership before dispatch, retaining the original pending ask when busy. A send is a *resume*, not a new spawn — queueing it would hang the conductor's foreground tool call until an unrelated sub-agent finishes, which is worse UX than just running it. The conductor system prompt instructs the LLM not to fan out parallel sends to the same sub-agent. Sends use the latest `available_actions` and revalidate on every call; `steer`/`follow_up` use live RPC and `send` continues a saved session in a new process.

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

### Per-send semantics for `<duration>` / `<usage>` / `<cost>` (item 15)

The top-level `<duration>` / `<usage>` / `<cost>` tags reflect the **most recent invocation only** — the initial spawn OR the most recent `ensemble_send` resume. They are NOT cumulative across resumes.

When the run has been resumed at least once (`resumeCount >= 1`), the envelope additionally carries an optional `<lifetime>` block with the cumulative-since-original-spawn totals plus a `<resumes>N</resumes>` counter:

```xml
<sub-agent-completed>
  <agent-id>builder-501r</agent-id>
  <persona>builder</persona>
  <status>completed</status>
  <duration>12.0m</duration>
  <usage><turns>8</turns><input>1400</input><output>3200</output><cost>3.4000</cost></usage>
  <lifetime>
    <duration>1.2h</duration>
    <usage><turns>34</turns><input>5800</input><output>14000</output><cost>16.1900</cost></usage>
    <cost>16.1900</cost>
    <resumes>5</resumes>
  </lifetime>
  <result>…</result>
  <transcript>…</transcript>
</sub-agent-completed>
```

Initial-spawn runs (no resumes yet) omit the `<lifetime>` block — per-send IS the lifetime, no need to repeat. The human-readable header line and the inline status line `✓ persona:id completed in <duration> [<usage>]` follow the same convention, with an optional `· lifetime <duration> $<cost>` suffix when resumed. See `docs/backlog.md` item 15 for the witness (`builder-501r`).

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
  "inlineAttachmentLimitBytes": 131072,  // A5: embedded envelope limit; total rendered evidence <= 4x
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

*Enforced by pi (2026-09-24).* Pi 0.87 accepts `--tools <csv>` (an allowlist that replaces the default active set and applies to builtin **and** extension tools) and `--exclude-tools <csv>` (a denylist); filtering is Set-based, so an unknown name is a harmless no-op (`dist/core/sdk.js` ~L140, `dist/core/agent-session.js` `_refreshToolRegistry` ~L2494). An excluded tool is dropped from the child's registry, so the child cannot re-activate it.

- **Frontmatter.** `tools` and `exclude_tools` are block lists of names matching `^[A-Za-z0-9_.:-]+$`. Entries are trimmed and deduped; empty entries, flow syntax (`[a, b]`), and an empty `tools` list are load errors.
- **Overrides.** `personaOverrides.<name>.tools` / `.exclude_tools` replace the persona's whole array. A malformed override drops the persona and records a resolution error rather than silently loosening its policy.
- **Always excluded.** Every argv from `buildPiArgs` passes `--exclude-tools` with `CONDUCTOR_LLM_TOOL_NAMES` (`src/types.ts`), the same constant `registerTools` reads its tool names from, plus `FOREIGN_SPAWN_TOOLS` (`subagent` from pi's bundled example extension, `agent` from pi-herdsman). A globally loaded `subagent` otherwise lets every child start agents the conductor never supervises. The `CONDUCTOR_SUBAGENT=1` registration gate in `src/tools.ts` stays as defense in depth. `/conductor doctor` flags any other loaded tool whose name has an `agent`/`subagent`/`spawn`/`delegate` token; the check is name-only, so a generically named spawn tool slips past it.
- **Persistence.** `Run.tools` / `Run.excludeTools` (and `record.json`) hold the effective lists, re-applied on every `ensemble_send` resume. Legacy runs without the fields, or with lists stamped before `FOREIGN_SPAWN_TOOLS` existed, still get every always-excluded tool, since `buildPiArgs` re-unions on each argv.
- **Builtins.** The nine read-only reviewers (`analyst`, `critic`, `finalizer`, `inspector`, `investigator`, `oracle`, `profiler`, `redteam`, `verifier`) exclude `edit`, `write`, `insert_before`, `insert_after` (the last two come from a smart-edit extension on some hosts). No builtin sets an allowlist.
- **Limit.** `bash` stays available, so this is partial enforcement: it removes the edit tools, not the ability to write through a shell. It is not a security boundary.
- **Delegation scope (N1, N2).** `effectiveExcludeTools`/`effectiveAllowTools` take the run's frozen `{depth, delegateAllow}` scope. Every child excludes `delegate` except an eligible depth-1 delegator, whose explicit allowlist also gains it; that name is the conductor's own lead-brokered tool, so a foreign `delegate` in a delegator is a pi load conflict, never a fallback. The depth-2 leaf scope also excludes `ask_owner`, `edit`, `write`, `insert_before`, `insert_after`. An explicit allowlist gains `ask_owner` only at depth 1, and an excluded name is never added. `registerTools` gives a child `ask_owner` only when `CONDUCTOR_DEPTH` is unset (legacy) or exactly `1`, and never an `ensemble_*` tool; `delegate` is registered only for a validated depth-1 delegator env (`CONDUCTOR_DELEGATE_ALLOW`, `CONDUCTOR_RUN_DIR`, `CONDUCTOR_RUN_ID`).

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

### v0.11 — on_complete_hook quality gates per persona — _shipped_
- Harness-enforced quality gates: `on_complete_hook` shell command runs after natural sub-agent exit, captures stdout/stderr to `runs/<id>/hook.log`, and overrides the terminal status to `hook_failed` on non-zero exit, timeout, spawn error, or runaway output. `forceTerminate` SIGTERMs any in-flight hook subprocess (SIGTERM → 2s → SIGKILL); the hook-exit handler is idempotent against an already-terminal `Run.status`.
- 4-layer cascade: per-call (`ensemble_spawn` / `ensemble_send` tool arg) > project config > user config > persona frontmatter. Empty string at any layer is the explicit-disable sentinel (short-circuits the cascade). `resolveOnCompleteHook` is a pure function; all 4 input layers are independently testable.
- New `hook_failed` terminal `RunStatus`. Full consumer-case audit (8 readers: `types.ts`, `transcript-style.ts`, `status-glyph.ts`, `commands.ts`, `runs.ts`, `notifications.ts`, `history.ts`, `widget.ts`).
- UX surfaces: `<hook>` block in completion envelope; `⊗` glyph + `hook failed` verb in header; distinct history row with command + exit code; `· hook` in-flight glyph in ensemble panel; `## Hooks` section in `/conductor doctor` with cascade source + PATH warning.
- `§11` conductor-prompt addendum: `hook_failed` handling paragraph (default `ensemble_send` route, ≤3-iteration cap, no-fresh-critic rule).
- Soft-compat callouts: R8 (`hook_failed` in `record.json` — treat as failure-class terminal); R9 (`final.md` mtime — written before hook fires, not at run end time).
- 6 slice commits: 1a `31fb4bd`, 1b `bffa16f`, 2 `35f4dd3`, 3 `7b4b8b4`, 4 `bb2ac6a`, 5 `35025f8`. Design `docs/v0.11-on-complete-hook-design.md`; plan `docs/v0.11-on-complete-hook-plan.md`. Test count 973 → 1369 (+396 across v0.11 + bug-bash commits). Verifier PASS 2026-05-29.

### v0.12 — Steering from conductor or user to running sub-agents — _shipped_
- Per-spawn `steerable: true` arg on `ensemble_spawn` launches the sub-agent in pi's RPC mode (`pi --mode rpc`), keeping its subprocess + stdin pipe alive between turns. Default OFF (cascade: per-call > project config > user config > built-in default `false`; persona-frontmatter layer deferred per oracle fix #1, mirroring v0.10 `kill_on_stall`'s shape exactly).
- `streaming_behavior: "auto" | "steer" | "follow_up" | "resume"` arg on `ensemble_send`. `auto` (default) resolves to `follow_up` for running steerable runs and `resume` for terminal runs — the non-disruptive default mirrors v0.10 Q3's reversal posture (advisory > triggered turn). Explicit `steer` interrupts mid-turn; explicit `resume` rejects on running runs.
- Single-writer per-run async stdin queue (`src/rpc-stdin.ts`) with FIFO + LF-only framing closes the partial-event-tearing race; `forceTerminate` calls `RpcStdinQueue.destroy("force-terminate")` before SIGTERM so pending ack promises reject cleanly. Vendored RPC type subset (`src/rpc-types.ts`) avoids a hard runtime dep on pi's non-public dist (no startup shape probe — Q5-deferred pattern).
- Watchdog `lastEventAt` bump asymmetry: bumps on RPC `response` lines (progress signal) but NOT on `extension_ui_request` lines (host-blocking, not progress) per oracle fix #2. W2 mutation witness pins both directions.
- Orphaned-RPC reconcile: when post-startup reconcile finds a `running` record with `streamingMode: "rpc"` whose pid is alive but whose stdin pipe is detached, classifier reclassifies to `killed` with `errorMessage: "orphaned: rpc-stream-detached"` and the executor SIGTERMs the stranded subprocess. Reuses v0.9.x D1's `killed`-with-prefix pattern — no new RunStatus.
- LLM-tool surface: `extension_ui_request` lines from steerable sub-agents are auto-cancelled (`{cancelled: true}`) and logged as warnings; personas can't rely on `ctx.ui.confirm`/`select` from extensions.
- User-facing: `/conductor send <agent-id> [--steer|--follow-up|--resume] <message>` slash command; the focused-stream overlay's existing `s` keybinding routes through the same surface, so a running steerable sub-agent now accepts inline sends.
- 8 slice commits (`3f73d9d` slice 1 → v0.12 closure); 7 vertical slices total + this closure commit. Design `docs/v0.12-steering-design.md`; plan `docs/v0.12-steering-plan.md`. Closes PRD Open question #6's last open edge (mid-run conductor → sub-agent direction). Sub-agent → conductor mid-run messaging stays a v2 line item.

### v0.13 — Worktree-per-persona isolation — _shipped_
- `worktree: true` in persona frontmatter spawns the sub-agent in an isolated git worktree at `<gitRoot>/.worktrees/conductor-wt/<run-id>/`. The sub-agent’s `--cwd` is overridden to the worktree path; the parent working tree is untouched.
- Non-git cwds fall back gracefully to shared cwd with a warning (no regression).
- Brazil-safe placement: worktree is inside `<gitRoot>` which is inside the workspace root; `brazil-build`’s `find_workspace_directory_up` succeeds (proven by direct test against `/workplace/$USER/Rosie/`).
- `finalize` removes the worktree best-effort on terminal; GC `delete` cleans up orphans via `RunRecord.worktreePath`.
- `builder.md` and `simplifier.md` default to `worktree: true`.
- New module `src/worktree.ts`; git env vars stripped from child processes to prevent pre-commit hook contamination.
- 1 commit `3b45a28`; 28 new tests; design `docs/v0.13-worktree-design.md`.

### v0.14 — Worktree auto-merge — _shipped_
- A worktree run that reaches `completed` merges its branch back to the base branch. `merge_strategy` selects how: `"squash"` (all commits into one), `"merge"` (merge commit), or `"none"` (leave the branch for a human/chain to inspect).
- `resolveMergeStrategy` cascade: per-call > project config > user config > persona frontmatter > built-in default. Built-in is `"squash"` for `builder`/`simplifier` and `"none"` for every other persona.
- New `"merge_conflict"` `RunStatus` (terminal, post-success) with its own `⊘` glyph — deliberately distinct from `⊗` (`hook_failed`) so the two post-success failure modes are never confused. `mergeWorktree` aborts cleanly on conflict and returns the conflicting paths; `worktreePath` is retained so the work is recoverable.
- `mergeStrategy` and `worktreeBaseBranch` stamped onto `Run` at spawn time; `applyMergeToTerminal` wired into `finalize` after the hook gate.
- Squash path pre-checks that the branch is actually ahead of base before squashing, so an empty diff reports `nothingToCommit` success instead of a false failure — and a branch that *is* ahead but stages nothing reports failure rather than silently losing work (`58e4ac8`).
- GC gains a `mergeConflictTtlDays` bucket (falls back to `failedTtlDays`) so conflicted worktrees aren't reaped on the ordinary completed-run schedule.
- `/conductor worktree list|merge|clean` for manual inspection and recovery.
- 7 commits `5601205..58e4ac8` (design `5601205`, slices S1–S6 `e86ab09..38e6ec2`, fix `58e4ac8`); design `docs/v0.14-worktree-merge-design.md`.

### v0.15 — Persona auto-chains — _shipped_
- `chains` in `.pi/conductor.json` maps a source persona to a `ChainStep`; when the source completes successfully the conductor auto-spawns the target as a background run. The chained run appears in the ensemble panel and fires its own completion notification, so the conductor doesn't have to remember to spawn the follow-up.
- **On by default, no config needed:** `builder → critic` and `simplifier → critic` ship as built-in defaults (`src/types.ts`). `{ then: "" }` is the explicit-disable sentinel, mirroring `on_complete_hook`'s empty-string convention; `chain: false` on a single `ensemble_spawn` skips that one spawn's chain.
- Depth-1 cap: chain-spawned runs never trigger further chains.
- Config merge is key-level — project keys override user keys, and keys absent from the incoming layer are preserved from the base layer, so a project can retarget one chain without redeclaring the rest.
- The chain task template hands the target the source's final output. When the source ran with `mergeStrategy: "none"`, `WORKTREE_CHAIN_TEMPLATE` is used instead: the critic gets the branch name and a ready-to-run `git diff {baseBranch}...{worktreeBranch}` rather than merged output it can't see.
- 2 commits `5529647` (config + resolution) and `fde2752` (built-in defaults); no separate design doc.

### v0.16 — Event bus + chain-aware worktrees — _shipped_
- `ConductorEventEmitter` thin wrapper over `pi.events` with typed channel constants under `conductor:agent:*` namespace. 6 agent-lifecycle channels (`created`, `started`, `completed`, `failed`, `steered`, `compacted`) + 3 hook channels (`hook:started`, `hook:completed`, `hook:failed`). DI-wired via `src/conductor-events.ts`; emit sites across `src/runs.ts`, `src/index.ts`, and `src/hooks.ts`.
- Compacted emit uses dual-detection: JSON `compact_result` event type + RPC `response.type === "compact"` to cover both non-RPC and RPC streaming modes without false positives.
- Chain-aware worktree context prompt: `{worktreeBranch}` and `{baseBranch}` template variables substituted into `WORKTREE_CHAIN_TEMPLATE` (injected when `mergeStrategy === "none"` + worktree branch set). Chain head persona receives the diff command ready to copy-paste.
- Infrastructure fixes bundled: `CONDUCTOR_SUBAGENT` unset in npm test (`9a3b275`); builder no-pipe + 60s timeout root cause (`3531e11`, `9960050`); `core.bare` auto-heal in npm test scripts and `mergeWorktree` checkout (`44bf8f5`, `25c1afc`).
- 8 commits `7e70e58..d156850`; design `docs/v0.16-events-design.md`; plan `docs/v0.16-events-plan.md`. Test count: ~1476 → ~1510 (+~34). Verifier PASS 2026-06-19.

### v0.17 — Graceful turn limits + hook events — _shipped_
- New `"aborted"` `RunStatus` (terminal, kill-class) for turn-limit termination. Added to `TERMINAL_STATUSES`; widget active-filter updated; all 8+ consumer call-sites audited.
- `resolveMaxTurns` / `resolveGraceTurns` cascade resolvers: per-spawn > project config > user config > built-in defaults (`maxTurns: undefined` = unlimited; `graceTurns: 3`). Mirrors the `kill_on_stall` / `steerable` cascade shape.
- `maxTurns` and `graceTurns` stamped onto `Run` at spawn time (not re-read from config on every tick).
- Turn-count enforcement in `processLine` (`checkTurnLimit`): on reaching `maxTurns`, inject a grace message into the sub-agent's stdin and set a grace countdown; on grace exhaustion, SIGTERM + status → `"aborted"`.
- Hook lifecycle events via `ConductorEventEmitter`: `hook:started`, `hook:completed`, `hook:failed` emitted from `src/hooks.ts` at the three natural boundary points.
- UX surfaces: ensemble panel shows `⏱ N turns / M max` glyph for capped runs; `/conductor doctor` reports `maxTurns`/`graceTurns` for each run; notification on abort; `/conductor history` renders `aborted` with dedicated glyph; conductor system-prompt addendum §12 documents the turn-budget contract for sub-agents.
- 7 commits `ddd5ea3..0c6b388`; design `docs/v0.17-graceful-turns-design.md`; plan `docs/v0.17-graceful-turns-plan.md`. Test count: ~1510 → 1546 (+36). Verifier PASS 2026-06-19 (1546 pass / 0 fail / 11 skipped; tsc clean).

### v0.18 — Autonomous mode (Metaphor pattern port) — _shipped_
- **Failure-classification taxonomy** (`src/failure-classify.ts`): every non-completed terminal is stamped with one of `syntax | logic | test | environment | permission | timeout | stall | turns | unknown`. The split that matters is deterministic-cause (`syntax`, `logic`) vs transient (`environment`, `stall`, `timeout`, `test`) — re-running the former just burns tokens.
- **Classified retry** (`src/retry.ts`): a retryable terminal auto-respawns the same persona with a diagnostic-augmented task, up to `retry_max_attempts` (per-call > project > user > persona > built-in). `DEFAULT_RETRY_POLICY` is `maxAttempts: 1` — **off by default** — with `retryableClasses: [environment, stall, timeout, test]`. Permission failures are never auto-retried; they always escalate.
- **Plans-as-hypotheses** chain re-evaluation: `ChainStep.reevaluate` gates the successor on the source's output, so a stop verdict halts the chain before the next persona spawns.
- **Confidence-weighted cross-session memory** (`src/memory.ts`): `ensemble_recommend` ranks personas by recency-decayed, confidence-weighted past success on the normalized shape of a task. Advisory only — an empty result means no history for that shape yet.
- **Capstone `ensemble_auto`** (`src/autonomous.ts`): runs a conductor-supplied ordered persona plan to a terminal outcome with in-loop classified retry, per-step re-evaluation, and `max_steps` / `budget_usd` caps. Halts and escalates on a non-retryable failure, a stop verdict, or a cap. Outcomes feed back into cross-session memory.
- 6 commits `207139d..d7af20b` (slices S1–S5 + docs); design `docs/v0.18-autonomous-mode-design.md`.

### Post-v0.18 — unversioned — _shipped_
- N1 (independent review pending) — validated delegation policy, no broker. Persona `agents:` block lists and whole-list `personaOverrides.<name>.agents` (`[]` disables) become `Persona.agents`. A roster pass after overrides, run to a fixed point, makes a persona unavailable when any entry is unknown, disabled, masked, itself, duplicated, non-string, badly named, flow syntax, beyond 8 entries, not explicitly `read_only: true`, or known write-capable. No builtin declares `agents`. Lead spawns persist `depth: 1` and `delegateAllow`, which record, orphan restore, resume argv/env, queue, retry and herdr launch all reuse. Missing both fields is a legacy depth-1 leaf; any other shape refuses send and is skipped by reconcile without probes (as H2 does for unsupported runtimes). Both runtimes always set `CONDUCTOR_DEPTH`/`CONDUCTOR_RUN_DIR` and set `CONDUCTOR_DELEGATE_ALLOW` only for an eligible delegator, dropping inherited copies. Every child, delegators included, excludes `delegate` and no allowlist adds it until N2 registers the conductor's own tool. H2 masking now also covers unparseable frontmatter and broken `read_only`/`tools`/`exclude_tools`/`agents`, keyed by source filename. Only an eligible delegator's prompt guard changes (it states the list but that no delegation tool exists); the depth-2 scope adds a read-only `QUESTION:` line. Doctor and `ensemble_list` show allowlists. Native witnesses: Pi 0.87.1 session from generated flags, including an eligible delegator's real subprocess and herdr launch argv against a foreign `delegate` decoy; 0.99.1 `getCallableToolNames()`/`ctx.executeTool()` negative calls. No `delegate` tool, broker, admission lanes, tree view, S or M6 work.
- N2 (independent review pending) — lead-brokered blocking `delegate` for subprocess parents (`src/delegate-tool.ts`, `src/delegation.ts`, `src/delegation-broker.ts`). The broker reads only the parent's own parsed stream through the pipeline's `onEvent`, spawns only on a call's first `tool_execution_update` (start precedes validation in Pi 0.87.1 and 0.99.1), claims create-only before any await, and answers create-only with the leaf's bounded envelope. Leaves are depth-2 read-only subprocess runs with lineage and no worktree/merge/hook/effort/chain/retry/context. Cancel on end, abort or terminal parent; timeout clamped to the parent's remaining hard timeout (`run.deadlineAt`, also passed as `CONDUCTOR_DEADLINE_AT`). Reload uses the approved R6 fallback. herdr refused by name until N5; no admission lanes (N3) or ownership gate (N4); opt-in only.
- N3 (independent review pending) — two-lane admission. A slot is a reservation (`holdsSlot`: a live status, or `run.processOpen` from launch until the subprocess's `close`); settlement's SIGTERM escalates to SIGKILL after 2 s, but `close` waits for stdio, so a descendant holding an inherited pipe can extend the reservation; the release is not strictly bounded. `SpawnQueue.waitReason` is the one predicate for enqueue and drain: lead-level entries keep `admitEffortWriter` (its global cap counts reservations); a leaf of a current awaiting delegator (`awaitingChildren`: unanswered calls of a slot-holding, valid depth-1 delegator) needs `A − W < maxConcurrent`, where `W` (`delegationLoad`) counts awaiting delegators with a leaf holding a slot plus the candidate's own parent. Claims and queued leaves never lend. Drain scans those leaves first; a leaf refused at drain fails instead of lingering queued. The broker answers a leaf's call only after the leaf's process closed, stamps the parent's `lastEventAt` before the last answer (no deadline change), and on cancel answers, withdraws the leaf, then notifies, queued leaves before running ones. `evaluateRun`/`classifyStall` suppress stalls while awaiting; `⇣N waiting` and `awaiting_children` share the count. Bounds: live-status executing runs ≤ max (side-tool overlap excepted); live owned subprocesses ≤ 2·max, lead-level ≤ max, for queue-admitted launches. A parent-side abort or a parent's own end leaves reservations counted until its processes close, during which nothing is admitted. Unchanged limits: `ensemble_send` resume is not queue-admitted; an exit-unconfirmed herdr child is not a reservation. No ownership gate or tree (N4), no herdr delegation (N5); opt-in only.
- N4 (independent review pending) — direct ownership. `childrenOf` is exact lineage (depth-1 parent, depth-2 child naming it, started no earlier, each id once); `terminateChildren` runs inside `forceTerminate` before the parent's own effects, queued leaves first, only for the current registered parent object, and closes delegation (`delegationClosed`, checked by `validateDelegateRequest`). `settleOwnedChildren` gates `createRunPipeline` finalize before the blocked transition, hook, merge, effort footprint and integration enqueue, `final.md`, record and card: it cancels this invocation's unsettled leaves and waits for close, at most 2.5 s (`CHILD_EXIT_BOUND_MS`; herdr transports use their own exit proof), treating exit with held pipes as `stdio-open`. An unconfirmed exit withholds hook, merge, integration, footprint and final (`childExitUnconfirmed` gates `writeFinal`, `getCompletionText`, `resultRef`, `run:` evidence and `settleWorktree`), withdraws a pending ask by name, and settles the parent once as `failed`. `abandonedChildren` is persisted and rendered as `<abandoned-children>`. Quit cancels queued leaves, then stops leaves first. Reconcile orphans a readopted leaf whose parent is terminal, missing or replaced, without signalling it. Depth-2 runs are kill-only in `runActionError` (focus remains a view); `pushCompletionCard` suppresses leaf cards. Envelopes add `<children>`/`<subtree-cost>`, `ensemble_status` adds `depth`/`parent_run_id`/`children`/`subtree_cost`, the panel indents leaves, and `ensemble_auto` charges `subtreeCost`. No herdr delegation (N5), S, M6 or overlay pre-order; opt-in only.
- H9 — proof-backed herdr kill preserves scrollback, signals only the exact current child PID/start identity, and revalidates the two-second escalation. Hook-group and synchronous forced-terminal bookkeeping are preserved. Quit awaits M5 suspension/transition/terminal-I/O barriers before a bounded five-second pane cleanup phase; uncertain resources retain evidence and integrating records are never rewritten killed. Explicit cleanup/ordinary GC use current nonce/status/child and empty-pane proof, never tab-wide close; unavailable server can permit child-gone ordinary file reclamation but not uncertain bound-worktree deletion. Effort GC protection remains. Owned attached herdr streams participate in watchdog detection; nested UI waits suppress both evaluation/rendering and emit one nonwaking card, and a first episode adds at most one redacted 2s/40-line/4-KiB live diagnostic. Reload behavior stays unchanged. Evidence is private fake CLI/owned child and approved offline native Pi 0.87.1 only; no global 0.99.1 parity, real herdr/TUI acceptance or rollout claim. Independent H9 review is required.

- H8 — live herdr steer/follow-up/grace use the H5 nonce inbox behind current attachment, child proof and shared A3/A6 policy gates. Delivery distinguishes accepted input (not execution), definite rejection and unconfirmed outcomes; no blind retries. Saved-session send/owner reply retains the concrete backend, uses a fresh nonce, reuses only a proven empty prior pane or creates a new subtree tab, and refuses unconfirmed previous exit. Owner answers require initial ack plus correlated native start; preacceptance failures retain the durable question, later model failure cannot falsely restore an accepted ask, and historical final output is not advertised for failed launches. Pause/resume signals remain subprocess-only. Verified with executable fake CLI plus isolated offline native Pi **0.87.1**, not actual TUI/herdr or global **0.99.1** parity. H10 adoption and H11 real/human acceptance remain deferred; H9 cleanup is described below. See `docs/h8-implementation-evidence.md`.

- H2 interim runtime selection (historical availability limit, superseded by H7/H8) — `auto | subprocess | herdr` cascades per-spawn/auto-step > effective persona override/frontmatter > project global > user global > auto, through the existing config/persona loaders. The pure resolver takes an injected environment: only exact `HERDR_ENV=1` plus nonempty socket/pane selects herdr automatically. **Herdr remains unavailable**: rejection precedes queue, Run, effort and worktree effects; explicit herdr never silently falls back. Use `runtime: "subprocess"` explicitly inside herdr until its backend lands. Concrete Run/RunRecord tags are frozen through queue/retry and saved-session resume; legacy missing tags always mean subprocess. Auto preflights all steps; fresh chains resolve the successor's current persona/config/environment rather than inherit a parent selector. Status includes runtime; doctor reports configured/effective/source/legacy behaviour without process probes. Reconcile/GC preserve unavailable records without probing/signalling guessed child PIDs; effort recovery/requeue refuses unsupported runtimes before ownership/workspace effects. Native print/RPC, A3 actions, A5 nonsteerable large-prompt transport, A6 answers and M5 settlement/fencing remain unchanged. No herdr CLI, bridge, pane launch, monitor, install/config rollout or other H slices. See README “Runtime selection (H2 interim)”.
Work that landed after the v0.18 capstone without its own phase number:
- M5 implementation (independent acceptance pending) — parent-only effort recovery uses append-only exclusive owner generations, acknowledged atomic WAL and Git reachable-candidate/trailer/parent/tree proof. Interrupted candidates rebuild through M2/M3 hooks and verification; stale CAS retries stop at three. Stable queue/WAL reconciliation preserves missing members and uncertain work. Human interactive resume/requeue validates ownership, source OIDs and the original resolved hook (an unknown legacy hook requires explicit replacement). Blocked A6 assignments are not enqueued; adoption establishes answer ownership before existing capacity/acceptance checks. Only known clean detached ancestor candidates are reclaimed; writer branches, dirty/unmerged evidence and merger states remain preserved. No landing, destructive TTL, readers, waves or runtime expansion.
- M4 — parallel admission for validated, obligatorily isolated effort writers of every non-read-only persona. One conservative predicate serves enqueue, drain and A6 answers: global/effort execution limits always apply, while ordinary writer caps/sends stay unchanged. Frozen scopes serialize on uncertain intersections; generated exclusions require full region coverage and never cross efforts. Pre-launch registration reserves capacity before asynchronous child effects. Earlier queued work reserves scope, while blocked/integrating writers retain scope without child slots; unresolved failures reserve universally. Actual NUL-delimited branch diffs widen reservations and report violations before integration admission releases a slot. Native barriers prove simultaneous independent worktrees, sequential verified integration, queued current-tip branching and same-assignment answer refusal/retry without oversubscription. A3 status/cards show waits and violations. Foreign/unobserved same-repo ownership fails closed; no recovery, waves, readers, merger or landing. Unattended parallel dogfood waits for M5; see README “Named efforts” for trusted-glob and shared-external-output limits.
- M3 — optional generated artifact regeneration uses the frozen effort policy and M2's detached candidate/command/commit/verify/WAL/CAS route. Clean generated diffs and generated-only conflicts rebuild once before the normal hooked squash commit. NUL-delimited merge output, original conflict paths/tree and index survive classification; conflicting artifacts start from the current tip's content/absence while ordinary merged source is preserved. Actual candidate file bytes/modes (including ignored/untracked files) and index-tree changes must stay inside concrete generated paths before explicit literal staging; index flags, HEAD changes, unsupported types and generated symlinks fail closed. Generator failures, cancellation, hook refusal and red verify preserve work without advancing the ref. Broad globs are explicit trust in a path policy, not semantic source recognition; commands are not sandboxed and external/transient effects are not audited. No new admission, recovery, merger or landing capability; see README “Named efforts” for operational and trust limits.
- M2 — verified serial effort integration. Newly observed, exited, hook-passed writers enter nonterminal `integrating`; the shared settlement tail alone publishes their outcome. A repository FIFO computes merge trees, constructs detached one-parent candidates via normal repository hooks, verifies the actual post-hook commit, persists acknowledged WAL and advances only by checked CAS. Baseline verification gates first integration, not effort open. Red baseline or operational uncertainty pauses; bounded red candidate retries end in `merge_conflict`. Kill cancels owned work; reload/quit stop verification and retain durable integrating records for inspection. M1 legacy completions are not certified. All branches/candidates/logs remain preserved, including success, until recovery/cleanup slices. No parallel admission, automatic recovery, merger, readers, effort auto/chains/retries or landing. Generated resolution is added by M3 above. See README “Named efforts” for guarantees, disabled-verify behavior and dependency limits.
- Phase A A6 — managed-child `ask_owner(question, files?)`. Native single-tool-batch validation, pending-message rejection and A2 retirement checks precede A5 evidence preparation and `terminate: true`; the tool-call id correlates the question. Depth-two leaves have no owner tool; parent tools and spawning exclusions stay unchanged. Parent observation requires paired execution start and non-error execution end, then native settlement and process exit before `blocked`. Blocked assignments retain question/session/worktree, free slots, survive restart, skip GC/watchdog/success hooks/merge/retry/chains, and halt auto plans. Foreground returns a question; background emits one `<sub-agent-asked>` card, not a final result-ref. Existing send resumes the original assignment with correlated owner-answer framing; failed preflight preserves the ask. Kill abandons the ask and preserves work for the existing TTL. See README “Owner questions (A6)”.
- Phase A A5 — file evidence and reusable `run:<agent_id>` results. Spawn/send, auto steps and configured chain steps accept `files`. One shared preflight validates readable regular local files or known persisted results (registry or validated canonical durable records), deduplicates by realpath, and prepares complete evidence before lifecycle effects. Spawn paths resolve against effective requested cwd; send paths explicitly use the caller's effective conductor cwd; auto prepares all steps up front; chains prepare at firing in the source run's cwd. Retirement rejects before send preparation. Complete strict UTF-8 without NUL embeds as escaped evidence; other files remain live canonical references. `inlineAttachmentLimitBytes` defaults to 131072 (integer 1024..1048576), bounding each whole embedded envelope; total rendered evidence, including references and framing, is bounded to four times that limit, with reference space reserved first. Queued/retried embeds retain the acceptance snapshot. Run refs preserve logical identity and embedded provenance without rewriting `final.md`; foreground/background results advertise refs only for persisted usable output, including retirement handoffs. Refs name the current final, not a versioned generation. Prompts above 96 KiB UTF-8 automatically use native RPC stdin, including seeded sessions, resumes, auto/chains/retries; short print spawns remain unchanged. Actual transport is recorded independently of explicit steering, preserving A3 action semantics. RPC completion still waits for `agent_settled`, uses existing accounting/timeout/kill/queue handling, and cleans up pending writer/acks. No A6, effort, herdr, or provider-extension disabling. See README section “File evidence and reusable results” for path, budget, failure, and transport contracts.
- Phase A A4 — bounded stall evidence and recurring soft reminders: the first notice for an invocation/resume-count plus unchanged `lastEventAt` includes assistant text, tool summaries, and results from at most 32 recent in-memory messages / 64 parts (multipart results visit first/last four parts). No system/user/thinking text or evidence log scans. Each result/assistant block is middle-truncated to 4 KiB; the complete escaped `<recent-activity>` block is at most 16 KiB UTF-8, including markup/omission markers, preserving Unicode and useful head/tail. Missing evidence yields a bounded fallback. Expanded cards expose the full bounded evidence and once-per-notice guidance; collapsed cards remain compact. First notice is eligible at effective soft S (subject to existing grace); subsequent intervals from actual notices are max(60s, S/2), max(60s, S/4), etc., evaluated on the existing 30s tick/registry change with no catch-up bursts. S=600 yields aligned-tick notices at 600, 900, 1050, 1140, 1200, 1260… seconds; default S=120 repeats every 60s. Fresh events/invocations reset; pause/terminal/hook/no-proc exclusions dispose episodes; SIGCONT may promptly begin a new episode if still stale, without changing the activity definition. Reminders reference the first notice and reuse its advisory A3 action snapshot (no repeated saved-session observation); actions still revalidate at execution. Use evidence first, at most one further bounded diagnostic read if needed, leave legitimate long-running work alone, never poll or read again merely for a reminder. Hard threshold/policy are unchanged: hard wins over a simultaneous reminder, emits once (with evidence if first observed hard), and stops soft reminders even with `kill_on_stall:false`. Exactly-one watchdog killed completion and silent tool kills remain, including queued promotion. Episode state is session-local and discarded on shutdown/removal. No A5/A6, heartbeat, or herdr implementation.
- Phase A A3 — authoritative action eligibility: every `ensemble_status` record reports `available_actions`; completion/stall envelopes include `<available-actions>`, and foreground results plus expanded notification cards expose the same advisory snapshot. Canonical tokens: `send` = `ensemble_send(streaming_behavior: "resume")`, a new process continuing a saved session; `steer` / `follow_up` = live RPC delivery through `ensemble_send`; `pause` / `resume` = SIGSTOP / SIGCONT through their respective tools; `kill` / `focus` = terminate/cancel and TUI overlay. `auto` selects live follow-up or saved-session send. One eligibility gate serves reporting and execution, reusing the existing send-strategy resolver, with read-only observations of session existence, A2 retirement (including fresh live RPC), config opt-out, stdin writability, process ownership/capabilities and TUI support. Every effect revalidates; reports never spawn, restore worktrees or write records. Terminal kill remains a successful no-op even though omitted from actions; reconciled terminal sessions remain resumable. A3 adds no viewer, backend, depth, delegation, blocked status or ownership redesign. Use the latest available_actions; each call revalidates. Later signal, filesystem or worktree errors remain possible.
- Phase A A2 — child context retirement: default-on `contextRetirement`, session-scoped `conductor-context-retired` marker, request-local hidden handoff guidance, persisted `Run.contextRetired`, and a shared continuation rejection. Threshold compaction is cancelled only for managed children; overflow recovery and manual compaction stay available. Disabled config bypasses even old markers. Foreground/background output directs follow-up to a fresh child; hooks and worktree safety are unchanged. A5–A6 and herdr remain unimplemented.
- `97dc6c2` — watchdog: stop cross-slot stall false-positives on shared-pid hosts.
- `2b2591f` — port Hermes persona doctrine.
- `0a576e7` — support externally owned worktrees.
- `d416d95` — allow host integrations to force conductor mode.
- `5d2ccdb` — stop installing a second Pi runtime.
- `cf527ef` — render sub-agent notifications as folded cards (see the 2026-06-20 decision-log entry).
- Enforced persona tool policy (`tools` / `exclude_tools`); see the 2026-09-24 decision-log entry.
- Per-spawn `cwd` on `ensemble_spawn` and each `ensemble_auto` step. It drives the child's process cwd, persona and config resolution, the git root for worktree isolation, and `run.cwd`. There is also a settable conductor default cwd: `/conductor cwd [<path>|--reset]` and the `ensemble_cwd` tool share one controller (`src/conductor-cwd.ts`), which persists a `conductor-cwd` session entry and restores it on `session_start`. pi's `ctx.cwd` updates never clobber the override. `ensemble_send` stays on `run.cwd`.
- Worktree children stay inside their worktree. A `worktree: true` spawn from a repo subdirectory works in the same subdirectory of its worktree (process cwd, seeded session header, `on_complete_hook`, resume restore), or at the worktree root when that directory isn't in the worktree. Persona `default_reads` reach the child as absolute paths: the child's own copy when it has one, else the requested cwd's, so untracked `context.md` / `plan.md` stay visible. The spawn prompt names the worktree, its branch, and the main checkout the child must not modify.
- Chain successors get `ensemble_spawn`'s worktree decision (`persona.worktree` and the config's `worktreeMode`), so a chained builder or simplifier branches its own worktree from the current HEAD, where a merged parent's work already is. When the parent's branch was kept unmerged (`mergeStrategy: none`), a write-capable successor is refused: it is recorded as a failed run whose card carries the kept-branch hint. Read-only successors still start, with `{worktreeBranch}` / `{baseBranch}`.

### v0.10+ — v2 ideas — _planned_
- Run-record GC (open question #12).
- `inherit_skills: true` (port parent skill catalog into child prompt).
- Worktree per persona (`worktree: true` in frontmatter). **Shipped v0.13.**
- Transient (in-process) runtime for read-only personas.
- Project-shareable persona library (a "marketplace" of `.md` files).
- Sub-agent → conductor mid-run messaging (analogous to pi-intercom).
- `ensemble_abort` — RPC graceful turn-cancel verb (deferred from v0.12 Q6; `ensemble_kill` stays SIGTERM).
- `Persona.steerable` frontmatter layer (deferred from v0.12 oracle fix #1; matches v0.10 `kill_on_stall` deferred-frontmatter shape).
- `extension_ui_request` proxy to focused-stream overlay (deferred from v0.12 Risk 2; today auto-cancels with `{cancelled: true}`).

## Open questions

All release-blocking questions through v0.7 are resolved. Remaining items are v1.x decisions that don't gate any current milestone.

1. ~~Naming.~~ **Resolved:** `pi-conductor`.
2. ~~Tool restriction enforcement.~~ **Resolved (2026-09-24):** enforced through pi's `--tools` / `--exclude-tools`; see §"Tool restriction in personas". Originally dropped on 2026-05-14 when pi had no such flags.
3. ~~Foreground vs background default.~~ **Resolved:** foreground default.
4. ~~Notification rendering.~~ **Resolved:** inline visible folded card.
5. ~~Persona tool inheritance.~~ **Resolved (2026-09-24):** a sub-agent gets its persona's `tools` / `exclude_tools` plus the always-excluded conductor and foreign spawn tools; nothing is inherited from the parent's tool set.
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
- **Tool restriction is partial.** Pi enforces `tools` / `exclude_tools`, but `bash` stays available unless excluded. Document it as partial enforcement and don't pretend it's a security boundary.
- **Cost surprises.** Multiple sub-agents in parallel with `thinking: high` can rack up cost fast. Mitigation: ensemble panel shows running cost; settings cap `maxConcurrent`; doctor warns if all personas use high-thinking large models.

## Decision log

- 2026-05-14 — Codename `pi-conductor` confirmed.
- 2026-05-14 — Will not replace `pi-essentials/subagent`; coexistence via `ensemble_*` tool namespace.
- 2026-05-14 — Sub-agents are subprocesses (subprocess pi --mode json -p); transient/in-process is a v2 option.
- 2026-05-14 — **Foreground by default** (was background). Background via `foreground: false`.
- 2026-05-14 — **Tool restrictions dropped.** Pi has no clean enforcement; persona `tools:` field removed; personas describe expected tool boundaries in prompt only. _Superseded 2026-09-24 — see entry below._
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
  - **Q2 — Soft threshold default 120s, hard threshold default 600s, tick interval 30s.** Empirical witness — the three observed pre-v0.10 hangs (`critic-yjsn`, `builder-z98m`, orchestrator `npm test`) all sat silent for >5 min; 120/600 catches that band with the soft tier as advisory and the hard tier as the kill threshold (when opted-in). Tick interval 30s is the sweet spot between detection lag and conductor wake-up cost (60s sluggish for a 120s soft, 10s excessive given the 4-slot concurrency cap). Tunable via `cfg.watchdog.{defaultSoftSeconds, defaultHardSeconds, tickIntervalSeconds}`; field-data tuning tracked in `docs/backlog.md` §"v0.10 Slice 3 follow-ups".
  - **Q3 — Soft advisory ships `triggerTurn: false`, `deliverAs: "followUp"`** (reversed from the original §7 Q3 recommendation of `triggerTurn: true`). The advisory is injected as system context the conductor sees on its next natural turn rather than yanking the user mid-edit with an immediate triggered turn. Reversed at slice-2 implementation time (`b7a36a9`, `src/index.ts:374`); slice-3 + slice-4 dogfooding validated the call. Soft advisories fire on legitimately slow operations (e.g. `npm test` stability loops, slow LLM thinking turns where `tool_execution_update` partials don't bump `lastEventAt`) that under `triggerTurn: true` would have produced spurious conductor turns for non-stalls. Widget glyph (slice 4) provides synchronous visual surfacing; the conductor still observes the advisory on its next action. Hard-threshold escalation (when `kill_on_stall` is set) and user-initiated abort handle the genuine-stall case. Reference `src/index.ts:374`, `docs/v0.10-watchdog-design.md` §7 Q3.
  - **Q4 — `Run.stalledSince` is in-memory only.** The field is meaningful only while the run is live; on terminal status it's irrelevant. Persisting would force a `RunRecord` schema bump and add restart-time invariants (do we re-derive on session_start? snapshot at shutdown?) for a field with no off-line use. Reference §7 Q4. Implementation: `src/types.ts` `Run.stalledSince` is unset on `RunRecord`; the watchdog re-derives state from `lastEventAt` on each tick.
  - **Q5 — `watchdog_silence` per-spawn flag DEFERRED.** Speculative knob with no field data justifying it (zero advisory cry-wolf escalations observed at slice-3 close). Build-on-demand: when ≥1 persona reliably trips advisories during legitimate work, add the per-spawn opt-out + a persona-frontmatter cascade entry (also deferred — see `docs/backlog.md` §"v0.10 Slice 3 follow-ups"). Reference §7 Q5 and §7 "Deferred from Slice 3".
  - Also locked: detector ignores paused (`Run.pausedAt !== undefined`) / terminal / queued runs and respects an initial grace window before first soft-fire (slice 1, `c8623cb`); pre-kill recheck inside the enforcer (slice 2, `b7a36a9`) re-evaluates stall freshness immediately before `forceTerminate` to defeat the recover-between-detector-and-kill race (design A2); W1 mutation witness imports `resolveKillOnStall` from `src/watchdog.ts` directly per `docs/wdd.md` parallel-formula rule rather than reconstructing the production lambda inline (slice 3, `9bed244` + parallel-formula doc `2999fca`). Test count: 953 → 972 (+19) across the v0.10 chain.
- 2026-05-21 — **v0.9.x post-startup reconcile — locked decisions D1–D5** (4 slice commits `d5583be..1f9604a`; design `docs/v0.9.x-post-startup-reconcile-design.md`).
  - **D1 — Reuse `killed` status with errorMessage prefix instead of adding a new `RunStatus`.** New status `crashed` would have forced an audit of every consumer (8 readers in v0.11 slice 1a alone). The `errorMessage` prefix `"orphaned: ..."` discriminates without enum churn. Backward compatible with existing `RunStatus` consumers; history rendering surfaces the prefix as a `⎘ orphaned:` glyph.
  - **D2 — `kill(pid, 0)` for liveness; EPERM treated as alive.** Pid 1 and other privileged processes raise EPERM but exist; the conservative call is to treat them as alive rather than reclassify a possibly-still-running orphan. ESRCH is the only signal of a dead process. Pinned by `tests/reconcile-startup-classifier.test.ts: EPERM treated as alive`.
  - **D3 — `setImmediate(reconcile) → setImmediate(GC)` ordering at `session_start`.** Reconcile must run before GC so GC sees the reclassified-killed records, not orphan-running ones. Both fire as deferred microtasks so the extension's `session_start` handler returns synchronously; ordering is by registration order in `src/index.ts`. Pinned by `tests/reconcile-startup-resume.test.ts`.
  - **D4 — One-shot per startup, no debounce.** Unlike GC's 6h debounce, reconcile is cheap (single readdir + N JSON parses) and idempotent (same-tree second pass produces empty `readopted`/`reclassified`). Manual re-run via `/conductor reconcile`.
  - **D5 — `--dry-run` via `dryRun: true` deps flag, not a separate preview function.** Single branch in `reconcileOrphansAtStartup` skips the 4 mutation sites; same result envelope shape as the live path. Avoids duplicating the classification arithmetic between live and preview code paths.
- 2026-05-28 — **v0.12 steering — locked decisions Q1/Q2/Q6/Q9 + oracle fixes #1–#3 + Risk 2** (8 slice commits `3f73d9d..dcf7ef0`; design `docs/v0.12-steering-design.md`; plan `docs/v0.12-steering-plan.md`).
- 2026-05-29 — **v0.11 on_complete_hook quality gates — shipped.** 6 slice commits: 1a `31fb4bd`, 1b `bffa16f`, 2 `35f4dd3`, 3 `7b4b8b4`, 4 `bb2ac6a`, 5 `35025f8`. Test count 973 → 1369 (+396 net across v0.11 slices + intervening bug-bash commits). R8 soft-compat: `hook_failed` is a new terminal `RunStatus` in `record.json`; external consumers must treat it as failure-class. R9: `final.md` mtime now precedes hook wall-time; tooling that assumes `final.md` mtime ≈ run-end must account for the delta. Verifier PASS 2026-05-29 (1369 tests / 0 fail / 11 skipped; tsc clean).
  - **Q1 — `steerable: true` per-spawn opt-in, default OFF; persona-frontmatter layer DEFERRED (oracle fix #1).** Steerable runs hold a live RPC subprocess + open stdin pipe between turns; making that the default would multiply long-lived process count for sub-agents that complete in seconds and never get sent to. Cascade shape mirrors v0.10 `kill_on_stall` exactly: per-call > project config > user config > built-in default `false`. The persona-frontmatter layer was on the table briefly but dropped to keep the two cascades isomorphic (a future PRD entry can upgrade both together; mixed shapes would accrete drift in `effectiveConfig`). Reference design §3 Q1, §4.1; oracle review fix #1.
  - **Q2 — `streaming_behavior: "auto" | "steer" | "follow_up" | "resume"` overload on `ensemble_send`, defaulting to non-disruptive.** `auto` resolves to `follow_up` for running steerable runs (queue at next turn boundary) and `resume` for terminal runs (today's `pi --session` behavior). `steer` interrupts mid-turn; `resume` rejects on running runs with a named error. The non-interrupting default matches v0.10 Q3's reversal posture (advisory ships `triggerTurn: false`) — the LLM defaults to politeness, opts into interruption explicitly. Decision matrix is pure-function `resolveSendStrategy(run, behavior)` pinned by ~20 unit cases incl. W3 string-pin witnesses. Reference design §4.3.
  - **Q6 — `ensemble_kill` stays SIGTERM; `ensemble_abort` (RPC graceful turn-cancel) DEFERRED to v2.** Adding a soft-cancel verb between "send" and "kill" changes the LLM's mental model of "kill = gone" without field data justifying the complexity. The existing `applyCloseHandlerTerminal` race-fix and W7 idempotency guard (`runs.ts:1296`/`:1386`/`:1454`) stay intact. `RpcStdinQueue.destroy("force-terminate")` runs before SIGTERM so pending stdin-write promises reject cleanly. Reference design §4.6.
  - **Q9 (with oracle fix #2) — Watchdog `lastEventAt` bump asymmetry: bumps on `response`, NOT on `extension_ui_request`.** Initial draft would have bumped on every inbound RPC line; oracle fix #2 narrowed it because `extension_ui_request` lines are *blocking on the host* (the sub-agent's extension is waiting for our reply), not progress signals. Bumping on those would mask a genuine stall class. Pinned by W2 mutation witness in `tests/event-handler-rpc.test.ts` covering both directions (false-negative if `response` doesn't bump; false-positive if `extension_ui_request` does). Reference design §4.7.
  - **Oracle fix #3 — Orphaned RPC subprocesses on conductor restart reclassify to `killed` with `errorMessage: "orphaned: rpc-stream-detached"`.** A live RPC subprocess whose stdin pipe the reborn conductor doesn't own is unsteerable; reclassifying preserves the v0.9.x D1 pattern (reuse `killed` RunStatus + errorMessage prefix; no new RunStatus, no consumer audit churn). Executor SIGTERMs the stranded pid (best effort; ESRCH is benign). The `⎘ orphaned:` history glyph already handles the new prefix without further changes. Reference design §4.4; oracle review fix #3.
  - **Risk 2 — `extension_ui_request` always auto-cancels with `{cancelled: true}`.** Steerable personas can't rely on `ctx.ui.confirm`/`select` from extensions — the conductor synchronously enqueues a cancellation envelope and logs a warning. Proxy-to-overseer was rejected as a v2 feature (UI-shaping decision needing field data); auto-cancel keeps the wire layer simple and makes the failure mode explicit to extension authors. Reference design §4.2; oracle review Risk 2.
  - Also locked: single-writer per-run async stdin queue (`src/rpc-stdin.ts`) with FIFO + LF-only framing closes Risk 1 (stdin race / partial-event tearing); vendored RPC type subset (`src/rpc-types.ts`) avoids hard runtime coupling on pi's non-public dist (no startup shape probe — Q5-deferred pattern from v0.10); slice 5 critic gate three-pronged (W2 bump asymmetry + reconcile-orphan classify+executor + forceTerminate `pendingAcks` cleanup). Test count: 1184 → ~1267 (+~83) across the v0.12 chain.
- 2026-06-19 — **v0.16 event bus + chain-aware worktrees — shipped.** 8 commits `7e70e58..d156850`. `ConductorEventEmitter` with 6 lifecycle + 3 hook channels under `conductor:agent:*`; dual JSON+RPC compacted detection; `{worktreeBranch}/{baseBranch}` chain template vars; infrastructure fixes for test isolation (`CONDUCTOR_SUBAGENT` unset) and `core.bare` corruption. Design `docs/v0.16-events-design.md`. Test count ~1476 → ~1510 (+~34).
- 2026-06-19 — **v0.17 graceful turn limits + hook events — shipped.** 7 commits `ddd5ea3..0c6b388`. `"aborted"` RunStatus; `resolveMaxTurns`/`resolveGraceTurns` cascade; `checkTurnLimit` enforcement in `processLine` with grace injection; hook lifecycle events from `src/hooks.ts`; UX surfaces in widget/doctor/history/notifications/prompt. Design `docs/v0.17-graceful-turns-design.md`. Test count ~1510 → 1546 (+36). Verifier PASS (1546 pass / 0 fail / 11 skipped; tsc clean).
- 2026-06-20 — **Folded completion cards actually rendered.** The 2026-05-14 decision above ("inline-visible folded completion cards") shipped only half: `pushCompletionNotification` sent `customType: "ensemble-notification"` with no `details` and no `pi.registerMessageRenderer`, so pi's `CustomMessageComponent` fell through to its default branch and printed the fenced ```xml envelope verbatim. The deferral note in `src/notifications.ts` ("pi's customMessage rendering doesn't yet support collapsible cards") was wrong — `MessageRenderer` has received `{ expanded, outputPad }` for as long as it has existed. Fix: `buildCompletionMessage` / `buildStallMessage` attach a pre-formatted `EnsembleNotificationDetails` beside the unchanged XML content, and `src/notification-renderer.ts` lays it out as spans (pure) which `paintCardLines` styles (the only ANSI step), mirroring the `transcript.ts` → `transcript-style.ts` split. Collapsed = header + one-line preview + ctrl+o hint; expanded adds the full body (capped at 40 lines), annotation rows, and the transcript path. Renderer returns `undefined` when `details` is absent so pre-existing sessions degrade to the old rendering rather than crash. Test count 1657 → 1673 (+16).
- 2026-09-24 — **Tool restrictions enforced; reverses the 2026-05-14 drop.** The original rationale ("pi has no clean way to whitelist tools in a child") no longer holds: pi 0.87.1 ships `--tools <csv>` (allowlist, replaces the default active set, applies to builtin and extension tools), `--exclude-tools <csv>` (denylist), and `--no-builtin-tools`. Filtering is Set-based (`dist/core/sdk.js` ~L140; `dist/core/agent-session.js` `_refreshToolRegistry` ~L2494), so unknown names are harmless and an excluded tool leaves the child's registry. Persona frontmatter gains `tools` and `exclude_tools` (block lists, name shape `^[A-Za-z0-9_.:-]+$`, deduped; `personaOverrides.<name>.tools` / `.exclude_tools` replace the whole array). `buildPiArgs` emits `--tools` when an allowlist is set and always emits `--exclude-tools` with the persona's exclusions unioned with `CONDUCTOR_LLM_TOOL_NAMES`, the constant `registerTools` reads its names from; fresh and resume spawns alike, with the effective lists persisted on `Run` / `record.json`. The nine read-only builtins exclude `edit` / `write` / `insert_before` / `insert_after`. `--no-extensions` is deliberately never emitted: the user's model provider is an extension. **Partial enforcement:** `bash` stays available, so this narrows the edit surface rather than sandboxing the child; the `CONDUCTOR_SUBAGENT=1` registration gate stays as defense in depth. _Amended the same day:_ the always-excluded list also carries `FOREIGN_SPAWN_TOOLS` (`subagent`, `agent`), because pi's bundled `subagent` extension is loaded globally from `settings.json` and gave every child an unsupervised spawn tool; `/conductor doctor` warns about other loaded tools whose names look spawn-capable.
- 2026-09-24 — **Startup reconcile: lead-only, and re-adopted runs never auto-merge.** A conductor child (`CONDUCTOR_SUBAGENT=1`) skips `reconcileOrphansAtStartup` at session_start: it shares the lead's runs root but owns none of its runs. `buildOrphanRun` now restores every field `record.json` persists (steerable, streamingMode, the worktree and merge fields, failureClass / retryAttempt, the per-invocation markers, resumeCount, compactionCount, lastEventAt). With the worktree fields back, a re-adopted run could reach `completed` through an `ensemble_send` resume and auto-merge, but its spawn-time `on_complete_hook` gate can't be rebuilt faithfully: the per-call hook is never persisted, and the resume runs in `run.cwd`, not the worktree being merged. So `applyMergeToTerminal` refuses re-adopted runs (`Run.reconciledAtStartup`, in-memory only) and returns `merge_conflict` with a hint to review the branch and run `/conductor worktree merge <id>`.
- 2026-09-24 — **A run that isn't merged never deletes unmerged commits; amends v0.14 Q6.** v0.14 Q6 removed a `failed` or `hook_failed` run's worktree and deleted its branch under `squash` / `merge`. Since v0.20 B4 (`b2976ee`) runs the `on_complete_hook` gate in the worktree, `hook_failed` is the normal outcome for work that fails the gate, and that rule deleted the work. Now every terminal other than a successful merge keeps the branch while it has commits the base branch can't reach (`git rev-list --count <base>..<branch>`; a git error counts as unmerged). The directory goes only when it's clean, as `releaseWorktree` already did. `run.worktreeBranch` stays set in `record.json`, the completion card names the branch, `/conductor worktree list` shows it as "directory removed; branch kept", and GC rule 5b deletes it from `record.cwd` after `mergeConflictTtlDays`. A completed run's branch without a directory is a `none` deliverable, so rule 5b leaves it alone. A branch with no unique commits is still deleted, since nothing is lost.

- 2026-09-30 — **H11 launch corrections adopted (user approved); automated real-herdr matrix passes; not rolled out.** The task is prepared durably before `agent start` and published only after herdr registers an idle child and its identity is proven. Each launch has a fresh physical agent name while the run id and Pi session stay the same. The hello reports the executing host Pi, not conductor's imported copy (labelled `piLibraryVersion`), and a lead/child mismatch is persisted and shown. Startup never readopts a requested herdr termination (a live kill had become failed after `/reload`). On herdr 0.9.1 with Pi 0.87.1 and 0.99.1, the 13 live scenarios pass: lifecycle, parity, steer/follow-up, ask/reply, kill, pane close and resume, threshold retirement, reload, crash takeover, effort hook/generated/verify/CAS, effort crash recovery, restart status/pane retention, version mismatch. Remaining: independent review, human TUI acceptance (unverified), and completed records still re-finalized on each restart. Delivery stays at most once.
- 2026-09-30 — **H11: isolated real-herdr acceptance found launch blockers; not rolled out.** An opt-in live test runs a real lead Pi and interactive Pi 0.87.1/0.99.1 children in a private, uniquely named herdr 0.9.1 session with an offline faux model, per-call socket ownership proof and exact-identity teardown. Kill, `/reload` reattach and lead-crash takeover pass on both versions. Herdr's omission of absent pane agent fields was fixed with a regression test. Two conflicts with the H6/H8 launch contract remain open for a decision: `agent start` succeeds only for an idle agent, but the initial request is written before it (child busy or exited at readiness), and a reused alias hits `agent_name_taken` after the previous agent exits. Retirement, herdr effort writers and human TUI checks are unverified. Keep `runtime: "subprocess"`. Prior art credit: pi-herdsman; nothing copied. LICENSE (MIT, contributors) added from the package's existing MIT declaration.
- 2026-09-24 — **Phase A A2: retire context, not the task.** Reimplemented the retirement idea without copying herdsman code. Only `CONDUCTOR_SUBAGENT=1` sessions change compaction behavior; the session's exact ID is persisted via `pi.appendEntry` before cancelling automatic threshold compaction. Overflow recovery is never cancelled and manual compaction is untouched. Guidance is injected into each request, not appended as conversation messages, and requires a safe stopping point, essential validation, and an honest self-contained handoff. Parent finalization reads the child's saved session before notifications and continuation decisions and persists `contextRetired`; copied parent markers cannot retire a new child. `ensemble_send`, slash sends, and overlay sends share rejection before subprocess/worktree effects. `contextRetirement: false` bypasses old markers without deleting metadata. A private child env value carries the spawning config cwd so untracked project settings still apply inside worktrees. Finalization now waits for native `agent_settled` (or process exit), since installed Pi performs overflow recovery after `agent_end`; RPC requires that event. Retirement alone is neither failure nor proof of task completion, and does not bypass quality hooks or worktree safety. Scope: **A2 only**, no A3–A6, fork API, or new orchestration tool.

- M5 delivery decision — **at-most-once automatic callback dispatch**, not exactly-once external delivery. Persist intent before the shared settlement tail invokes completion callbacks, lifecycle events and the local best-effort memory append. An interrupted intent is delivery-uncertain: keep Git-proven integration and usable result files, suppress automatic replay, and disclose potentially missed notification/event/outcome. A returned local dispatch is not receiver acknowledgement. Human inspection/manual repost can duplicate prior delivery; never reintegrate to recreate a notification. Receiver-side acknowledgements/deduplication remain out of scope. README “Recovery guarantees and human controls” documents commands and fail-closed limits.


### H10 — Fenced herdr reattachment (offline implementation; not rolled out)

- Run-stream ownership uses durable exclusive-create, append-only generations, with module epoch, session, PID/start identity, socket, run and launch nonce. Release fences rather than unlinks a generation. Live/unknown owners refuse takeover; off Linux, proven dead PID plus age at least 90 seconds is the minimum.
- Reload refuses new herdr launches/callback admission, awaits pipeline and existing M5 transition/settlement barriers, then detaches observation and releases its own generation without finalizing the child. Subprocess reload pipelines remain unchanged. Quit retains proof-backed stop/cleanup and the post-M5 five-second pane budget.
- Same-socket startup classifies herdr before legacy PID/effort restoration, claims one stream, and reconstructs accepted invocation history within a 32 MiB LF-aligned window. No task resend, usage accumulation, automatic chain or retry. Proven death without accepted native settlement is failure; unknown ownership/identity preserves evidence. Original ordinary hooks cannot be faithfully reconstructed, so recovered work never auto-merges past that gate.
- Ordinary settlement uses `herdr.settlement` with launch nonce and `intent | attempted | uncertain`. Persist intent before automatic external completion dispatch; an interrupted intent suppresses replay and can miss a notification/event/memory outcome. Repairable final files are not a reason to rerun a task. This is at-most-once automatic dispatch, not exactly-once receiver delivery.
- Run attachment is not EffortOwner authority. A live proc-less herdr writer survives registry restoration and is bound only after explicit M5 ownership recovery. Durable integration WAL remains exclusively M5's responsibility and uses only `integration.delivery`. No attachment-driven verifier/CAS restart, ungated merge or effort GC is introduced.
- Evidence is offline: executable fake herdr, private Git repositories and approved native Pi 0.87.1 faux children. Real herdr/TUI acceptance is H11; no global settings, package-cache or global Pi 0.99.1 rollout is certified here.
