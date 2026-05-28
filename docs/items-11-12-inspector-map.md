# Items 11 + 12 — inspector recon map

HEAD: `123151e` (pi-conductor master).
Scope: read-only survey of in-repo surface for backlog items 11
(`<sub-agent-completed>` didn't wake conductor) and 12
(`filtered_compact` admits parent-identity bleed). Cheap defenses
ranked; cross-repo / v2 work flagged separately.

---

## 1. Item 11 — Notification path map

### 1.1 Sole call site

`pi.sendMessage` for `<sub-agent-completed>` is invoked in **exactly
one place**: `src/index.ts:308–318`, the
`pushCompletionNotification` closure on `RegisterToolsOpts`:

```ts
pushCompletionNotification: (run: Run) => {
  const text = formatCompletionNotification(run);
  pi.sendMessage(
    { customType: "ensemble-notification", content: text, display: true },
    { triggerTurn: true, deliverAs: "followUp" },
  );
},
```

`triggerTurn: true` is **unconditional** — no branch on
`foreground`, on `run.status`, or on registry state.

### 1.2 Where the closure fans out

Five wire-points, all routing back to the single call site:

| Path | File:line |
|---|---|
| Background `ensemble_spawn` (spawned) | `src/tools.ts:331` |
| Background `ensemble_spawn` (queued → terminal) | `src/tools.ts:344–351` (self-unsubscribing `registry.onChange`) |
| Foreground `ensemble_spawn` post-Esc-detach | `src/tools.ts:432`, `:672` (via `installPostDetachCompletionListener`) |
| Background `ensemble_send` | `src/tools.ts:576` |
| `executePromptAndSend` slash + InputPane | `src/prompt-and-send.ts:124` |

### 1.3 Terminal-status → notification chain

For background spawns:

1. `runs.ts:1252 finalize(...)` (closure inside `runPiSubprocess`)
2. terminal status applied via `applyCloseHandlerTerminal`
   (`runs.ts:1316`)
3. `opts.registry.notify(run)` (`runs.ts:1317`)
4. After `Promise.all([writeRecord, writeFinal])`, `opts.onComplete(run)`
   fires (`runs.ts:1342–1346`) — wrapped in `try { … } catch {}` that
   silently swallows listener errors
5. `onComplete` → `pushCompletionNotification` → `index.ts:310`
   `pi.sendMessage(...)`.

Race-guard for foreground-detach is
`src/foreground-stream.ts:349 installPostDetachCompletionListener`
(syncs a microtask-window check after subscribing).

### 1.4 `pi.sendMessage` + `triggerTurn` semantics

- API surface: `dist/core/extensions/types.d.ts:283–286`, `:833–837`.
- Implementation: `dist/core/agent-session.js:945–986`,
  `sendCustomMessage`:
  - `deliverAs === "nextTurn"` → push to `_pendingNextTurnMessages`.
  - `this.isStreaming` → if `deliverAs === "followUp"` →
    `agent.followUp(appMessage)`; else `agent.steer(appMessage)`.
    **`triggerTurn` is ignored on the streaming branch.**
  - `triggerTurn: true` (not streaming, not nextTurn) →
    `await this.agent.prompt(appMessage)` — fires a turn.
  - Default → push to `state.messages`, emit `message_start` /
    `message_end`. **No turn.**

**Implication.** The conductor passes both `triggerTurn: true` AND
`deliverAs: "followUp"`. On the streaming branch, `deliverAs:
"followUp"` wins; the message is queued via `agent.followUp(...)`.
If the conductor's current turn ends without consuming the followUp
queue and the session sits idle, **no turn fires** — exactly the
witness symptom (info line, idle conductor).

This is **not a contract bug per se** — followUp queueing is
intentional v0.10 behavior; PRD line 653 (Q3) ratifies the same
choice for the watchdog soft advisory. But for `<sub-agent-completed>`
the PRD line 257 contract reads as *"wakes the conductor"* —
followUp does that only conditionally.

### 1.5 Existing tests pinning `triggerTurn`

**None.** `grep -rn "triggerTurn" tests/` returns zero hits. Test
fixtures stub `pushCompletionNotification` as a counter
(`tests/ensemble-send.test.ts:78`,
`tests/promptAndSendToRun.test.ts:106`, plus 5 others) — they
verify the closure fires but never assert on the
`pi.sendMessage` options arg. **Untested contract.**

---

## 2. Item 11 — In-repo surface for the three hypotheses

**Hyp 1 (pi-conductor pushes wrong shape).** Static read of
`index.ts:310–317` does **not** support a regression of the
`triggerTurn` flag itself. But the co-passed `deliverAs:
"followUp"` makes `triggerTurn` advisory on the streaming branch
(§1.4). Test pin closes the gap (§3.4); none exists today.

**Hyp 2 (pi-dashboard downgrades).** Out of repo. In-repo signal
that would help isolate the boundary: a `console.error("[conductor]
push-completion …")` immediately before the `pi.sendMessage`
call (§3.2) and a `/conductor wake` slash command (§3.3). Neither
fixes the dashboard bug; both make the boundary observable.

**Hyp 3 (state-dependent swallow).** Code surface supports this.
Per §1.4, when conductor is streaming at completion-time, the
message is queued via `agent.followUp` rather than firing a turn.
If the in-flight turn ends without draining the followUp queue
(or pi-dashboard's chat slot renders the queued message as info),
the witness reproduces. In-repo signal that "a turn happened":
`pi.on("turn_start", …)` is already wired at `index.ts:530` for
`cwd`/`ctxRef` refresh — adding a `lastTurnStartedAt: number` is
one line. Combined with a `Set<runId>` of outstanding wakes
cleared on `turn_start`, this becomes a dead-man switch (§3.1).

---

## 3. Item 11 — Cheap in-repo defenses

### 3.1 Dead-man-switch for completion notifications

**Where:** module-scoped state in `src/index.ts` near the existing
`ctxRef`/`widget` declarations:

```ts
const pendingWakes = new Map<string, { sentAt: number; persona: string }>();
let lastTurnStartedAt = 0;
```

- In `pushCompletionNotification` (`index.ts:309`):
  `pendingWakes.set(run.id, { sentAt: Date.now(), persona: run.persona })`.
- In the existing `pi.on("turn_start", …)` (`index.ts:530`): set
  `lastTurnStartedAt = Date.now()` and drop entries with
  `sentAt <= lastTurnStartedAt`.
- Piggyback on the watchdog tick (`index.ts:431`) at 30s: for any
  `pendingWakes` entry where `now - sentAt >= N`, re-call
  `pi.sendMessage` (or fire a stronger `<sub-agent-completed-reminder>`
  envelope), bump `sentAt` for backoff.

**Failure modes:**
- False-positive: conductor chose to ignore. Cap re-sends at 1–2.
- Re-entrancy across `session_shutdown` → `session_start`: clear
  `pendingWakes` in the existing shutdown handler (`index.ts:491`).

**LOC:** ~40 + a unit test.
**Closest precedent:** v0.10 watchdog soft-advisory injection
(`src/index.ts:419–471`) — same template, inverts the
turn-trigger choice.

### 3.2 Defensive logging on every `pi.sendMessage`

`console.error` immediately before the call at `index.ts:309`,
mirroring the watchdog's `console.error("watchdog: ${msg}")` at
`index.ts:455`. ~5–10 LOC, no test required.

### 3.3 `/conductor wake` slash command

**Where:** add a `wake` subcommand to `src/commands.ts:94–175`
SUBCOMMANDS switch (registration shape at `:165 case "send"`).
Body: re-fire the most-recent unprocessed completion (read from
`pendingWakes` per §3.1, or fall back to "most-recent terminal run
in registry").

**LOC:** ~30 + help-string update.
**Closest precedent:** `runSendCmd` (`commands.ts:166`).

### 3.4 Test pin for `triggerTurn: true`

**Where:** extend `tests/notifications.test.ts`, OR a new
`tests/push-completion-notification.test.ts`. The closure currently
lives inline in `setupConductor` (`index.ts:236`) and is not
directly importable; either factor it out (~5 LOC, same shape as
the `prompt-and-send.ts` extraction) or assert via the existing
`tests/ensemble-spawn.test.ts:62`-style harness with a mock that
records the options arg.

**LOC:** ~35 (5 refactor + 30 test).
**Closest precedent:** `tests/promptAndSendToRun.test.ts:106`
already captures `pushCompletionNotification` invocations; extend
to record options.

---

## 4. Item 12 — Filter map

### 4.1 `filterParentContext` (base)

`src/context-filter.ts:71–202`.

- `DEFAULT_TOOL_PREFIXES = ["ensemble_", "subagent"]` (`:57`).
- `DEFAULT_CUSTOM_TYPE_PREFIXES = ["ensemble-notification", "subagent"]`
  (`:58`).
- `dropThinking` default `true` (`:135`).
- Drops `bashExecution` entries with `excludeFromContext: true`
  (`:174–177`).
- Whole-message drop: any assistant message containing an excluded
  toolCall is dropped along with sibling toolCalls — orphan-result
  guard (`:99–124`).
- Preserved verbatim: `branchSummary`, `compactionSummary`, unknown
  roles (`:189–198`).

### 4.2 `filterParentContextCompact`

`src/context-filter.ts:223–293`.

- Calls `filterParentContext` first (`:228`), then walks results.
- Per assistant message: keep non-`text` blocks (toolCalls;
  thinking already removed), drop every `text` block, count drops
  in `elidedAssistantBlocks` (`:241–256`).
- If `kept.length === 0` → drop entirely (`:258`).
- When ≥1 block elided, prepend a synthetic assistant message
  `[conductor narration elided: N prose block(s) …]`
  (`:265–293`). Precedent for fix candidate #2.

User messages are passed through verbatim — no filter on user
content shape today.

### 4.3 What does the parent's first user message actually look like?

Walked recent seeded.jsonl in `~/.pi/agent/conductor/runs/`:
entries [2] of `builder-zsps`, `builder-4gsl`, `builder-02qx` are
all clean task strings (e.g. `"update this project on GH…"`).
Python-walked the full fleet for any user message whose first
text block *starts with* `## Recent Sessions` or `<memory>`:
**zero hits.** The verbatim project-context preamble (the one
this inspector session is reading right now at the top of its
first user message) is **not present** in the fleet's seeded
files.

Two readings: (1) the witness's bleed source may have been a
session where the user's first conductor prompt itself contained
the preamble — dashboard injecting it as the first user turn,
rather than as a system prompt. Post-`0ee741c` files don't show
it. (2) Or the bleed source is shape, not content: orchestration
patterns surviving `filtered_compact`, plus the user's terse
decision style (witness cites `"a"`, `"a, a, a"`, `"confirm"`).
Candidate #1's value is conditional on (1); candidate #2's
strengthening is unconditional and addresses (2) directly.

---

## 5. Item 12 — In-repo surface for the four candidates

### 5.1 Candidate #1 — Drop project-context preamble

**Where:** user-message branch of `filterParentContext`
(`context-filter.ts:131`) or a post-pass before
`filterParentContextCompact` returns (`:295`). Detection:
prefix-match on the first user message's first text block —
`## Recent Sessions`, `<memory>`, `<available_skills>`,
`# Project Context`.

**Edge cases:** literal user prompts starting with these strings
(false positive — small but real); pasted dashboard blocks when
the user is asking the conductor *about* itself; preamble shape
drifts across dashboard versions.

**LOC:** ~25 (predicate + invocation + tests). Self-contained;
wire via a `FilterOptions` flag (default-on), same shape as
`dropThinking` (`:135`). **Caveat:** field evidence weak (§4.3).

### 5.2 Candidate #2 — Auto-inject `[YOU ARE A FRESH SUB-AGENT]`

**Where:** the synthetic header constant in
`filterParentContextCompact` (`context-filter.ts:266–293`), OR
strengthen `filteredHistorySentinel` (`runs.ts:564–589`) — a
user-role sentinel already prepended for both filtered AND
filtered_compact (verified in `builder-zsps/session/seeded.jsonl`
entry [1]). The sentinel already carries identity-clarification;
strengthening the prose to open with `[YOU ARE A FRESH SUB-AGENT.]`
is text-only — both synthetic mechanisms coexist already, so it's
wording, not shape.

**LOC:** ≤10 + test pin updates. Self-contained; smallest of the
four.

### 5.3 Candidate #3 — Per-call `inherit_context: none` override

**Where:** schema add to `ensemble_spawn` parameters
(`tools.ts:225` block) next to `kill_on_stall` /
`stall_threshold_seconds` / `steerable`; thread through
`enqueueOrSpawn` → `spawnRun` → `planSpawnPiArgs`. Spawn entry
(`runs.ts:996`) builds `plan` from `persona` today; layer the
per-call value as an explicit `effectiveInheritContext`.
Persona-frontmatter default `"filtered"` lives at
`personas.ts:197–199`; cascade precedent is `kill_on_stall`
(see `collapseSteerableCascade` at `tools.ts:284–290`).

**LOC:** ~70, 2 commits. Three files touched (largest of the
four); cascade pattern well-precedented, risk low.

### 5.4 Candidate #4 — Chain-depth heuristic auto-downgrade

**Where:** add `CONDUCTOR_DEPTH=N` env-var counter (item 14's
`CONDUCTOR_SUBAGENT=1` is a flag, not a depth). Increment at
spawn (`runs.ts:996`-area args build); read at `setupConductor`
load. Branch in `planSpawnPiArgs` (`runs.ts:616`) to downgrade
`filtered_compact` → `none` past a threshold.

**LOC:** ~70–100; touches the spawn pipeline (highest test
surface in the repo). **Defer:** witnesses are at depth 1 — a
depth heuristic wouldn't have caught builder-4gsl. Lowest
value/effort of the four.

---

## 6. Recommendations

Ordered by value/effort. All in-repo.

1. **Strengthen `filteredHistorySentinel` text** (item 12, candidate #2).
   Replace the body in `runs.ts:564–589` with prose opening
   `[YOU ARE A FRESH SUB-AGENT.]` and explicitly addressing the
   builder-4gsl failure mode.
   LOC: ≤10. Commits: 1.
   Pattern: the existing sentinel.
   Risk: minimal — text-only; pinned by 5+ tests in
   `tests/context-filter.test.ts` + `tests/runs.test.ts`.

2. **Test pin: `pushCompletionNotification` always sets `triggerTurn: true`** (item 11).
   Extract the `pushCompletionNotification` closure
   (`index.ts:308–318`) to a top-level helper, then assert on the
   options arg.
   LOC: ~35. Commits: 1.
   Pattern: `executePromptAndSend` extraction
   (`prompt-and-send.ts` + `tests/promptAndSendToRun.test.ts`).
   Risk: low — pure refactor + new test.

3. **Dead-man-switch for completion notifications** (item 11).
   Track pushed completions in `Map<runId, sentAt>`; clear on
   `turn_start`; on a 30s tick, re-fire pending wakes older than
   N seconds.
   LOC: ~40 + test. Commits: 1.
   Pattern: v0.10 watchdog soft-advisory injection
   (`index.ts:419–471`).
   Risk: medium — re-entrant timer + global map; need cleanup on
   `session_shutdown` and bounded re-fires per resume.

4. **Per-call `inherit_context: none` override on `ensemble_spawn`** (item 12, candidate #3).
   LOC: ~70. Commits: 2.
   Pattern: `kill_on_stall` cascade (`tools.ts:246–252` schema +
   `runs.ts` plumbing).
   Risk: low; effort higher than #1–3.

5. **Drop project-context preamble** (item 12, candidate #1).
   LOC: ~25. Commits: 1.
   Pattern: `dropThinking` flag + customType-prefix excludes.
   Risk: medium — false-positive surface; field evidence weak
   (§4.3). **Ship only if a fresh witness pins the preamble in a
   real seeded.jsonl.**

---

## 7. Genuinely cross-repo / v2-design

- **pi-dashboard rendering of `triggerTurn: true` user-role
  messages** (item 11, hyp 2). Lives in
  `pi-dashboard/backend/pi-manager.ts` per the backlog entry; not
  present in this workspace. §3.1–3.3 mitigate the symptom only.
- **`pi.sendMessage` semantics when `triggerTurn: true` AND
  `deliverAs: "followUp"` are co-passed** (item 11, hyp 3 root).
  Implementation in `@earendil-works/pi-coding-agent/dist/core/agent-session.js:945`
  — read-only reference. Dead-man works around it; doesn't change
  upstream branching.
- **Chain-depth-aware downgrade** (item 12, candidate #4). Could
  ship in-repo but is the most speculative; reads as a v2 PRD
  entry under `Context inheritance`. Defer.
- **Worktree-per-persona, on_complete_hook quality gates** (PRD
  v0.10+ planned list) — out of scope for items 11/12; flagged
  only to avoid confusion when scoping these patches.

---

## 8. Open questions

- Has anyone reproduced item 11 in TUI mode (no pi-dashboard)? If
  TUI also fails, the dead-man switch is necessary; if TUI
  succeeds, hypothesis 2 climbs and the cheap defenses become
  diagnostic-only. No in-repo evidence either way.
- For item 12: does any seeded.jsonl actually contain a verbatim
  project-context preamble in a user message? Fleet sample
  (§4.3) didn't surface one — but I only walked the
  mtime-recent set (~50 entries). A targeted reproduction of
  builder-4gsl with that session's seeded.jsonl preserved would
  settle whether candidate #1 is worth shipping.
- Does pi-dashboard's `pi-manager.ts` render
  `customType: "ensemble-notification"` differently from a plain
  user-role message? Reproducing TUI vs dashboard side-by-side
  isolates the boundary; cannot be answered from this repo.
