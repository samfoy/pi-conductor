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
- **LLM tools:** `ensemble_list`, `ensemble_status`, `ensemble_spawn`, `ensemble_send`, `ensemble_pause`, `ensemble_resume`, `ensemble_kill`, `ensemble_focus`, `ensemble_recommend` (v0.18 memory-ranked persona suggestions), `ensemble_auto` (v0.18 autonomous plan execution), `ensemble_cwd` (show or change the default cwd for spawns), `ensemble_effort` (open/status of verified serial efforts).
- **Slash commands:** `/conductor list | show | doctor | on | off | status | stop | pause | resume | queue | focus | history | pin | unpin | gc | reconcile | watchdog | send | worktree | cwd | effort`. `send <id> <message>` resumes or steers a run like `ensemble_send`; `worktree list | merge <id> | clean` inspects and settles kept worktrees.

### Spawning + lifecycle

- **Foreground spawns** (default) block AND stream the sub-agent's transcript inline in the parent's tool-call card. Updates are throttled at 50ms; the card collapses to a compact 1–3 line summary on completion. Width tracks the live terminal (`process.stdout.columns`, clamped to [40, 240]).
- **Background spawns** return immediately; completion arrives as a `<sub-agent-completed>` notification card.
- **Esc detaches** a foreground spawn into a background run; the conductor gets a `detached-as-background` result so it doesn't re-spawn, and the eventual completion still arrives as a notification card. **Ctrl+C kills.**
- **Concurrency cap + FIFO queue**; foreground-while-full auto-downgrades to background.
- **Pause / resume** via SIGSTOP / SIGCONT; **stop** via SIGTERM. Works on running OR queued sub-agents.
- **Per-spawn `cwd`** on `ensemble_spawn` and on each `ensemble_auto` step sets where the sub-agent runs and where personas, config, and the git root for `worktree: true` isolation resolve. `~` and relative paths resolve against the conductor's default cwd; a missing directory is rejected before any run starts. `ensemble_send` resumes and chain successors keep the original run's cwd. A chain successor gets the same worktree decision as `ensemble_spawn`, branching from the current HEAD; a write-capable successor after a parent whose branch was kept unmerged fails instead of starting without that work.
- **Conductor default cwd.** pi can't change a session's cwd, so the conductor keeps its own: `/conductor cwd [<path>|--reset]` or the `ensemble_cwd` tool (`{ path?, reset? }`) sets or clears an override for later spawns. With no argument, both report the effective cwd and its source. The override is saved as a `conductor-cwd` session entry, so it survives `/reload` and resume.

### Runtime selection, herdr controls and recovery (H11 automated acceptance; not rolled out)

`runtime: "auto" | "subprocess" | "herdr"` is accepted on `ensemble_spawn`,
each `ensemble_auto` step, persona frontmatter, and config (top-level or
`personaOverrides.<name>.runtime`). Precedence is **per-call > effective persona
> project global > user global > auto**. Persona overrides keep the existing
field-level project-over-user merge, above frontmatter.

`auto` selects herdr only when `HERDR_ENV=1` and both `HERDR_SOCKET_PATH` and
`HERDR_PANE_ID` are nonempty; otherwise it selects subprocess. Explicit herdr
outside that environment fails without silent fallback. H7/H8 implement managed
pane launch, observation, live inbox controls and saved-session relaunch. This is
backed by fake-CLI and offline native Pi 0.87.1 tests plus the H11 automated
real-herdr matrix below (herdr 0.9.1 with Pi 0.87.1 and 0.99.1). That is **not a
rollout**: independent review and human TUI acceptance are still outstanding. Keep
using **`runtime: "subprocess"`** until then.

For an owned, attached, ready and running herdr child, `steer`/`follow_up` use
the nonce inbox; automatic turn-limit grace uses steer delivery. No RPC mode or
steering opt-in is inferred from the runtime tag. Controls recheck child identity
and current owner-question/retirement policy before writing. Their acknowledgement
means **input accepted, not executed**; rejection and unconfirmed delivery are
distinct. Never blindly retry an unconfirmed request.

`send` on a finished or blocked herdr run relaunches the same saved session with
a fresh nonce. It reuses only the exact proven empty prior pane, otherwise creates
a new subtree tab and preserves the old pane. Unknown previous child exit blocks
relaunch, including workspace reuse. An owner question remains pending until
initial input acknowledgement **and a correlated native agent_start**; preacceptance
failure restores the question, while later model failure does not roll back an
accepted answer. Failed launch never advertises a historical final as new output.
`pause`/`resume` (SIGSTOP/SIGCONT) remain subprocess-only; use `send` for a
saved-session relaunch. Only the current fenced attachment may use live controls; an unattached record is not control authority.

**Kill, quit and cleanup.** Herdr kill preserves pane scrollback. It signals only the verified current positive child PID (never the pane shell or CLI), with TERM then a freshly proven KILL after two seconds. Synchronous kill classification, pending-delivery cancellation and owned hook-group termination remain unchanged. Unknown identity sends no signal and preserves resources. Foreground abort remains process-only.

Quit first awaits M5 integration suspension, verifier-group safety and terminal I/O; **only then** does a five-second pane-cleanup budget start. Managed children stop and exact empty panes (including completed runs) are released. Budget expiry cannot bypass verifier safety or authorize deleting a child workspace. Unreleased bindings and diagnostics remain doctor-visible; integrating work is not reclassified killed. Reload instead quiesces the old pipeline and M5 barriers, detaches its stream/monitor/inbox waits, and releases its owner generation without stopping the child. New herdr launches are refused during shutdown. Subprocess pipelines keep their existing reload behavior.

