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

(The pre-commit hook auto-rebuilds `dist/` when `src/` is staged, so you don't need a separate `npm run build` step — but `npm run dev` running in the background is the recommended iteration loop. See `CONTRIBUTING.md`.)

## What this repo is

A pi extension that turns the parent pi session into an orchestrator driving persona-based sub-agents with first-class TUI visibility. See `README.md` for the user-facing summary.

Versioning lives in the PRD's "Implementation phases" section. **Current state: v0.10 shipped** — all milestones v0.1–v0.10 are live (read-only scaffold, background + foreground spawn with inline-streamed transcript, queue, ensemble panel, conductor mode prompt, focused-stream overlay, ensemble_send / pause / resume, filtered context inheritance, Esc-to-detach, /conductor history, strict-overseer mode with default-off, inherit_skills frontmatter, run-record GC capstone with auto + manual + reconcile-orphans + cold-archive + delete + user-pinning, sub-agent watchdog with soft/hard thresholds + per-spawn kill_on_stall + UX surfaces). Next up (per PRD v0.10+ planned list): worktree-per-persona, on_complete_hook quality gates; smaller items live in `docs/backlog.md`.

## Project conventions

- `src/` — TypeScript source, strict mode.
- `tests/` — `node:test` + `tsx`. Unit tests run in <5s. Live integration tests gated on `CONDUCTOR_LIVE_TESTS=1`.
- `personas/` — markdown files with YAML-ish frontmatter, one per shipped persona.
- `~/.pi/agent/conductor/personas/` — user-level overrides at runtime (NOT in this repo).
- `<project>/.pi/conductor/personas/` — project-level overrides at runtime (NOT in this repo).
- `tools/` — maintenance scripts (e.g. `rename-pi-namespace.mjs`); not part of the runtime.

## Upstream package namespace

pi-coding-agent and its companions live under `@earendil-works/`, not `@mariozechner/`. The migration happened in commit `5594e5d`; if you see `@mariozechner/pi-*` imports they are stale and need to be rewritten. The namespace packages are not on the workplace npm proxy — install with `--registry https://registry.npmjs.org`.

## What NOT to do

- Don't enable phase-aware default models. Persona files do not set `model:` or `thinking:`. (Decision logged in PRD §"Default model per persona".)
- Don't add a `tools:` field to personas. Pi has no tool-restriction mechanism we'd be willing to fake. (Decision logged in PRD §"Tool restriction".)
- Don't add discovery paths beyond `~/.pi/agent/conductor/personas/` and `<project>/.pi/conductor/personas/`. (Decision logged in PRD §"Persona discovery paths".)
- Don't reach into pi-subagents' `shared/fork-context.ts`. We reimplement filter logic ourselves. (Decision logged in PRD §"Filtered context inheritance".)
