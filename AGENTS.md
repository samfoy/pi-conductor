# Agent Instructions for pi-conductor

You are working in `/home/samfp/scratch/pi-conductor/` — the pi-conductor extension repo.

## Before you write any code

1. Read `PRD.md` for the current design and decision log.
2. Read `CONTRIBUTING.md` for the **mandatory** TDD workflow.
3. Run `npm test` to confirm the current suite is green before you start.

## TDD is non-negotiable

Every behavior change ships with a test. **Tests-first.** No exceptions for "small" changes.

- **Red:** write a failing test that pins the behavior you intend.
- **Green:** smallest code change that passes.
- **Refactor:** clean up with tests still green.

The pre-commit hook (`hooks/pre-commit`) runs `npm test` and rejects commits on red. Don't bypass it with `--no-verify`.

If you can't figure out how to test something cleanly, the code probably needs refactoring. Don't ship untested behavior.

## When you finish a piece of work

1. `npm test` is green.
2. `npx tsc --noEmit` is clean.
3. Conventional Commits message.
4. Don't bundle unrelated changes into one commit.

## What this repo is

A pi extension that turns the parent pi session into an orchestrator driving persona-based sub-agents with first-class TUI visibility. See `README.md` for the user-facing summary.

Versioning lives in the PRD's "Implementation phases" section. Current state is v0.2 (background + foreground spawn, queue, panel, conductor mode). v0.3 is the focused stream overlay.

## Project conventions

- `src/` — TypeScript source, strict mode.
- `tests/` — `node:test` + `tsx`. Unit tests run in <5s. Live integration tests gated on `CONDUCTOR_LIVE_TESTS=1`.
- `personas/` — markdown files with YAML-ish frontmatter, one per shipped persona.
- `~/.pi/agent/conductor/personas/` — user-level overrides at runtime (NOT in this repo).
- `<project>/.pi/conductor/personas/` — project-level overrides at runtime (NOT in this repo).

## What NOT to do

- Don't enable phase-aware default models. Persona files do not set `model:` or `thinking:`. (Decision logged in PRD §"Default model per persona".)
- Don't add a `tools:` field to personas. Pi has no tool-restriction mechanism we'd be willing to fake. (Decision logged in PRD §"Tool restriction".)
- Don't add discovery paths beyond `~/.pi/agent/conductor/personas/` and `<project>/.pi/conductor/personas/`. (Decision logged in PRD §"Persona discovery paths".)
- Don't reach into pi-subagents' `shared/fork-context.ts`. We reimplement filter logic ourselves. (Decision logged in PRD §"Filtered context inheritance".)
