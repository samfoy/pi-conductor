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

`focus` is a read-only view, not control: it can be listed for a run that accepts no
other action. A delegated leaf (depth 2) offers only `kill` (N4, below).
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

**Tool policy is enforced by pi.** `tools` is an allowlist (`pi --tools <csv>`) that replaces the child's default active set, builtin and extension tools alike; omit it to keep pi's defaults. `exclude_tools` is a denylist (`pi --exclude-tools <csv>`). Both are block lists of tool names (`^[A-Za-z0-9_.:-]+$`); unknown names are harmless. Every sub-agent also runs with the conductor's own `ensemble_*` tools, the foreign spawn tools (`subagent`, `agent`), the supervision tools (`chief`, `peer`, `staff`) and, except in an eligible delegator, `delegate` (below) excluded, on fresh spawns and `ensemble_send` resumes alike, so a child can't start agents the conductor doesn't supervise. `/conductor doctor` warns when another loaded tool's name looks spawn-capable. The nine read-only builtins exclude `edit`, `write`, `insert_before`, and `insert_after`. `personaOverrides.<name>.tools` / `.exclude_tools` replace the persona's whole list. `ensemble_list` and `/conductor show <name>` display the effective policy.

This is **partial enforcement**, not a sandbox: `bash` stays available unless a persona excludes it, so a read-only persona can still write through the shell.

**Delegation allowlists (N1 policy, N2–N5 broker; opt-in).** `agents` is an optional block list of at most 8 persona names a persona may later delegate read-only work to. `personaOverrides.<name>.agents` replaces the whole list; `[]` disables it. No builtin declares one. The list is checked against the fully resolved roster, and any bad entry makes the declaring persona unavailable (a load error in `/conductor doctor`), never a shorter list: an unknown, disabled or masked target, the persona itself, a duplicate, a non-string or badly named entry, flow syntax, more than 8 entries, a target that is not explicitly `read_only: true`, or a known write-capable target (`builder`, `simplifier`). A lead spawn persists `depth: 1` and the validated `delegateAllow` in `record.json`; queue drain, retry, resume and reattach reuse that frozen scope, later config changes do not alter it, and no `ensemble_spawn` argument can set it. A record with neither field is a legacy depth-1 leaf. Any other depth or allowlist shape refuses `send` and is left untouched by startup reconcile. Every child gets conductor-owned `CONDUCTOR_DEPTH` and `CONDUCTOR_RUN_DIR`, with inherited copies dropped, on both runtimes. Only a depth-1 child with a non-empty list gets `CONDUCTOR_DELEGATE_ALLOW`. Only that child keeps `delegate`, and an explicit `tools` list gains it; every other child excludes it, and an explicit `exclude_tools: [delegate]` still wins. The name is filled by the conductor's own tool, so another extension's `delegate` loaded into a delegator fails pi's startup as a tool conflict (doctor warns when one is loaded). The depth-2 leaf scope also excludes `ask_owner`, `edit`, `write`, `insert_before` and `insert_after`, and its prompt asks for a final `QUESTION:` line instead. A child registers `ask_owner` only when `CONDUCTOR_DEPTH` is unset or `1`, and never an `ensemble_*` tool. `ensemble_list` and `/conductor doctor` show each allowlist.

