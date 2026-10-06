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

**Current state: v0.18 shipped**, plus unversioned work on top. Do not restate the feature list here — it rotted six versions behind reality once already. Read the PRD's "Implementation phases" section for what each version delivered, the "Post-v0.18 — unversioned" subsection for anything newer, and `docs/backlog.md` for smaller open items. `README.md` has the user-facing summary.

## Project conventions

- `src/` — TypeScript source, strict mode.
- `tests/` — `node:test` + `tsx`. Unit tests run in <5s. Live integration tests gated on `CONDUCTOR_LIVE_TESTS=1`.
- `tests/herdr-live.test.ts` and `tests/supervision-live.test.ts` (S5: two leads and a chief) are the only real-herdr tests. Both are opt-in (`CONDUCTOR_LIVE_TESTS=1` plus explicit `CONDUCTOR_H11_PI_ROOTS`; `CONDUCTOR_H11_ALT_PI_ROOT` for the H11 version-mismatch lead), use the H11 fixture in `tests/helpers/herdr-live.ts`, and start their own private herdr session. Every herdr control, signal and cleanup goes through that fixture, which proves the private socket first. Run one Pi root per invocation. Never point a test at an inherited or ambient herdr session.
- `personas/` — markdown files with YAML-ish frontmatter, one per shipped persona.
- `~/.pi/agent/conductor/personas/` — user-level overrides at runtime (NOT in this repo).
- `<project>/.pi/conductor/personas/` — project-level overrides at runtime (NOT in this repo).
- `tools/` — maintenance scripts (e.g. `rename-pi-namespace.mjs`); not part of the runtime.

## Upstream package namespace

pi-coding-agent and its companions live under `@earendil-works/`, not `@mariozechner/`. The migration happened in commit `5594e5d`; if you see `@mariozechner/pi-*` imports they are stale and need to be rewritten. The namespace packages are not on the workplace npm proxy — install with `--registry https://registry.npmjs.org`.

## What NOT to do

- Don't enable phase-aware default models. Persona files do not set `model:` or `thinking:`. (Decision logged in PRD §"Default model per persona".)
- Don't treat persona `tools` / `exclude_tools` as a sandbox. Pi enforces them via `--tools` / `--exclude-tools`, but `bash` stays available unless excluded. Don't hand-copy the conductor's tool names either: they live in `CONDUCTOR_LLM_TOOLS` (`src/types.ts`), which `registerTools` and `buildPiArgs` both read. Other extensions' spawn tools (`subagent`, `agent`) are always excluded via `FOREIGN_SPAWN_TOOLS` in the same file. Never emit `--no-extensions` for a child: the model provider is an extension. (Decision logged in PRD §"Tool restriction in personas" and the 2026-09-24 decision-log entry.)
- Don't open another child-spawn route. Child delegation is `delegate` only: lead-brokered, opt-in through `agents:`, read-only depth-2 leaves the parent owns (kill-only to the lead, no leaf cards). No builtin persona declares `agents`; nothing is rolled out by default. (See README "Direct ownership (N4)".)
- Don't register or activate the supervision tools (`chief`, `peer`, `staff`; `SUPERVISION_TOOL_NAMES` in `src/types.ts`) in any child. Every child scope excludes them, even another extension's, and delegators keep only `delegate`. A pi with `CONDUCTOR_SUBAGENT=1` is never a lead.
- Don't use `pi.sendUserMessage`, `deliverAs: "steer"` or `nextTurn` for coordination. Supervision cards are custom messages (`deliverAs: "followUp"`), claimed `.sending` first and proven only by the recipient's own session file; they never pass input handlers or commands and grant no authority. Delivery is at most once with visible uncertainty, never exactly once. (README "Supervision acceptance and scope (S5)".)
- Don't add discovery paths beyond `~/.pi/agent/conductor/personas/` and `<project>/.pi/conductor/personas/`. (Decision logged in PRD §"Persona discovery paths".)
- Don't reach into pi-subagents' `shared/fork-context.ts`. We reimplement filter logic ourselves. (Decision logged in PRD §"Filtered context inheritance".)
