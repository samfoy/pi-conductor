# H5: child inbox acceptance — intermediate, offline-only scope

H5 adds the managed-child inbox pump, **not a usable herdr backend**. Public
runtime selection remains fail-closed. No H6 launcher, live pane, parent ack
waiter, monitor, tail owner, or lifecycle changes are included. Ordinary Pi and
depth-two ask capability gates are unchanged. H3 binding and H4's single tee,
accepted/closing state and process-lifetime fault tombstone remain authoritative.

## Mailbox and acceptance contract

- `writeInboxRequest(runDir, request)` validates the current recorded run/nonce,
  canonical directories, positive sequence (1–999999), bounded identifiers,
  kind, text and reply ask ID before request publication. Text is already A5
  prepared; neither helper nor input handler expands commands or reads files.
- Requests and acks live under `inbox/<launchNonce>/`. This scopes request IDs
  physically as well as in every record. A fresh nonce never borrows old acks.
  A request is `<sequence:06d>-<requestId>.json`; its ack is
  `<requestId>.ack.json`. Kinds are `initial` (new or resumed assignment),
  `reply`, `steer`, `follow_up`, `grace`.
- Individual text is at most 8 MiB UTF-8; serialized records at most 32 MiB;
  one invocation directory at most 1024 entries. Reads are bounded, strict UTF-8,
  no-follow, nonblocking, regular-file-only, and reject hard links. Malformed,
  foreign, filename-mismatched or duplicate request identities never schedule.
  Invalid acks fail closed rather than becoming permission to replay.
- Publication is exclusive-temp + synchronous complete-buffer write + rename,
  mode 0600. The parent is the sole request producer, with unique IDs/sequences;
  the child is the sole ack writer. This is not a cross-process multi-producer
  CAS or a same-UID security boundary. No fsync/power-loss guarantee is claimed.
- The 250 ms unref interval starts in `session_start` but does not pump inline.
  It picks the oldest unacked request. Before calling the void native API it
  renames **that request itself** to `.sending.json`. An unacked dispatched
  request blocks automatic further dispatch/replay, including on reload. No
  new outbox, transcript, dispatch event log, or receiver protocol is added.
  Failed temporary writes and dispatched request bytes remain inspection evidence.
- The marker includes nonce, sequence and request ID. `steer`/`grace` explicitly
  use `deliverAs: "steer"`; all other kinds use `"followUp"`. Input transforms
  happen once. A scheduled/accepted input is held through idle preflight or
  queued-message consumption; native `agent_start` / matching user
  `message_start`, not a permanent busy flag, releases that in-flight gate.
- Dispatch first requires native idle, or a non-aborted native run signal inside
  an observed `turn_start`–`turn_end` interval. This excludes compaction's early
  auth phase before `session_before_compact`. That event also closes the pump;
  success/failure/cancellation finish the attempt, then native idle or a following
  turn boundary reopens it. Success handlers can still run while Pi owns its
  controller. A2 threshold cancellation and overflow recovery stay unchanged.
- The input handler consumes all reserved malformed/foreign/unknown/duplicate
  markers. Only a dispatched current request can transform. It writes its
  correlated ack synchronously **before returning transform**. Ack-write errors
  are caught locally and return `handled`, even if warning delivery fails. The
  invocation is disqualified through H4's sticky fault tombstone. Closing/faulted
  inputs never ack, pump, or resurrect on reload.
- Active owner calls remain busy through `turn_end`: `tool_execution_end` precedes
  native result persistence. Replies require the successful **current branch's**
  last assistant sole call plus non-error tool-result details, matching toolCallId,
  askId and question. Later user/assistant messages, failed/batched/historical
  questions, queued messages and duplicate accepted replies are refused. The A6
  owner-answer formatter is shared with subprocess sends, unchanged and applied
  exactly once. Original owner state is not cleared by this bridge.

## What an ack proves (and does not prove)

| Evidence | Meaning |
| --- | --- |
| Valid `accepted:true` ack | This bridge accepted input at its transform boundary; **not** model invocation or success. |
| Valid `accepted:false`, `busy` or `stale-ask` ack | Definite bridge rejection; input was handled, not transformed. |
| No valid ack, thrown/lost write or pump result, timeout, crash | Unconfirmed. Preserve request/temp/dispatch evidence; never blindly redeliver. |
| Settled and unacked | Definite non-delivery **only after quiescence and a final ack read**, not on an early settle observation alone. |

