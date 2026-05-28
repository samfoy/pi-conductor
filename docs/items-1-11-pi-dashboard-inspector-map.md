# pi-dashboard inspector map — backlog items 1 (heartbeat) and 11 (wake render)

Recon for cross-repo investigation. Read-only.

- pi-dashboard HEAD: `7fb5ecda` (clean tree)
- pi-conductor backlog: `/local/home/samfp/scratch/pi-conductor/docs/backlog.md` items §1, §11
- pi-coding-agent dist (read-only): `/home/samfp/.local/share/mise/installs/node/24.7.0/lib/node_modules/@earendil-works/pi-coding-agent/dist/`

---

## 1. pi-dashboard repo orientation

Top-level: `backend/` (Express + WS + child-pi supervisor), `frontend/`
(Vite/React/Redux SPA), `plugins/`, `shared/`, `bin/`, `dist/`, ops
files (`run.sh`, `pi-dashboard.service`, etc.). Runtime spec in
`PLUGIN_RUNTIME_SPEC.md`.

- **Backend entry:** `backend/server.ts:1–694` (Express + WebSocket;
  bridges PiManager events onto WS).
- **PiManager / PiProcess:** `backend/pi-manager.ts:112` (`PiProcess`)
  and `:778` (`PiManager`). Each chat slot owns one **child `pi` CLI
  subprocess** spawned at `backend/pi-manager.ts:219` via
  `spawn(NODE_BIN, [...V8_FLAGS, PI_SCRIPT, '--mode', 'rpc', ...])`.
  Communication is JSON-RPC over child stdio.
- **Pi extensions are NOT loaded by pi-dashboard.** They live in
  `~/.pi/agent/extensions/` and are loaded by the **child pi process
  itself**. Pi-conductor therefore runs inside the child; its only
  IPC path back to pi-dashboard is the RPC event stream consumed in
  `_handleEvent` at `backend/pi-manager.ts:~595–768`. There is **no
  in-process API** the dashboard exposes to extensions.
- **`pi-manager.ts` duties:** spawn/restart/shutdown the child; tail
  stdout JSON events; maintain `messages[]`, `running`,
  `_lastActivity`, `_toolsRunning`; re-emit events for `server.ts`;
  run a **5s `_healthCheck`** to reap idle slots.

---

## 2. Item 1 — Idle-reaper map

### Location

- **`PiManager._healthCheck`:** `backend/pi-manager.ts:980–995`.
- **Caller:** the only invoker is the constructor's
  `setInterval(() => this._healthCheck(), 5000)` at
  `backend/pi-manager.ts:796`. Cleared in `shutdown()` (line 999) and
  `gracefulShutdown()` (line 1010).

### Reap predicate (current state — backlog mitigation drifted)

`backend/pi-manager.ts:986–991`:

```ts
if (pi.proc && !pi.running && !pi._stopping && pi._lastActivity > 0) {
  const idle = now - pi._lastActivity
  if (idle > 30 * 60 * 60 * 1000) {  // 30 *hours*
    pi.emit('log', { level: 'info', msg: `Slot ${pi.slotKey}: idle ${Math.round(idle/60000)}m, gracefully stopping process` })
    pi.gracefulShutdown().then(() => { pi.proc = null })
  }
}
```

Backlog §1 says the mitigation is *"the reaper block was disabled
2026-05-21 — preserved as commented-out code with a dated rationale."*
**That is stale.** Two parallel branches both touched this on
2026-05-28:

- `bbd55464` (origin master, 2026-05-28 21:22 UTC): "fix(pi-manager):
  disable idle reaper for pi-conductor compatibility".
- `aa118fca` (origin master, 2026-05-28 17:35 UTC): "feat(backend):
  inject resume hint on session reload + extend idle reap to 30h".
- Merge `349eb962` resolved them in favor of the **30h threshold**.

