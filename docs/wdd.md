# Witness-Driven Development (WDD)

A discipline that emerged organically in pi-conductor v0.8.2 and v0.9. This
note names the pattern so agents and humans can reference it cheaply. **It is
a discipline, not a tool.** If we ever need a tool, we'll know because the
discipline got annoying.

## The pattern

Every slice that claims TDD coverage of new behavior ships with a **mutation
witness**: a named, pre-declared mutation paired with the named test that
must fail when the mutation is applied.

The protocol — performed by the critic during gating:

1. Land tests + production fix together (normal red→green TDD).
2. `git stash` *only* the production change. Tests stay in the working tree.
3. Run the named killing test against pre-fix source. Confirm it goes red.
4. Run the named pin tests (preservation/regression). Confirm they stay green.
5. `git stash pop` to restore.

If the killing test still passes against mutated source, the test has no
teeth — reject the slice.

## Vocabulary

- **Witness** — the (mutation, killing test, pin tests) triple attached to a
  slice's claim.
- **Killing test** — the test that must go red under the mutation. Borrowed
  from PIT.
- **Pin tests** — preservation tests that must stay green. Prove the mutation
  didn't break unrelated behavior.
- **Witnessed slice** — a slice whose claim has at least one named witness.
- **Bare slice** — a slice without a witness. Allowed only for doc-only or
  purely additive work.

## Witness anti-pattern: parallel-formula tests

A killing test that re-implements the production formula inline, instead of
importing the production code path, **has no teeth**. Mutating the
production source leaves the inline copy untouched, the test stays green,
the witness lies.

The anti-pattern is seductive because the formula is usually one line.
Copying `(run) => run.killOnStall ?? d` into a test feels lighter than
refactoring production to expose a helper. It is the wrong trade: the test
no longer pins the production code, it pins a parallel copy of itself.

**The rule.** The killing test must execute production code. If the formula
isn't yet importable, *extract it* before writing the test. The extraction
is part of the witness work, not separate plumbing.

**Concrete example.** v0.10 watchdog Slice 3 (`9bed244`). The original
brief prescribed a W1 killing test that reconstructed the `isKillOnStall`
lambda inline, mirroring `src/index.ts:391`. The builder mutated
`src/index.ts:391` and the test silently passed — the witness had no teeth.
The fix was to extract the formula as `resolveKillOnStall(run,
defaultKillOnStall)` in `src/watchdog.ts`, have the production lambda
call it, and rewrite the test to import and exercise the helper directly.
Mutating either the helper or the production call site now reds the test.

**Spotting it at brief time.** If the brief says "reconstruct the
production lambda" or "mirrors `src/foo.ts:bar`", that's a smell. Replace
with "imports `<helper>` from `src/foo.ts` and exercises it directly." The
brief should never describe a test that re-derives production logic; it
should describe a test that *calls* production logic.

## Why this exists

WDD is **not** a coverage-discovery tool like PIT / Stryker / mutmut. Those
ask "of all syntactic perturbations, how many does the suite catch?" and
report a kill-rate metric.

WDD asks a different question: **"if I revert this exact slice's diff, do
the tests the agent claims pin it actually fail?"**

The forcing function was structural: sub-agents in the conductor harness
can't run live smoke for some slices (host-only `/reload`, stale `dist/`,
runtime-only paths). Critics needed *some* novel verification beyond
re-running the builder's own tests, and LLM agents will happily produce
convincing-but-toothless tests that pass against any source.

WDD is the cheapest known check that an agent's TDD claim is real.

## Why it's cheap

- **One mutation per claim**, hand-picked to violate the named assertion.
  Not O(branches × mutators).
- **`git stash` + `npm test`** is the entire mechanism. No bytecode
  rewriting, no equivalent-mutant problem, no separate `pitest` task.
- **Inline at gate time.** Seconds, not minutes. Every critic runs it.

## Where the pattern lives in this repo

The persona contract:

- `personas/critic.md` — "Mandatory novel verification" section, **Mutation
  test (gold standard)** bullet. Canonical statement of the protocol.

Examples of witnesses encoded as load-bearing test comments:

- `tests/gc-policy.test.ts:92` — `// Active-run gate (LOAD-BEARING —
  mutation-tested)`. The mutation: drop the active-run gate. The killing
  test: "in-memory run with live proc → keep."
- `tests/shutdown.test.ts:77` — `reason=reload preserves run records (no
  mutation)`. The mutation: flip SIGTERM → SIGKILL or remove the reload
  guard.
- `tests/runs-helpers.test.ts` — comment ecology around
  `applyCloseHandlerTerminal` documenting the guard the mutation flips.

Examples of witnesses pre-declared in design docs (planning primitive):

- `docs/v0.9-gc-design.md` §6 "Mutation (per critic playbook)" — three
  witnesses written *before* the code existed, one per slice. The same
  doc's §7 chain-shape table uses "easy to mutation-test inline" as a
  budgeting heuristic for whether a slice needs a critic gate at all.

## When NOT to use WDD

- **Doc-only slices.** Nothing to mutate.
- **Purely additive features** with no behavioral claim being pinned (a
  new file, a new exported helper not yet wired in). Fall back to other
  novel-check shapes.
- **Subtractive slices / refactors.** No new behavior to witness; rely on
  existing regression pins and other novel checks.
- **When live smoke is available and cheap.** Smoke is stronger evidence;
  use it. WDD shines specifically when smoke is structurally unavailable.

## Relationship to PIT-style mutation testing

Both apply mutations and observe tests. They solve different problems and
should coexist where both are available.

| | PIT-style | WDD |
|---|---|---|
| Mutation source | Bytecode operators, generated | Hand-picked, source-level, == slice diff |
| Scope | Whole package | One slice, one assertion |
| Pass criterion | Kill-rate ≥ threshold | Named test reds, named pins stay green |
| Cadence | Separate task, not every commit | Every critic gate, inline |
| Persistence | HTML report, regenerated | Comments in tests + design docs |
| Purpose | Find gaps in mature suites | Verify an agent's TDD claim is real |
| Used in planning? | No | Yes |

PIT measures suite gaps. WDD verifies slice claims. Different jobs.

## Wait-and-see: when to build tooling

Today the "system" is this doc plus six lines in `personas/critic.md` plus
load-bearing comments in three test files. That is sufficient.

Build tooling only when one of these forcing functions actually fires:

- Critics start cargo-culting weak mutations → addendum to `critic.md` on
  what makes a good witness. Still no code.
- A witness silently rots (mutation no longer reds the test, nobody
  notices) → now we need `pi-witness verify` to detect drift.
- Adoption in a second repo with diverging discipline → now we need a
  shared spec and maybe a shared tool.
- An agent fakes a witness convincingly enough to pass review → now we
  need automated verification.

None have happened. Don't pre-build.