Later extensions can intercept accepted text; model/auth preflight can fail after
ack. H6/H8 must require a correlated initial/reply ack **and subsequent native
`agent_start`** before clearing the parent's pending owner answer. They must not
interpret `sendUserMessage` returning, CLI readiness, input ack or a timeout as
proof of execution. Human re-delivery of ambiguous work can duplicate it. This
is not exactly-once execution. H5 deliberately has no timeout/result classifier
that could accidentally make those stronger claims.

## Native evidence and verification

The harness follows H4's private esbuild pattern: explicitly resolve installed
Pi **0.87.1** and version-check `pi-ai`, `pi-agent-core`, `pi-tui` **0.87.1**;
report each resolved module URL. It does not silently use the repository's
0.84.3 dependencies. No package/global config changes, node_modules copies,
credentials, network provider, paid inference or live herdr are involved.
`tmpDir`/`sandboxPi` provide private HOME, TMPDIR, agent state and memory.

Relevant installed source evidence:
- `dist/core/agent-session.js`: `prompt` (1207 onward), `sendUserMessage` (1547),
  `_handleAgentEvent` (556), manual `compact` (1865), `_runAutoCompaction` (2153),
  extension `sendUserMessage` wrapper (2406), `reload` (2603).
- `dist/core/extensions/runner.js`: `emitInput` (1097). Handler exceptions are
  reported and processing continues; this is why a local catch is load-bearing.
- Complete installed `docs/extensions.md`, `sdk.md`, `sessions.md`,
  `session-format.md`, `compaction.md`, and the custom-compaction example inform
  branch reconstruction, native event timing and A2 cancellation.

Native faux-provider scenarios cover healthy exact CRLF/Unicode text, later
input interception, model-preflight failure, local ack failure and reload,
settle-during-pump, real A6 ask then fresh-nonce reply, stale-branch refusal,
manual compaction success/failure/cancel, actual A2 threshold cancellation,
positive overflow compact/retry, and a held preflight/second-input race.
Interception and preflight cases both produce accepted acks with **zero native
starts and zero provider calls**. The healthy ask/reply has two starts and two
shutdown requests across two nonces. A5 file bytes survive changing the source
file between preparation and native delivery, with exactly one owner wrapper.
The separate `fake-child.mjs` fixture is explicitly marker-free scripted process
behavior; it does not impersonate or replace native Pi acceptance evidence.

Targeted mutation witnesses (snapshot copy/restore, SHA256 checked):
1. Remove `session_compact_failed` from the finished-gate reset. The focused test
   fails `compaction terminal must reopen pump even after cancellation` (0 sends
   versus 1 expected).
2. Add ack publication before the pump calls native input. The focused test fails
   `scheduling is not input acceptance` (ack exists before input handler runs).

Commands:
```sh
node --test --test-timeout=60000 --import tsx tests/child-inbox.test.ts tests/child-inbox-native.test.ts tests/child-inbox-smoke.test.ts
node --test --test-timeout=60000 --import tsx --test-name-pattern='compaction gate releases on session_compact_failed' tests/child-inbox.test.ts
node --test --test-timeout=60000 --import tsx --test-name-pattern='initial ack is synchronous inside input' tests/child-inbox.test.ts
```

Strip inherited CONDUCTOR_SUBAGENT/HERDR variables for suite commands as in
CONTRIBUTING.md. Normal full-suite/typecheck/build/diff checks and repository
commit hooks remain required. H4 native/tee tests, A6 native/corrections, A2
retirement, tool-policy and M5 recovery/reload settlement barriers are included
in the focused regression gate. No human TUI or real-pane acceptance is claimed.

## Early-compaction correction (critic-5gnj)

The initial H5 native test only ticked from `session_before_compact` and later
handlers. It missed the authentication await **before** that event, when native
`compact()` has already installed its controller. The added held-auth witness
first failed the exact `native held-auth compaction must leave the request
undispatched` assertion: `.sending.json` existed with no ack.

API choice, checked against installed 0.87.1 source:
- `ExtensionContext.isIdle()` delegates to `AgentSession.isIdle`, which includes
  the native manual/automatic compaction controllers (`agent-session.js:875,
  928, 2447`). It is false throughout held summarization auth.