**`delegate` (N2).** A depth-1 delegator calls `delegate({persona, task, files?, timeout_minutes?})`, which blocks until the lead answers; several calls in one turn run in parallel. The lead brokers it only from that run's own parsed event stream. Pi emits `tool_execution_start` before it validates a call, and an unknown, schema-invalid, blocked or aborted call still starts and then ends in error, so start alone never spawns anything: the broker spawns only on the call's first `tool_execution_update`, which the tool emits from inside `execute`. Ids must match `^[A-Za-z0-9_-]{1,128}$`; Pi 0.99 nested `ctx.executeTool()` calls are refused. Before any await the broker creates `delegate/<id>.claim.json` create-only and counts the call; a duplicate update or an existing claim never spawns a second leaf (an existing claim is answered as uncertain, never replayed). It then checks the persisted allowlist against the current roster (read-only, not write-capable), a non-blank task of at most 64 KiB, `files` resolved against the parent's effective cwd with `run:` references only to the parent's own leaves, and at most 8 outstanding calls. The leaf is depth 2 and read-only, runs in the parent's effective cwd on the runtime the normal persona/project/user/auto cascade selects (no per-call layer; herdr placement is N5 below), gets no inherited context, worktree, merge, hook, effort, chain, retry or steering, uses that persona's configured `model`/`thinking` (overrides applied; unset inherits pi's default, never the parent's), and records `parentRunId`/`delegateToolCallId`. Its timeout is the least of its persona's, `timeout_minutes` and the parent's remaining hard timeout. The answer is written create-only to `delegate/<id>.json` and is the leaf's completion envelope, aimed at `inlineAttachmentLimitBytes` (over it, a summary plus `result-ref` and the `final.md` path; the last, minimal form is bounded by a constant of about 2 KB, so a very small limit is not strict); the lead posts no card for a leaf. An end, abort or terminal parent cancels: a queued leaf is removed, a running one is killed, and the call gets `delegate cancelled: …`. The child waits with `fs.watch` plus a 1 s poll and gives up two minutes after the clamped deadline with `delegate outcome unconfirmed`: no answer is not proof of rejection, and a leaf may have run. Delivery is at most once, not exactly once.

**Two-lane admission (N3).** Slots are reservations: a run holds one while its status is live and, once it settles, until its own subprocess has closed; settlement sends SIGTERM, and SIGKILL 2 s later to a child that ignores it. Close waits for the child's stdio, so a descendant that inherited its pipes can hold the reservation past those 2 s: the release is not strictly bounded. A depth-1 delegator holding a slot is *awaiting* while it has an unanswered `delegate` call. With `A` the reservations and `W` the awaiting delegators whose own slot one of their leaves holds (running or still exiting), `A − W` is the work actually executing. Lead-level spawns (depth ≤ 1) are unchanged: `A < maxConcurrent`, the write-capable cap and effort `maxParallel`/footprints, with awaiting parents still counted, so lead-level work never runs on a waiting parent's slot. A leaf of a current awaiting delegator runs while `A − W < maxConcurrent` with its own parent counted in `W`, and with no write-cap or effort check (it is read-only and no effort member). So a delegator's first leaf runs on that delegator's own slot even when the pool is full, and its further leaves, or another parent's, take only capacity no executing run holds. A claim still being validated, or a queued leaf, lends nothing. A leaf whose parent is unknown, A6-blocked, terminal, depth 2, not delegating or not awaiting takes the lead-level rule. Immediate enqueue and queue drain use the same predicate, and drain offers capacity to such leaves before lead-level entries. A leaf's answer is written only after its process has closed, so its parent stays blocked, and its slot stays lent, until then. Bounds for queue-admitted launches: runs with a live status that are not blocked on an unanswered call never exceed `maxConcurrent`, the one accepted overlap being a parent running another tool beside `delegate`; live owned `pi` subprocesses never exceed `2 × maxConcurrent`, and lead-level ones never exceed `maxConcurrent`; a waiting effort writer keeps its `maxParallel` slot and footprint. When a parent ends its own call (abort) or ends itself, it and its leaves may be exiting at once; their reservations stay counted, so nothing more is admitted until they close. In that window `A − W` counts exiting work as well as executing work. An awaiting parent shows `⇣N waiting` in the panel and `awaiting_children: N` in `ensemble_status`, both the number of unanswered calls. The watchdog and `/conductor watchdog` do not treat it as stalled. Its last answer restarts its silence clock; its hard deadline does not move. Limits: an `ensemble_send` resume of a settled run is not queue-admitted (unchanged) and can exceed the cap, and herdr depth-1 runs, which prove their exit before settling, are not tracked as reservations when that exit is unconfirmed. A herdr leaf (N5) holds its reservation until its pane child's exit is proven, so an unconfirmed exit keeps it held.