So as of HEAD `7fb5ecda` the reaper is **active with a 30-hour
threshold**, not disabled. The dated comment block at
`backend/pi-manager.ts:973–979` correctly reflects current state
(*"replaced the disable with a 30-hour threshold so slots survive
overnight without being reaped"*). The backlog entry needs updating;
the proposed cross-repo fix is now lower priority (a slot must be
idle for 30h, not 30m, before reap).

### What bumps `_lastActivity` today

Audited via `grep -n "_lastActivity" backend/pi-manager.ts`:

| Site | Line | Trigger |
|------|------|---------|
| `prompt()` entry | 353 | host calls `pi.prompt(...)` (user submit) |
| `agent_start` | 614 | turn starts (LOAD-BEARING comment) |
| `agent_end` | 622 | turn ends |
| `message_update` | 703 | streaming delta |
| `tool_execution_start` | 738 | tool dispatched |
| `tool_execution_end` | 750 | tool completes |
| `message_end` (custom only) | 734 | only via the embedded note in the case block — actually no, **`_lastActivity` is NOT bumped here**; the bump is at line 734 inside `tool_execution_start`. Re-check: lines 715–727 (`message_start`/`message_end`) push the message to `messages[]` for `role==='custom'` but **do NOT bump `_lastActivity`**. |
| `tool_execution_update` | n/a | **NOT bumped.** Case at 742–744 only re-emits the event. |
| `turn_start` / `turn_end` | n/a | **NOT bumped.** Case at 754–756 just re-emits. |
| `extension_ui_request` | n/a | **NOT bumped.** Case at 765. |

**The backlog hint is partially wrong.** It says
*"`tool_execution_update` is one [of the channels that bumps
`_lastActivity`]"*. It is not. `tool_execution_update` is consumed
(re-emitted as `tool_update` to drive partial-output rendering at
`server.ts:383`) but the `_lastActivity` bump only happens on
`_start`/`_end`. So a synthetic `tool_execution_update` from
pi-conductor would surface as a UI event but would **not** keep the
slot alive.

### Why background sub-agents look idle

`ensemble_spawn { foreground: false }` returns immediately, closing
the parent turn (`tool_execution_end` bumps once → `agent_end` bumps
once → silence). Background sub-agent activity runs in a **separate
child pi process** whose stdio is not wired into the orchestrator's
RPC stream, so zero events reach `pi-manager._handleEvent` until
completion fires `pi.sendMessage` back through the parent. At 30m
that killed parents; at 30h it's tolerable.

### Disabled-block / comment audit

No disabled block at HEAD. The comment at
`backend/pi-manager.ts:967–979` is the dated rationale and is
**accurate**: 967–971 covers the prior 5-min watchdog removal
(810cd776 → dd33d3c5); 973–979 covers the 30m → disabled
(2026-05-21) → 30h (`aa118fca`) progression and names witnesses
`builder-shzs` and `builder-utrr`. It correctly does not mention the
cross-repo heartbeat plan since 30h makes it optional.

### Cross-repo fix sketches

**Sketch A — pi-conductor emits a synthetic event already consumed
by pi-manager.** Channels that bump `_lastActivity` on dashboard
side: `tool_execution_start/_end`, `message_update`, `agent_start`/
`agent_end`. None of these are emittable from a pi extension via
the public `pi.*` API without side effects (spurious tool calls in
chat, fake assistant deltas, fake turn boundaries). The
already-consumed `tool_execution_update` channel is the cleanest
target *if* pi-dashboard is willing to add a one-line
`this._lastActivity = Date.now()` to `case 'tool_execution_update'`.
**Effort:** 1 LOC in pi-dashboard + however the conductor wires a
heartbeat in pi-coding-agent. **Risk:** zero in pi-dashboard
direction. The blocker is pi-coding-agent's lack of a
`pi.emit('tool_execution_update', …)` API for extensions; that's an
upstream conversation, not pi-dashboard's call.

**Sketch B — new `agent_busy` channel.** pi-dashboard would need to
recognize a new RPC event type (e.g. `extension_heartbeat`) in
`_handleEvent` and bump `_lastActivity` from it. **Effort:** ~5 LOC
in pi-manager.ts. **Risk:** also requires the upstream extension
API to expose a heartbeat emitter; same upstream blocker.

**Sketch C — pi-host API to bump activity directly.** No such API
exists. The pi child has no awareness of the dashboard's slot-level
state; everything is mediated by RPC events. **Out of scope** —
would require pi-coding-agent design work.

**Cheap pi-dashboard-side defense (no upstream change):**
piggyback on the conductor's ensemble widget refresh. `pi.setStatus`
/ `pi.setWidget` flow through `extension_ui_request` events
(pi-manager.ts:765). Add the `_lastActivity` bump there, gated to
`setStatus`/`setWidget`, so the existing live-widget refresh keeps
the slot alive while runs are active. **Effort:** ~3 LOC. **Risk:**
any chatty widget would extend slot life; today that's mostly the
conductor + ad-process, both of which *should* keep the slot alive.

### Reapability pre-flight (deferred)

