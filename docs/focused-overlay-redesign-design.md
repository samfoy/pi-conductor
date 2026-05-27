# Design: Focused-stream overlay redesign

Status: design (no code).
HEAD at design time: `git rev-parse --short HEAD` (capture in plan).
Source: inspector map (cited inline), user decisions logged 2026-05-22, prior pass `docs/v0.8.3-item3-design.md`.

Predecessor: `docs/v0.8.3-item3-design.md` (chrome-polish slice). That doc explicitly deferred "Box-bordered overlay viewport" as a structural redesign needing a pi-tui API pass (`docs/v0.8.2-backlog.md:661–664`). This is that pass.

---

## 1. Goals & non-goals

### Goals

- **Visible chrome.** A bordered modal anchored centre, with terminal margin so the user can tell it is a modal, not a takeover.
- **No overflow in tmux.** Body never scrolls the host terminal; size is bounded by `overlayOptions.maxHeight` and a viewport-aware internal scroll model.
- **Live-stream stickiness.** Auto-follow-tail when the user is at the bottom; latch off the moment they scroll up; re-arm on `End` / `G`.
- **Painless send.** Pressing `s` splits the body into transcript + inline input pane in-place — no modal-on-modal `ctx.ui.input`.
- **Fold long content.** Expanded tool-call args and thinking blocks are capped with a fold marker; per-block expand binding.
- **Throttled re-render contract.** Registry events drive `tui.requestRender()` through a 50 ms coalesce window. No more "host scheduler tick" lottery.

### Non-goals (deferred)

- Search inside transcript, copy-to-clipboard, mouse, history scrubbing across runs, persistent layout settings.
- A general-purpose pi-tui scrollable-region primitive (we implement scroll locally; flag upstream gap).
- PTY/tmux snapshot harness (recommend, scope-defer — see §13).
- Multi-pane layouts beyond transcript+input.

---

## 2. Component tree

