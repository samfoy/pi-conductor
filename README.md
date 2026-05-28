# pi-conductor

A pi extension that turns the parent pi session into an **orchestrator** driving a roster of **persona-based sub-agents** with first-class TUI visibility.

> **Current state: v0.12 shipped.** All milestones v0.1–v0.12 are live. Highlights through v0.10: conductor mode (OFF by default in v0.8+), foreground sub-agents that stream their transcript inline in the parent's tool-call card, Esc-to-detach into the background, the focused-stream overlay (Ctrl+G) for live drilldown, filtered context inheritance (incl. v0.12's `filtered_compact` for builder-shaped personas), `ensemble_send`/`pause`/`resume`/`kill`/`focus`, `/conductor history`, run-record GC capstone (auto + manual + cold-archive + delete + user-pinning), post-startup reconcile of orphaned runs, and the sub-agent watchdog (soft/hard stall thresholds + per-spawn `kill_on_stall`).
>
> **v0.12 — steering** — `ensemble_spawn` gains `steerable: true` (per-spawn opt-in, default OFF) to launch a sub-agent in pi's RPC mode; `ensemble_send` gains `streaming_behavior: "auto"|"steer"|"follow_up"|"resume"`, defaulting to a non-disruptive queue; `/conductor send` slash command + the focused-stream overlay's `s` keybinding both route through the same surface. Single-writer stdin queue, watchdog `lastEventAt` bump asymmetry between `response` and host-blocking `extension_ui_request` lines, orphan-RPC reconcile branch on conductor restart. Design at [`docs/v0.12-steering-design.md`](./docs/v0.12-steering-design.md); plan at [`docs/v0.12-steering-plan.md`](./docs/v0.12-steering-plan.md).
>
> **v0.11 — `on_complete_hook` quality gates per persona** — design at [`docs/v0.11-on-complete-hook-design.md`](./docs/v0.11-on-complete-hook-design.md), in progress.

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
- **LLM tools:** `ensemble_list`, `ensemble_status`, `ensemble_spawn`, `ensemble_send`, `ensemble_pause`, `ensemble_resume`, `ensemble_kill`, `ensemble_focus`.
- **Slash commands:** `/conductor list | show | doctor | on | off | status | stop | pause | resume | queue | focus | history | pin | unpin | gc | reconcile | watchdog`.

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
- **Conductor system prompt addendum** — auto-injected at every turn when conductor mode is ON. Documents the persona roster, the `ensemble_*` tools, parallelism rules, the queue auto-downgrade contract, parent-snapshot semantics, and **§10 — the delegation playbook** so the LLM acts as a strict overseer (v0.8: addendum §1 declares "you are not the implementer"; banned-tools list in §1.5).
- **`/conductor history [N]`** — browses past runs from `~/.pi/agent/conductor/runs/`, sorted by mtime DESC, default 20.

### Persistence + reliability (v0.9 / v0.9.x / v0.10)

- Every spawn writes its session JSONL into `<runDir>/session/`; `Run.sessionPath` is populated up-front when seeded or on finalize for fresh spawns.
- `ensemble_send` resumes any finished sub-agent's session via `pi --session <path>`. Reuse a sub-agent's loaded context instead of re-spawning when you want a follow-up.
- **Run-record GC (v0.9).** Two-tier reclaim — cold-archive (`unlink transcript.jsonl`, keep `record.json` / `final.md` / `session/`) preserves `ensemble_send` resumability for the configured TTL (default 30 days); full-delete frees `runs/<id>/` once the run is already archived AND past the second TTL AND unpinned. Triggers: auto on `session_start` (debounced 6h), manual `/conductor gc [--dry-run] [--force] [--persona=<name>] [--verbose]`. User-pinning sidecar (`.pinned` via `/conductor pin`/`unpin`) opts a run out of both tiers. Doctor surface lists disk usage; `/conductor history` annotates with `pinned` / `archived`.
- **Post-startup reconcile (v0.9.x).** On `session_start`, any `running` records orphaned by a previous crash (parent pi died, pid no longer alive) are reclassified to `killed` with `errorMessage: "orphaned: ..."`. Liveness via `kill(pid, 0)`; EPERM treated as alive. Reconcile runs ahead of GC. Manual re-run: `/conductor reconcile [--dry-run]`.
- **Sub-agent watchdog (v0.10).** Pure tick-based detector. Soft threshold (default 120s) emits a `<sub-agent-stalled>` advisory; hard threshold (default 600s) escalates to `forceTerminate` only when `kill_on_stall: true` was set on the spawn (default OFF). Tick interval 30s; ignores paused / terminal / queued runs and respects an initial grace window. Per-spawn args `kill_on_stall: bool` and `stall_threshold_seconds: int` on `ensemble_spawn` and `ensemble_send` (cascade: per-call > project > user > built-in default). UX: ensemble-panel `· STALLED Ns` glyph, `/conductor watchdog status`, doctor surface.

## Install

```bash
# Clone for development
git clone https://github.com/samfoy/pi-conductor.git
cd pi-conductor
npm install --registry https://registry.npmjs.org    # @earendil-works packages
npm test

# Load locally with pi (per session)
pi -e /path/to/pi-conductor/dist/index.js

# Or auto-load every session: add the package path to settings.packages[].
# Edit ~/.pi/agent/settings.json and append the absolute repo root:
#
#   {
#     "packages": [
#       "/path/to/pi-conductor"
#     ]
#   }
#
# pi reads `pi.extensions` from the repo's package.json (./dist/index.js)
# and loads it on every startup. Do NOT symlink into
# ~/.pi/agent/extensions/conductor/ — the dual-load breaks persona
# discovery. See docs/v0.9-symlink-investigation.md.
```

> Conductor mode is **OFF by default** in v0.8 (was ON in v0.7). Three opt-in paths:
>
> - **Per session:** `/conductor on`.
> - **Per shell:** `export PI_CONDUCTOR_MODE=1`.
> - **Persistent:** add `{"defaultMode": "on"}` to `~/.pi/agent/extensions/conductor/config.json`.
>
> The tools and slash commands stay registered either way; only the system-prompt addendum is gated.

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
timeout_minutes: 60
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
  "defaultMode": "off",                  // v0.8: "on" | "off". Pinned
                                         // conductor-mode default at
                                         // extension load. Beats env var.
  "defaultTimeoutMinutes": 60,
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
- [x] v0.8 — Strict-overseer mode + conductor-mode default OFF + `defaultMode` config
- [x] v0.8.1 — `inherit_context` per-persona audit (7 read-only specialists flipped to `none`)
- [x] v0.9 — Run-record GC capstone (cold-archive then delete, auto + manual triggers, user-pinning)
- [x] v0.9.x — Post-startup reconcile of orphaned `running` records
- [x] v0.10 — Sub-agent watchdog (soft + hard stall thresholds, per-spawn `kill_on_stall`, UX surfaces)
- [x] v0.12 — Steering (`steerable: true` per-spawn opt-in, `streaming_behavior` arg on `ensemble_send`, `/conductor send` subcommand, RPC subprocess plumbing, watchdog bump asymmetry, orphan-RPC reconcile)
- [ ] v0.11 — `on_complete_hook` quality gates per persona _(in progress)_
- [ ] v0.10+ planned — worktree per persona, `inherit_skills: true`, transient runtime for read-only personas, project-shareable persona library, sub-agent → conductor mid-run messaging

## License

MIT.