Explicit cleanup and GC recheck invocation/status and exact socket/pane/terminal/tab/workspace evidence before pane-only close; no tab-wide close can take a sibling pane. Ordinary archived run files may be reclaimed after proven child absence even when the server is unavailable, but a bound worktree and its ownership record stay if pane release is uncertain. Existing ordinary TTL policy and effort protection remain; this adds no effort abandonment or destructive effort TTL.

Blocking child UI prompts suppress watchdog stalls and stall rendering. One non-waking dialog card describes each continuous wait, including overlapping prompts; conductor never answers it. First-episode stall evidence may include one redacted live read (two seconds, 40 lines, 4 KiB); reminders reference the first evidence rather than polling again. Read failure neither hides the advisory nor establishes permission to kill.

The concrete backend is frozen before queue admission and persisted in `record.json`.
Queue drain, retries and saved-session sends retain it; legacy records without a
tag always mean subprocess, including inside herdr. Auto validates/freezes every
step before starting the plan, including retries. A chain is a **fresh successor**:
its persona and current config/environment resolve when it fires, not from its
parent's runtime or per-call selector. Pin the successor persona/config to subprocess
if needed. Unsupported successors are reported without creating a run.

`ensemble_status` reports `runtime` alongside the existing `available_actions`.
Doctor reports configured selection, each persona's effective kind/source, saved
kinds and legacy behaviour using read-only checks; it does not run a herdr health
probe. Startup reconciliation reattaches proven same-socket herdr invocations as described below. Unreachable/foreign sockets and unknown identity are preserved without guessing at the record's legacy PID. Effort recovery retains its separate ownership checks. Ordinary GC requires a matching current invocation and durable hello plus a fresh positive-child-PID absence probe. Live, reused-PID and unknown children retain their files. Effort resources remain protected from legacy GC.
**Reattachment and delivery limits.** Each run has append-only, exclusive-create owner
generations with module epoch, session, PID/start identity, socket and launch nonce.
A release leaves its generation in place; it never deletes and reuses a number.
Only a released or proven-dead owner can be replaced. A live or unknown owner,
including another module in the same PID, blocks takeover. Off Linux, dead PID
evidence also needs an owner age of at least 90 seconds.

The new owner reads bounded (32 MiB), LF-aligned history from the exact native
launch boundary and current nonce. It does not send the task again. Usage and
pending questions are reconstructed rather than added to saved totals. Per-launch usage baselines are independent of live-send markers; older records without that baseline report current-invocation usage only. A child
that settled while the lead was absent is finalized only after proven exit;
death without complete accepted native evidence is an orphan failure. Unknown
identity preserves the workspace and does not publish a model result. Recovery
never reconstructs chain/retry closures. An unknown original ordinary-run hook
prevents auto-merge; inspect the kept branch and use the explicit worktree controls.

Ordinary runs persist `herdr.settlement = {launchNonce, delivery}` before automatic
completion dispatch. An interrupted `intent` becomes visible `uncertain` and is
**not replayed**. `attempted` means the local call returned, not receiver delivery.
Notifications, lifecycle events or memory outcomes can be missed after a crash;
manually reposting may duplicate a previous delivery. Repairing final files never
reruns the task to recreate a notification. Effort runs use **only** the existing
`integration.delivery` ledger: a stream claim grants no effort authority, and a
proc-less live writer is bound only after M5 ownership recovery succeeds. Durable
integrating entries remain M5's responsibility; attachment cannot restart CAS or
verification. Retired sessions still refuse sends, and owner answers retain A6's
acceptance rules.

Subprocess print and RPC are **transports, not runtimes**: explicit steering and
A5's automatic large-prompt RPC both remain subprocess, and automatic RPC does
not grant steering. A6 answers and M5 integration verification retain their existing
subprocess semantics; verification commands are independent of the agent selector.

### Isolated real-herdr acceptance (H11; automated only, not rolled out)

`tests/herdr-live.test.ts` is opt-in. With `CONDUCTOR_LIVE_TESTS=1` and
`CONDUCTOR_H11_PI_ROOTS=<pi-coding-agent root>[:<root>...]` it starts one uniquely
named private `herdr --session conductor-h11-<id> server` per listed Pi root. Each
server runs in a private user+network namespace and gets a temporary
HOME/XDG/agent directory, `/bin/sh` non-login panes, the package's declared `pi`
bin entry, an offline faux model and no credentials. The namespace is mandatory:
there is no opt-out, and a host without unprivileged namespaces fails the test as
blocked rather than skipping it. The harness refuses inherited `HERDR_*` targets
and name collisions. Before every control and cleanup call it proves the socket is
held by its own server, in a network namespace other than the test's. Teardown
stops only that session and waits for every captured process. It captures and
signals only processes whose start identity still matches; a reused server PID
seeds nothing. The fixture root is a plain `mkdtemp` directory, not an auto-cleaned
test temp dir. A clean teardown removes it; an incomplete one keeps it, reports its
path and fails. `CONDUCTOR_H11_ALT_PI_ROOT` names the Pi used for the
version-mismatch lead. The default suite runs only the fake-effect guard tests.

**Launch contract, per real herdr 0.9.1.** `agent start` succeeds only for an idle
agent, and herdr keeps an exited agent's name on its terminal. So conductor writes
the task durably but out of the pump's view (`inbox/<nonce>/<seq>-<id>.prepared.json`)
and publishes it only after `agent start` returned and the child's hello and identity
are proven. It still requires ack plus a correlated native `agent_start`. If the
launch fails before publication, the prepared task and any pending owner question
stay, and the task is not retried or replayed. Every launch uses a fresh physical
agent name (`<run>-<8 hex of the nonce>`), stored as `herdr.agentName`. The logical
run id and Pi session stay the same, and stall reads use only the current name.

**Automated results, herdr 0.9.1, Pi 0.87.1 and 0.99.1, the same on both:**

