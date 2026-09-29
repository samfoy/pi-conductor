# M5: resolved delivery policy and implementation evidence

**The delivery-policy blocker is resolved. Independent acceptance is pending.**
The initial native diagnostic and policy discussion remain in checkpoint
`98104dc94537e8bc14cde4160855984997830923`. The user selected at-most-once
automatic dispatch; no receiver acknowledgement protocol is added.

Base: `eee85d5b3ce8cea0941bb9837b5fef66e551865c`. Implementation branch:
`feature/m5-effort-recovery`, private worktree
`/home/samfp/scratch/pi-conductor/.worktrees/m5-effort-recovery`.
The governing untracked main-checkout implementation plan was read, never edited
or staged. No master edits, publication, installation/config rollout or live model
calls were performed.

## Protocol implemented

- Effort and repository-driver claims share create-only, fsynced append-only
  generations. Session/PID/start identity and generation fence writes/CAS. A
  live/unknown owner rejects takeover before any foreign repository-driver claim.
  Two native dead-owner claimants have one successor. PID reuse, EPERM, missing
  start evidence and malformed claims fail closed; no stale-time lease or purge.
- Critical run WAL snapshots retain M4's per-run delayed-write ordering and
  acknowledge atomic file/directory persistence. Queue membership is written
  after durable integrating WAL; recovery unions persisted queue order with
  WAL-only members, stably ordered by enqueue time/id. Missing members pause.
- Before CAS, candidates regenerate/commit/verify again through the normal M2/M3
  route. Acceptance checks exact candidate/tree, expected parent, frozen verify
  identity, exact effort/run trailers and reachability. A descendant tip is valid
  inclusion evidence. Stale CAS recomputes, stopping after three failures.
- The original settlement tail is shared, not copied into a second finalizer.
  Result files precede durable dispatch intent. Completion callback, lifecycle
  events and local best-effort memory append share one automatic dispatch attempt.
  Interrupted intent and integrated legacy records without this protocol become
  delivery-uncertain and are not replayed. `attempted` is not a receiver receipt.
- Generic reconcile does not kill or enqueue effort writers. Fenced effort
  adoption precedes answer ownership; blocked asks retain native A6 acceptance
  and capacity rules. Known original hooks survive adopted answers; unknown
  legacy hooks cannot silently authorize integration.
- Interactive human resume/requeue confirms ownership, pause cause, source
  cleanliness/OID and original hook. Unknown hooks require explicit replacement;
  changed heads require explicit OID confirmation. The gate runs in a fresh
  private checkout with preserved shell text and original final-text evidence.
  Baseline and required repository hooks remain mandatory.
- Recovery stops only recorded identity-proven process groups. It removes only
  known unreferenced clean detached ancestor candidates, with no ignored files.
  Dirty/unmerged/unreachable work, changed writer branches and merger states stay.

## Native crash matrix

`tests/effort-recovery-smoke.test.ts` runs **19 cases**. Its subprocess barrier
fixture is `docs/m5-settlement-crash-probe.mts`, reusing the existing native Pi
faux-provider adapter with model refresh/network disabled. Git, ownership claims,
WAL writes, normal candidate commits, verification and CAS are production effects.
Each controlled conductor process is killed through its exact handle with SIGKILL;
recorded old verification groups are stopped through the production identity helper.
Each case reconciles twice and inspects actual refs, records, callbacks and assets.

| Boundary/scenario | Result |
| --- | --- |
| Queued; merging; interrupted record write; interrupted queue write | One integration, one automatic callback |
| During generation; during verification | Owned old group cannot execute; generation/verify rerun; one integration/callback |
| Verified WAL before CAS | Rebuild/reverify, then one integration/callback |
| CAS before settlement; completed record before dispatch intent | Recognize/retain integration; dispatch once without another commit |
| Intent before callback; callback before attempted marker | Completed Git proof plus delivery-uncertain; zero automatic replay |
| Attempted marker durable | No callback replay or repeated memory append |
| Legacy completed record without dispatch protocol | Delivery-uncertain; no legacy callback/outcome replay |
| Queue/WAL order mismatch | Durable queue member precedes WAL-only member; two source branches integrate once each |
| Source head changed | Paused; original WAL OID and changed branch both retained, no CAS/callback |
| Old candidate dirty | Dirty evidence retained; fresh verified candidate integrates once |
| Integration ref checked out | Pause without update; human resume after checkout removal reverifies |
| Command-start WAL without PID identity | Preserve/pause, no inferred teardown or integration |
| Unsupported merger `resolving` state | Preserve/pause; no merger recovery |