**Direct ownership (N4).** A delegator owns exactly the leaves it spawned: depth 2, naming it as `parentRunId`, started no earlier than it, in the current registry. A stale or replaced parent object, an older leaf of a reused id, a malformed depth-1 "child" or a cyclic pair owns or is owned by nothing. Before a delegator's settlement does anything visible (an owner-question block, hook, merge, effort footprint or integration enqueue, `final.md`, terminal record, card), it closes delegation, so later calls are rejected; it cancels this invocation's unsettled leaves, queued ones first; and it waits for each process to exit: SIGTERM, SIGKILL after 2 s, at most 2.5 s in all. It never waits for a leaf's answer, and there is no blocked-children gate. A terminal status is not an exit, so a leaf the parent's own abort already killed is still waited for. A leaf that exited while a descendant holds its pipes counts as exited (`stdio-open`) and keeps its N3 reservation until they close. If any exit stays unconfirmed, nothing is published: no hook, merge, integration, footprint or `final.md`. A pending owner question is withdrawn and named in the error. The worktree and branch are kept. The parent settles once as `failed` with `delegated child <id> exit unconfirmed …`, and `result-ref`/`run:` references to it are refused. Cards and records list `<abandoned-children>` with each leaf's status and observed exit: `confirmed`, `stdio-open`, `requested` (only signalled so far) or `unconfirmed`. Kills cascade inside `forceTerminate`, queued leaves first, then running ones, then the parent. So `ensemble_kill`, `/conductor stop`, the overlay's `k`, the hard timeout, the watchdog and the turn limit all stop leaves before the parent's own record and card. Quit cancels queued leaves, then stops leaves before parents. The gate is fenced by invocation: if the killed or timed-out parent is resumed while its gate still waits, the old invocation stops there, its kill-time record and card stand, and it writes nothing into the resumed run (no abandoned children, question, status, hook, merge, final or card); only its own process is still reaped. Effort state is never written: the gate runs inside H10's `herdrEffortAuthorized` deferral, and a writer's integration starts only after it. A leaf offers the lead only `kill`. `send`, `steer`, `follow_up`, `pause` and `resume` are refused (`owned by <parent>; only kill`) on every path: `sendToRun`, `pauseRun`, `resumeRun`, the tools, `/conductor` commands and the overlay. The lead never posts a leaf's card, live or readopted. Startup reconcile marks a readopted subprocess leaf whose parent is terminal, missing or replaced as `killed` with `orphaned: parent <id> terminal|missing; process <pid> was not signalled …`. It never signals that pid and deletes nothing. A herdr leaf (N5) is attached with a proven child instead, so an orphaned one is stopped through that proof once attached (`orphaned: parent <id> terminal|missing; stopped through its proven pane child`); one that settled while the lead was down only finalizes. A delegator's envelope adds `<children>` (id, persona, status, cost, result-ref) and `<subtree-cost>` for the current invocation (per send, like `<usage>`), and a lifetime `<subtree-cost>` once resumed. `ensemble_status` adds `depth`, `parent_run_id`, `children` and `subtree_cost`, and the panel indents leaves without reordering rows. `ensemble_auto`'s `budget_usd` charges each step its run plus that run's own leaves, each once, when the step settles; a leaf still closing then (`stdio-open` or `unconfirmed`) can add usage that is not charged, so the budget is not an exact bill. A leaf's `QUESTION:` line reaches its parent in the envelope; once the `delegate` call has settled, the parent may delegate again or escalate through its own sole-call `ask_owner`.

