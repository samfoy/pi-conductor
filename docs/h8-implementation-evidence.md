# H8: live controls and saved-session owner replies

Base: `84a947d57bc73cbccbd5fa9241207eb189346c29` (accepted H7).
Branch: `feature/h8-herdr-send`; isolated worktree `.worktrees/h8-herdr-send`.
The two untracked implementation plans in the main checkout were read only.

## Implemented boundary

- The recorded concrete runtime routes delivery. Herdr capabilities come from the
  attached launch, current nonce/process proof and readiness, not streamingMode.
  Pause/SIGCONT remain subprocess-only. Subprocess RPC opt-in, automatic large-RPC
  transport, protocol acknowledgements and grace behavior are unchanged.
- Live controls reuse H5's inbox, with per-invocation sequence/request identities
  and a serialized delivery tail. Before publishing, a bounded pane query reproves
  the child, the canonical tail drains, and shared send policy rechecks ownership,
  retirement and owner-question execution/pending state. An A3 snapshot is advisory.
- The synchronous started/rejected API retains an acknowledgement promise. Herdr
  input acceptance, definite rejection and unconfirmed delivery are distinct in
  tool/slash/overlay text. Ack does not prove execution. No timeout/transport failure
  resends a request. Current nonce and exact ack sequence are mandatory.
- Saved-session send reuses the existing worktree restoration, model qualification,
  A5 evidence preparation, invocation accounting and hook resolution. The runtime
  creates a fresh nonce and byte-safe system-prompt file. It reuses only a proven
  empty prior pane; a manually busy prior pane is retained beside a new subtree tab.
  Unknown previous child exit refuses relaunch before workspace/lifecycle effects.
- The child alone adds the existing owner-answer wrapper. Original pending ask,
  task, session and cwd survive launch/ack/start rejection and preacceptance
  cancellation. Only initial ack plus correlated native start accepts an answer;
  user kill wins, and later model failure does not falsely restore an accepted ask.
  M4/M5 same-owner, capacity, integration and settlement mechanisms are reused.
- `herdrResultUnavailable` suppresses historical final publication/references after
  failed launch or an accepted invocation with no usable new output, independently
  of H7's unknown-exit suppression. It roundtrips in records; finalization checks
  only this invocation's messages for usable output. No second finalizer or delivery framework.

## Tests and observed verification

Every verification shell uses the approved installation explicitly:

```
CONDUCTOR_NATIVE_PI_ROOT=/home/samfp/scratch/conductor-native-pi-0871-H2ZDlZ/node_modules/@earendil-works/pi-coding-agent
```

Focused commands use this prefix:

```
env -u CONDUCTOR_SUBAGENT -u HERDR_ENV -u HERDR_SOCKET_PATH \
  -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
  -u HERDR_SESSION -u HERDR_BIN_PATH \
  node --test --test-timeout=60000 --import tsx <test-files>
```

- Baseline `npm test`: **2597 passed / 12 skipped**.
  `/tmp/conductor-h8-baseline.c1HVrd/baseline.log`.
- Test-first live actions, inbox delivery/grace and relaunch: seven initial failures.
  A separate regression exposed historical final advertisement after failed relaunch;
  a turn-limit regression exposed abandoning a settling owner question. Both went
  red before their guards were added.
- H8, A3, A6 native/corrections, A5 transport and turn-limit checks: **99 passed**.
  Subsequent coverage adds registered tool outcomes and native retirement.
- H8/A3 plus all seven required native/parallel/generated/policy/recovery/teardown/
  reload-settlement effort files: **161 passed / zero skipped**; typecheck passed.
  `/tmp/conductor-h8-gate.ril4Sg/gate.log`.
- `herdr-send-smoke.test.ts` runs the executable fake CLI and nine actual private
  Pi SDK 0.87.1 child processes with a faux-only provider: live steer/follow-up/grace,
  settle/relaunch, native ask, intercepted-input rollback, one-wrapper reply,
  accepted-then-model-failure, and native saved-session retirement. It checks exact
  nonce/session continuity, system-prompt bytes, invocation counts, old busy pane
  retention and input acknowledgement without claiming real TUI execution.
- Unit fixtures cover stale acknowledgement, queued overlapping sends, owner ask
  drain races, busy/stale/no-ack/no-start/preaccept-death, cancellation/user kill,
  unconfirmed previous exit and missing fresh final. The effort smoke rejects a
  foreign owner and exhausted execution capacity without mutation, then admits the
  same owner and reaches existing verified integration/dispatch exactly once.

All native package URLs are emitted by the smoke. Test HOME/TMPDIR/agent/model/
credential paths are private, fake socket/bin are explicit, and fixture Git uses
`gitTestEnv`. Real children are retained as exact handles with exit-listener and
signalCode checks, then killed if necessary and awaited before artifact cleanup.
No ambient herdr server, provider credentials, live panes, package-cache changes,
shared native harness edits or node_modules copies were used.

## Mutation witness

Removed only the correlated native-agent-start wait in `src/herdr/runtime.ts`.
The executable fake-CLI/native test failed at the intended assertion:

> native input ack without correlated agent_start cannot make reply ready
> 'ready' !== 'pending'

`/tmp/conductor-h8-witness.H690bb/red.log`; test exit 1, not cancellation or fixture
failure. The runtime was restored from a snapshot copy and SHA-256 verification
reported `src/herdr/runtime.ts: OK`. Positive native controls run before that
assertion; the unmutated native test and full suite are rerun after restoration.

## Limits

No real-herdr or human foreground/overlay/TUI acceptance, merge, push or live
rollout. Global Pi **0.99.1 remains unchanged and is not parity-certified**.
H9 full quit/GC/dialog integration, H10 reload/adoption and H11 real/human
acceptance remain deferred. Unattached saved herdr records fail closed until H10;
unknown identity preserves evidence/resources rather than authorizing reuse.
No N/S/M6 expansion or changes to M5 suspension/settlement/claim ownership.

## Final verification and complexity pass

- A final-result regression also went red for an **accepted** relaunch whose child
  exits before producing new output. The same result-unavailable flag now covers
  both launch failure and empty current-invocation output, without adding another
  persisted flag. Historical final bytes remain intact and unavailable as run refs.
- After that correction, H8 native/send, H7 exit-publication and exhaustive record
  roundtrip checks passed: **39 tests**, no skips; typecheck passed.
- Final `npm test`: **2628 passed / 12 skipped / zero failures** (2640 tests).
  `/tmp/conductor-h8-verified.mRS8xx/full.log`. This includes the restored positive
  native witness and all existing A3/A5/A6/M5 regression files.
- `npm run typecheck`, `npm run build` and `git diff --check` passed.
- Complexity-only pass removed a duplicate tail drain and duplicate ack-read/
  conversion branch. Added delivery uses the existing inbox, identity proof, tail,
  runtime seam, action predicate and settlement pipeline. No new transport library,
  dependency, provider adapter or lifecycle framework. Remaining checks protect
  current identity, input acceptance or historical-result safety.

