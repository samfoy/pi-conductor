# pi-conductor

A pi extension that turns the parent pi session into an **orchestrator** driving a roster of **persona-based sub-agents** with first-class TUI visibility.

> **Current state: v0.18 shipped.** All milestones v0.1–v0.18 are live. Highlights through v0.10: conductor mode (OFF by default in v0.8+), foreground sub-agents that stream their transcript inline in the parent's tool-call card, Esc-to-detach into the background, the focused-stream overlay (Ctrl+G) for live drilldown, filtered context inheritance (incl. v0.12's `filtered_compact` for builder-shaped personas), `ensemble_send`/`pause`/`resume`/`kill`/`focus`, `/conductor history`, run-record GC capstone (auto + manual + cold-archive + delete + user-pinning), post-startup reconcile of orphaned runs, and the sub-agent watchdog (soft/hard stall thresholds + per-spawn `kill_on_stall`).
>
> **v0.18 — autonomous mode (Metaphor pattern port)** — four composable features: (1) a **failure-classification taxonomy** (syntax/logic/test/environment/permission/timeout/stall/turns) stamped on every non-completed terminal; (2) **classified retry** — transient failures auto-respawn with a diagnostic-augmented task up to a per-cascade budget (`retry_max_attempts`, default OFF); (3) **plans-as-hypotheses** chain re-evaluation (`ChainStep.reevaluate` — a stop verdict halts the chain before the successor spawns); (4) **confidence-weighted cross-session memory** (`ensemble_recommend` ranks personas by recency-weighted past success on a task shape). Capstone: **`ensemble_auto`** runs a conductor-supplied ordered persona plan to a terminal outcome with in-loop classified retry + re-eval + step/USD-budget caps + kill-safe execution. Design at [`docs/v0.18-autonomous-mode-design.md`](./docs/v0.18-autonomous-mode-design.md).
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

- **17 starter personas** covering the full SDLC, layered builtin → user → project precedence:
  - **Discovery:** `inspector`, `analyst`, `cartographer`
  - **Spec / design:** `clarifier`, `designer`, `oracle`
  - **Implementation:** `planner`, `builder`, `simplifier`
  - **Review / verification:** `critic`, `redteam`, `finalizer`, `verifier`
  - **Debugging:** `investigator`
  - **Other:** `profiler`, `scribe`
- **LLM tools:** `ensemble_list`, `ensemble_status`, `ensemble_spawn`, `ensemble_send`, `ensemble_pause`, `ensemble_resume`, `ensemble_kill`, `ensemble_focus`, `ensemble_recommend` (v0.18 memory-ranked persona suggestions), `ensemble_auto` (v0.18 autonomous plan execution), `ensemble_cwd` (show or change the default cwd for spawns).
- **Slash commands:** `/conductor list | show | doctor | on | off | status | stop | pause | resume | queue | focus | history | pin | unpin | gc | reconcile | watchdog | send | worktree | cwd`. `send <id> <message>` resumes or steers a run like `ensemble_send`; `worktree list | merge <id> | clean` inspects and settles kept worktrees.

### Spawning + lifecycle

- **Foreground spawns** (default) block AND stream the sub-agent's transcript inline in the parent's tool-call card. Updates are throttled at 50ms; the card collapses to a compact 1–3 line summary on completion. Width tracks the live terminal (`process.stdout.columns`, clamped to [40, 240]).
- **Background spawns** return immediately; completion arrives as a `<sub-agent-completed>` notification card.
- **Esc detaches** a foreground spawn into a background run; the conductor gets a `detached-as-background` result so it doesn't re-spawn, and the eventual completion still arrives as a notification card. **Ctrl+C kills.**
- **Concurrency cap + FIFO queue**; foreground-while-full auto-downgrades to background.
- **Pause / resume** via SIGSTOP / SIGCONT; **stop** via SIGTERM. Works on running OR queued sub-agents.
- **Per-spawn `cwd`** on `ensemble_spawn` and on each `ensemble_auto` step sets where the sub-agent runs and where personas, config, and the git root for `worktree: true` isolation resolve. `~` and relative paths resolve against the conductor's default cwd; a missing directory is rejected before any run starts. `ensemble_send` resumes and chain successors keep the original run's cwd. A chain successor gets the same worktree decision as `ensemble_spawn`, branching from the current HEAD; a write-capable successor after a parent whose branch was kept unmerged fails instead of starting without that work.
- **Conductor default cwd.** pi can't change a session's cwd, so the conductor keeps its own: `/conductor cwd [<path>|--reset]` or the `ensemble_cwd` tool (`{ path?, reset? }`) sets or clears an override for later spawns. With no argument, both report the effective cwd and its source. The override is saved as a `conductor-cwd` session entry, so it survives `/reload` and resume.

### Available actions (Phase A A3)

`ensemble_status` reports `available_actions` for every run, including queued,
paused, and all terminal statuses. Completion and stall envelopes include
`<available-actions>` (comma-separated tokens); foreground completion text/details
and expanded notification cards carry the same snapshot.

| Token | Operation |
|---|---|
| `send` | `ensemble_send` with `streaming_behavior: "resume"`: new process continuing the saved session |
| `steer` | `ensemble_send` with `streaming_behavior: "steer"`: live RPC course correction before the next model call |
| `follow_up` | `ensemble_send` with `streaming_behavior: "follow_up"`: live RPC message queued until the agent finishes |
| `pause` | `ensemble_pause`: SIGSTOP |
| `resume` | `ensemble_resume`: SIGCONT, **not** saved-session send |
| `kill` | `ensemble_kill`: terminate the run or cancel its queue entry |
| `focus` | `ensemble_focus`: open the transcript overlay in TUI mode |

