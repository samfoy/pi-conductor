# H4 child bridge evidence

## Scope and private contract

Base: `6ad11dbf23f705bd110d1e890635484476145f98`. Branch: `feature/h4-child-bridge`.
Implementation worktree: `/home/samfp/scratch/pi-conductor/.worktrees/h4-child-bridge`.

Only the child bridge is implemented. `src/index.ts` registers the string flag before any handlers and installs the bridge in child scope. H2's public herdr-unavailable gate, A2 retirement, A6 registration, parent pipeline and integration code are unchanged.

The bridge requires child/herdr selection, the launch flag, canonical run/session paths and a matching **parent-persisted `record.json` H3 `herdr` binding**. It cross-checks the record ID/runtime, run/nonce/session identity, socket/pane/tab/workspace environment and any recorded child PID/start identity. The terminal ID is taken from that binding, not guessed from environment. H6 must supply this binding before child startup; this slice does not implement that parent write or independently query herdr.

`launch/<nonce>.json` is exclusive-create hello evidence: H3 `LaunchHello` plus terminal ID. Reload requires exact process/start/run/nonce/session/pane/protocol/version identity. Claims stay on disk; their descriptors do not. No claim is overwritten or removed on disposal.

The narrow `acceptInitial(nonce)` method writes exclusive-create `<nonce>.accepted.json` containing the same hello identity. Accepted settlement flushes the transcript, writes `<nonce>.closing.json`, then requests `ctx.shutdown()`. Both immutable state markers are validated on reload. Closing reloads emit no replay and do not request shutdown again. H5 must call acceptance after its real input acceptance; no inbox, timer, input marker or automatic acceptance is implemented here.

The sole transcript fd uses O_APPEND and a synchronous complete-buffer loop. Every line has `_c.n`. Final messages retain their native object until the next event boundary. Turn records retain only type/index; duplicated turn message/results and BoundaryState are unnecessary for current `applyEvent`. Tool-end bodies and partial updates are omitted, except successful A6 `{askId, question, evidence}` details. Evidence supports the existing maximum four-times-1MiB A5 cap; the serialized details envelope is capped at 8MiB. Invalid/oversized successful details make the bridge inert with a diagnostic, never a truncated accepted question. Native `session_compact` maps once to the existing compaction telemetry shape without copying context.

## Tests-first and verification

- Baseline `npm test`: **2404 pass / 12 skip / 0 fail**, 2416 total.
- Initial red: entry point first call was `on:context`, not `registerFlag:conductor-launch`.
- Projection red: production `applyEvent` had no correlated pending ask. Additional red checks caught missing acceptance, missing switch/fork flush, conflicting recorded process acceptance, and a too-small record read cap rejecting valid A5 tasks.
- Focused command (prefixed with the repository's `env -u CONDUCTOR_SUBAGENT -u HERDR_*` isolation list):
  `node --test --test-timeout=60000 --import tsx tests/child-bridge.test.ts tests/child-bridge-native.test.ts tests/context-retirement-pipeline.test.ts tests/tool-policy.test.ts`
  yielded **94 pass / 0 fail / 0 skip**. The broader A2/cwd/startup/watchdog wiring gate also passed (126 tests before the final large-record/evidence test was added).
- Final pre-commit manual gate: `npm test` → **2446 pass / 12 skip / 0 fail**, 2458 total; `npm run typecheck`, `npm run build`, `git diff --check` → clean.
- Existing fake ExtensionAPI objects gained only no-op flag methods; no existing assertion was removed or relaxed.
- FD witness: 20 reloads, including starts without prior shutdown, at most one append descriptor and zero owned descriptors after repeated disposal. Partial-write witness forces 17-byte writes through 100 Unicode message bursts, including U+2028/U+2029.

## Native version gate

Repository resolution remains **0.84.3**:
`file:///home/samfp/scratch/pi-conductor/node_modules/@earendil-works/pi-coding-agent/dist/index.js`.

The private esbuild harness explicitly aliases to these **0.87.1** modules and verifies their package versions and the bridge's hello version:

- `file:///home/samfp/.local/share/mise/installs/node/24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js`
- `file:///home/samfp/.local/share/mise/installs/node/24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/index.js`
- `file:///home/samfp/.local/share/mise/installs/node/24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/index.js`
- `file:///home/samfp/.local/share/mise/installs/node/24.16.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/index.js`

Default discovery is relative to the Node executable's global package directory; `CONDUCTOR_NATIVE_PI_ROOT` can identify another existing installation. A missing/wrong version fails, never skips. The generated harness lives under `tmpDir()`, not node_modules. Native code runs inside the isolated node:test file process with private HOME/agent directory/TMPDIR/memory, offline faux provider, disabled model-network refresh and cache warming. No Pi/herdr child, credentialed model call, pane, symlink or dependency copy is created. The esbuild service is stopped after the test.

Observed native outcomes: sole ask **20 records**, batch rejection **26**, retired-session rejection **23**; each accepted invocation made **one shutdown request**. Native Pi performed later-extension message replacement, tool execution and A6 validation, compaction, session reload and lifecycle dispatch. The SDK shutdown callback observes an exit **request**, not process death or full interactive terminal teardown.

## Targeted mutation witness

Changed only transcript `_c.n` from the current hello nonce to `foreign-nonce`, then ran `tests/child-bridge-native.test.ts`. It failed at the intended production-pipeline assertion:

`H4 native production pipeline preserves corrected ask`: actual `undefined`, expected `Corrected?\nA or B 🙂`.

This feeds real projected native records through the current-nonce filter and production `applyEvent`, not a duplicate correlation implementation. Restored by snapshot copy; both source and snapshot SHA-256 were `1bb033cdbc0794d0231053499b0ae7489cfa0950573b0f56c8c5af6574122302`. The subsequent full suite was green, including the native positive controls.

## Complexity check and limitations

The complexity pass removed an arbitrary 64KiB parent-record read cap instead of adding a configurable size-policy layer. Added one bridge module; reused H3 evidence types, Pi VERSION, the existing process-start reader and `applyEvent`. Omitted repeated context/results instead of adding a second event log. No generic messaging framework, watchers, pump, timers, shell killing or child finalizer.

Not verified or implemented: real herdr/TUI startup, actual process exit, non-Linux runtime, parent monitor/tail/finalizer/pane cleanup, H5 acceptance delivery or public backend activation. Existing A2 behavior and A6 scope semantics still apply independently of bridge activation. This is not an OS-user security sandbox. Immutable files provide process-reload evidence, not fsync-backed power-loss durability or exactly-once external delivery.
