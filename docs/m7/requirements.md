# M7 reader policy clarification

Decided by the user on 2026-10-07, after the first M7 implementation at `b545d179af1b4001818b8d23752141b5034ed8b1`. These requirements supersede that implementation's subprocess-only readers and ignored configured hooks.

## R1 — Both runtimes

User choice: **“Support herdr readers now (recommended)”**.

Effort readers and chained read-only successors must work on the selected subprocess or herdr backend. Do not silently downgrade a herdr selection or require a subprocess override merely because the member is a reader. Preserve the existing detached view at the captured effort tip, subdirectory mapping, frozen role/prompt/tool policy and effort ownership checks.

## R2 — Validation hooks

User choice: **“Honor validation hooks (recommended)”**.

Run the normal configured or explicit validation hook in the reader's view. Hook failure prevents a successful review or finalizer verdict. A hook does not turn the reader into a writer: readers never enter the integration driver or merge into the base checkout. Check the exact pinned view after the hook; dirty, moved, ignored-file or uncertain output is preserved, not cleaned to manufacture success.

## R3 — Existing safety contracts remain

- A reader or its children must have exited before validation, review evidence or workspace release.
- For herdr, releasing a view requires the existing current-identity, empty-pane and durable-record guards; uncertain ownership or exit keeps the view and diagnostics.
- Blocked owner questions retain their view and correlation. Failed dispatch or stale ownership cannot lose the question.
- A finalizer verdict is tied to the exact reviewed OID, recorded only from a live successful finalizer and clean view, and becomes stale when the effort tip moves.
- Run-stream ownership is not effort ownership. Recovery must not turn a proc-less herdr reader into a lost writer or permit an ungated integration.
- Hooks, git-defender, at-most-once settlement and all existing no-loss rules remain enforced.

## Scope and verification

First obtain a read-only design of the smallest implementation changes. Then implement and test in this M7 worktree; no master edits, merge, push or rollout. Fake-herdr and native faux-provider tests are in scope. Actual new real-herdr reader scenarios need execution-time authorization (planned for M10). Existing minimum/current-version and human-TUI acceptance limits remain explicit.

## R4 — Completion surfaces honor preservation and owner fencing

Decided by the user on 2026-10-07 after the second review accepted `1fab002`. User choices: **"Fix gaps, then merge (recommended)"** and **"Fence it in M7 (recommended)"**.

- **Owner change during a reader's hook or release:** no completion surface posts a card to a stale effort owner. That covers the settlement path, the post-detach completion listener, the queued-spawn listener (`tools.ts`) and any other status listener. On herdr, the stale owner's waiter still ends, so nothing waits forever on a run that is `completed` in memory with no process. Behaviour must match design.md: "every reader card is fenced by the current effort owner."
- **Correct reason:** a reader whose first record write was refused because the effort owner changed reports `effort owner changed`, not `durable record or registry changed`. The hint must not depend on timing.
- **Preserved reader card:** detached and queued foreground spawns may get a `failed` card for a preserved reader, but only for the current owner, only with accurate content, and with no actions. The README must say exactly what is and isn't sent. "It sends no card" is overstated.
- **Coverage:** a committed test pins the `writeRecord` refusal to after the last await: the flag is read when the write runs, not when it is queued. It must go red under that mutation. Another committed test covers the listener card paths above.
