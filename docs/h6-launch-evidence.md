# H6 bounded launch evidence (independent review pending)

Base: `2f6287325ea390c76a2ee8f000892bb4ebf360cd`. Implementation branch:
`feature/h6-herdr-launch`. Public runtime selection still rejects herdr before
spawn/admission effects. No live panes or paid inference were used.

## Contract and boundaries

- `HerdrRuntime` requires an explicitly injected H3 CLI for launch. The synchronous
  handle has `ready`, `cancel`, process-only `stop`, diagnostics and `closed`, never
  a CLI ChildProcess. `runtimeFor` can stop an attached handle without discovering
  an ambient CLI. Subprocess handles alone own `proc`; legacy records stay subprocess.
- `ready` resolves once after matching launch identity, the initial inbox ack, and
  a correlated native `agent_start`. The H6 observer reads complete nonce-stamped
  lines from the launch offset and never calls the pipeline sink or `applyEvent`.
  Its startup transcript budget is 32 MiB. H7 owns the sole streaming tail.
- The bridge labels the start only after the acknowledged input reaches its own
  `before_agent_start`. A human input invalidates correlation. A later extension
  transformation, template expansion or pre-start reload may conservatively lose
  correlation: bounded failure, never a claim that an ack proves execution.
- `closed` means positively observed child disappearance, not CLI exit or failed
  identity proof. Death can precede `ready` (fast settle) or its rejection. On
  startup failure, `ready` rejects after bounded rollback/diagnostic attempts;
  `closed` intentionally stays pending when identity/death is unknown. Cancellation
  returns after these bounded attempts, never waits indefinitely on `closed`.
  Post-ready monitoring/settlement belongs to H7, not this handle's H6 observer.
- Binding publication reuses `writeRecord`'s acknowledged, fenced durable path;
  H5 inbox publication validates it before start. Rejected startup releases a
  registration through `failEffortLaunch`, or restores the existing A6 question.
  Late readiness after cancellation cannot clear that question. No worktree is
  deleted. A reused pane is never rollback-closed; a fresh pane closes only after
  positive child death and a fresh H3 empty-pane proof.
- Budgets: start CLI 65 s around herdr 60 s; hello 15 s; ack 30 s; native start
  30 s. Only `agent_pane_busy` retries once, after 2 s and another empty-pane proof.
  TERM/KILL each require proof; escalation and exit observation each allow 2 s.
  Startup read requests 40 lines, caps output at 4 KiB and allows 2 s; configured
  environment values, credential assignments and authenticated proxy URLs are redacted.
- Herdr argv uses shared `buildPiCoreArgs`, a private 0600 system-prompt file,
  explicit session, model/thinking/skills/tool policy and launch nonce. No task
  positional, print/RPC mode or extension-disabling flag. Native session parsing
  reuses SessionManager; fresh session seeding reuses `seedSessionFile`.

## Native dependency harness

Retained intentionally for H6–H11 minimum-version tests:

`/home/samfp/scratch/conductor-native-pi-0871-H2ZDlZ`

Set:

```sh
export CONDUCTOR_NATIVE_PI_ROOT=/home/samfp/scratch/conductor-native-pi-0871-H2ZDlZ/node_modules/@earendil-works/pi-coding-agent
```

Pi, pi-ai, pi-agent-core and pi-tui are all **0.87.1**. The test-required nested
companion paths are symlinks to the same private prefix's matching packages; no
node_modules tree or credentials were copied. Installation used the retained
0.87.1 Pi tarball and explicit companion versions through mise/npm with the
public registry, `--prefix`, and `--ignore-scripts`.

Global Pi remains **0.99.1**, not native-parity certified by H6. Read-only comparison
confirmed identical trust-manager declarations and project-trust resolution code;
0.99.1's protected-resource helper additionally recognizes `.pi/mcp.json`. H6 uses
that exported helper, not a duplicated resource parser. Native 0.87.1 tests exercise
all 24 resource/decision/default combinations, including saved rejection and
missing default (ask), and assert trust.json bytes do not change. Native get()
briefly locks its store directory; H6 never calls trust setters or approves dialogs.

## Verification

All test commands used the explicit native root above, private TMPDIR/memory,
and npm's HERDR/CONDUCTOR_SUBAGENT isolation. Standalone files used the same env
unset list and `node --test --test-timeout=60000 --import tsx`.

- Corrected baseline `npm test`: **2520 pass / 12 skip**.
- Final full `npm test`: **2565 pass / 12 skip**, zero failures.
- `npm run typecheck`, `npm run build`, `git diff --check`: passed.
- Focused H6 launch/argv/pipeline/unwind/cwd/large-RPC gates passed, alongside the
  new native and real fake-process launch tests. Full suite includes original
  native A6, H4/H5, large RPC and M5 barriers; no existing specific gate was replaced.
- Real fake-herdr + fake-child smoke: a real, reaped child with start/ack/settle
  evidence reaches readiness even when it exits before the CLI result is observed;
  ack without start fails and closes only the proven fresh empty fixture pane.
  The CLI result itself never stamps Run.proc/pid or resolves child.closed.
- Mutation: replacing the initial-ack gate with an accepted fallback made
  `H6 no-ack never reports readiness` fail with **Missing expected rejection**
  (false readiness), not a fixture/import error. Snapshot restoration checked SHA-256.
- One full-suite attempt hit existing `effort-teardown-smoke.test.ts`'s partial
  descendant-JSON read (`Unexpected end of JSON input`). No M5 code/test change:
  its focused rerun passed **10/10**, then the full suite passed as above.
- Read-only `herdr api schema --json` confirmed AgentInfo carries terminal,
  workspace, tab, pane and agent_session metadata. No server/pane control used.

Logs retained at `/tmp/h6-verify.uB6InO/` (baseline, focused, native/mutation and
full-suite evidence). This is builder evidence, not independent acceptance.

## Scope / complexity check

Removed subprocess framing/task assembly from the common argument builder;
reused existing CLI/placement/identity, inbox reader/publication, LF decoder,
session seed/parser, durable record publication and A6 failure handling. No
plugin registry, provider setup, new identity parser, tail owner, monitor, GC,
supervision or delegation framework was added. Shared M5 suspension, settlement
and verifier-group barriers are unchanged. Public activation and current-version
native parity remain separate gates.