| Scenario | Result |
|---|---|
| spawn → stream → `agent_settled` → child exit → shell scrollback | pass |
| semantic parity (final text, usage, assistant content) with a subprocess faux run | pass |
| live steer then follow-up: input accepted, then executed in order | pass |
| owner ask → child exits → reply relaunches the same session in the proven pane, fresh alias | pass |
| kill signals only the proven child; pane shell and scrollback kept | pass |
| own idle pane closed by hand, then resume in a new tab | pass |
| native automatic (threshold) compaction retires the context under exit-at-settle; later send refused | pass |
| lead `/reload` fences the old owner; one completion | pass |
| lead SIGKILL; a fresh lead takes over and settles once | pass |
| effort writer: persona hook → generated-artifact regeneration → repository hook → verify → CAS | pass |
| effort writer survives a lead SIGKILL; the fresh lead integrates it once | pass |
| restarts keep a requested kill as killed and keep every run's pane | pass |
| lead on the other Pi version: mismatch persisted and shown on the completion card | pass |

The child hello's `piVersion` is the executing host Pi, taken from host module
identity or the package's declared CLI entry, otherwise `unknown`. Conductor's own
import (0.84.3 from its package `node_modules` in these runs) is reported separately
as `piLibraryVersion`. A lead/child difference is persisted as `herdr.versionWarning`
and appears as a `<warning reason="pi-version">`. An unprovable version reads as
"unverified", never as a match.

**Limits:**
- Delivery is at most once. One observed notification per run is evidence, not an
  exactly-once guarantee.
- The retirement run exercised threshold compaction (A2 cancels it). Overflow
  compaction was not reached.
- Completed and failed herdr records are still re-adopted and re-finalized on every
  lead restart. The ledger stopped any duplicate notification, but each restart does
  that CLI work again.
- A lead crash after `agent start` registered the child but before the task was
  published: with the child still alive, the record is left untouched as foreign
  (`running`, ask kept, idle unfed Pi in the pane, no card). With the child gone it
  fails with the generic "exited before accepted native launch evidence" message
  instead of "prepared but never published". Nothing is replayed in either case.
- A killed run whose ordinary notification stopped at `intent` stays `intent`; it is
  not re-marked `uncertain`. Nothing is replayed.
- The fake herdr CLI answers a reused name with `agent_name_taken`. Real herdr 0.9.1
  answers `agent_name_not_found` and has already launched Pi in the pane by then.
  Conductor never reuses names, so no behaviour depends on this.
- **Human TUI acceptance is unverified.** Nobody has looked at regular-mode
  scrollback, foreground Esc-detach and Ctrl+G, Esc in a child followed by resume,
  trust-prompt refusal, or the dialog card.

Prior art: pi-herdsman's herdr-pane sub-agents informed these ideas; no herdsman
code is copied.

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

### Bounded stall evidence and reminders (Phase A A4)

The first `<sub-agent-stalled>` notice in an episode includes recent assistant
text, tool-call summaries, and tool-result text from `Run.messages`. Evidence
visits at most the last **32 messages / 64 content parts**, with at most the first
and last four parts of a multipart result. System prompts, user briefs, and
thinking are excluded. Each result (and assistant block) is middle-truncated to
**4 KiB**; the complete `<recent-activity>` block, including XML escaping and
omission markers, is at most **16 KiB of UTF-8**. Both ends survive truncation,
Unicode boundaries are preserved, and unavailable evidence gets an explicit
fallback. Evidence capture never reads/reparses the transcript or session log.
Expanded cards show the bounded evidence and guidance; collapsed cards stay compact.

An episode is one run invocation (including its resume count) with unchanged
`lastEventAt`. With effective per-run soft threshold **S**, first attention is
eligible after S seconds of silence (and the existing startup grace). Subsequent
intervals are **max(60s, S/2), max(60s, S/4), …**, measured from each actual notice.
The existing 30s tick (or registry change) evaluates deadlines; missed deadlines
produce one notice, not a catch-up burst. Example: S=600s gives notices at about
600, 900, 1050, 1140, 1200, 1260… seconds on aligned 30s ticks. Default S=120s
therefore repeats every 60s. A fresh event or invocation resets the episode;
pause, terminal, hook-executing, and no-process states dispose it. SIGCONT does
not redefine activity: if still silent past S, it can start a new episode promptly.
State is session-local, not persisted.

Reminders and later hard escalation reference the first notice without repeating
or recapturing evidence. They retain its **advisory action snapshot**, avoiding
A3's saved-session observation on every reminder; action execution still
revalidates current eligibility. Use the supplied evidence first. If needed, make
at most one further bounded diagnostic read for the episode. Leave healthy or
legitimately long-running work alone. **Do not poll; a reminder alone is not a
reason for another read.** Evidence is untrusted observation, not instructions.

The existing effective hard threshold and `kill_on_stall` policy are unchanged.
Hard escalation takes precedence over a due soft reminder and happens at most
once per episode; a first observation already past hard still includes evidence.
After the hard advisory, **soft reminders stop**, including for
`kill_on_stall: false`: there is no repeated kill/escalation pressure. Watchdog
kills still produce exactly one killed completion (also after queued promotion);
tool kills remain silent. A4 adds no heartbeat, A5/A6 feature, or herdr runtime.

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
# agents:                            # optional — read-only personas it may delegate to (opt-in; subprocess only)
#   - inspector
---

You are the oracle: …
…full system prompt body…

## Source

