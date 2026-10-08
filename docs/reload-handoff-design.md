# Reload handoff for subprocess runs

Status: implemented (2026-10-08) in `src/reload-handoff.ts`, wired in `src/index.ts`. Follows
`717a730`, which stopped the crash. Tests: `tests/reload-handoff.test.ts`.

## Problem

On `/reload`, `handleSessionShutdown` spares running children (`src/shutdown.ts`, the
oracle-3l2e contract: "a future Step 2 may rehydrate them in the new runtime's registry"). pi
awaits `session_shutdown`, invalidates the old runtime, then sends the new instance
`session_start{reason:"reload"}` (`AgentSession.reload`). Before this change, a survivor:

- **lost its card.** The old instance's `pi.sendMessage` threw stale inside `dispatch`'s `try`.
  Observed in crashes.json 2026-10-08T20:44:51Z: `critic-rwzn`'s REJECTED verdict never reached the session.
- **stayed `running`** in the new registry (print mode readopted, unwatched) until GC.
- **was SIGTERMed if it was RPC and its record said so.** The new instance's reconcile
  classified a live `streamingMode: "rpc"` record as a stranded orphan. The spawn-time record omits
  `streamingMode` (see backlog), so this needed a mid-run write, e.g. after an owner answer.
- **could not be killed** from the new instance. `terminate`/`stopProcess` need `run.proc`.

## Design

One process, two module instances, so the handoff is a process-global slot
(`Symbol.for("pi-conductor.reload-survivors.v1")`): session id → run id → `{ terminate? }`.

**Old instance, `session_shutdown{reload}`, before any await:**
- It stops its own survivor watches.
- It publishes every `handOffCandidate`: running or paused, subprocess, no effort, integration
  or merger, not a delegated leaf. herdr runs have the H10 fenced owner handoff and effort runs
  have effort recovery. It also publishes survivors it claimed but has not registered yet.
- It adds those ids to `handedOff`. `pushCompletionNotification` skips them from then on, so
  a card in the window between shutdown and invalidation is not sent twice.
- `terminate` is `() => forceTerminate(run, "killed", registry)` on its own run object, or the
  `reloadTerminate` it was handed for a run it got from an earlier instance.

**New instance, `session_start{reload}`:**
- It claims the session's survivors synchronously, then passes their ids to
  `reconcileOrphansAtStartup`. `classifyRecord` returns `readopt` for them after the ownership
  check, before the liveness and RPC-orphan checks. The old close handler still owns the outcome
  even if the child has just exited.
- After reconcile, each survivor gets `reloadTerminate` and a `watchSurvivor` poll (1 s) on its
  record. When the record is settled (terminal, or blocked: that path has no reload test yet), the poll rebuilds the run from it
  (`buildOrphanRun`). It uses `final.md` only if that file was written during this invocation,
  waiting up to 5 s for it. The rebuilt run updates or registers the entry, and the instance
  posts the card and lifecycle event once.
- If this instance settled the run itself first (`ensemble_kill`), the watch stops silently.
- `SubprocessRuntime.terminate`/`stopProcess` call `reloadTerminate` when there is no `proc`.
  `ensemble_kill`, `/conductor stop` and a later quit, new, resume or fork therefore stop the
  child through its holder.

Nothing crosses module versions except plain ids and a `() => void`. The old instance never
reads the new one's objects.

## Rejected

- **In-process `Run` handoff** (rebind the old close handlers' sinks to the new instance). It
  would keep steering, but every capture site of `onComplete`/`events` would have to move behind a
  mutable sink, and old-dist closures would run against new-dist objects.
- **A durable delivery claim in `record.json`.** The record's writer is the old close handler.
  The in-memory `handedOff` set makes the old instance's silence deterministic, which is all a claim
  would buy here.

## Open

See `docs/backlog.md` "Reload handoff follow-ups": queued runs, retry and chain successors started by
the old instance, steering survivors, the spawn-time `streamingMode` gap, and unsettled records.