Queue-order, legacy and unsupported-merger variants deliberately adjust saved
fixture metadata to model cross-store/version boundaries. The queue-order second
writer is a constructed durable record backed by its own real Git source branch,
not a second paid/native model invocation. Normal two-native-writer admission and
integration remain covered by `tests/effort-parallel.test.ts`.

Local outcome assertions use a separate per-case memory path: normal dispatch
appends once (two for the two-member case); uncertain interrupted bundles append
zero in the tested window; already-attempted/legacy outcomes are not appended again.
The protocol permits missing/partial best-effort outcomes and missed external
notifications/events; it makes no transactional delivery claim.

## Verification actually observed

All invocations used private TMPDIR/memory, live tests unset, and fixture Git env.

- Full `npm test`: **2265 total, 2253 passed, 12 skipped, zero failures**;
  76.98 seconds. Baseline was 2225 passed/12 skipped.
- Governing focused list plus native crash suite: **128 passed**, zero failures;
  71.37 seconds, command below.
- A6/admission regression command (`effort-owner-smoke`,
  `ask-owner-corrections-smoke`, `effort-parallel`): **18 passed**.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- Normal repository pre-commit remains enabled (`core.hooksPath=hooks`); commit
  verification is reported in the builder return, not bypassed.

```bash
env -u CONDUCTOR_SUBAGENT -u HERDR_ENV -u HERDR_SOCKET_PATH \
  -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
  -u HERDR_SESSION -u HERDR_BIN_PATH \
  node --test --test-timeout=90000 --import tsx \
  tests/effort-reconcile.test.ts tests/effort-recovery-commands.test.ts \
  tests/effort-recovery-smoke.test.ts tests/effort-policy-hooks.test.ts \
  tests/reconcile-startup-classifier.test.ts tests/reconcile-readopt.test.ts \
  tests/session-start-gc.test.ts tests/gc-policy.test.ts \
  tests/gc-executor.test.ts tests/shutdown.test.ts
```

One intermediate full run hit an unreadable procfs task during teardown. A
focused red witness reproduced empty stat bytes followed by disappearance. The
helper now ignores malformed bytes only if a second read proves ENOENT/ESRCH;
persistently malformed/permission-ambiguous identity still fails closed. The
focused group suite passed 17 tests afterward; the final full suite above passed.

## Mutation witnesses (final-source rerun)

Each mutation ran the named test using
`node --test --test-timeout=60000 --test-name-pattern=<pattern> --import tsx tests/effort-reconcile.test.ts`.
Each exited **1 at the specific safety assertion**, not fixture setup. Source was
restored from byte snapshots in `finally` and SHA-256 checked after every case.

| Mutation | Exact failing assertion |
| --- | --- |
| Remove `expected` from the `effortGit(..., "update-ref", ref, candidate, expected)` call | `stale CAS must recompute expectedTip instead of overwriting the moved ref` |
| Accept ancestry exit 1 as reachable | `unreachable candidate cannot certify completion` |
| Remove `sameOwner(current, owner)` from claim fencing | `old-generation record write must be fenced` |

Restored final-source hashes:

```text
src/effort/git.ts   89f65f7dae2545170a35354a5d474e77cd5bdbe65db2b8a6f5e6601c615977f2
src/effort/store.ts 4a9b7b72be525f500dd140c8680667cb631f71577af0dfb45a242d86b47f8c58
```

## Scope and review limits