**Delegation on herdr (N5).** A herdr delegator's calls reach the same broker through its H4 tee: nonce-filtered, through the same `onEvent` that only a current pipeline feeds. Spawn still waits for the first `tool_execution_update`, and every asynchronous step (roster resolution, the leaf's answer, its deadline) re-checks that this lead still owns the parent's stream (H10 owner generation and launch) before it spawns, answers or cancels; a fenced step only drops its local credit. A leaf's runtime comes from the cascade with no per-call layer: inside herdr it is herdr, and a selection that cannot be met (herdr outside herdr) is a named rejection, never a silent fallback. A herdr leaf of a herdr parent splits the parent's pane only while `pane get` proves that pane's pane, terminal, workspace and tab: the first leaf `--direction right` from the parent, a later one `down` from the previous leaf while that leaf's pane is proven in the same tab, otherwise right from the parent again. Leaves of one parent take placement turns in spawn order. An unproven parent pane (any single field), another socket or a subprocess parent gives the leaf its own tab, never a guessed split target, plus `<warning reason="placement">` in its envelope. Split and own-tab panes alike get `CONDUCTOR_DEPTH=2` and no allowlist, in the parent's effective cwd, with no worktree, hook, merge, effort membership, chain, retry or `ask_owner`. Launch is H11's unchanged contract: a fresh physical alias and nonce, the task published only after herdr registers the idle child, then input acceptance and the correlated native start. Release (quit, GC) closes only the leaf's own pane, after exit proof; herdr removes a tab when its last pane closes, and the conductor never closes a tab, the parent's pane or a sibling's. On lead `/reload` a herdr parent survives: a launched herdr leaf is handed over unanswered, and only what cannot be handed over (no leaf yet, a queued or still-launching leaf, or a subprocess leaf, which has no event source in the next module instance) is cancelled with `lead /reload stopped a leaf it could not hand over …` while the old instance still owns the parent. The next owner's readopt replays the parent's tee from the launch boundary into its broker (usage and messages are rebuilt from the launch baseline, as in H10, not added) and decides each claimed call only after startup reconcile and effort recovery finish, so neither the reconcile order nor whether a writer's effort grant comes before or after its replay loses a leaf: a response → skip; a registered leaf it observes → rebound as awaiting (it counts toward the 8 outstanding calls and `awaiting_children`); a terminal leaf record with no response → answered from that record, create-only; anything else (foreign, unknown, unadopted or H11 prepared-unpublished) → `leaf outcome uncertain after lead restart; not replayed`. A claim must name this parent, this call and this launch. An unclaimed call is brokered normally; an end in the replay cancels a rebound leaf. A claimed call is never re-spawned, an old broker never answers or cancels after handing over, and an existing response always wins. A crash takeover uses the same table. A readopted parent's N4 gate covers its still-unanswered leaves (an answered leaf being re-finalized after a restart is not its to stop). Run ownership is not effort ownership: a call deferred during that barrier is decided only if, when the barrier resolves, the parent is still this lead's current invocation (registry entry, owner generation and launch nonce as when it was deferred) and, for an effort writer, M5 recovery has granted it; otherwise, and for any call of a writer without its effort claim, the broker only observes (no claim, answer, credit or cancel). Ordinary herdr A6 questions and a delegator's own `ask_owner` stay depth 1.

Limits: Pi 0.99+ nested call ids (`<parent>/<n>`) are still refused by the call-id grammar on both sides. The N4 exit bound covers processes this lead launched or attached; a readopted subprocess leaf has no handle, so it is never signalled and its exit is never confirmed. A herdr leaf whose reattach stays uncertain keeps its reservation, and its parent's call waits until the child's own wait deadline (then the end cancels it). The H11 limits (idle orphans, ambiguous notification intents, completed records re-finalized on restart) are bounded by suppression and the uncertain answer, not repaired. A writer whose grant came only after the barrier (not the startup order) stays observe-only for that call. The reattached N4 gate measures from the run's start, so it also covers an older invocation's still-unanswered leaves. A closed broker's rejection text (`resume this run with ensemble_send`) is written for subprocess parents; reload suspends a herdr parent's stream before it closes the broker, so a herdr call should not reach it, but if one did it would get that wording although the parent keeps running. `close()` itself does not re-check ownership; it is safe because shutdown closes the broker before it detaches and releases. Each readopted claimed call without a registered leaf scans the runs root once. Verified offline with the executable multi-pane fake herdr and native Pi pane children (the 0.87.1 minimum and each `CONDUCTOR_H11_PI_ROOTS` root at its own version, run on 1.0.0), and with the opt-in isolated real-herdr scenario on Pi 0.87.1 and 1.0.0; human TUI acceptance is unverified. Child delegation is `delegate` only and opt-in: no builtin persona declares `agents`, and nothing is rolled out by default. On lead `/reload`, a subprocess parent with outstanding calls is killed, leaves first, with `lead /reload interrupted subprocess delegation; resume with ensemble_send` (the R6 fallback, subprocess parents only); parents with nothing outstanding keep the normal reload preservation, and a call they make later, including one whose start came before the reload, is claimed and rejected by the closed old broker. Read-only here is still a tool-policy and prompt boundary with `bash` available, not an OS sandbox, and not a defence against a same-uid process.

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

## Lead presence and `peer list` (S1; not rolled out)

