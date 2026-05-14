# pi-conductor

A pi extension that turns the parent pi session into an **orchestrator** driving a roster of **persona-based sub-agents** with first-class TUI visibility.

> **v0.1 — read-only scaffold.** Persona discovery, listing, and inspection. Spawning, the ensemble panel, and the focused stream view land in v0.2+.

See [`PRD.md`](./PRD.md) for the full design and decision log.

## Why pi-conductor

Pi already has good options for sub-agents (`pi-essentials/subagent`, `pi-mono/team-mode`, `pi-subagents`). They each leave one gap: **you can't watch a sub-agent stream live inside pi's TUI.** You either tail a tmux pane, read a log file, or see a status widget that shows tool-call hints but not the actual reasoning.

pi-conductor closes that gap. The parent pi session is the conductor, sub-agents are subprocesses, and the user can drop into any sub-agent's live transcript view at will — without leaving pi.

## v0.3 — what works today

- Everything from v0.1 + v0.2 (persona discovery + roster, `ensemble_list`, `ensemble_status`, `ensemble_spawn` foreground/background, queue with auto-downgrade, ensemble panel, conductor mode prompt, pause/resume/stop, `/conductor` slash commands, doctor with config error surfacing, applyEvent extracted for testability).
- **`ensemble_focus(agent_id?)`** — LLM-callable tool that opens the focused-stream overlay on a sub-agent. Omit `agent_id` to open on the most recently active sub-agent.
- **`/conductor focus <agent-id>`** — user-facing slash command equivalent.
- **`Ctrl+G`** — keybinding that opens the overlay on the most recently active sub-agent.
- **Focused stream overlay** — full-screen drilldown that renders one sub-agent's live transcript: header (persona, id, status, elapsed, usage), turn-separated assistant messages with collapsible tool calls and toggleable thinking blocks, footer with keybinding hints.
  - `Esc` close, `Tab`/`Shift+Tab` cycle, `↑/↓` scroll, `PgUp/PgDn` page scroll, `c` toggle tool-call collapse, `t` toggle thinking visibility, `k` kill the focused sub-agent.
  - Scroll position is per-agent; fold flags are global.
  - Live updates: the overlay re-renders as the sub-agent emits events.

- **Persona discovery + resolution** — markdown files with frontmatter; layered builtin → user → project precedence.
- **16 starter personas** covering the full SDLC, adapted from external role definitions:
  - **Discovery:** `inspector`, `analyst`, `cartographer`
  - **Spec / design:** `clarifier`, `designer`, `oracle`
  - **Implementation:** `planner`, `builder`, `simplifier`
  - **Review / verification:** `critic`, `redteam`, `finalizer`, `verifier`
  - **Debugging:** `investigator`
  - **Other:** `profiler`, `scribe`
- **Tools:**
  - `ensemble_list` — list available personas with descriptions, model/thinking config, and source.
  - `ensemble_status` — stub returning empty until v0.2 ships spawning.
- **Slash commands:**
  - `/conductor list` — list personas with their resolved configuration.
  - `/conductor show <name>` — display a persona's full file (system prompt + frontmatter).
  - `/conductor doctor` — health check: persona counts by source, shadowed entries, parse errors, unknown overrides, config file resolution.

## Coming next

Per the [PRD](./PRD.md):

- **v0.4** — inline-streamed foreground transcript (currently foreground blocks but renders only the final completion card; we want the live stream to render in the parent conversation).
- **v0.5** — `ensemble_send` (continue a sub-agent's session via `pi --session`), and `s` keybinding inside the overlay to send a message.
- **v0.6** — `inherit_context: filtered` (port the parent's filtered conversation into the sub-agent's session).

## Install

```bash
# Clone for development
git clone https://github.com/samfoy/pi-conductor.git
cd pi-conductor
npm install
npm test

# Load locally with pi
pi -e /path/to/pi-conductor/src/index.ts
```

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

- [x] v0.1 — Read-only scaffold
- [x] v0.2 — Background spawning + ensemble panel + queue + conductor mode
- [x] v0.3 — Focused stream overlay (Ctrl+G)
- [ ] v0.4 — Foreground spawning with inline-streamed transcript (currently foreground returns the result card)
- [ ] v0.5 — Send / pause / resume / kill (kill works via /conductor stop and overlay 'k'; send is the missing piece)
- [ ] v0.6 — Filtered context inheritance + history browser

## License

MIT.