30h defers Sketches A/B without closing them. If the threshold
ever tightens again the heartbeat becomes mandatory. Until then the
conductor's existing widget refresh, watchdog advisories, and
pre-completion notifications all incidentally bump activity.

---

## 3. Item 11 — Chat-slot rendering map

### The render pipeline

Server-side translation:

1. `backend/pi-manager.ts:715–726` — `case 'message_end'`. If
   `event.message.role === 'custom'`, push to slot `messages[]` as
   `{ role: 'system', content: '[customType] ' + text, meta: {
   customType } }`. Other roles fall through (no push).
2. `backend/server.ts:447–479` — `pi.on('message_end', ...)`. Same
   filter (`role === 'custom'`) re-broadcasts the message over WS
   as `{ type: 'chat_message', role: 'system', content: '[type]
   text', meta: { customType } }`. Also: lines 461–477 hold a
   **separate auto-trigger list** (`TURN_TRIGGER_TYPES = [
   'subagent-result', 'ad-process:update' ]`) that fires a follow-up
   `pi.send({ type: 'prompt', message: <hint> })` 500ms after
   ingestion, **but only for those two customTypes**. Conductor's
   `ensemble-notification` is **not** in this list — and doesn't
   need to be, since pi-conductor itself fires the turn via
   `triggerTurn: true`.

Client-side rendering:

3. `frontend/src/hooks/useWebSocket.ts:109–112` — WS `chat_message`
   case dispatches `sseChatMessage(data)`.
4. `frontend/src/store/chatSlice.ts:199` — reducer pushes into
   `state.messages` (verbatim, with role and meta preserved).
5. `frontend/src/pages/ChatPage.tsx:599–612` — `renderMessage()`
   switch. **`role === 'system'` → `<SystemMessage content={m.content}
   meta={m.meta} />`** at line 605.
6. `frontend/src/pages/chat/SystemMessage.tsx:199–294` —
   per-`customType` switch:
   - `ad-process:*` → styled process card (line 202)
   - `ad-subagent:*` → subagent card (line 229)
   - **`ensemble-notification` → `EnsembleNotificationCard`** via
     `parseEnsembleNotification(stripped)` at line 246–251.
   - `subagent-result` → `SubagentResultCard` (line 254)
   - `knowledge-overview`, `ralph-hat` → markdown cards
   - **catch-all (no customType match) → generic `ℹ` info-line bar**
     at line 288–294.

### User-bubble vs info-line discriminator

**Decided entirely by `m.role`** at `ChatPage.tsx:599–614`. Look at
the path:

- `role === 'user'` → flex-row-reverse, accent-bg user bubble
  (`ChatPage.tsx:613, 620–642`).
- `role === 'assistant' | 'streaming'` → assistant card.
- `role === 'system'` → `SystemMessage` → either a typed card OR
  the `ℹ` catch-all.

A custom message from a pi extension **is shaped as `role: 'custom'`
in the pi-coding-agent layer**
(`pi-coding-agent/dist/core/agent-session.js:947–967`,
`sendCustomMessage`: `appMessage = { role: "custom", customType,
content, ... }`). pi-manager.ts then transcodes it to `role:
'system'` for the UI. **There is no path on the pi-dashboard side
that would render an extension-emitted message as `role: 'user'`** —
even with `triggerTurn: true`, the message stays `role: 'custom'`
through pi-coding-agent and `role: 'system'` once it lands in the
dashboard's chat log.

### Does `triggerTurn: true` propagate visibly?