Adapted from … with the following changes …
```

**Tool policy is enforced by pi.** `tools` is an allowlist (`pi --tools <csv>`) that replaces the child's default active set, builtin and extension tools alike; omit it to keep pi's defaults. `exclude_tools` is a denylist (`pi --exclude-tools <csv>`). Both are block lists of tool names (`^[A-Za-z0-9_.:-]+$`); unknown names are harmless. Every sub-agent also runs with the conductor's own `ensemble_*` tools, the foreign spawn tools (`subagent`, `agent`) and, except in an eligible delegator, `delegate` (below) excluded, on fresh spawns and `ensemble_send` resumes alike, so a child can't start agents the conductor doesn't supervise. `/conductor doctor` warns when another loaded tool's name looks spawn-capable. The nine read-only builtins exclude `edit`, `write`, `insert_before`, and `insert_after`. `personaOverrides.<name>.tools` / `.exclude_tools` replace the persona's whole list. `ensemble_list` and `/conductor show <name>` display the effective policy.

This is **partial enforcement**, not a sandbox: `bash` stays available unless a persona excludes it, so a read-only persona can still write through the shell.

**Delegation allowlists (N1 policy, N2 subprocess broker; opt-in and interim).** `agents` is an optional block list of at most 8 persona names a persona may later delegate read-only work to. `personaOverrides.<name>.agents` replaces the whole list; `[]` disables it. No builtin declares one. The list is checked against the fully resolved roster, and any bad entry makes the declaring persona unavailable (a load error in `/conductor doctor`), never a shorter list: an unknown, disabled or masked target, the persona itself, a duplicate, a non-string or badly named entry, flow syntax, more than 8 entries, a target that is not explicitly `read_only: true`, or a known write-capable target (`builder`, `simplifier`). A lead spawn persists `depth: 1` and the validated `delegateAllow` in `record.json`; queue drain, retry, resume and reattach reuse that frozen scope, later config changes do not alter it, and no `ensemble_spawn` argument can set it. A record with neither field is a legacy depth-1 leaf. Any other depth or allowlist shape refuses `send` and is left untouched by startup reconcile. Every child gets conductor-owned `CONDUCTOR_DEPTH` and `CONDUCTOR_RUN_DIR`, with inherited copies dropped, on both runtimes. Only a depth-1 child with a non-empty list gets `CONDUCTOR_DELEGATE_ALLOW`. Only that child keeps `delegate`, and an explicit `tools` list gains it; every other child excludes it, and an explicit `exclude_tools: [delegate]` still wins. The name is filled by the conductor's own tool, so another extension's `delegate` loaded into a delegator fails pi's startup as a tool conflict (doctor warns when one is loaded). The depth-2 leaf scope also excludes `ask_owner`, `edit`, `write`, `insert_before` and `insert_after`, and its prompt asks for a final `QUESTION:` line instead. A child registers `ask_owner` only when `CONDUCTOR_DEPTH` is unset or `1`, and never an `ensemble_*` tool. `ensemble_list` and `/conductor doctor` show each allowlist.

**`delegate` (N2).** A depth-1 delegator calls `delegate({persona, task, files?, timeout_minutes?})`, which blocks until the lead answers; several calls in one turn run in parallel. The lead brokers it only from that run's own parsed event stream. Pi emits `tool_execution_start` before it validates a call, and an unknown, schema-invalid, blocked or aborted call still starts and then ends in error, so start alone never spawns anything: the broker spawns only on the call's first `tool_execution_update`, which the tool emits from inside `execute`. Ids must match `^[A-Za-z0-9_-]{1,128}$`; Pi 0.99 nested `ctx.executeTool()` calls are refused. Before any await the broker creates `delegate/<id>.claim.json` create-only and counts the call; a duplicate update or an existing claim never spawns a second leaf (an existing claim is answered as uncertain, never replayed). It then checks the persisted allowlist against the current roster (read-only, not write-capable), a non-blank task of at most 64 KiB, `files` resolved against the parent's effective cwd with `run:` references only to the parent's own leaves, and at most 8 outstanding calls. The leaf is depth 2 and read-only, runs in the parent's effective cwd on subprocess, gets no inherited context, worktree, merge, hook, effort, chain, retry or steering, uses that persona's configured `model`/`thinking` (overrides applied; unset inherits pi's default, never the parent's), and records `parentRunId`/`delegateToolCallId`. Its timeout is the least of its persona's, `timeout_minutes` and the parent's remaining hard timeout. The answer is written create-only to `delegate/<id>.json` and is the leaf's completion envelope, aimed at `inlineAttachmentLimitBytes` (over it, a summary plus `result-ref` and the `final.md` path; the last, minimal form is bounded by a constant of about 2 KB, so a very small limit is not strict); the lead posts no card for a leaf. An end, abort or terminal parent cancels: a queued leaf is removed, a running one is killed, and the call gets `delegate cancelled: …`. The child waits with `fs.watch` plus a 1 s poll and gives up two minutes after the clamped deadline with `delegate outcome unconfirmed`: no answer is not proof of rejection, and a leaf may have run. Delivery is at most once, not exactly once.

Interim limits: herdr is refused by name for delegating personas and for leaf targets until N5. There are no admission lanes yet (N3), so leaves queue behind the global cap like any spawn, and a full pool of waiting parents can block until their timeouts. A parent that ends cancels its own pending leaves, but finalize has no child-first gate, leaves still accept direct actions, and `ensemble_status` shows no tree (N4). On lead `/reload`, a subprocess parent with outstanding calls is killed, leaves first, with `lead /reload interrupted subprocess delegation; resume with ensemble_send`; parents with nothing outstanding keep the normal reload preservation, and a call they make later, including one whose start came before the reload, is claimed and rejected by the closed old broker. Read-only here is still a tool-policy and prompt boundary with `bash` available, not an OS sandbox, and not a defence against a same-uid process.

**Broken higher-layer persona files fail closed.** A user or project persona file whose frontmatter is unparseable, or that declares `runtime`, `read_only`, `tools`, `exclude_tools` or `agents` and fails validation, masks each lower-layer persona whose filename or declared name matches the broken file's filename (never the broken file's possibly malformed declared name). A broken narrowing file therefore never falls back to a wider builtin. Other invalid fields keep the old fallback, and a valid file in a higher layer still wins.

## File evidence and reusable results (A5)

`ensemble_spawn`, `ensemble_send`, each `ensemble_auto` step, and configured
chain steps accept optional `files: string[]`:

```json
{
  "persona": "critic",
  "task": "Review the implementation against the approved plan.",
  "files": ["plan.md", "run:builder-7f3a"]
}
```

Copy the exact `result-ref: run:<agent_id>` from a foreground result or the
`<result-ref>` in a background completion into `files`, rather than paraphrasing
its findings. A2 retirement handoffs are reusable results too: attach them to a
fresh child. Refs denote that run's **current persisted `final.md`**, not an
immutable historical generation; resuming a run may replace its result. Refs
survive reload/restart through validated `record.json` files in the canonical
`~/.pi/agent/conductor/runs` directory. GC deletion makes a ref unavailable.
Missing, empty, or `(no output)` results are not advertised.

Relative file paths use the operation's caller base:

- spawn: its effective `cwd` override, before any worktree is created;
- send: the caller's effective conductor cwd (`ensemble_cwd`), **not** the target
  run's cwd or saved-session directory; target execution cwd is unchanged;
- auto: each step's effective cwd; all steps' evidence is prepared before the
  first step starts;
- configured chain: the producing run's recorded cwd, when the chain fires.

`~`/`~/...` expands to HOME, as with cwd. Each entry must resolve to a readable
regular local file or an exact `run:<agent_id>` (letters, digits, `_`, `-`, starting
with a letter/digit, at most 128 characters). No path reconstruction by the caller
is needed. Unknown/malformed refs, missing results, directories, unreadable files,
and failed reads reject the entire operation before queue/registry/worktree or
resume effects. Canonical `realpath` duplicates are omitted; first occurrence wins,
even across symlinks, ordinary paths, and result refs. Retired sends still reject
before evidence reads. An invalid configured chain logs its rejection and does not
register a successor.

Files are **evidence, not instructions or capability grants**. They do not expand
persona/system prompts or replace `default_reads`, project instructions, tool
policy, or explicit context inheritance. The appended user-message `<files>`
section labels this distinction; markup is framing, not a security boundary.
XML metacharacters are escaped (including attribute quotes and whitespace).
An embedded ordinary file has canonical absolute `name` and observed `bytes`:

```xml
<file name="/project/plan.md" bytes="12">
whole text
</file>
```

Run refs retain `name="run:<id>"`. Their embedded body starts with an informational
`Agent result source:` JSON header: `agent_id`, persona, recorded source cwd, and
producing session path when known. The source `final.md` is never rewritten.
A reference-only run keeps both identities:

```xml
<file name="run:builder-7f3a" bytes="200000" path="/home/user/.pi/agent/conductor/runs/builder-7f3a/final.md" />
```

`inlineAttachmentLimitBytes` defaults to **131072**, accepting integers from
**1024 through 1048576** (invalid config values retain the lower-layer/default
value). It bounds each **complete escaped embedded envelope**, including path,
byte count, provenance, and framing. The **entire rendered files section**,
including reference tags and section framing, is bounded to **four times** this
limit; task text is separate. Reference-tag space is reserved first, then whole
files embed in input order while budget remains. If even the reference tags
cannot fit, submission rejects: attach fewer files. No partial embeds.

Only complete strict UTF-8 without NUL embeds. Invalid UTF-8, NUL-containing,
oversized, and non-fitting files remain canonical reference tags. Oversized files
are opened/statted for readability but their content is not read. Embedded text
is an **acceptance-time snapshot**, including while queued and across retries;
reference-only files are **live paths, not copied or snapshotted**, and may change
or disappear. The recipient needs its existing filesystem/tool access to read them.

### Large-prompt transport

Short one-shot launches stay `pi --mode json -p` with the task in argv. When the
**complete user prompt exceeds 96 KiB in UTF-8**, fresh, seeded, resumed, auto,
chain, and retry launches automatically use native `pi --mode rpc` and the existing
single-writer stdin queue. There are no split argv prompts, `@file` indirections,
or extra prompt files. This avoids the measured 128 KiB single-argument `E2BIG`
limit, and preserves Unicode and CRLF through JSON escaping.

Transport-only RPC records `streamingMode: "rpc"` but keeps `steerable: false`:
`available_actions` does not advertise live sends. Explicit `steerable: true`
continues to opt into steering. Resumes don't inherit steering, regardless of
transport. Both RPC forms use the normal `agent_settled` completion, accounting,
timeouts, kill and queue-release paths, and destroy pending stdin/ack work on
settlement. Prompt rejection is a failed run, not completion. As with explicit
RPC, extension dialogs are auto-cancelled; provider extensions remain enabled.
This does not address independently oversized persona/system-prompt argv.

## Named efforts (M5 — fenced crash recovery, verified integration)

`ensemble_effort({action:"open", effort:"feature", verify:"npm test"})` captures
an attached base branch and commit from the conductor's requested checkout and
creates **`refs/heads/conductor-int/feature` without checking it out**. Status is
available through `ensemble_effort({action:"status", effort:"feature"})` and
`/conductor effort list` or `/conductor effort status feature`.

**New writers finish only after integration.** Native settlement waits for the
child process to exit and the original persona hook to pass, then enters
`integrating` without a child slot. A serial FIFO per canonical repository merges
against the current integration tip using `merge-tree`. Candidate construction
uses ordinary `git commit` in a detached worktree, with repository hooks intact;
`efforts.verify` gates the exact post-hook commit before a conditional ref update.
The main checkout, index and branch are not changed. Completion cards, result refs,
chains/retries, memory and `done` remain deferred to the shared settlement tail.
A6 blocked writers are never enqueued. Existing M1 completions stay UNINTEGRATED;
neither reload nor inspecting a legacy member certifies it.

The baseline is checked in an isolated worktree on first integration, and again
if the tip is not a previously gated tip. Opening alone is **not** a green-baseline
claim. A red baseline pauses the effort queue, not unrelated running builders.
A no-op requires tree equality to this gated tip. Candidate verification retries
a red result once on the same commit (`verifyRetries: 0` disables that retry);
two reds settle `merge_conflict` with `verify_failed` or `verify_timeout`.
Command launch/output failures, required-hook failures, missing prerequisites,
unexpected dirty changes, ownership uncertainty and WAL failures pause for
inspection. A stale CAS rebuilds and reverifies against the actual tip; three
failures pause the effort rather than overwrite an external ref update. No builder retry or automatic merger is attempted.

`ensemble_status` exposes the integration stage, captured OIDs, reason, bounded
logs and verification duration; completed cards include the same evidence.
Kill cancels only the owned integration and waits for its process group before
settlement. Quit/reload stop active generation/verification and preserve integrating
records. Concurrent shutdown callers first share the in-progress suspension/drain,
even after integration controls are cleared. Reload then awaits an already-started
integration settlement's final-file and dispatch-state writes before fresh recovery;
it does not wait for active
children to finish. Parent startup restores durable work under an exclusive owner generation;
children never run recovery. Live owners reject takeover. PID reuse, missing start
identity, permission ambiguity and incomplete claims fail closed, not by stale TTL.
A stopped old owner cannot write a new generation's records or CAS its ref.

Integration teardown is independent of shell exit: TERM-resistant descendants
with closed stdio still get SIGKILL after the two-second TERM grace. Linux procfs
membership, session IDs and observed PID/start-time anchors guard each signal.
Completion requires a vanished group or two stable zombie/dead-only observations;
conductor cannot reap orphan zombies, but they cannot execute further work. There
is a one-second confirmation deadline after escalation, not an indefinite wait.
Missing identity/procfs access, EPERM, lost group continuity or a still-live group
at the deadline preserve the work and driver claim with `teardownError`; shutdown
rejects, including repeat attempts, rather than claiming teardown succeeded.
Live-group confirmation currently requires Linux and readable procfs; elsewhere
only an already-gone group (ESRCH) can be acknowledged. POSIX signalling remains
check-then-signal, not an atomic PID/start binding. Processes that escape the owned
session/group are not supervised. Successful effort commands also confirm group
termination before clearing their process WAL. Ordinary persona-hook behavior is unchanged.

Writer branches and evidence remain preserved, including changed source heads.
Recovery removes only known, unreferenced, clean detached candidates whose HEAD
is an ancestor of the integration tip, after owned processes are stopped. Dirty,
unreachable/unmerged, ignored-file and ambiguous workspaces stay. Legacy
worktree merge/clean and GC still skip effort assets. No effort TTL purge,
abandon, landing or source-branch deletion is introduced.

Spawn with `effort:"feature"` and optional `touches:["src/**"]`. The first spawn
can open the effort using config. Every effort writer gets its own worktree,
even with persona `worktree:false`, and foreground requests become background.
The branch starts at the integration tip **when dequeued**, not when requested.
Repo-subdirectory mapping, seeded sessions, hooks and owner answers use that
isolated cwd, including when called from a linked checkout. A blocked A6 writer
can receive its answer on the same assignment; terminal effort runs require a
fresh effort spawn. Children cannot access `ensemble_effort`.

Policy precedence is explicit open override (`verify`, `land`) > project
`<requested cwd>/.pi/conductor.json` > user config > defaults, frozen at open:

```json
{"efforts":{"verify":"npm test","verifyTimeoutSeconds":1200,"verifyRetries":1,"generated":{"paths":["dist/**"],"command":"npm run build"},"maxParallel":2,"merger":"auto","mergerMaxAttempts":1,"land":"branch","history":"squash"}}
```

There is **no default verify command**. Explicit `verify:""` records disabled
verification; it does not disable repository hooks, and status explicitly labels
the weaker guarantee. Verify and candidate hooks have bounded output and a timeout
(default 1200 seconds); effort commands scrub inherited `GIT_*`/`HERDR_*` variables
and use private temporary directories. Candidate hooks may stage changes, but the
resulting post-hook tree must be clean and pass verification. There is no automatic
dependency installation or base `node_modules` modification: hooks needing a local
installation pause when it is missing. Merger and land remain captured-only. Names match
`^[a-z][a-z0-9-]{0,39}$`. Scope/generated paths are nonempty repo-relative
literal (including Unicode letters/numbers), `*` or `**` globs; traversal, absolute
paths and other glob syntax are rejected. Omitted or empty `touches` means universal
`**` and runs serially, including beside generated-only writers.

**Parallel admission.** All non-read-only effort personas, including custom names,
use one admission predicate at immediate spawn, dequeue and blocked-answer resume.
`maxConcurrent` bounds running/paused children and pre-launch reservations;
`efforts.maxParallel` additionally bounds executing writers in that effort.
Validated effort writers alone escape the legacy `maxConcurrentWriteCapable` cap.
Ordinary non-effort writer admission and sends retain their existing behavior.
Worktree creation failure never falls back to the shared checkout. Each queued
launch revalidates ownership/isolation and reads the current integration tip.

Accepted touches are copied per assignment. Literal path segments before the first
wildcard must diverge to prove disjointness: `src/a/**` and `src/b/**` can run together,
but `src/*.ts` and `src/*.md` serialize. Earlier queued work reserves scope, not a
process slot; later independent work can advance. Running, blocked and integrating
writers retain their footprint until integration succeeds. Integrating and blocked
writers consume no child slot; an unresolved failed writer conservatively reserves
all paths. Cancelled, never-launched placeholders reserve nothing. These are
admission hints, **not a sandbox or dependency scheduler**.

Only fully covered generated regions can be excluded: `dist/**` covers
`dist/maps/**`, but intersecting `src/**` with generated `src/generated/**` does not
exclude source. Generated exclusions do not cross effort boundaries. Same-repo
scopes are compared across locally observed efforts. Foreign effort owners or
unobserved assignments refuse admission pending fenced recovery. Missing durable
members remain visible and pause the queue; recovery never treats an unknown
assignment as a free execution slot or validated source.

Before integration releases a slot, a NUL-delimited diff against `spawnBase` and
`branchHead` records changed paths and touches violations, including both rename
endpoints, deletions, mode changes and unusual filenames. Violations widen the
reservation and appear in status/cards; they do not silently reject valuable work.
Blocked writers are measured too; dirty or unreadable blocked work reserves `**`.
Already-running writers may still make undeclared overlapping edits: merge-tree,
exact-tree verification and CAS remain mandatory for every integration. Shared
external outputs, installs and undeclared dependencies are not isolated by touches.

An A6 answer keeps the original assignment, worktree and footprint. It must acquire
both global and effort execution capacity without conflicting with another owned
footprint. It never waits on itself or its queued successors. Busy answers are
refused before dispatch, leaving the pending ask and record unchanged; retry the
same answer after capacity frees. A3 status/actions and completion cards expose the
current admission snapshot; native acceptance/rollback semantics are unchanged.
Unattended parallel dogfood remains deferred until **M5 recovery acceptance**.

**Generated artifacts (optional).** The frozen `generated.paths` and
`generated.command` policy now runs once when a clean merge changes a declared
output, or when **every original conflict path** matches the policy. A mixed
source/output conflict still returns `merge_conflict` with all original paths,
without invoking the generator. Without generated policy, the M2 route is unchanged.
The NUL-delimited merge output, original tree OID and exact index copy are retained
before classification. For generated-only conflicts, conflicting paths start with
the current integration tip's content (or absence), avoiding marker-filled input;
nonconflicting merged files, including source, stay unchanged. Rename source paths
absent from both trees stay absent. The generator must rebuild outputs from source,
not depend on either builder's artifact bytes. A tree-equal gated no-op still skips
candidate construction and regeneration.

Generation uses the same bounded runner, private TMPDIR, environment scrubbing and
owned-group cancellation as verification, with no generator retry. Before staging,
the driver compares the pre-generation index tree and actual file bytes/modes with
the result, including ignored/untracked files and both sides of renames/deletions.
Only concrete matching paths are staged, with literal path handling; declared
ignored additions are explicitly included. Out-of-policy edits, changed index flags,
HEAD/ref changes, unsupported file types or generated symlink artifacts pause the
effort and preserve evidence. Snapshots do not follow symlinks; generated symlinks
are refused before running or staging. Empty directories are not Git outputs.
Source, index-only and ignored-file edits cannot silently ride along with generation.

A successful generation is committed **once through normal repository hooks**,
then the exact post-hook OID/tree goes through independent verification, durable
WAL and expected-tip/owner CAS. There is no plumbing commit or hook bypass. Hook
changes are trusted repository policy, not constrained by generated globs, but their
result is still verified. Generator error/timeout/cancel, boundary rejection, hook
failure or red verify never authorizes a ref advance. Inspect `generate.log`,
`generation-before.json`, `merge-tree.z`, `merge.index` and recorded OIDs in the
retained candidate/evidence directories. Interrupted generation is rebuilt through
the same normal-hook/verification route; no automatic merger runs.

**Trust limits:** globs classify paths, not file meaning. Declaring `src/**` or `**`
as generated explicitly authorizes regeneration there, including conflict resolution;
there is no source-language or semantic detector. Matching uses Node's native
`path.matchesGlob` (dotfiles require an explicit matching pattern). Generators,
hooks and verifiers are trusted local commands, **not sandboxed**: snapshots check
final candidate-local changes, not transient or external filesystem effects, network
access or escaped processes. Candidate-local ignored dependencies are scanned too,
which can be expensive; nothing installs dependencies or copies `node_modules`.
Generated footprint exclusions use conservative containment, described below.

Readers, effort auto plans, chains and classified retries are unavailable until
later slices; none silently escapes into non-effort work. Non-git, detached-base,
Brazil and external-worktree-mode opens are refused. Opening requires a session id
and records process-start identity (Linux start ticks, otherwise Node's stable
process time origin). No config is rewritten.

Records live under `~/.pi/agent/conductor/efforts/<name>-<sha256(real gitRoot)>/`.
The canonical repository root is the main checkout, even for linked-worktree
callers; the captured base remains the caller's branch. An exclusive `effort.lock`
claim and atomic `effort.json` replacements retain owner session/pid/start identity,
frozen policy and ordered member ids. Existing refs/records/claims fail closed.
Claims use append-only generations published create-only from fsynced bytes;
competing dead-owner claimants cannot replace each other's generation. Atomic
run/effort writes acknowledge file and directory persistence before CAS. A failed
creation/persistence retains its claim and any created ref; rollback never deletes
a ref that another actor may have replaced. A claim without `effort.json` is not
proof of a successful open and needs inspection.


### Recovery guarantees and human controls

Before CAS, recovery rebuilds the candidate and reruns regeneration, required
repository commit hooks and effort verification. An interrupted verification is
not trusted. After CAS, acceptance requires the WAL's exact candidate/tree,
expected parent, frozen verify identity, exact effort/run trailers **and** candidate
reachability from the current tip. A later descendant tip still proves inclusion;
an unrelated trailer, unreachable candidate or completed JSON status does not.
Durable per-effort queue order wins; WAL-only integrating members are appended in
stable enqueue-time/id order. Missing/conflicting records pause instead of vanishing.

**Automatic callback dispatch is at most once, not exactly-once delivery.** The
shared settlement path repairs/persists result files, then writes dispatch intent
before notification callbacks, lifecycle events and the local memory append.
On restart, an unfinished intent becomes `integration.delivery: "uncertain"`:
Legacy integrated records without the dispatch protocol are also uncertain.
Git-proven integration stays completed, result files remain usable, and callbacks
are **not replayed**. A card, event or memory outcome can be missed in that window.
`"attempted"` means local dispatch returned, not that a receiver acknowledged it.
Local memory remains best-effort and shares that at-most-once dispatch scope;
recovery never repeatedly appends it. There is no receiver acknowledgement protocol.
Inspect `/conductor effort status <name>` or `ensemble_status` for uncertainty.
Manually reading/reposting a result is possible, but may duplicate an earlier
notification. Never reintegrate work just to recreate delivery.

Human-only, interactive commands (confirmation required; no LLM requeue tool):

```text
/conductor effort resume <name>
/conductor effort requeue <run-id> [--oid=<current-source-oid>] [--hook <replacement command>]
```

`resume` requires a paused effort, establishes current ownership, validates the
pause's source/process evidence and reruns baseline validation through the normal
candidate route. `requeue` requires preserved stopped work and a clean exact source
OID; a changed head needs explicit `--oid` confirmation. It runs the saved original
resolved hook in a fresh private source checkout before integration. A legacy or
unreconstructable per-call hook **requires an explicit human replacement** via
`--hook`; it is never assumed to have passed. Requeue can retry its own member's
pause, but unrelated/unknown pauses require inspection/resume. Required repository
hooks and effort verification remain active even with a replacement hook.

Lost running writers are never automatically enqueued. A blocked A6 question stays
blocked; only explicit successful effort-owner adoption establishes the new answer
owner, after which ordinary A6 capacity and acceptance checks still apply. An old
ask with an unrecorded hook can be answered, but its output stays unintegrated
until human requeue establishes that gate; recovery never invents a passed hook. Merger
states are preserved, not recovered. A command launch interrupted before its PID/
start WAL is durable, unreadable/ambiguous ownership, missing records or unsafe
process-group identity can require manual investigation rather than automatic
progress. Takeover currently requires the Linux identity evidence above. These
limits favor retaining work over guessing, killing unrelated processes or purging
assets. Unattended rollout still requires independent M5 acceptance.

## Owner questions (A6)

Managed children have `ask_owner({ question, files? })` for **one decision needed
to continue the current assignment**, not progress messages. Call it alone: Pi's
actual assistant tool batch must contain only this call. Blank questions, invalid
file evidence, queued messages, duplicate asks, inactive contexts and retired
sessions reject without ending the turn. Depth-two leaves have no `ask_owner`;
put their questions in final text. Explicit tool allowlists retain `ask_owner`;
a persona's explicit `exclude_tools` still wins. Parent tools do not change.

Accepted questions end the child's turn. After native `agent_settled` and process
exit, the run is **`blocked` (`?`)**, not successful or failed. Foreground calls
return the question; background calls deliver one `<sub-agent-asked>` card with
the question, tool-call ask id, prepared file evidence and `available_actions`.
Files use A5's validation and budgets, resolved from the **child's cwd** (including
its worktree). Embedded evidence is prepared once in the accepted tool execution.
No `final.md` or result-ref is manufactured for a question.

Answer through the existing send surface:

```json
{"agent_id":"builder-7f3a","message":"Use option B.","streaming_behavior":"resume"}
```

`auto` also works. The answer is framed with the outstanding ask id and question,
and resumes the saved Pi session and **original assignment/worktree**, not a new
task. The question remains pending until Pi accepts the replacement prompt: a
native `agent_start` after print preflight, or a correlated successful initial
`prompt` response for RPC. Spawn alone is not acceptance. Pre-acceptance exit,
timeout, spawn error or RPC rejection restores `blocked` with the same question,
session and worktree; a `<sub-agent-answer-failed>` notice explains delivery failure
without claiming assignment completion. Retry with `ensemble_send`.

Live sends are closed while an ask execution is unresolved, reopening if it fails.
Already-in-flight or extension-queued input can still reach Pi. Only a consumed
user message followed by a real assistant response supersedes the earlier stopping
ask; queue updates and arbitrary progress do not. Native settlement then produces
one truthful completion or question, never an obsolete blocked card.

`/conductor send` and the overlay's
`s` control do the same; `ensemble_resume` is SIGCONT, not an answer tool.

Blocked runs consume no concurrency slot, have no running process (print and both
RPC transports), and are ignored by the watchdog. They retain their session,
question, worktree and branch across restart; GC does not reclaim unresolved work.
No success hook, merge, normal completion card, retry or auto-chain/auto-plan
advancement occurs while blocked. A later successful answer turn runs normal
completion gates. Auto plans halt and require owner intervention rather than
silently restarting the plan. Kill abandons the ask and preserves work under the
existing killed-run TTL policy. Retirement prevents continuation consistently;
if the saved session is retired, use a fresh child with the transcript/handoff.
The parent can do independent work; **do not poll** for questions or answers.

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
Phase A **A2–A6** and H7–H11 are implemented. H11 automated real-herdr acceptance
passes in private sessions. Human TUI acceptance and rollout are still open; see the
runtime section. Offline recovery tests use executable fake herdr and the approved
native Pi 0.87.1 harness, never personal panes.

`~/.pi/agent/extensions/conductor/config.json` (user) or `<project>/.pi/conductor.json` (project, overrides user):

```jsonc
{
  "defaultMode": "off",                  // v0.8: "on" | "off". Pinned
                                         // conductor-mode default at
                                         // extension load. Beats env var.
  "contextRetirement": true,             // A2: retire managed children on automatic context pressure
  "inlineAttachmentLimitBytes": 131072,   // A5: per embedded envelope; total files section <= 4x
  "chains": { "builder": { "then": "critic", "files": ["plan.md"] } },
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

MIT. See [LICENSE](LICENSE).