A **lead** is a conductor-ON pi running in a herdr pane: `CONDUCTOR_SUBAGENT` is
not `1`, `HERDR_ENV` is exactly `1`, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID` are
set, and the session is saved (not `--no-session`). A pi typed by hand into a
managed pane inherits `CONDUCTOR_SUBAGENT=1` and is not a lead. Only a lead
registers `peer`, and it stays inactive until the lead is eligible.

While eligible, the lead publishes one record at
`~/.pi/agent/conductor/supervision/leads/<sha256(session id)>.json` (at most
4 KiB and 24 run briefs; directory 0700, file 0600). It publishes on session
start and `/conductor on`, refreshes 2 s after a registry change and every 30 s,
and removes its own record on `/conductor off`, on every shutdown reason (quit,
reload, new, resume, fork) and on a session switch. `/reload` republishes under
a fresh epoch only if conductor mode is ON by default: as before, a `/conductor on`
toggle does not survive reload. A second live pi on the same session stays
inactive and says so.

```json
{"action":"list"}
```

returns `{"self": "<this session id>", "peers": [{"lead", "name", "cwd", "repo", "branch", "workspace_label", "state"}]}`.
Leads on any herdr socket appear, but not this one. `lead` is the exact full pi
session id; every other field is self-reported presentation and grants nothing.
`workspace_label` is empty because supervision never calls the herdr CLI.
`state` is `live` or, when the process cannot be proven (off Linux after 90 s
without a refresh), `unknown`. The listing scans at most 1024 entries and returns
at most 16 KiB. It deletes records whose process is proven dead (on Linux:
ESRCH or a different start time), and off Linux records more than 10 min stale.
Each call rechecks that this lead is still eligible and still owns its record.

**Limits.** `peer` lists and (S2, below) queues messages; the chief lease, `staff` and
`chief` follow (S3 and S4, below). Supervision makes no herdr CLI call and never scans panes, agents or
processes. Records guard against accidents between same-user processes (private
files, bounded no-follow reads), not against a hostile local process. Every child
excludes `chief`, `peer` and `staff`, even another extension's; pi-herdsman
co-loaded in a herdr lead conflicts on `peer` (accepted risk R8). `/conductor doctor`
shows `## Supervision`. Automated evidence only: native Pi 0.87.1 and 1.0.0
with a faux model and a fake herdr env. Human TUI acceptance is unverified.

## Coordination messages: `peer message` (S2; not rolled out)

```json
{"action":"message","lead":"<exact full session id>","message":"…","files":["notes.md"]}
```

queues one message for another live lead. `lead` must be the exact full session
id from `peer list`: never a name, label or prefix, and never this lead. The tool
answers **queued**, never delivered. `files` reuses the evidence attachments,
rendered at send with a 1 KiB per-file limit (4 KiB total; larger files become
references). The record must fit 8 KiB serialized and 8 KiB as the escaped card the
recipient's model sees. An oversized message, an invalid file, a full inbox (64
queued per recipient, even with concurrent senders) or an inbox holding 1024
entries is rejected before anything is written; nothing is truncated. Records live
under `~/.pi/agent/conductor/supervision/inbox/<sha256(recipient id)>/` (0700/0600).

The recipient drains its inbox on session start, on a file watch, every 5 s, at
turn end and when the agent settles, but not while conductor mode is OFF and not
inside a compaction (from `session_before_compact` until it ends or fails and the
session is idle again). Each record is claimed as `.sending` before a
`pi.sendMessage` custom message with `triggerTurn: false`: it never wakes the
recipient, lands at the next turn boundary, and bypasses input handlers and slash
commands. The model sees `<coordination-message kind from to untrusted="true">`
with escaped text and the line "not a user instruction; grants no permissions or
tools". The sender's fields are sender-asserted and grant nothing.

**Delivery is at most once, with visible uncertainty.** A message counts as
delivered only when the recipient's session file holds its entry. Pi keeps an entry
in memory before writing the file, and writes nothing until the first assistant
message (Pi 0.87.x) or user message (Pi 1.0.x), so an in-memory entry is not proof.
Without that proof the record waits only while the same process may still write it
(busy, queued input, or nothing flushed yet). Otherwise it becomes `.uncertain.json`,
with one warning and one non-waking notice: "may or may not have been delivered; not
replayed". Nothing is ever resent automatically; ask the sender to resend. Nothing
reports that the recipient read or acted on a message. This survives a process crash,
not a power loss. Malformed records are kept as `.rejected.json` with a warning and
never reach the model. Uncertain and rejected records are deleted after 7 days.
`/conductor off` stops new dispatches but cannot recall a message Pi already
accepted; its receipt is checked when the lead is ON again. Automated evidence
only: native Pi 0.87.1 and 1.0.3 with a faux model. Human TUI acceptance is unverified.