**No.** `grep -rn "triggerTurn|deliverAs" backend/ frontend/src/`
returns exactly one match: a comment at `backend/pi-manager.ts:611`
explaining why `agent_start` bumps `_lastActivity` (so re-entrant
turns from `triggerTurn: true` don't trip stale-activity watchdogs).
There is **no code path** that reads `triggerTurn` to alter
rendering. The dashboard is wholly agnostic. The visible effect of
`triggerTurn: true` is purely indirect: pi-coding-agent fires
`await this.agent.prompt(appMessage)` which emits the standard
`agent_start` / streaming chunks / `agent_end` cascade — that's how
the dashboard "knows" a turn happened.

### Does pi-conductor's fix close the witness?

**Semantically (background spawns):** yes. `src/index.ts:323–337`
calls `pi.sendMessage(..., buildCompletionSendMessageOptions(run))`,
which post-fix returns `{ triggerTurn: true }` only for backgrounds
(`src/notifications.ts:260–266`). That hits the pi-coding-agent
default branch (`agent.prompt(appMessage)` at
`agent-session.js:980–981`), firing a real turn while emitting
`message_start`/`message_end`. Combined with `completionWakeTracker`
dead-man-switch re-fire, the conductor wakes even if the first
trigger is swallowed.

**Visually:** the message lands as `role: 'system'` /
`customType: 'ensemble-notification'`. Card vs `ℹ` is decided by
`parseEnsembleNotification` (`SystemMessage.tsx:44–88`), which
requires `<sub-agent-completed>` + a fenced ```xml``` block —
`notifications.ts:78,114` confirms the formatter emits exactly
that. A properly-formatted completion renders as the styled card.

The 2026-05-27 witness rendered as `ℹ` because the parser fell
through — likely the pre-`f066df7` formatter omitted the xml
envelope, OR the fenced block was malformed. Worth confirming on
the next live witness.

**Residual gap:** visual rendering is independent of turn-firing.
If the parser ever fails on a future envelope shape, the user sees
the `ℹ` line even though the turn fired correctly. That's a
SystemMessage parser robustness issue, not a wake bug. The
"25 minutes idle" symptom is closed by the conductor-side fix.

---

## 4. Cheap cross-repo defenses (pi-dashboard-side, no conductor change)

### Item 1 — keep slot alive while extensions are visibly busy

- **D1.** Bump `_lastActivity` on `extension_ui_request` events.
  **LOC:** ~3 at `backend/pi-manager.ts:765–767`. **Pattern:**
  mirror the bump at line 738. **Risk:** any chatty widget extends
  slot life — today that's mostly conductor + ad-process.
- **D2.** Bump `_lastActivity` on `tool_execution_update`.
  **LOC:** 1 at `backend/pi-manager.ts:742–744`. **Pattern:** copy
  line 750. **Risk:** zero today; placeholder until upstream
  exposes synthetic tool emits.
- **D3.** New `extension_heartbeat` RPC case. **LOC:** ~5,
  patterned on `auto_compaction_start/_end` at line 759. **Risk:**
  no-op until pi-coding-agent ships a heartbeat-emitter API.

### Item 11 — visual robustness

- **D4.** Tighten `parseEnsembleNotification` fallback at
  `frontend/src/pages/chat/SystemMessage.tsx:44–88` so a markdown
  body without the xml envelope still routes to
  `EnsembleNotificationCard`. **LOC:** ~10–25. **Pattern:** the
  dual xml/markdown match used for `ad-process:*` higher in the
  same file. **Risk:** false positives — gate on `<persona>`,
  `<duration>`, or literal `completed`/`stalled`.
- **D5.** Add `'ensemble-notification'` to `TURN_TRIGGER_TYPES` at
  `backend/server.ts:461–477`. **LOC:** 1. **Risk:** would
  double-fire turns alongside conductor's own `triggerTurn: true`;
  **don't ship** unless conductor switches to non-triggering
  envelopes. Inventory only.

---

## 5. Deferred / out of scope for cheap fixes

- **Spawn-relationship awareness.** Dashboard knowing slot A's pi
  child has spawned slot B via conductor needs both upstream
  (child-process registry surface) and conductor (cross-process
  publish) work. **Deferred.**
- **`triggerTurn` / `deliverAs` propagation into the renderer.**
  Would require pi-coding-agent's `message_end` event to carry the
  send options. **Out of scope; upstream semantic change.**
- **Render `role: 'custom'` as user bubble when `triggerTurn:
  true`.** Same upstream constraint. **Out of scope.**
- **Reaper threshold tuning.** 30h is pragmatic. Heartbeat is the
  cleaner long-term answer; tracked in conductor backlog §1
  cross-repo half. **Deferred** unless memory pressure forces it.

---

## Open questions

- The 2026-05-27 witness: was the conductor's pre-`f066df7`
  completion formatter emitting the `<sub-agent-completed>` xml
  envelope, or a plain markdown body? If the latter, the
  `ℹ` rendering is fully explained by `parseEnsembleNotification`
  returning null and falling through to the catch-all. Confirming
  this would close item 11's visual half without any dashboard
  patch.
- Is pi-coding-agent willing to expose a synthetic
  `tool_execution_update` (or new `extension_heartbeat`) emitter on
  the extension public API? If yes, Sketch A/B become trivial.
- Is the 30h reaper a permanent stance, or should this map drive a
  follow-up to re-enable a tighter threshold once heartbeats land?
