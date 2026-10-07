# M7 readers on both runtimes, with validation hooks — implemented flow

Implements `requirements.md` R1, R2 and R3 on top of `b545d17`, and R4 on top of `1fab002`. It follows the read-only design pass
(`~/.pi/agent/conductor/runs/redteam-sol-tzex/final.md`, status READY). README "Readers, owned chains
and retries, finalizer verdicts (M7)" is the user-facing statement; tests are cited there.

## Settlement order (one lifecycle, `createRunPipeline`)

1. Herdr only: positive `waitForExit` (the pane child's exit is proven), then drain and answer acceptance.
2. Owned delegated leaves are settled.
3. Subprocess only: the reader's process has closed.
4. The normal `on_complete_hook` cascade (`effort.gate`: the resolved hook, `null` for none, `undefined`
   for an unknown legacy gate) runs in the mapped view cwd.
5. `settleReaderView` (`src/effort/reader.ts`) runs, and is awaited:
   - Evidence: `effort.reviewed` (and, for a frozen `finalizer`, `EffortRecord.finalizer` for that OID)
     needs every one of: a code-0 natural exit; a passed or known-absent hook; a live invocation (not
     reattached or reconciled); the current effort owner; no forced terminal or shutdown; a clean view
     detached at `spawnBase`.
   - Release: the run's own pane is proven empty and closed through `releaseRunPane`. Then the reader
     guard and the owner and view checks run again before a plain `git worktree remove`.
   - A failed reader guard, before or after the release await, is one of two cases. A replaced invocation
     (`!live()`: resume, reload, readopt, or on herdr a replaced registry entry, which is part of the H10
     pipeline fence) is `retired`: it mutates nothing. A still-live invocation whose registry entry or
     durable record changed is `preserved`: the view stays with `reader view kept (durable record or
     registry changed before|during release)`, or `(effort owner changed)` when the owner is no longer
     current (R4: for example, the owner fence refused this reader's first record write, so the guard found none).
     `run.settlementPreserved` makes every later record and final write a no-op or refusal (read after
     `writeRecord`'s last await), and settlement stops through the existing preserved path. That means
     no record, final, settlement card, chain, retry, finalize event or memory outcome; the other
     writer's bytes stay intact. Its waiter ends with the run `failed` in memory and `settlement
     preserved: …`. A status listener sees that flip: a detached foreground `ensemble_send` answer gets
     one `failed` card with that message and no actions, only for the current owner (step 6). No
     evidence is recorded after the guard fails; evidence recorded before a release-time failure stays.
6. Terminal persistence and dispatch. A herdr reader uses the ordinary nonce ledger
   (`dispatchHerdrSettlement`); a writer keeps the M5 WAL. Every reader card and record write is fenced
   by the current effort owner. Settlement callbacks pass `readerFence`. Every card, whoever posts it
   (settlement, a kill or timeout, the post-detach or queued-spawn listener), passes `pushCompletionCard`,
   which drops a reader card when `readerOwned` fails. Both use `assertRunEffortOwner`. Writer and
   non-effort cards are unchanged. A stale owner's waiter still ends: its herdr pipeline, whose fenced
   record write throws into the preserved catch, resolves with the run as settled in memory (R4).
   Effort spawns, chains and retries are background, so the queued-spawn listener never sees a reader.

## Reader release guard

`readerReleaseGuard` (`src/runs.ts`) sits beside H9's `worktreeCleanupGuard` but does not reuse it. H9
requires a branch, a terminal record and no effort, none of which a detached, preterminal view has.

The guard snapshots the assignment (name, gitRoot, role, spawnBase, cwd), the view path and the herdr
binding before any await. It then requires all three to still match: the live run, its registry entry
and the durable record. It also requires the live invocation (`current() && !replaced()`). The guard is
the `isCurrent` predicate passed through `releaseRunPane` to the herdr empty-pane proof.

## Other behaviour

- **Admission and spawn:** only `touches` (and ownership) refuse a reader. Runtime selection and the hook
  cascade are ordinary.
- **Chains:** a chained successor gets the parent's `runtimeEnv`, so its launch routes the same way its
  runtime was chosen.
- **N3 reservation:** a herdr effort reader holds `processOpen` until its pane child's exit is proven, as
  a herdr leaf does.
- **Answers:** before any effect, the session header cwd must equal the frozen view cwd, and the view must
  be usable.
- **Recovery:** unchanged code paths, now covered by tests. An unattached non-integrating herdr reader is
  skipped. A readopted one waits for `recoverEffort` (same object, `herdrResumeSettlement`), then settles
  once with no review evidence.

## Limits

- No real-herdr reader run: that needs execution-time authorization (M10).
- A reader restored at startup and then answered records no review.
- A crash between the verdict write and the reader's record leaves the verdict next to a reader recovered
  as lost.
- On herdr a replaced registry entry retires the old pipeline through the H10 fence, which, as before,
  does not resolve the old waiter. A preserved settlement's verdict, if recorded before the release,
  stays on the effort record.
- Under a stale owner a subprocess reader still writes its own `final.md`; a herdr one writes none.
  A dead-man-switch re-fire repeats a card first sent under the then-current owner without checking
  the owner again.
- Human TUI acceptance and rollout remain unverified.