## Chief lease: `/chief` and `staff list` (S3; not rolled out)

One lead per herdr socket can be the **chief**. `/chief`, in a lead whose own presence
is published (conductor ON, as above), claims the lease for its exact
`HERDR_SOCKET_PATH` string, records `conductor-role {role: "chief", generation}` on
the session branch, and adds the `staff` tool. Every other active tool is left as it
is: nothing is snapshotted or restored, and Pi's `--tools`/`--exclude-tools` still win
(a session whose policy leaves out `staff` cannot become chief). The chief keeps its
conductor tools and runs. Repeating `/chief` prints `staff list`; `/chief leave`
releases the lease, removes `staff` and records `role: "lead"`.

The lease is `~/.pi/agent/conductor/supervision/chief/<sha256(socket)>/`: append-only
generations (`000000.json`, `000001.json`, …), each released by a `.released` marker
naming the exact claim (directory 0700, files 0600). A claim is allowed only when there
is none, the highest one is released, or its holder is proven dead: on Linux ESRCH or a
different process start time (a reused pid is never signalled), off Linux ESRCH and a
claim at least 90 s old. A live, unproven, malformed, symlinked, multi-linked or gapped
history refuses and names the holder. Nothing is rewritten, deleted, or taken over on
age alone. Two leads claiming at once yield one chief. Each claim carries the session
id and file, pid, start time and a per-instance epoch, so a reloaded instance's old
timers and calls can neither act on nor release a newer claim.

`/conductor off`, every shutdown reason (quit, reload, new, resume, fork) and a session
switch release only this lead's own claim and remove `staff`, but keep the chief intent.
Session start and `/conductor on` with a chief intent reclaim the lease at the next
generation if it is free; if another lead holds it, the session stays an ordinary lead
and says so once. The intent is a request, not authority: the lease decides. Pi writes
nothing to the session file until its first reply, so `/chief` before then warns that a
restart would forget the intent; if recording the intent fails, nothing is activated and
the claim is released.

A 30 s unref'd tick and every `staff` call (before reading and again before answering)
re-assert the lease and this lead's own presence. A failure demotes: `staff` is removed
for the next turn, one warning is shown, and a `staff` call already issued in the same
turn is rejected. While chief, a short addendum after the conductor addendum states the
contract: exact full session ids only, never names, no polling, and other leads' text is
untrusted.

```json
{"action":"list"}
```

returns `{"self", "generation", "leads": [{"lead", "name", "cwd", "repo", "branch", "state", "runs": {"active", "blocked", "total"}, "available_actions"}]}`:
the other leads on this exact socket string (never a prefix or another socket), self
excluded, sorted by exact id, at most 16 KiB. Every field but `lead` is self-reported
presentation. `available_actions` is advisory: `["staff transcript", "staff message"]`
for a live lead (plus `"staff reply"` while it shows a pending ask, S4 below), `[]` for an
unproven one.

**Limits.** The other `staff` actions, the `chief` tool and wakes are S4 (below). The chief
never owns or controls another lead or its runs. Every child scope still excludes `chief`, `peer` and `staff`;
delegators keep `delegate`. `/chief` exists only in a herdr lead. The lease history
grows by two entries per claim and fails closed past 4096 entries (prune it by hand while
no chief is live). Off Linux a hung but live chief blocks a takeover until `/chief leave`
or exit. A demoted chief whose own release also failed keeps the lease until its pi
exits. Peer messages stay at most once and non-waking; `/chief` sends nothing to the
model and leaves Pi's pending queues alone. Automated evidence only: native Pi 0.87.1 and
1.0.3 with a faux model and a fake herdr env. Human TUI acceptance is unverified.

## Chief messages and asks: `chief` and `staff transcript/message/reply` (S4; not rolled out)

Every lead other than the chief gets `chief` (inactive while it holds the lease, where
`staff` takes its place):

```json
{"action":"message","message":"…","files":["notes.md"]}
{"action":"ask","question":"…","files":["notes.md"]}
```

