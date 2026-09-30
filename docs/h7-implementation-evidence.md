# H7: herdr transcript observation and shared settlement

Base: `133038881d30e7d9c663491228f7d0a9f88392f9` (H6).
Implementation branch: `feature/h7-herdr-pipeline`.

## Implemented boundary

- Public fresh spawn selects the recorded herdr backend and carries the injected
  routing environment through the registered tool and queue. Interactive launch
  still uses H6's nonce, durable request, hello, ack and correlated native start.
- H6's bounded readiness scan never applies events. After readiness, the pipeline
  clears any accepted owner answer, then attaches the sole H7 read-only tail at
  the saved launch byte offset. Pre-request human events stay in the canonical
  transcript but do not complete or contribute usage to the assignment.
- Tail reads use 64 KiB chunks, a persistent UTF-8 decoder, LF framing, a partial
  line carry, filesystem watch and a one-second fallback. Backlog/partial-line
  scanning is capped at 32 MiB. Foreign/missing nonces are excluded before observers;
  an unterminated last JSON record is never treated as an event. The parent does
  not append to a herdr transcript. Descriptors, watches and timers are closed.
- Each attached launch has an independent monitor: five-second identity/PID
  checks, thirty-second pane scans (two-second CLI bound), no socket subscription
  and no watchdog-config dependency. Only proven disappearance generates a gone
  fact. Unknown identity preserves evidence, not a fabricated successful close.
- Shared finalization waits up to ten seconds for proven exit, then uses H6's
  re-proven TERM/KILL fallback. Unconfirmed exit fails with the workspace retained
  and never runs the hook or integration. A requested termination keeps its status.
- Ordinary ordering: child gone -> existing hook -> existing merge -> exact empty
  pane proof/close if removing the directory -> shared worktree release -> shared
  settlement. Pane proof failure retains the directory and worktree fields. Manual
  merge refuses absent exit proof; manual clean uses the same awaited release guard.
  Successful ordinary runs without a removable worktree keep pane and scrollback.
- Effort ordering: child gone -> hook/clean branch -> existing EffortDriver ->
  integrating -> verified candidate/CAS -> shared settleRun. Branch, worktree and
  pane remain. M5 ownership, process-group teardown, suspension/terminal-I/O
  barriers and at-most-once dispatch protocol are unchanged. A6 blocked asks wait
  for child exit and bypass hooks, merge, final.md and retry.

## Verification observed

All native verification shells explicitly selected the retained harness:

```
CONDUCTOR_NATIVE_PI_ROOT=/home/samfp/scratch/conductor-native-pi-0871-H2ZDlZ/node_modules/@earendil-works/pi-coding-agent
```

- Baseline `npm test`: **2565 passed, 12 skipped**.
- Implementation `npm test`: **2592 passed, 12 skipped**, no failures.
  Log: `/tmp/conductor-h7-full.FCDENM/full.log`.
- H7 slice checks plus the seven specified M5 native/parallel/generated/policy/
  recovery/teardown/reload gates: **193 passed, zero skipped**.
  Log: `/tmp/conductor-h7-native-gate.3uERVG/gate.log`.
- After the complexity-only cleanup, H2/H6/H7 focused files: **102 passed, zero
  skipped**. `npm run typecheck`, `npm run build`, `git diff --check` passed.
  Log: `/tmp/conductor-h7-check.ibq10L/focused.log`.

Focused test command prefix (full npm test also clears inherited herdr context):

```
env -u CONDUCTOR_SUBAGENT -u HERDR_ENV -u HERDR_SOCKET_PATH \
  -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
  -u HERDR_SESSION -u HERDR_BIN_PATH \
  node --test --test-timeout=60000 --import tsx <test-files>
```

Tests use sandboxPi/tmpDir/private memory and explicit fake socket paths. Fixture
Git subprocesses use gitTestEnv. The public smoke owns and awaits its actual child
handle before removing artifacts; the short-lived fake CLI is never run.proc/pid.
The effort witness makes ordinary hooked Git commits and holds candidate verify,
asserting no completion/final/ref advance before release and verified CAS.

Native evidence: `tests/herdr-native.test.ts` aliases Pi and companions explicitly
and asserts **0.87.1**. Offline native initial input, bridge projection, native
agent_settled and A6 ask events flow through the actual H6/H7 runtime and pipeline.
Its CLI and exit observations are injected; `ctx.shutdown()` is not claimed to
prove an actual TUI exit. Actual child exit and split UTF-8 writes are separately
covered by the fake executable/owned child smoke.