`ensemble_send`'s default `auto` selects live `follow_up` or saved-session `send`.
**Use the latest available_actions; each call revalidates.** Snapshots are advisory:
the session file, retirement marker, stdin, process ownership, or UI capability may
change before execution. Reporting only reads; it never starts a process, restores
a worktree, changes branches, or writes a run record. Runtime errors (for example,
a rejected signal or worktree restoration failure) can still prevent an action.

Retirement removes `send`, `steer`, and `follow_up`, including fresh RPC sessions
whose marker arrives before finalization. `contextRetirement: false` bypasses that
restriction. Process controls require local ownership; saved terminal sessions can
still be continued after startup reconciliation. `focus` is unavailable in RPC,
JSON, and print modes even when an RPC client supports other UI interactions.
Terminal `ensemble_kill` remains an idempotent no-op success although `kill` is not
advertised there. No runtime backend or ownership redesign is included in A3.

### Context inheritance

- **`inherit_context: filtered`** — sub-agent boots with a seeded session of the conductor's filtered transcript: keeps user/assistant prose + read/write/bash tool calls + branch / compaction summaries; drops `ensemble_*` and `subagent` orchestration noise, `<sub-agent-completed>` cards, and `!!`-prefix bash entries.
- **`inherit_context: full`** passes the whole transcript verbatim.
- **`inherit_context: none`** boots fresh.
- The persona file's frontmatter decides; the conductor doesn't.

### TUI surface

- **Ensemble panel** — always-visible widget below the editor when ≥1 sub-agent is active or recently finished, or a conductor cwd override is active (shown as `cwd: <path>`).
- **Focused stream overlay (Ctrl+G)** — full-screen drilldown of one sub-agent's live transcript. Tab/Sh-Tab cycle, ↑↓ scroll, `c` collapse tool calls, `t` show thinking, `s` send a follow-up, `k` kill, Esc close.
- **Conductor system prompt addendum** — auto-injected at every turn when conductor mode is ON. Documents the persona roster, the `ensemble_*` tools, parallelism rules, the queue auto-downgrade contract, parent-snapshot semantics, and **§10 — the delegation playbook** so the LLM acts as a strict overseer (v0.8: addendum §1 declares "you are not the implementer"; banned-tools list in §1.5).
- **`/conductor history [N]`** — browses past runs from `~/.pi/agent/conductor/runs/`, sorted by mtime DESC, default 20.

### Persistence + reliability (v0.9 / v0.9.x / v0.10)

- Every spawn writes its session JSONL into `<runDir>/session/`; `Run.sessionPath` is populated up-front when seeded or on finalize for fresh spawns.
- `ensemble_send` resumes a finished sub-agent's session via `pi --session <path>`, unless it has retired under context pressure. For a retired session, start a fresh child with its handoff.
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
read_only: true
exclude_tools:                       # optional — denylist, passed as `pi --exclude-tools`
  - edit
  - write
# tools:                             # optional — allowlist, passed as `pi --tools`
#   - read
#   - bash
---

You are the oracle: …
…full system prompt body…

## Source

Adapted from … with the following changes …
```

**Tool policy is enforced by pi.** `tools` is an allowlist (`pi --tools <csv>`) that replaces the child's default active set, builtin and extension tools alike; omit it to keep pi's defaults. `exclude_tools` is a denylist (`pi --exclude-tools <csv>`). Both are block lists of tool names (`^[A-Za-z0-9_.:-]+$`); unknown names are harmless. Every sub-agent also runs with the conductor's own `ensemble_*` tools and the foreign spawn tools (`subagent`, `agent`) excluded, on fresh spawns and `ensemble_send` resumes alike, so a child can't start agents the conductor doesn't supervise. `/conductor doctor` warns when another loaded tool's name looks spawn-capable. The nine read-only builtins exclude `edit`, `write`, `insert_before`, and `insert_after`. `personaOverrides.<name>.tools` / `.exclude_tools` replace the persona's whole list. `ensemble_list` and `/conductor show <name>` display the effective policy.

This is **partial enforcement**, not a sandbox: `bash` stays available unless a persona excludes it, so a read-only persona can still write through the shell.

## Configuration

`contextRetirement` defaults to `true` and applies only to managed conductor children
(`CONDUCTOR_SUBAGENT=1`), never to the parent's compaction. Automatic threshold
compaction records a session-scoped retirement marker and is cancelled; overflow
recovery still compacts and retries. Manual compaction is unchanged. Each subsequent
request receives hidden, request-local guidance to stop safely, preserve essential
validation, and return a self-contained handoff, not a claim of completion.

The parent reads the exact session's marker before settlement notifications and
retains `contextRetired` in `record.json`, including through reconcile and resumes.
Foreground and background output identify retirement. `ensemble_send`, `/conductor send`,
and overlay sends reject retired sessions before spawning or restoring worktrees.
Set `contextRetirement: false` to bypass retirement, including old markers, and allow
native compaction and resume again; historical metadata is retained. Children in
worktrees read this setting from the spawning project's config location. Quality
hooks and worktree safety still apply. Settlement uses Pi's `agent_settled` event
(JSON and RPC), not `agent_end`, which can precede overflow recovery; process exit
is the fallback. Supported host: **Pi 0.87.1 or newer** (`@earendil-works/pi-coding-agent >=0.87.1`);
0.87.1 is the verified floor for the required `agent_settled` API.
Phase A **A2 and A3** are shipped; A4–A6 and the herdr runtime remain deferred.

`~/.pi/agent/extensions/conductor/config.json` (user) or `<project>/.pi/conductor.json` (project, overrides user):

```jsonc
{
  "defaultMode": "off",                  // v0.8: "on" | "off". Pinned
                                         // conductor-mode default at
                                         // extension load. Beats env var.
  "contextRetirement": true,             // A2: retire managed children on automatic context pressure
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
