# pi-conductor

A pi extension that turns the parent pi session into an **orchestrator** driving a roster of **persona-based sub-agents** with first-class TUI visibility.

> **Current state: v0.7 shipped.** Conductor mode is on by default; foreground sub-agents stream their transcript inline in the parent's tool-call card; Esc detaches a foreground spawn into the background; `/conductor history` browses past runs; sub-agents can inherit a filtered slice of the conductor's conversation; the focused-stream overlay (Ctrl+G) drills into any sub-agent's live transcript.

See [`PRD.md`](./PRD.md) for the full design and decision log.

## Why pi-conductor

Pi already has good options for sub-agents (`pi-essentials/subagent`, `pi-mono/team-mode`, `pi-subagents`). They each leave one gap: **you can't watch a sub-agent stream live inside pi's TUI.** You either tail a tmux pane, read a log file, or see a status widget that shows tool-call hints but not the actual reasoning.

pi-conductor closes that gap. The parent pi session is the conductor, sub-agents are subprocesses, and the user can drop into any sub-agent's live transcript view at will — without leaving pi.

## What works today

### Personas + tools

- **16 starter personas** covering the full SDLC, layered builtin → user → project precedence:
  - **Discovery:** `inspector`, `analyst`, `cartographer`
  - **Spec / design:** `clarifier`, `designer`, `oracle`
  - **Implementation:** `planner`, `builder`, `simplifier`
  - **Review / verification:** `critic`, `redteam`, `finalizer`, `verifier`
  - **Debugging:** `investigator`
  - **Other:** `profiler`, `scribe`
- **LLM tools:** `ensemble_list`, `ensemble_status`, `ensemble_spawn`, `ensemble_send`, `ensemble_pause`, `ensemble_resume`, `ensemble_focus`.
- **Slash commands:** `/conductor list | show | doctor | on | off | status | stop | pause | resume | queue | focus | history`.

### Spawning + lifecycle

- **Foreground spawns** (default) block AND stream the sub-agent's transcript inline in the parent's tool-call card. Updates are throttled at 50ms; the card collapses to a compact 1–3 line summary on completion. Width tracks the live terminal (`process.stdout.columns`, clamped to [40, 240]).
- **Background spawns** return immediately; completion arrives as a `<sub-agent-completed>` notification card.
- **Esc detaches** a foreground spawn into a background run; the conductor gets a `detached-as-background` result so it doesn't re-spawn, and the eventual completion still arrives as a notification card. **Ctrl+C kills.**
- **Concurrency cap + FIFO queue**; foreground-while-full auto-downgrades to background.
- **Pause / resume** via SIGSTOP / SIGCONT; **stop** via SIGTERM. Works on running OR queued sub-agents.

### Context inheritance

- **`inherit_context: filtered`** — sub-agent boots with a seeded session of the conductor's filtered transcript: keeps user/assistant prose + read/write/bash tool calls + branch / compaction summaries; drops `ensemble_*` and `subagent` orchestration noise, `<sub-agent-completed>` cards, and `!!`-prefix bash entries.
- **`inherit_context: full`** passes the whole transcript verbatim.
- **`inherit_context: none`** boots fresh.
- The persona file's frontmatter decides; the conductor doesn't.

### TUI surface

- **Ensemble panel** — always-visible widget below the editor when ≥1 sub-agent is active or recently finished.
- **Focused stream overlay (Ctrl+G)** — full-screen drilldown of one sub-agent's live transcript. Tab/Sh-Tab cycle, ↑↓ scroll, `c` collapse tool calls, `t` show thinking, `s` send a follow-up, `k` kill, Esc close.
- **Conductor system prompt addendum** — auto-injected at every turn when conductor mode is on (default). Documents the persona roster, the `ensemble_*` tools, parallelism rules, the queue auto-downgrade contract, parent-snapshot semantics, and **§10 — heuristic delegation triggers** so the LLM proactively reaches for personas when appropriate.
- **`/conductor history [N]`** — browses past runs from `~/.pi/agent/conductor/runs/`, sorted by mtime DESC, default 20.