## Mutation witness

In `releaseWorktree`, temporarily replaced the herdr pane-release condition with
`false`, then ran the `replaced=true` test in `herdr-worktree-smoke.test.ts`.
It exited 1 at **"unsafe directory delete without exact empty-pane proof"**.
Restored the snapshot copy and verified identical SHA-256; all four worktree
checks then passed, including the positive owned-empty-pane control.
Log: `/tmp/conductor-h7-mutation.r9iHj5/red.log`.

Complexity-only cleanup removed the duplicate manual-clean removal path and its
unused import, redundant resolved-runtime availability checks, and unused native
fault-fixture setup. Added only the tail/monitor and narrow shared-pipeline guards;
no alternate finalizer, lifecycle framework, registry or dependency.

## Deliberate limits

This is a feature implementation, **not rollout or real-herdr/TUI acceptance**.
No live herdr session, paid model, global Pi update, package-cache edit, merge or
push was used. Global Pi **0.99.1 is not native parity-certified** by this work.

Live send, saved-session resume/owner reply and pause remain unavailable on herdr;
H8 adds delivery. H9 owns full quit/GC/watchdog-dialog integration. Before H10,
reload/crash recovery preserves tagged records and refuses subprocess adoption or
unproven cleanup; it does not attach or transfer stream ownership. H11 retains
real isolated herdr and human foreground/overlay acceptance. No N/S or M6 features
are included. Existing shared M5 integration behavior is retained, not replaced.

## critic-hgv8 correction: uncertain exit is diagnostic-only

The critic's owned-child probe found that failed exit proof correctly refused
hooks/merge but still published the assistant result through ordinary writeFinal.
This correction removes that publication, not the existing failure bookkeeping.

- Persist `herdrExitUnconfirmed` on this outcome (also before a requested herdr
  timeout/kill dispatch while exit is unproven). Positive exit proof clears it.
- writeFinal leaves any prior invocation's final.md byte-for-byte intact, or
  creates nothing when there was no prior artifact. No placeholder is substituted.
- Completion text is diagnostic-only. Result references are neither advertised
  nor accepted, including from a restored/on-disk record with a historical final.
  Messages, canonical transcript, diagnostics and worktree/branch remain intact.
- Proven exit retains normal publication, including after requested termination.
  No hook/merge guards, subprocess behavior, H8 delivery or H9 cleanup changed.

`tests/herdr-exit-publication-smoke.test.ts` reuses the existing executable fake
CLI and test-owned child. The child emits the native event protocol, remains
alive, and the terminal binding changes. Natural failure, prior-artifact
preservation, timeout and kill all return in about 10.4 seconds with one callback,
no new assistant final/reference, no hook/base merge, and preserved workspace.
A same-protocol proven-exit control publishes and merges normally. These are
scripted process fixtures, not a claim of native TUI exit. The separate actual
Pi 0.87.1 native pipeline/A6 witnesses were rerun with the retained harness.

Observed correction verification:

- Baseline: 2592 passed / 12 skipped.
- New regression before correction: four exact unsafe-publication/history
  assertion failures; proven-exit positive control passed.
  `/tmp/h7-correction-red.4ej1hK/red.log`
- Corrected regression: five passed.
  `/tmp/h7-correction-green.c8klTf/green.log`
- Restoring unconditional writeFinal failed at
  **"SAFETY: assistant final published without proven child exit"**.
  Snapshot restored with identical SHA-256; negative and positive controls passed.
  `/tmp/h7-correction-mutation.7TlZhZ/mutation.log`
- Focused publication/notification/native checks: 79 passed, zero skipped.
  `/tmp/h7-correction-check.CSYTQ4/check.log`
- H7 + M5 + exhaustive record-roundtrip gates: 205 passed, zero skipped.
  `/tmp/h7-correction-gate.Gkdqmn/gate.log`
- Final full suite: **2597 passed / 12 skipped**; typecheck, build and diff check
  passed. `/tmp/h7-correction-final.FLg59j/full.log`

The exhaustive record-roundtrip fixture now sets the new field; none of its
assertions was weakened. Complexity-only check: one persisted outcome flag and
one shared completion-text helper replace unsafe publication at existing
surfaces; no new lifecycle or finalization framework. Critic evidence under
`/tmp/h7-critic.pzJww8/` was read only and retained.