No receiver acknowledgements, callback replay automation, merger recovery,
readers, waves, landing, destructive TTL/abandon, live herdr or paid dogfood.
Unknown original gate/process/ownership evidence needs human investigation, not
an inferred pass. Source branches are never deleted. Unsupported/non-Linux
ownership fingerprints and live unresolved driver claims can require stopping
the old owner before recovery is possible. Commands are trusted local shell
commands, not a sandbox; escaped process groups/external side effects remain
outside the supervised workspace guarantee.

Complexity pass reused the M2 group helper, ordinary hook runner and shared
settlement tail. Removed the parallel settlement possibility, duplicate in-memory
flight tracking and unnecessary rename of a temporary claim; no dependency,
provider wrapper, background daemon or extra finalizer was introduced. This is
implementation evidence, not independent approval or permission to roll out.

## critic-sjpp correction: surviving settlement across reload

The critic's same-session/PID overlap reproduced on `daa4d6b`: one Git
integration, but callbacks `["recovered", "original"]` and two memory outcomes.
The no-reload control had one of each. Critic evidence under
`/tmp/m5-critic.ZPa9r3/` was read/reused without edits or deletion.

The correction tracks only the post-integration settlement Promise on the Run,
before terminal effects start. The shared entry point covers live pipelines,
recovery and human requeue without duplicating their finalizer. Shutdown awaits
that tail through final-file persistence and dispatch-state handling, including
quiescence after rejected persistence. It does not await a running child's done
Promise or change ordinary active-subprocess reload behavior. Fresh recovery then
reads the authoritative durable delivery state; the old Run cannot dispatch later.
No new durable claim, generation rule, receiver acknowledgement or replay policy.

`tests/effort-reload-settlement-smoke.test.ts` ports the native faux-provider/real
Git reproduction with externally released I/O barriers (no circular wait inside
mkdir). Six cases cover no reload, held final write, shutdown after intent fsync
before callback with held attempted-record write, failed final write, throwing
callback, and failed attempted-record write. All assert one integration, one
callback/outcome across separate registry/Run objects with unchanged owner PID,
session and generation. Reload stays pending while I/O is held. Failure before
intent lets recovery dispatch once; failure after intent preserves uncertainty.

Observed focused command: new smoke file + `shutdown.test.ts` +
`runtime-reload.test.ts` -> **20 passed**. The native live-child reload control
still passes. Typecheck passes. Full-suite/final gates are recorded below.

Mutation: replace `if (settlements.length) await Promise.allSettled(settlements)`
with fire-and-forget `void` in `src/shutdown.ts`. Running the new smoke test with
`--test-name-pattern='reload-final:'` exits 1 at the intended callback assertion,
**`2 !== 1`**, with two memory outcomes and one Git integration. Restoring the
source byte snapshot returns the same test to green (one callback/outcome/commit).
No fixture/setup failure or weaker timing assertion is used as the witness.

Complexity pass: one runtime-only Promise, one shared settlement wrapper, and one
conditional shutdown wait. Existing settlement effects and durable intent ordering
are unchanged; no second finalizer, store, dependency or broad recovery redesign.

Final correction gates observed:

- `node --test --test-timeout=90000 --import tsx tests/effort-reload-settlement-smoke.test.ts tests/effort-recovery-smoke.test.ts tests/runtime-reload.test.ts tests/shutdown.test.ts`
  (same scrubbed environment as above): **39 passed**, including the prior 19
  SIGKILL crash cases and the live-child reload control.
- `npm test`: **2271 total, 2259 passed, 12 skipped, zero failures**, 77.96 seconds.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- One earlier full run encountered `Unexpected end of JSON input` in unchanged
  `effort-teardown-smoke.test.ts:56`, whose readiness check reads a PID file between
  creation and completion of its write. The unchanged file passed all 10 cases
  on rerun, followed by the successful full suite above. No adjacent fixture or
  process-group code was changed for this correction.

Waiting is intentional, not a timeout that abandons live settlement I/O. Rejected
I/O releases the wait; an operation that never returns still requires its I/O to
finish. Active child lifetimes are excluded. Opaque callback/receiver semantics
and the approved potentially-missed-delivery policy remain unchanged.

## critic-sjpp followup: concurrent suspension-to-settlement transition

