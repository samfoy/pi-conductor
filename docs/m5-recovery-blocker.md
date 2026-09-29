# M5 checkpoint: settlement-delivery policy needs a decision

**Blocked; M5 is not implemented or accepted.** Base:
`eee85d5b3ce8cea0941bb9837b5fef66e551865c`. Branch:
`feature/m5-effort-recovery`; private worktree:
`/home/samfp/scratch/pi-conductor/.worktrees/m5-effort-recovery`.
The governing `docs/h1-m5-implementation-plan.md` in the main checkout was read only.

## Exact policy conflict

The brief requires restart-idempotent settlement, no duplicate notifications,
and exact callback counts across crashes, while reusing the original settlement
path. Git can prove that a candidate was integrated. It cannot prove that an
opaque completion callback delivered its external effect before its process died.

The brief also permits truthful paused/uncertain state and says to reuse original
settlement "when safe". What is not explicit is whether **possibly missing
notifications/events after a dispatch-boundary crash** are acceptable. I stopped
rather than silently interpreting that as permission to weaken exact delivery.

At the pinned base:

- `src/run-pipeline.ts:256-259`: `settled` is only an in-memory guard.
- `src/run-pipeline.ts:314-319`: record and final-file writes precede
  `opts.onComplete(run)`; there is no durable callback delivery receipt.
- `src/run-pipeline.ts:331-333`: memory append and lifecycle event emission occur
  afterward, not transactionally with the callback or record.
- `src/index.ts:390-392`: the completion callback calls `pi.sendMessage`.
- `src/conductor-events.ts`: the event adapter exposes `emit(...): void`, with no
  durable consumer acknowledgement.
- `src/memory.ts`: outcomes are best-effort appends without run-id deduplication.

A sender-only delivery marker cannot remove the ambiguity:

| Marker placement | Process dies in the gap | Automatic restart choice |
| --- | --- | --- |
| After callback | Callback may already have delivered | Replay can duplicate |
| Before callback | Callback may not have delivered | Suppression can omit |

A durable dispatch intent can make this uncertainty visible and avoid automatic
replay, but it does not guarantee exactly-once external delivery. An outbox alone
also needs receiver-side idempotency to guarantee that property.

**Recommended decision:** allow at-most-once automatic callback dispatch, with a
durable dispatch-intent/uncertain state and explicit human recovery after an
ambiguous crash. Preserve Git-proven integration and repairable final files;
never reintegrate just to recreate a notification. Scope the "exact callback
counts" tests to unambiguous recovery boundaries. This is narrower than changing
Pi/companion consumers into an acknowledged, idempotent delivery protocol.

If guaranteed external delivery exactly once is required instead, extend the
contract to define receiver idempotency/acknowledgements before implementation.
No delivery policy has been implemented in this checkpoint.

## Native diagnostic witness

`docs/m5-settlement-crash-probe.mts` invokes the **production** effort open,
spawn, integration driver and settlement path in private real Git repositories.
The existing `tests/helpers/native-owner-child.ts` supplies native Pi protocol
with its offline faux provider (model refresh/network disabled). A test callback
models an opaque consumer through a private external receipt file.

Two owned conductor fixture processes are held at the callback boundary and
terminated through their exact `ChildProcess` handles. The writer has exited and
the ordinary hooked candidate has been verified and CAS-integrated before either
barrier. No user process or global run is signalled. The external receipt is
probe-only; production recovery has no such callback acknowledgement.

Observed output from the corrected probe (both cases pass):

```text
phase=before status=completed integration=accepted commits=1 queue=[] delivered=0
phase=after  status=completed integration=accepted commits=1 queue=[] delivered=1
```

Both cases exit via `SIGKILL`. Their record bytes and effort records are unchanged
after the kill, and their integration refs each still contain exactly one commit
with exact effort/run trailers. The main HEAD stays at the original base. The
witness demonstrates the delivery ambiguity; it does **not** implement restart,
claim ownership fencing, or certify M5's full crash matrix.

The first probe attempt exited before the barrier because it passed the native
TypeScript helper directly as `PI_BIN`. That was a fixture setup failure, not a
safety witness. The corrected probe uses the same `tsx/esm/api` bootstrap as
`tests/effort-parallel.test.ts`. Two corrected executions passed; the second
also asserted durable queue contents.

### Reproduction

From this worktree with the existing dependencies available:

```bash
export TMPDIR="$(mktemp -d /tmp/conductor-m5-receipt.XXXXXX)"
export CONDUCTOR_MEMORY_PATH="$TMPDIR/memory.jsonl"
unset CONDUCTOR_LIVE_TESTS
env -u CONDUCTOR_SUBAGENT -u HERDR_ENV -u HERDR_SOCKET_PATH \
  -u HERDR_PANE_ID -u HERDR_TAB_ID -u HERDR_WORKSPACE_ID \
  -u HERDR_SESSION -u HERDR_BIN_PATH \
  node --test --test-timeout=60000 --import tsx docs/m5-settlement-crash-probe.mts
```

It is deliberately outside the default `tests/*.test.ts` glob: this is a
checkpoint diagnostic of today's limitation, not a regression test requiring a
future implementation to preserve missing delivery receipts.

## Verification observed before checkpoint commit

- Isolated `npm test`: **2237 total; 2225 passed; 12 skipped; 0 failed**,
  67.2 seconds. Private TMPDIR/memory; live tests unset.
- Explicit native diagnostic above: **1 passed**, two native crash cases,
  7.76 seconds for the final invocation.
- `npm run typecheck`: passed.
- `npm run build`: passed; no tracked dist changes.
- `git diff --check`: passed before checkpoint documentation was added.
- `git config --get core.hooksPath`: `hooks`; normal commit hooks remain active.
- Over-engineering pass: reused native fixture, `sandboxPi`, `tmpDir`,
  `gitTestEnv`, and production integration rather than adding a recovery
  abstraction or copied settlement implementation. No production code added or
  deleted. No additional abstraction to cut from the diagnostic.

## Unverified / not implemented

All M5 production work, including owner generations, takeover arbitration,
recovery driver, bounded CAS retries, original-hook requeue, resume controls,
candidate cleanup and README/PRD recovery guarantees remains outstanding.
No full M5 crash matrix or mutation witnesses have been claimed. No independent
review, merge, push, publication, config rollout or parallel dogfood occurred.
The next planner should resolve only the delivery policy above, then reassign M5
from the pinned base (or retain this diagnostic checkpoint as evidence).