### Persistence

- Every spawn writes its session JSONL into `<runDir>/session/`; `Run.sessionPath` is populated up-front when seeded or on finalize for fresh spawns.
- `ensemble_send` resumes any finished sub-agent's session via `pi --session <path>`. Reuse a sub-agent's loaded context instead of re-spawning when you want a follow-up.

## Install

```bash
# Clone for development
git clone https://github.com/samfoy/pi-conductor.git
cd pi-conductor
npm install --registry https://registry.npmjs.org    # @earendil-works packages
npm test

# Load locally with pi (per session)
pi -e /path/to/pi-conductor/src/index.ts

# Or auto-load every session
mkdir -p ~/.pi/agent/extensions/conductor
ln -s /path/to/pi-conductor/src/index.ts ~/.pi/agent/extensions/conductor/index.ts
```

> Conductor mode is **on by default** when the extension loads. Disable per session with `PI_CONDUCTOR_MODE=0` or `/conductor off`. The tools and slash commands stay registered either way; only the system-prompt addendum is gated.

Once published:

```bash
pi install npm:@samfp/pi-conductor
```

## Persona discovery paths

```
~/.pi/agent/conductor/personas/<name>.md         # user-level
<project>/.pi/conductor/personas/<name>.md       # project-level (overrides user)
```

Both override the bundled built-ins. No other discovery paths.

## Persona file format

```markdown
---
name: oracle
description: Decision-consistency check before committing to an approach
model: anthropic/claude-sonnet-4    # optional — omit to inherit from parent session
thinking: high                       # optional — omit to inherit from parent session
inherit_context: filtered            # none | filtered | full
inherit_skills: false
default_reads:
  - context.md
  - design.md
  - plan.md
worktree: false
timeout_minutes: 30
---

You are the oracle: …
…full system prompt body…

## Source

Adapted from … with the following changes …
```

**No `tools` field.** Pi has no clean way to whitelist tools in a child subprocess; pi-conductor doesn't fake it. Personas describe expected tool boundaries in the prompt body.

## Configuration

`~/.pi/agent/extensions/conductor/config.json` (user) or `<project>/.pi/conductor.json` (project, overrides user):

```jsonc
{
  "defaultTimeoutMinutes": 30,
  "maxConcurrent": 4,
  "queueOnConcurrencyCap": true,
  "autoOpenFocusOnSpawn": false,
  "defaultSpawnMode": "foreground",
  "personaOverrides": {
    "oracle":   { "model": "anthropic/claude-opus-4-1", "thinking": "high" },
    "redteam":  { "disabled": true }
  },
  "conductorPromptPath": null
}
```

## Coexistence with `pi-essentials/subagent`

pi-conductor does **not** replace `pi-essentials/subagent`. Different tools (`ensemble_*` vs `subagent`), different mental models. Both can be loaded.

| Use… | When… |
|---|---|
| `pi-essentials/subagent` | "Go investigate X in the background while I keep coding." Fire-and-forget, no persona. |
| `pi-conductor` | "Have the oracle review my plan." / "Run a planner → builder → critic chain on this." Persona-named, live-watchable, conductor-led. |

## Status

- [x] v0.1 — Read-only scaffold (persona discovery, list/show/doctor)
- [x] v0.2 — Background spawning + ensemble panel + queue + conductor mode
- [x] v0.3 — Focused stream overlay (Ctrl+G)
- [x] v0.4 — Inline-streamed foreground transcript (throttled tool-card re-render; compact summary on completion)
- [x] v0.5 — `ensemble_send` + `ensemble_pause` / `ensemble_resume` + overlay `s` keybinding
- [x] v0.6 — Filtered context inheritance (`inherit_context: filtered` / `full`)
- [x] v0.7 — Esc-to-detach + `/conductor history` + live terminal width + conductor mode on by default + §10 delegation triggers
- [ ] v0.8 — Run-record GC, worktree per persona, `inherit_skills: true`

## License

MIT.