- `ExtensionContext.signal` is a live getter delegating to `agent.signal`
  (`extensions/runner.js:597`, `agent-session.js:2449`,
  `pi-agent-core/dist/agent.js:212`). A signal exists during healthy streaming
  **and between-turn automatic compaction**, so signal presence alone is unsafe.
- `turn_end` precedes `_compactBeforeNextAssistantResponse` in native
  `prepareNextTurn`; `turn_start` follows it (`agent-session.js:295–423`). The
  bridge records only this observed turn interval. The first correction used a
  weak set of native signals; the boundary-time reload correction below replaces
  it with an invocation-fenced phase handoff. The existing late-event gate remains
  in place. Production never patches native compaction internals.

Nine added native compaction scenarios hold `_getSummarizationRequestAuth` in
the **test harness only**: manual success/auth-failure/cancel, pre-prompt A2
threshold cancellation, post-run overflow success, and between-turn threshold,
auth-failure, cancellation and reload. Each proves unchanged request bytes,
`dispatched:false`, no ack and zero `sendUserMessage` calls before releasing
auth; the later tick accepts the exact text once. Four positive streaming
controls prove both steer and follow-up still enqueue during a held provider
call, with and without native reload. That correction expanded the harness to 26 scenarios.

Correction mutations both fail the intended native undispatched assertion:
1. Remove the new pre-rename native-state guard: fails during manual held auth.
2. Keep idle/signal checks but remove observed-turn membership: manual and
   post-run cases pass, then between-turn held auth fails. This witnesses why
   the turn phase cannot be replaced with signal presence alone.

Both use snapshot restoration with SHA256 verification. Run the existing
`tests/child-inbox-native.test.ts` command above to execute these new scenarios
and all earlier ack, ask, compaction and fault controls. No replay or acceptance
semantics were weakened; no H6/public-runtime code was changed.

## Snapshotted-boundary reload correction (critic-5gnj)

The next native ordering witness registers an async handler **before** the bridge
and holds native `turn_start` or `turn_end`, reloads externally, then releases it.
The original two no-reload controls passed, while both reload cases failed:
missing start membership blocked healthy steer; stale end membership permitted
dispatch during automatic compaction. Native `ExtensionRunner.emit` and
`emitBoundary` snapshot handlers before dispatch (`runner.js:662–735`). New
handlers do not receive an already-started dispatch.

`createContext()` uses guarded getters, including `signal` (`runner.js:545–620`).
`AgentSession.reload()` emits shutdown before invalidating the old runner and
loading the new runtime (`agent-session.js:2603–2627`). The new tests assert that
reading the saved boundary context after reload actually throws; the bridge does
not attempt to use that stale context.

The WeakSet is replaced, not supplemented, by a small per-run phase slot:
H4 invocation identity, native signal, active-turn bit and current attachment
identity. Reload shutdown captures the native signal **while the context is still
valid**. An old disposed callback may then update only the matching phase bit.
It cannot reopen the fd, project its late event, send input, pump, or inspect its
stale context. A changed run/nonce/signal, replaced phase slot, or H4 fault
fences it out. Attachment identity prevents old cleanup from deleting a new
attachment's slot. Quit, closing and faults remove the owned slot; the handoff
contains no extension context, transcript writer or durable delivery ledger.

The native tests include both reload failures and matched no-reload controls,
plus zero-byte and 17-byte tee faults during boundary-time reload. Poisoned
invocations remain unacked with unchanged damaged transcript and no shutdown
success after another reload. Three deterministic tests genuinely re-evaluate
the bridge module and verify that late start/end callbacks with a throwing stale
context cannot authorize or revoke a different nonce, native signal or run.
The harness now reports **32 named native subtests** (the original 26 plus six
boundary cases), rather than hiding scenarios inside one aggregate test.

Mutation: removing the disposed callback's `observePhase(event.type,
reloadSignal)` handoff fails exactly the two native boundary assertions above
(and their parent test); both no-reload and zero/partial-fault controls remain
green. The source is restored from a snapshot with SHA256 verification. No
request-replay or ack/execution semantics changed.

## Complexity pass

The existing H4 writer, invocation proof and fault tombstone are reused. The
inline subprocess owner wrapper was removed in favor of the same shared A6
formatter used by the inbox. An unused request copy was removed from the
in-flight gate. There is no general transport framework, scheduler, new runtime
selector, polling parent service, or retry policy in H5.
