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