pi-tui primitives in scope (`docs/tui.md:185, 207, 221, 244` and re-exports): `Container`, `Box`, `Text`, `Spacer`, `Markdown`, `Input`, `Editor`, `Focusable`. **No native scrollable region. No native `Box` border** — `Box` is padding+bg only; borders are drawn as flat ASCII lines by us (today's pattern, e.g. `transcript.ts:35–36` ruler) or via the host's `DynamicBorder` component (`docs/tui.md:594` example).

```
FocusedOverlayRoot (Container, Focusable)        ← mounted via ctx.ui.custom({ overlay: true, overlayOptions })
├── HeaderZone (Container)
│     • top border line (╭─…─╮)
│     • status line  (persona · id · status · elapsed · usage · activity)
│     • bottom rule  (├─…─┤)
├── BodyZone (Container)            ← height computed from viewport - header - footer - input
│   ├── TranscriptPane (custom Component)
│   │     • renders run via existing renderTranscript() sliced by [scrollOffset, scrollOffset + paneRows]
│   │     • scroll-position breadcrumb on the bottom row when content is clipped
│   └── InputPane (Container, Focusable)         ← present iff model.inputPaneOpen
│         • separator rule (├─…─┤)
│         • prompt prefix line:  "↪ send to <id>"
│         • Editor child (multiline, capped at INPUT_PANE_ROWS_MAX)
│         • hint line:  "Enter send · Esc cancel"
└── FooterZone (Container)
      • bottom rule (├─…─┤) [omitted when InputPane drew its own separator]
      • hint line built from FOOTER_BINDINGS (context-dependent — §8)
      • bottom border line (╰─…─╯)
```

Notes on primitives:

- `HeaderZone`, `BodyZone`, `FooterZone` are plain `Container`s. Each border / rule is a `Text` line emitted by the parent — we are not depending on `Box.border` because no such property exists in pi-tui.
- `TranscriptPane` is a thin `Component` whose `render(width)` returns the already-existing `renderTranscript()` output sliced to its parent-allotted height. **Reuses `transcript.ts` / `transcript-classify.ts` / `transcript-style.ts` verbatim** — those modules are pure and already battle-tested.
- `InputPane` is a `Container` with an `Editor` child (`docs/tui.md:55`) for multi-line typing. The container implements `Focusable` and propagates `focused` to the `Editor` for IME cursor positioning (`docs/tui.md:64–82`).
- The root component implements `Focusable` and forwards focus to either the Editor (when input pane is open) or absorbs keys itself. It owns `handleInput` dispatch and routes to the focused subtree.

**pi-tui gap flagged.** No `Container` API for *vertical splits with a known child height*. The root must compute heights manually from `process.stdout.rows` and pass them down (each child's `render(width)` doesn't receive a height argument — `docs/tui.md:24`). This is the same pattern today's `transcript.ts` uses; not a blocker, just verbose. Recorded in §14 as upstream feedback.

---

## 3. Sizing & anchoring

Mount call replaces `src/index.ts:113–125`:

```ts
ctx.ui.custom(factory, {
  overlay: true,
  overlayOptions: {
    width: "95%",
    maxHeight: "90%",
    minWidth: 60,
    anchor: "center",
    margin: 1,
    visible: (w, h) => w >= 70 && h >= 18,
  },
});
```

- `width: "95%"` + `margin: 1` leaves a one-cell ring of host content on each side — visibly a modal, not a takeover. (`docs/tui.md:120–145` confirms percentage support.)
- `maxHeight: "90%"` clips before the host terminal scrolls. This is the single biggest fix for the tmux "scrolls off page" report — pi-tui already has the clip, today's mount just doesn't ask for it.
- `minWidth: 60` keeps the modal usable on 80-column terminals; anything narrower would crush the header.
- `visible: (w,h) => w >= 80 && h >= 20` — below this, the overlay is not rendered. Threshold matches Brazil terminal default; chrome math (header 4 + footer 3 + min body 6 + margin 2 = 15 rows) leaves comfortable slack at 20 rows. Pressing `Ctrl+G` on a too-small terminal must still be safe. **Fallback:** the shortcut handler (`focused-overlay-shortcut.ts`) reads `tui.terminal.rows` / `.columns` and, when below the visibility threshold, calls `ctx.ui.notify("Terminal too small for focused overlay (need ≥80×20)", "warning")` instead of opening. (`ctx.ui.notify` is the real API — used 5× in `src/index.ts`.)
- **Resize handling.** pi-tui re-runs `render(width)` on SIGWINCH; the root must recompute internal heights from `process.stdout.rows` on each render. No persistent height cache.

**Internal height arithmetic.** pi-tui doesn't pass height to `render(width)`. The root reads `tui.terminal.rows` / `.columns` (`pi-tui/dist/terminal.d.ts:18-19`, exposed via `tui.d.ts:135`) — pi-tui's authoritative size source. `process.stdout.rows` is a fallback for tests with no `tui` handle.

```
totalRows  = tui.terminal.rows ?? process.stdout.rows
overlayRows = floor(totalRows * 0.90) − 2 * margin    // matches overlayOptions
bodyRows   = overlayRows − HEADER_ROWS(=4) − FOOTER_ROWS(=3)
              − (model.inputPaneOpen ? INPUT_PANE_ROWS(=6) : 0)
```

Stub via the existing `getViewportHeight` injection (already plumbed; `focused-stream-overlay.ts:30–44`). **Wire it in the factory** (today's bug, `focused-overlay-factory.ts:60–73`).

---

## 4. State model

Extend `FocusedStreamModel` (`src/focused-stream-model.ts`). Existing fields keep their semantics; new ones:

| Field | Default | Notes |
|---|---|---|
| `_scrollPerAgent: Map<id, number>` | (existing) | Now bounded — see §5. |
| `_stickToTailPerAgent: Map<id, boolean>` | `true` | Auto-follow lock. Per-agent so cycling restores per-agent intent. |
| `_inputPaneOpen: boolean` | `false` | Global; one input pane at a time. |
| `_foldExpanded: Map<string, boolean>` | (empty) | Per-block fold override. Key = `<agentId>:<turnIdx>:<partIdx>`. Absence = use global default. |

Methods added (no `inputBuffer` — Editor owns its text):

- `setStickToTail(id, on: boolean)` / `stickToTail(): boolean`
- `openInputPane()` / `closeInputPane()` / `inputPaneOpen(): boolean`
- `expandBlock(key)` / `collapseBlock(key)` / `isExpanded(key, defaultExpanded): boolean`
- `jumpToTail()` — sets `scrollOffset = max(0, transcriptLineCount - viewportRows)`, `stickToTail = true`
- `scrollUp(n)` / `scrollDown(n)` — clamp against the viewport (§5)

Pure module — still no TUI imports.

---

## 5. Auto-follow-tail rules

Let `bottom = max(0, transcriptLineCount - bodyRows)` be the offset where the last line is visible.

Transitions:

| Trigger | Effect |
|---|---|
| `scrollUp(n)` while at `bottom` | `stickToTail = false`; offset decrements. |
| `scrollDown(n)` reaches `bottom` | `stickToTail = true`; offset clamped at `bottom`. (No further increment.) |
| `End` or `G` | `offset = bottom`, `stickToTail = true`. |
| `Home` or `g` | `offset = 0`, `stickToTail = false`. |
| New transcript lines arrive (registry refresh) | If `stickToTail`: `offset = bottom` (auto-scroll). Else: offset unchanged. |
| Tab / Shift-Tab cycle | Restore the per-agent `(offset, stickToTail)` pair for the new agent. |
| Resize | Re-clamp `offset = min(offset, bottom)`. If `stickToTail`, snap to new `bottom`. |

Bound `scrollDown` so the user can't mash past `bottom` (today's bug — `focused-stream-model.ts:92–97`). The clamp lives in the model, given a viewport rows callback at refresh time, **or** the overlay component clamps post-hoc and notifies the model. Cleaner: model takes `viewportRows` as an argument to scroll mutators (testable, no I/O).

---

## 6. Fold caps

Defaults (configurable later):

- **Tool-call expanded JSON** — show first **12 lines** of `JSON.stringify(args, null, 2)`. If body exceeds, replace tail with `  ⋯ N more lines (Enter to expand)`. (Today: `transcript.ts:258–264` dumps the whole thing.)
- **Inline tool-result body** in expanded mode — show first **6 lines** of each result text part with same fold marker. (Today: `transcript.ts:267–278` emits `firstLine` only — already capped, leave as-is.)
- **Thinking body** when `showThinking=true` — show first **20 lines** wrapped, then fold marker. (Today: `transcript.ts:202–207` unbounded.)
- **Per-block override** — Enter on the focused fold marker line toggles the per-block `_foldExpanded[key]` to bypass the cap. There is no body navigation/cursor today; we add a "selected fold" pointer in the model (focus = lowest fold marker visible in viewport; `j`/`k` cycle markers; Enter expands the selected one). v1 simplification: **no fold selection cursor**, Enter does nothing; the binding is `e` "expand all" / `E` "collapse all" applied globally to the focused agent. Selection-cursor is a follow-up.

Indicator format (chosen for short visible width and consistency with existing `· …` dim convention):

```
  ⋯ 187 more lines  (e expand all)
```

The `⋯` glyph is added to `transcript-classify.ts` as a new `LineKind = "fold"`, themed via `dim` slot.

---

## 7. Header zone

Two render lines + two border lines = 4 rows. Reuse `renderHeader` and `deriveActivity` (`transcript.ts:30–112`) — they already produce the right content. Wrapping responsibilities shift to the root (we draw the modal border lines).

Layout per row:

```
╭───────────────────────────────────────────────────────────────────╮
│ ◉ builder (builder-xz5l)  running 2:14  · ⌬ Read tool             │
├───────────────────────────────────────────────────────────────────┤
```

- Left segment: `<glyph> <persona> (<id>) <status> <elapsed>` — never truncated (truncation budget eats activity first, then usage).
- Middle segment (separator + activity): `· <activity>` from `deriveActivity` — first to truncate, then drop.
- Right segment: `[<usage>]` — second to truncate, then drop.
- Truncation order on narrow widths: drop usage → drop activity → ellipsise base. Matches existing `transcript.ts:42–58`.

ANSI theme slots (existing): glyph slot per `STATUS_GLYPH` mapping (`transcript-style.ts`), persona name in `accent`, activity in `dim`, usage in `muted`. Border lines in `border` slot — confirmed available in `Theme.fg` (`docs/tui.md:412`).

---

## 8. Footer zone

Single line of hints + bottom border row + (when input pane is closed) one separator rule above. Total 3 rows in default mode; 2 rows when input pane is open (input pane drew its own separator).

`FOOTER_BINDINGS` remains the single source of truth (`focused-stream-overlay.ts:139–207`). Hints render contextually:

| Context | Visible hints (in order) |
|---|---|
| Default (input pane closed) | `Esc close · Tab cycle · ↑↓ scroll · End tail · s send · c collapse · t thinking · e expand · k kill` |
| Input pane open, Editor focused | `Esc cancel · Enter send · Ctrl-Enter newline` |
| No focused run | `Esc close` |

Width budgeting algorithm unchanged from today (`renderFooterLine`, line 230); contextual list selection happens before the loop based on `model.inputPaneOpen()` and `model.focused()`.

---

## 9. Input pane (split on `s`)

Trigger: pressing `s` with a focused run. Effect:

1. `model.openInputPane()`.
2. Body height shrinks by `INPUT_PANE_ROWS = 6` (4 Editor rows + separator + hint).
3. If `stickToTail` was true, body re-anchors to new `bottom` (so the user can still see the latest activity above the input).
4. Root focus transfers to the InputPane's Editor.

Editor sizing: fixed 4 visible rows; multi-line by `Ctrl-Enter`. Cap at `INPUT_PANE_ROWS_MAX = 8` total before the editor itself scrolls internally. Hard cap because the body is the priority view.

Esc / Enter semantics:

- `Esc` from Editor → `model.closeInputPane()`, focus returns to root, body re-expands. **Does not** close the overlay (root absorbs only when input pane is closed).
- `Enter` → submit current buffer via `promptAndSendToRun(focused.id, buffer)`, then `closeInputPane()`.
- `Ctrl-Enter` → newline.
- Empty / whitespace-only submit → no-op (closeInputPane only; matches existing whitespace check at `src/index.ts:168`).

Separator chrome owned by InputPane (so removing the pane removes its separator atomically). HeaderZone separator stays put.

**`Editor` instantiation.** Constructor signature is `new Editor(tui, theme: EditorTheme, options)` (`pi-tui/components/editor.d.ts:24-31`). `EditorTheme` requires `borderColor` + `selectList: SelectListTheme`. Build a minimal literal from `theme.fg("border", ...)` plus `getSettingsListTheme()`-style helpers, or crib the `setEditorComponent` factory pattern (`docs/tui.md:880`).

**`promptAndSendToRun` signature change.** Today the function is `async promptAndSendToRun(agentId: string): Promise<void>` (`src/index.ts:138-191`). New signature:

```
async function promptAndSendToRun(
  agentId: string,
  presuppliedText?: string,
): Promise<void>
```

When `presuppliedText` is provided **and non-empty after trim**, the `ctx.ui.input` modal call (lines 158-167) is skipped; the trimmed text is used as `message`. **All other steps run unchanged**: `registry.get` → `validateSendable` pre-check → persona resolution via `resolved.personas.get(run.persona)` → `resolveTimeoutMs` → `sendToRun({ ..., onComplete: opts.pushCompletionNotification })` → rejection notify. The persona-resolution block (lines 175-181) is unaffected. Empty/whitespace `presuppliedText` returns early without calling `sendToRun`. Done as a single commit in this slice — not split out as a precursor.

---

## 10. Re-render contract

Today: registry change → `model.refresh()` → nothing requests a re-render → reliance on host scheduler tick. `Component.invalidate()` is a no-op (`focused-stream-overlay.ts:307`).

Fix: extend the existing session-scoped subscription with a coalescer + `requestRender` edge.

```
RunRegistry.onChange ─▶ rerenderCoalescer.schedule()
                                 │ (50 ms window, leading edge)
                                 ▼
                          model.refresh()
                          tui.requestRender()
```

Implementation notes:

- **Extend the existing subscription, do not add a new one.** `installFocusedOverlayShortcut` already wires `subscribeToRegistry: () => registry.onChange(() => focusModel.refresh())` once per session (`src/index.ts:328`). The fix is to widen that callback in-place so it also `coalescer.schedule()`s a `tui.requestRender()`. The `tui` handle (and the coalescer) are passed in as new dependencies to `installFocusedOverlayShortcut`. **Not** registered in the per-overlay factory: `focused-overlay-factory.ts:8-16` has an explicit comment warning that per-open listener registration leaks one entry per overlay open. Honour it.
- Coalesce window: 50 ms, matching the existing inline-stream throttle (`PRD.md` background; foreground card uses the same window). Leading-edge fire so the first event in a quiet window paints immediately; trailing-edge fire after the window so the last event isn't lost.
- Subscription lifetime: registered once per session, torn down on session unload via the existing `unsubFocusedShortcut` path (`src/index.ts:321`).
- **`Component.invalidate()` is a real obligation, not a courtesy.** Once `TranscriptPane` (or any subcomponent) starts caching rendered slices, `invalidate()` MUST clear that cache. The current no-op (`focused-stream-overlay.ts:307`) is acceptable only while there is no cache; introducing one without wiring `invalidate()` is a correctness bug, not a style nit.
- `handleInput` paths that mutate the model also call `tui.requestRender()` directly (already the pi-tui norm — `docs/tui.md:288`).

---

## 11. Keybinding map

| Key | Default mode | Input-pane-open mode |
|---|---|---|
| `Esc` | Close overlay | Close input pane (return to default) |
| `Tab` / `Sh-Tab` | Cycle agent forward / back | (passthrough to Editor: nothing) |
| `↑` / `↓` | Scroll 1 (breaks stickToTail) | (Editor: cursor) |
| `PgUp` / `PgDn` | Scroll 10 | (Editor: cursor) |
| `Home` / `g` | Jump to top, stickToTail=false | (Editor: cursor) |
| `End` / `G` | Jump to tail, stickToTail=true | (Editor: cursor) |
| `s` | Open input pane | (Editor: literal `s`) |
| `c` | Toggle collapse-tool-calls | n/a |
| `t` | Toggle show-thinking | n/a |
| `e` / `E` | Expand-all / collapse-all blocks | n/a |
| `k` | Begin kill confirmation (footer-row swap; see below) | n/a |
| `y` / `Y` | Confirm kill (only while `pendingKillConfirm` is set) | n/a |
| `n` / `N` | Cancel kill confirmation | n/a |
| `Enter` | (no-op in v1; v2: expand selected fold) | Submit & close pane |
| `Ctrl-Enter` | n/a | Newline in Editor |

`Home/g`, `End/G`, `e/E` are net-new bindings. Remainder is today's set with bounded scrolling.

**Kill confirmation flow (net new).** Today, `k` calls `onKill` synchronously with no confirmation (`src/focused-stream-overlay.ts:199-205`). New behaviour:

- On `k`, the model sets `pendingKillConfirm = focused.id` (string, not boolean — survives Tab cycles defensively but is invalidated by them; see below).
- Footer-row content swaps to a single confirm row: `Kill <agentId>? [y/N]`. **Non-modal — no popup, no overlay-on-overlay.** Body and header keep rendering.
- `y` / `Y` → fire `onKill(pendingKillConfirm)`, then clear `pendingKillConfirm`. Footer reverts.
- `n` / `N` / `Esc` → clear `pendingKillConfirm`, footer reverts. Esc does **not** close the overlay while confirm is pending.
- `Tab` / `Shift-Tab` while confirm is pending → cancel the confirm (clear), then cycle. Avoids "confirmed kill on the wrong agent" if the user cycled mid-decision.
- Any other key while confirm is pending → cancel the confirm and pass through to its normal binding.

Model addition: `pendingKillConfirm: string | null`. Pure state; no I/O.

---

## 12. Migration plan

| File | Action |
|---|---|
| `src/transcript.ts` | **Keep, light edits.** Add `fold` line emission for tool-call JSON cap (§6) and thinking cap. No structural change. |
| `src/transcript-classify.ts` | **Keep, extend.** Add `"fold"` LineKind; map `⋯` prefix. |
| `src/transcript-style.ts` | **Keep, extend.** Theme slot for `fold` = `dim`. |
| `src/focused-stream-model.ts` | **Extend.** Add `stickToTail`, `inputPaneOpen`, `_foldExpanded`, `pendingKillConfirm`, `jumpToTail`, viewport-aware scroll clamp, `activeList()` foreign-pid filter (§15). Pure. |
| `src/focused-stream-overlay.ts` | **Rewrite.** New root Component (Container-based), HeaderZone / BodyZone / FooterZone children. Mostly composes existing pure renderers. Old flat-string render path is the fallback we delete. |
| `src/focused-overlay-factory.ts` | **Rewrite.** Wire `getViewportHeight` (today's omission), pass `tui` handle for `requestRender`, instantiate Editor for InputPane. |
| `src/focused-overlay-shortcut.ts` | **Light edit.** Add too-small-terminal guard (§3). Re-render edge stays here. |
| `src/index.ts:113–125` | **Edit.** Add `overlayOptions` block (§3). |
| `src/index.ts:328` | **Edit.** Wire registry change → coalescer → `tui.requestRender()`. |
| `src/index.ts ~promptAndSendToRun` | **Edit.** Accept optional pre-supplied text to skip `ctx.ui.input`. |
| Tests | New file `tests/focused-overlay-layout.test.ts` (Box composition shape). Extend `focused-stream-model.test.ts` for stickToTail / fold / input-pane / clamped scroll. |
| **Net new** | `src/input-pane.ts` (Container + Editor wrapper, focusable). |

---

## 13. Test strategy

- **Unit (model).** `focused-stream-model.test.ts` extended: stickToTail transitions across scrollUp/Down/End/Home/refresh; input-pane open/close idempotency; fold per-block override; `jumpToTail` math; per-agent state restoration on cycle. ~12 new cases.
- **Unit (renderer).** `transcript.test.ts` gains fold-cap cases for tool-call JSON > 12 lines and thinking > 20 lines; assert exact fold-line shape.
- **Component (Box layout).** New `focused-overlay-layout.test.ts`: stub `process.stdout.rows`, render the root, assert the line stream contains expected border rows in expected positions, assert body rows count == computed `bodyRows`, assert input-pane open vs closed line counts differ by `INPUT_PANE_ROWS`. Pure-string assertions; no PTY.
- **Component (re-render).** New small test that wires a fake registry, fires `onChange`, advances a fake clock past the coalesce window, asserts `tui.requestRender` was called once (leading-edge fire) and again at trailing edge if a second event landed.
- **PTY/tmux snapshot — DEFERRED.** Inspector noted no PTY harness exists. Recommend adding `node-pty` + an ANSI-screen golden in a follow-up slice; out of scope here. Until then, the only way to prove "looks right in tmux" remains manual smoke. Capture two screenshots in the slice's PR description (default + input-pane open) as a workaround.
- **Manual smoke.** (a) Default 100×30 tmux pane: open overlay, verify 1-cell margin, scroll to bottom while spawn streams (stickToTail), open input pane, send, close. (b) 70×18 (min): verify still usable. (c) 60×16 (sub-min): verify shortcut surfaces "too small" message and does not open.

---

## 14. Resolved decisions (was: open questions)

1. **Border slot** — confirmed available in `Theme.fg` (`docs/tui.md:412`). Use directly.
2. **Height query** — use `tui.terminal.rows` / `.columns` (`pi-tui/dist/terminal.d.ts:18-19`, `tui.d.ts:135`); `process.stdout.rows` only as a test-time fallback.
3. **`promptAndSendToRun` signature change** — single commit in this slice; spec'd in §9.
4. **Fold cursor** — deferred. v1 ships `e/E` global toggle only; per-block Enter-to-expand is a follow-up.
5. **Input pane component** — `Editor` (multi-line). `sendToRun` accepts arbitrary string content including newlines.
6. **Visibility threshold** — 80×20 (Brazil terminal default; chrome math leaves comfortable slack).

No open questions remain at design time.

---

## 15. Risks, defenses & rollback

### Defensive foreign-agent filter

`reconcileOrphansAtStartup` currently re-adopts every alive `running` record on disk into the local `RunRegistry` regardless of which pi process spawned it (`src/reconcile-startup.ts:248`, classifier at `:104-127`, liveness probe at `:151-159`). Fix is in flight in a parallel slot (adds `parentPid` + `parentStartTime` to `RunRecord` and skips foreign records in `classifyRecord`).

Until that lands, this overlay's Tab cycle will include foreign agents and `s` / `k` against them is unsafe — `forceTerminate` would mutate the foreign owner's `record.json` to `status=killed` (no SIGTERM dispatched because `proc` is undefined for readopted runs, but disk state would be corrupted; queue-starvation is also a real symptom).

**Defensive gate:** `FocusedStreamModel.activeList()` filters runs whose `parentPid !== process.pid`. One-line check, harmless after the reconcile fix lands. Cite `src/reconcile-startup.ts:248` in the implementation comment so the filter's removal is discoverable when the upstream fix is verified.

### Risks


| Risk | Likelihood | Mitigation |
|---|---|---|
| pi-tui `Box`/border ASCII looks worse than today's flat lines on certain themes | Medium | Theme-driven; if `border` slot absent, fall back to flat ASCII (existing rulers). Snapshot tests pin shape. |
| `process.stdout.rows` lies in tmux during fast resizes → arithmetic off-by-one | Low | Re-clamp scroll on every render; +/-1 row is cosmetic. |
| Editor focus-stealing breaks IME for parent conversation when overlay closes | Medium | Container-Focusable propagation per `docs/tui.md:64–82`. Manual smoke on CJK input. |
| Coalesce window hides the last event when `stickToTail` is on | Low | Trailing-edge fire guarantees final paint; tested in §13. |
| Net new file `input-pane.ts` adds another disposable that leaks if dispose path forgets it | Low | Disposed via root Component teardown when overlay closes; tested via factory test. |
| Loss of empty-state polish landed in v0.8.3 Slice 10 | Low | Empty-state branch preserved in BodyZone (no focused run → renderEmpty into a single child). |

**Rollback story.** All net-new behaviour is gated behind the rewrite of `focused-stream-overlay.ts` + the `overlayOptions` mount edit in `index.ts` + the `promptAndSendToRun` signature change. Reverting the slice's commits returns to the v0.8.3 chrome-polish state. No persisted state, no schema change. No feature flag needed; PR can be reverted cleanly. The defensive foreign-pid filter (§15) survives rollback as a tiny independent improvement to `activeList()`.

---

## 16. Source citations

- `src/index.ts:113–125, 328, 391–419` — mount, registry subscription, stall-warn shim.
- `src/focused-stream-overlay.ts:30–44, 92–97, 270–308` — `getViewportHeight`, scroll model, render entry, no-op invalidate.
- `src/focused-overlay-factory.ts:60–73` — factory misses `getViewportHeight`.
- `src/focused-stream-model.ts:92–97` — unbounded scrollDown.
- `src/transcript.ts:30–112, 195–207, 245–264` — header, thinking, tool-call expanded JSON.
- `docs/tui.md:24, 64–82, 120–145, 185, 207, 221, 244, 288` — Component contract, Focusable, overlayOptions, primitives, requestRender.
- `docs/v0.8.2-backlog.md:661–664` — prior `Box` deferral.
- `docs/v0.8.3-item3-design.md` — chrome-polish predecessor.
- `PRD.md:283–296` — original spec.
