# Contributing to pi-conductor

## TDD is the workflow

Every behavior change in this repo lands via tests-first development. The rule is **non-negotiable**:

> **No code change ships without a test that exercises it.** Bug fixes start with a failing test that reproduces the bug. New features start with a failing test that pins the behavior. Refactors keep all existing tests green.

This applies equally to humans, subagents, autoloop runs, and any other automated contributor. There is one exception: pure documentation edits (READMEs, persona prompts, AGENTS.md, this file).

### The TDD loop

1. **Red.** Write the smallest failing test that captures the behavior you intend to change. Run `npm test` and confirm it fails for the reason you expect — not because of a typo or a missing import.
2. **Green.** Make the smallest code change that passes the test. Resist the urge to "while I'm here" anything else.
3. **Refactor.** With tests green, clean up. Tests must still pass after the refactor.
4. **Repeat.** Each commit on a feature branch should map to one or more red-green-refactor cycles.

### What "a test" means here

- A `node:test` test file under `tests/` using `assert` from `node:assert/strict`.
- Behavior-focused, not implementation-focused. The test should still pass if the implementation is rewritten in a different idiomatic style.
- Deterministic: no real `pi` subprocesses, no real network, no clock-dependent assertions, no leaking `process.env` mutations.
- Cleaning up its fixtures in a `finally` block.
- Live integration tests (real `pi` subprocess) live behind the `CONDUCTOR_LIVE_TESTS=1` gate and are not required for every change.

### Coverage targets

We don't enforce a numeric coverage gate. The expected outcome of "every change ships with a test" is that meaningful behavior is exercised. If you find yourself writing a test that's hard to write because the code resists it, **that's a refactoring signal** — file an issue or refactor the code in a separate commit.

### Bugs caught by tests > bugs caught in production

If a bug ships, the regression test for it is part of the fix. The PR description should call out the failing test before the fix.

## Pre-commit hook

The repo ships a pre-commit hook at `hooks/pre-commit` that runs `npm test` and rejects the commit if any test fails. When the staged change touches `src/`, the hook also runs `npm run build` and auto-stages `dist/index.js` + `dist/index.js.map` — `dist/` is a tracked artifact whose only legitimate state is "matches src/", so the rebuild is automatic and contributors don't need to remember it. The hook also runs `scripts/check-no-mutation-markers.sh`, which rejects commits with residual WDD `// MUTATION:` / `// MUTATE:` comment markers staged in `src/*.ts` (defense against a builder killed mid-verification leaving mutated production code behind). Activate the hook once per clone:

```bash
git config core.hooksPath hooks
```

Or run the bundled installer:

```bash
./scripts/install-hooks.sh
```

To skip the hook for a true emergency (almost never appropriate), pass `--no-verify` to `git commit`. Don't make a habit of it.

## Iteration workflow

`pi.extensions` loads the bundled `dist/index.js`, not `src/`, so any `src/` change must be rebuilt before the parent pi session can see it. Two ways to keep the bundle current during development:

- **`npm run dev`** — esbuild in watch mode. Run it as a background process; every save in `src/` regenerates `dist/index.js` in ~30ms. Pair with the host's `/reload` slash command in the parent pi session and changes pick up without a full pi restart.
- **The pre-commit hook is the safety net.** If `npm run dev` wasn't running (or crashed), the hook rebuilds + auto-stages `dist/` whenever staged files include `src/`. You don't need to remember `npm run build` before commit.

### What `/reload` preserves

As of `1c72856` (`fix(lifecycle): preserve runs on /reload`), the conductor's `session_shutdown` handler is reload-aware:

- **Preserved across `/reload`:** chat history, conductor brief, scratchpad notes (`note set`/`note get`), the `pi.on("context", …)` sanitizer hook (re-registers cleanly on the new runtime).
- **Not preserved:** in-flight sub-agent registry entries. Surviving sub-agents keep running as separate processes and write their `final.md` / `record.json` to disk, but the new runtime won't fire `<sub-agent-completed>` notifications for runs that started under the old one. Wait for them to finish naturally and read the on-disk record, or check `~/.pi/agent/conductor/runs/<persona>-<id>/`.

### Recommended loop

1. Start `npm run dev` in a background process (e.g. via the `pi-processes` extension or a tmux pane).
2. Edit `src/`. Watch rebuilds `dist/index.js`.
3. `/reload` in the parent pi session to pick up the new bundle.
4. Test interactively or via `npm test`.
5. Commit. The pre-commit hook re-runs the build as a safety net even if `dev` was off, plus the test suite.

## Running the test suite

```bash
npm test                      # unit tests only (default; skips live integration)
CONDUCTOR_LIVE_TESTS=1 npm test  # includes the live integration test (needs AWS creds)
npm run typecheck             # tsc --noEmit
```

Target wall time for the unit suite: **under 5 seconds**. If a single test pushes that over, mark it `{ skip: true }` with a justification or move it into a gated suite.

**Tests that fork real subprocesses must set an explicit timeout** (either `--test-timeout=<ms>` on the runner or `{ timeout: <ms> }` on the test) — tsx defaults to `--test-timeout=0` (no timeout), so a buggy helper that never resolves hangs the runner indefinitely. See `personas/builder.md` “Test discipline.”

## Coding standards

- **TypeScript strict mode.** No `any` unless documented and justified in a comment.
- **No global mutable state.** Per-session state lives on objects passed through `getCwd`/`getRegistry`-style accessors.
- **Conventional Commits** for commit messages (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`).
- **No `--no-verify` in normal commits.** If the test suite fails, fix the test or the code.

## Commit boundaries

- One logical change per commit. A feature commit shouldn't bundle an unrelated test fix.
- A bug fix commit must include the failing-test-first regression test in the same commit.
- A refactor commit should leave tests untouched (otherwise it's not a pure refactor).

## When you find resistance

Some legitimate cases where TDD is awkward:

- **TUI rendering.** Test the model that drives the render, not the rendered output.
- **Subprocess spawning.** Test the argv builders, the JSON parser, the lifecycle state machine — separately from spawning.
- **Time-based logic.** Inject a clock or use a fake timer; never assert on `Date.now()`.

If you can't find a way to test something cleanly within these constraints, write the change anyway, then file an issue ("untested: X — refactor needed for testability") and link it from the commit message.