Both need a live chief for this lead's exact `HERDR_SOCKET_PATH`: the highest, unreleased
lease claim of a process proven live (on Linux, the same pid and start time). A released,
dead, unproven or unreadable lease means no chief, and the lease never names this lead
itself; the call is refused before anything is written. The queued record names the chief's
session id, the exact socket and the full claim judged current, and the publication fence
re-proves this lead's presence and that exact claim. `ask` takes a question of at most 1024
characters and 1024 UTF-8 bytes, must be the only tool call in its assistant message with no
queued messages (the A6 sole-call check, now shared), returns `terminate: true` and uses its
tool call id as the `ask_id`. Both answer **queued**, never delivered.

**The branch decides the outstanding ask.** It is the newest successful `chief ask` tool
result on this session's current branch: a newer ask supersedes it, an error result
supersedes nothing, and after a rewind, fork or restart it is whatever that branch holds. It
is answered only when a delivered chief reply card for its `ask_id` follows it on the branch
and that delivery's persisted receipt has retired its inbox record. A reply that is only
queued, in flight (`.sending`), uncertain, or held in memory after a failed session write
does not answer it. The lead record mirrors the ask as `pendingAsk` (presentation for
`staff list`), refreshed after each turn, reply and `/tree`, and the panel shows one
`⧗ waiting on chief: <question>` line (at most 80 code points). No record, message or
presence file can create an ask.

The chief's `staff` gains three actions. Each asserts the lease and the chief's own presence
first, and again, with the target, before returning or at the publication fence, so a lease,
presence or target generation that changes meanwhile is an error, never a stale result:

```json
{"action":"transcript","lead":"<exact full session id>"}
{"action":"message","lead":"<exact full session id>","message":"…","files":["notes.md"]}
{"action":"reply","lead":"<exact full session id>","ask_id":"<ask id>","message":"…"}
```

The target must be a live lead on the same exact socket string, and not the chief itself.
Names, labels, prefixes and other sockets never match. `transcript` opens that lead's own
session file no-follow and requires a single-link regular file whose header names the
target. It reads at most the last 512 KiB, starting after a line break (so a UTF-8 sequence
never splits), drops a partial last line, skips unreadable lines and says so, and errors if
the file was replaced while it was read. A newest entry larger than the window is reported,
never parsed from a fragment. The tail renders through the A4 recent-activity builder
(assistant text, tool calls and results), escaped and framed as
`<lead-transcript … untrusted="true">`, at most 16 KiB. `reply` needs the target's record to
show that `ask_id` pending; the lead's branch still decides. `staff list` shows each lead's
`pending_ask`. There is still no run-level action: `staff` cannot spawn, send to, kill or own
another lead or its runs.

**Delivery and wakes.** All four kinds reuse the S2 inbox, bounds and state machine: 8 KiB
records, 64 queued, a `.sending` claim before a `pi.sendMessage` custom message with
`deliverAs: "followUp"`, persisted receipts, and `.uncertain` without replay. Never `steer`,
`nextTurn` or `sendUserMessage`. At dispatch the recipient revalidates against the lease on
disk. A message or question to the chief wakes it (`triggerTurn: true`) only while it still
holds the exact claim named in the record. A chief message or reply wakes a lead only while
that claim is still the live holder on the lead's socket. A later generation, even of the
same session, is a different chief. A stale ordinary message arrives without waking,
labelled "former chief". A reply that is stale, from another socket, or not the outstanding
ask on the branch is kept as `.rejected.json` with one warning; it never reaches the model
and never clears the ask. A reply that arrives while the asking turn is still running waits
for that turn to end, and a second reply to an ask with one in flight waits until the first
settles. A woken dispatch is not classified uncertain before Pi has started its turn. Peer
messages still never wake. A wake asks for a turn; nothing reports that the model read or
acted on a message.

**Limits.** No S5 multiprocess or live acceptance yet. Off Linux no chief can be proven
live, so `chief` refuses, chief messages arrive as non-waking "former chief" cards and chief
replies are rejected. A question delivered under a lease generation its recipient no longer
holds is a non-waking card; the current chief can still answer it from `staff list`. A fork
keeps the parent's outstanding ask, but replies go to the session id that asked. If the same
process keeps an in-memory reply whose `.uncertain` record is swept after 7 days, that reply
then counts as an answer. Delivery is at most once and never resent automatically.
Automated evidence only: native Pi 0.87.1 and 1.0.3 with a faux model and a fake herdr env.
Human TUI acceptance is unverified.

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
