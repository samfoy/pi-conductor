# pi-conductor

A pi extension that turns the parent pi session into an **orchestrator** driving a roster of **persona-based sub-agents** with first-class TUI visibility.

> **v0.5 — send & resume.** Persona discovery, full ensemble roster (`spawn`, `send`, `pause`, `resume`, `status`, `list`, `focus`), focused-stream overlay with the `s` keybinding to send follow-ups inline.

See [`PRD.md`](./PRD.md) for the full design and decision log.

## Why pi-conductor

Pi already has good options for sub-agents (`pi-essentials/subagent`, `pi-mono/team-mode`, `pi-subagents`). They each leave one gap: **you can't watch a sub-agent stream live inside pi's TUI.** You either tail a tmux pane, read a log file, or see a status widget that shows tool-call hints but not the actual reasoning.

pi-conductor closes that gap. The parent pi session is the conductor, sub-agents are subprocesses, and the user can drop into any sub-agent's live transcript view at will — without leaving pi.

## v0.5 — what works today

- Everything from v0.1–v0.4 (persona discovery + roster, all tools listed below, queue with auto-downgrade, ensemble panel, conductor mode prompt, focused-stream overlay).
- **`ensemble_send(agent_id, message, foreground?)`** — continue an existing sub-agent's session with a new user-role message. Works on finished sub-agents too — resumes via `pi --session <path>`. Foreground default streams tool-call hints inline; background notifies via the standard `<sub-agent-completed>` card.
- **`ensemble_pause(agent_id)`** / **`ensemble_resume(agent_id)`** — LLM-callable wrappers around SIGSTOP / SIGCONT. The corresponding slash commands (`/conductor pause` / `/conductor resume`) are unchanged.
- **Resumable sessions on disk** — every spawn now writes its session JSONL into `<runDir>/session/`; `Run.sessionPath` is populated on finalize so `ensemble_send` can resume the sub-agent at any later point.
- **Focused-stream `s` keybinding** — prompts the user for a follow-up message and dispatches it through `sendToRun` for the focused sub-agent. Footer now shows `s send`.
- **`getPiInvocation` fix** — honors a `PI_BIN` env override and only re-uses `process.argv[1]` when it actually looks like pi's CLI. Live integration tests can now exercise spawn + send end-to-end via `CONDUCTOR_LIVE_TESTS=1`.

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

- **v0.6** — `inherit_context: filtered` (port the parent's filtered conversation into the sub-agent's session).
- **v0.7+** — inline-streamed foreground transcript, history browser, run-record GC.

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
- [x] v0.5 — `ensemble_send` + `ensemble_pause` / `ensemble_resume` + overlay `s` keybinding
- [ ] v0.4 — Inline-streamed foreground transcript (foreground currently returns the result card; the live stream is via the panel + Ctrl+G overlay)
- [ ] v0.6 — Filtered context inheritance + history browser

## License

MIT.