The re-review found a narrower gap in `6abe33b`: at the accepted run-WAL write,
the first shutdown cleared `integrationControl` and waited for the driver, while
a second shutdown saw neither control nor settlement and returned. The retained
native repro in `/tmp/m5-rereview.hEOiu4/repo/tests/critic-transition-overlap.mts`
was read and ported; critic evidence was not modified or deleted.

New native cases in `effort-reload-settlement-smoke.test.ts` reproduce the actual
accepted-WAL boundary, with single-call, concurrent-call and synchronous reentrant
control-clearing variants. Before the fix, the single-call control passed and both
overlap variants failed at **2 callbacks != 1**, with two memory outcomes, one Git
integration, and returned-while-held `[false, true]`. No owner death, synthesized
ownership or replacement WAL is used in these three cases.

The driver now publishes one runtime-only `integrationSuspension` Promise before
setting its suspension flag or clearing the control. Suspension still fences the
job synchronously; process teardown and the existing driver flight drain through
that shared Promise. Every shutdown caller discovers and awaits it, then awaits
the existing pre-effect-registered settlement tail. The driver never awaits its
own suspension or the settlement Promise, so there is no circular self-await.
Success clears the transition after draining. Rejection remains visible and causes
concurrent and later shutdowns to reject rather than infer quiescence.

All three native variants now pass: concurrent/reentrant returned-while-held is
`[false, false]`, followed by one callback, one outcome and one integration across
two registry/Run objects and two recovery passes. Successful transition and
settlement Promises clear. An additional real-verifier test injects permission
ambiguity only for its recorded owned process group: concurrent and subsequent
shutdowns all reject; cleanup restores the signal function, stops the exact group
through the production identity helper, and awaits the driver before fixture cleanup.

Targeted mutation: hide `run.integrationSuspension` from the shutdown lookup,
leaving only `run.integrationControl?.suspend()`. The native concurrent case again
fails at the callback assertion **`2 !== 1`**, not fixture setup, with two outcomes
and one integration. A byte snapshot plus SHA-256 check restores the source; the
same command then passes with one of each:

```bash
node --test --test-timeout=60000 --test-name-pattern='transition-concurrent:' \
  --import tsx tests/effort-reload-settlement-smoke.test.ts
```

The earlier six settlement cases and pre-effect settlement registration remain.
No receiver protocol, durable schema/generation change, filesystem cancellation,
active-child lifetime wait or general shutdown coordinator was added. Complexity
is limited to one runtime Promise on the existing Run and the existing driver's
suspend path; no new helper module or duplicated finalizer.

Followup verification observed:

- Baseline `npm test`: **2259 passed, 12 skipped**.
- Focused command (scrubbed child/herdr environment, private TMPDIR/memory):
  `node --test --test-timeout=90000 --import tsx tests/effort-reload-settlement-smoke.test.ts tests/effort-recovery-smoke.test.ts tests/runtime-reload.test.ts tests/shutdown.test.ts`
  -> **43 passed**, including the prior six settlement cases, all 19 SIGKILL cases,
  the live-child reload control and four new transition/error cases.
- Full `npm test`: **2275 total, 2263 passed, 12 skipped, zero failures**,
  81.09 seconds.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- The hidden-transition mutation failed exactly at **2 != 1**; restored
  `src/shutdown.ts` SHA-256:
  `390672feb494d3e2877f337e672e5c422e4e1cdf74f4958a59e2109018e6aa79`.

Rejected suspension is intentionally sticky on that runtime Run: later shutdown
calls must report the unresolved transition, not silently authorize fresh recovery.
It is not persisted or treated as a receiver acknowledgement. This followup is
awaiting focused independent re-review; no merge or rollout is authorized here.

The first followup commit-hook run hit the same unchanged teardown fixture's
partial PID-JSON readiness read (`effort-teardown-smoke.test.ts:56`, before its
shutdown call). No source or fixture change was made for that out-of-scope race;
the unchanged file passed all 10 tests on rerun. The correction is committed only
with the normal full pre-commit gate passing, never with a bypass.
