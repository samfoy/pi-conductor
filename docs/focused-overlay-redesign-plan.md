# Plan: Focused-stream overlay redesign

Status: plan (no code).
HEAD at planning time: `0acb87a`.
Source: `docs/focused-overlay-redesign-design.md` (oracle-gated revision, 2026-05-22).

8 slices, each independently green (`npm test` + `npx tsc --noEmit`), single Conventional Commit, vertical and verifiable. Test-first per slice.

---

## 1. Slice list

| # | Title | Net change | Visible? | Tests Δ | LOC est. |
|---|---|---|---|---|---|
| 1 | Mount discipline + viewport wiring + too-small fallback | `overlayOptions` block, `getViewportHeight` wired, shortcut declines to open below 80×20 with `ctx.ui.notify` | ✅ resurrects scroll hint + centred empty state, kills tmux overflow | +5 | ~120 |
| 2 | Defensive foreign-pid filter in `activeList()` | One-liner gate, harmless once reconcile fix lands | safety net | +1 | ~30 |
| 3 | Registry → coalescer → `tui.requestRender()` | 50ms leading+trailing, extends existing session subscription | ✅ live updates stop relying on host scheduler tick | +3 | ~150 |
| 4 | Bounded scroll + `stickToTail` + `Home/g` `End/G` | Per-agent latch, viewport-aware clamps in model | ✅ auto-follow-tail, can't mash past content | +12 | ~220 |
| 5 | Fold caps for tool-call JSON + thinking + `e/E` toggle | New `LineKind="fold"`, 12/20-line caps, global expand-all/collapse-all | ✅ no more 200-line JSON walls | +8 | ~200 |
| 6 | Three-zone chrome rewrite (HeaderZone/BodyZone/FooterZone) | Container-based root, ASCII border rules, `Component.invalidate` honoured | ✅ visible bordered modal | +10 | ~360 |
| 7 | Split-pane input on `s` + `promptAndSendToRun(id, text?)` | New `input-pane.ts`, `Editor` child, signature change, footer mode swap | ✅ no more modal-on-modal send | +8 | ~280 |
| 8 | `k` y/N kill confirmation row | `pendingKillConfirm` state, contextual footer, Tab cancels | ✅ guard against accidental kill | +6 | ~120 |

Total: ~1,480 LOC across product+tests; biggest single slice (#6) ~360 LOC. All under the 300-LOC product-only target.

---

## 2. Per-slice spec

### Slice 1 — Mount discipline + viewport wiring + too-small fallback

**Commit subject:** `fix(overlay): anchor focused-stream modal at 95×90% with viewport wiring`

**Files touched:**
- `src/index.ts` (mount block ~113–125)
- `src/focused-overlay-factory.ts` (60–73, missing `getViewportHeight`)
- `src/focused-overlay-shortcut.ts` (too-small guard)
- `tests/focused-overlay-factory.test.ts`
- `tests/focused-overlay-shortcut.test.ts`

**Behaviour:**
- `ctx.ui.custom(..., { overlay: true, overlayOptions: { width:"95%", maxHeight:"90%", minWidth:60, anchor:"center", margin:1 } })`. **No `visible:` predicate** — pi-tui's `visible` would open-then-suppress and swallow the notify. Single source of truth for the threshold is the shortcut-side guard below.
- Factory passes `getViewportHeight: () => tui.terminal.rows ?? process.stdout.rows ?? 24` through to overlay component.
- Shortcut handler reads `tui.terminal.rows`/`columns`; if `<80×20` calls `ctx.ui.notify("Focused overlay needs ≥80×20 terminal", "warning")` and returns without opening.

**Tests added (specific):**
- `focused-overlay-factory.test.ts`: extend — `wires getViewportHeight from injected source`, `viewport rows propagate to renderEmpty centring`, `viewport rows propagate to renderScrollHint`.
- `focused-overlay-shortcut.test.ts`: extend — `declines to open when terminal columns<80`, `declines to open when rows<20`, `notify called with warning level when below threshold`, `opens normally at 80×20`.

**Acceptance:**
- `tests/focused-overlay-factory.test.ts` exercises non-zero `viewportHeight` in production code path (today only tests pass it; design §3, factory bug at `focused-overlay-factory.ts:60–73`).
- `renderScrollHint` returns a non-null line when transcript exceeds viewport (today suppressed because `viewportHeight<=0`, `focused-stream-overlay.ts:372`).
- Manual: open overlay in a 200×60 tmux pane → 1-cell margin visible; resize to 70×17 → overlay does not open, warning notify shown.

**Dependencies:** none.

**Risk + rollback:** `tui.terminal.rows` may differ from `process.stdout.rows` in headless tests — design §3 mandates fallback chain. If `overlayOptions` percentages misbehave, revert this single commit; behaviour returns to v0.8.3 (overflowing but functional).

---

### Slice 2 — Defensive foreign-pid filter throughout focus model

**Commit subject:** `fix(overlay): gate focused-stream model against foreign-pid runs`

**Files touched:**
- `src/focused-stream-model.ts` (private `isLocal(run)` helper; gate `activeList()`, `refresh()` default-focus pick, `focused()` accessor, `cycleNext`/`cyclePrev` already use `activeList()`)
- `tests/focused-stream-model.test.ts`

**Behaviour:**
- `Run.parentPid` already exists (`src/types.ts:333`, populated at `src/runs.ts:766`). Read directly — no cast.
- New private `isLocal(run): boolean` returns `run.parentPid === undefined || run.parentPid === process.pid`. (Undefined treated as "trust local" for legacy records; the field is required for new spawns.)
- `activeList()` filters via `isLocal`.
- `refresh()` (`focused-stream-model.ts:28`) routes through `activeList()` (or `.filter(isLocal)`) when picking the default focus and when validating an existing `_focusedId` is still present.
- `focused()` (`:41-43`) returns `undefined` when the resolved run is non-local — defence against a foreign run sneaking in via stale `_focusedId`.
- Inline comment on `isLocal` cites `src/reconcile-startup.ts:248` so the gate's removal is discoverable when the upstream reconcile fix is verified end-to-end.

**Tests added:**
- `focused-stream-model.test.ts`: extend — `activeList() excludes run with foreign parentPid`, `activeList() includes run with parentPid===process.pid`, `activeList() includes run with no parentPid (legacy)`, **`refresh() ignores foreign-pid run when picking default focus`**, **`refresh() drops _focusedId when current run becomes foreign`**, **`focused() returns undefined when stored _focusedId resolves to a foreign run`**.

**Acceptance:**
- Tab cycle, default focus selection, and `focused()` accessor all skip foreign runs uniformly.
- New tests fail on stub `Run` records with `parentPid: 999_999`; pass after the gate.

**Dependencies:** none. `parentPid` already shipped (`src/types.ts:333`, `:453`).

**Risk + rollback:** filter is a single helper; revert one commit. No regression possible.

---

### Slice 3 — Registry → coalescer → `tui.requestRender()`


**Commit subject:** `fix(overlay): coalesce registry events into 50ms requestRender window`

**Files touched:**
- `src/focused-overlay-shortcut.ts` (extend `installFocusedOverlayShortcut` signature with `tui` dep + new coalescer)
- `src/index.ts` (~328 — pass `tui` through to shortcut, replace one-liner subscription with coalescer-aware version)
- `src/rerender-coalescer.ts` (new, ~40 LOC; pure timer helper)
- `tests/rerender-coalescer.test.ts` (new)
- `tests/focused-overlay-shortcut.test.ts`

**Behaviour:**
- Pure `RerenderCoalescer` with `schedule()` method, leading-edge fire + trailing-edge fire after window quiescence. Injectable clock and `setTimeout`.
- `installFocusedOverlayShortcut` widens the registry callback: `model.refresh(); coalescer.schedule(() => tui.requestRender())`.
- `Component.invalidate()` remains no-op for now (no cache yet) — but a comment marks the obligation per design §10. Slice 6 enforces it when caching arrives.

**Tests added:**
- `rerender-coalescer.test.ts`: `fires leading-edge synchronously`, `fires trailing-edge once after quiet window`, `coalesces N events in window into 2 fires (leading+trailing)`, `does not fire trailing if no event lands during window`, **`burst then quiesce paints final frame`** (covers the stickToTail-last-event concern from design §15 directly here, not deferred to slice 4).
- `focused-overlay-shortcut.test.ts`: extend — `registry onChange triggers tui.requestRender exactly once on leading edge`, `multiple onChange in 50ms window produce one trailing tui.requestRender`.

**Acceptance:**
- No new listener registrations per overlay open (honour `focused-overlay-factory.ts:8–16` warning); only the existing session-scoped subscription is widened.
- `tui.requestRender` is called from outside `render()` (preserves O6 render-purity invariant — design §16, prior slice 11).

**Dependencies:** slice 1 helpful but not required (the coalescer is independent of mount geometry).

**Risk + rollback:** if the coalescer's trailing-edge logic drops the last event under stick-to-tail, slice 4 will surface it via the model's tail-anchor test. Revert this commit alone restores prior behaviour (live updates remain on host scheduler tick).

---

### Slice 4 — Bounded scroll + `stickToTail` + `Home/g` `End/G`

**Commit subject:** `feat(overlay): auto-follow-tail and viewport-bounded scroll`

**Files touched:**
- `src/focused-stream-model.ts` (constructor accepts `getMetrics: () => { bodyRows: number; transcriptLength: number }`; add `_stickToTailPerAgent`, `setStickToTail`, `stickToTail()`, `jumpToTail()`; rewrite `scrollUp(n)` / `scrollDown(n)` to consult `getMetrics()` for the clamp + stickToTail latch — **no width/height args added to mutators**, keeping `Component.handleInput` callsites parameter-free)
- `src/focused-overlay-factory.ts` (build the `getMetrics` closure: `bodyRows` from the same arithmetic as `getViewportHeight`, `transcriptLength` from a transcript-cache reference held by the overlay component; pass to `FocusedStreamModel` constructor)
- `src/focused-stream-overlay.ts` (expose the transcript-length value the factory's `getMetrics` reads — populated as a pure side-output of `render()` into a getter, NOT a state mutation; bind `Home/g`/`End/G`; reset stickToTail on tab cycle restore via existing per-agent state map)
- `tests/focused-stream-model.test.ts`
- `tests/focused-stream-overlay.test.ts`

**Data-flow decision (oracle gate fix):** `Component.handleInput(data)` has no width/height parameter. Of the three options (overlay caches metrics post-render and reads in handleInput / overlay re-renders inside handleInput / model takes a metrics injection), **picked (c): `getMetrics` injection at construction time**. Cleanest, no double-render, no purity violation. The factory closes over `tui.terminal.rows` (live) and a transcript-length getter the overlay exposes from its last cached slice computation. The transcript-length getter is read-only on the overlay; updating its underlying value happens during render via the cache that slice 6 introduces (until then, the overlay computes transcript length lazily inside the getter — pure, recomputable, cheap).

**Behaviour:** per design §5 transition table.

**Tests added:**
- `focused-stream-model.test.ts`: extend — `model takes getMetrics injection`, `scrollDown clamps at bottom (per getMetrics)`, `stickToTail latches on at bottom`, `stickToTail latches off on user-up`, `End/G resets stickToTail=true and snaps to bottom`, `Home/g sets stickToTail=false and offset=0`, `refresh while stickToTail keeps offset at new bottom (re-reads getMetrics)`, `refresh without stickToTail leaves offset alone`, `Tab cycle restores per-agent (offset, stickToTail) pair`, `resize (getMetrics returns new bodyRows) re-clamps offset on next mutation`.
- `focused-stream-overlay.test.ts`: extend — `Home key dispatches model.scrollUp to top`, `End key dispatches model.jumpToTail`, `g/G shortcuts mirror Home/End`, `factory wires getMetrics closure with live tui.terminal.rows`.

**Acceptance:**
- `scrollDown` cannot increment past `bottom = max(0, transcriptLineCount - bodyRows)` (today's bug at `focused-stream-model.ts:92–97`).
- Live-streaming agent: every refresh tick keeps the latest line visible without user intervention.
- `End`/`G` re-arms after a user `↑`.

**Dependencies:** slice 1 (viewport rows wired) + slice 3 (refresh tick reliable) recommended; not strictly blocking — model takes `viewportRows` as an arg.

**Risk + rollback:** revert restores unbounded scroll; no regression beyond losing auto-follow.

---

### Slice 5 — Fold caps for tool-call JSON + thinking + `e/E` toggle

**Commit subject:** `feat(overlay): cap expanded tool-call and thinking blocks with fold marker`

**Files touched:**
- `src/transcript.ts` (`renderToolCall` expanded JSON branch ~245–264, `renderThinking` ~195–207)
- `src/transcript-classify.ts` (new `LineKind = "fold"`)
- `src/transcript-style.ts` (theme slot for `"fold"` → `dim`)
- `src/focused-stream-model.ts` (`_foldExpanded: Map<string,boolean>`, `expandAll()`, `collapseAll()`, `isExpanded(key, default)`)
- `src/focused-stream-overlay.ts` (bind `e`/`E`; pass `model.isExpanded` into renderer signature)
- `tests/transcript-classify.test.ts`
- `tests/transcript-style.test.ts`
- `tests/focused-stream-model.test.ts`
- new `tests/transcript-fold.test.ts`

**Behaviour:**
- Tool-call expanded JSON > 12 lines → first 12 + `  ⋯ N more lines  (e expand all · E collapse all)` (`fold` LineKind).
- Thinking body > 20 lines (when `showThinking=true`) → first 20 + same fold marker.
- `e` = expand-all (sets `_foldExpanded` true for all visible block keys); `E` = collapse-all (clears map). Matches design §11 binding table verbatim. Footer hint disambiguates: `e:expand all  E:collapse all`. Note: this is **opposite** to vim/less convention (lower=collapse, upper=expand) — the design choice is intentional (lowercase = additive/expand, uppercase = destructive/collapse). Cite design §11 in the commit body.
- Per-block Enter is **explicitly out of scope v1** (design §6, §11).

**Tests added:**
- `transcript-fold.test.ts`: `tool-call JSON < 12 lines emits no fold line`, `tool-call JSON > 12 lines emits exact fold line shape`, `thinking < 20 lines no fold`, `thinking > 20 lines fold present`, `expanded override bypasses cap`, `collapse override re-applies cap`.
- `transcript-classify.test.ts`: extend — `classifies ⋯-prefixed line as fold`.
- `transcript-style.test.ts`: extend — `fold slot themed with dim`.
- `focused-stream-model.test.ts`: extend — `expandAll/collapseAll mutate _foldExpanded`, `isExpanded falls back to default when key absent`.

**Acceptance:**
- A tool call with 200-line JSON args produces exactly 13 transcript lines (12 + fold) by default; `e` expands to 200.
- Existing tests in `transcript-classify.test.ts` / `transcript-style.test.ts` remain green.

**Dependencies:** slice 4 helpful (refresh on toggle); not strictly required.

**Risk + rollback:** the `(e expand all)` hint in the marker becomes a lie if slice 6 changes binding letters — they don't, per design §11. Revert restores unbounded JSON walls.

---

### Slice 6 — Three-zone chrome rewrite (HeaderZone/BodyZone/FooterZone)

**Commit subject:** `feat(overlay): bordered three-zone modal chrome with Container layout`

**Files touched:**
- `src/focused-stream-overlay.ts` (rewrite — root is `Container`-composed; flat-`string[]` path deleted; `invalidate()` now clears any internal slice cache)
- `src/focused-overlay-factory.ts` (compose Header + Body + Footer; pass `tui.terminal` for height arithmetic)
- `tests/focused-stream-overlay.test.ts` (rewrite-adjacent)
- new `tests/focused-overlay-layout.test.ts`

**Behaviour:** per design §2, §7. Header (4 rows: top border, status, mid-rule, optional spare), Body (computed rows; renders `transcript.ts` slice; bottom-row scroll breadcrumb when clipped), Footer (3 rows: rule, hints, bottom border). Borders drawn via `Text` rows themed with `theme.fg("border", …)` (slot confirmed at `docs/tui.md:412`).

**Tests added:**
- `focused-overlay-layout.test.ts`: stub `tui.terminal.rows=30, columns=100`. `renders top border ╭…╮ on row 0`, `renders bottom border ╰…╯ on last row`, `body rows == overlayRows - HEADER_ROWS - FOOTER_ROWS`, `body line count fits viewport exactly when transcript longer`, `body shows breadcrumb on bottom row when clipped`, `empty state preserved when no focused run` (carry forward v0.8.3 polish per design §15).
- `focused-stream-overlay.test.ts`: existing render-shape tests adjusted to the new chrome (border lines added at known positions; assertions tightened).

**Acceptance (merge-blocking):**
- Existing `transcript.ts` / `-classify` / `-style` modules are not modified (design §2, §12).
- `Component.invalidate()` clears the slice cache (write a test that calls it twice and asserts the cache is empty per design §10).

**Acceptance (PR-description checkbox, NON-merge-blocking):**
- Manual smoke: 100×30 tmux → bordered modal with 1-cell margin, three zones distinct, no overflow. Critic must not reject a green PR for a missing screenshot — flag if absent, do not block.

**Dependencies:** slice 1 (viewport wired) — required.

**Risk + rollback:** biggest slice. If border characters render badly on a theme without `border` slot, fall back to flat ASCII (already the v0.8.3 pattern). Revert returns to v0.8.3 chrome-polish state. Snapshot tests in `focused-overlay-layout.test.ts` pin shape regressions.

---

### Slice 7 — Split-pane input on `s` + `promptAndSendToRun(id, text?)`

**Commit subject:** `feat(overlay): inline split-pane send via Editor on s`

**Files touched:**
- `src/input-pane.ts` (new — `Container` + `Editor` child, focusable, owns separator+hint rows)
- `src/focused-stream-model.ts` (`_inputPaneOpen`, `openInputPane()`, `closeInputPane()`, `inputPaneOpen()`)
- `src/focused-overlay-factory.ts` (instantiate Editor with minimal `EditorTheme` literal — `borderColor` from `theme.fg("border", …)`, `selectList` cribbed from `setEditorComponent` factory pattern at `docs/tui.md:880`)
- `src/focused-stream-overlay.ts` (root focus delegation when input pane open; body height shrinks by `INPUT_PANE_ROWS=6`; `s` opens, `Esc` closes, `Enter` submits then closes; whitespace-only no-ops)
- `src/index.ts` (`promptAndSendToRun(agentId, presuppliedText?: string)` signature change — when text provided & non-empty after trim, skip `ctx.ui.input` modal but **preserve** `validateSendable`, persona-resolution at lines 175–181, `resolveTimeoutMs`, `sendToRun` with `pushCompletionNotification`, rejection notify; ~138–191)
- `src/focused-overlay-factory.ts` callsite for `promptAndSendToRun` updated to forward Editor buffer
- `tests/input-pane.test.ts` (new)
- `tests/focused-stream-model.test.ts`
- `tests/focused-stream-overlay.test.ts`
- `tests/promptAndSendToRun.test.ts` (new or extend the most-direct existing test)

**Behaviour:** per design §9, §11.

**Tests added:**
- `input-pane.test.ts`: `renders separator + prompt + Editor + hint`, `Esc closes pane and restores focus`, `Enter submits buffer then closes`, `Ctrl-Enter inserts newline (Editor passthrough)`, `whitespace-only Enter no-ops then closes`, `pane disposed on overlay close (no leak)`.
- `focused-stream-model.test.ts`: extend — `openInputPane is idempotent`, `closeInputPane is idempotent`, `body height arithmetic excludes INPUT_PANE_ROWS when closed and includes when open`.
- `focused-stream-overlay.test.ts`: extend — `s key opens pane in default mode`, `s key is consumed by Editor when pane open (no second open)`, `pane open keys (↑↓ etc) passthrough to Editor`, `stickToTail re-anchors to new bottom on pane open`.
- `promptAndSendToRun.test.ts`: `presuppliedText empty after trim → no sendToRun call, no notify`, `presuppliedText non-empty → ctx.ui.input is NOT called`, `presuppliedText non-empty → validateSendable still runs`, `presuppliedText non-empty → sendToRun called with trimmed text`, `presuppliedText non-empty → persona resolution still runs`, `rejection branch still notifies`.

**Acceptance:**
- Sending from the input pane never opens a `ctx.ui.input` modal.
- Closing overlay while pane open disposes Editor cleanly (no listener leak — covered in test).
- IME smoke: focus propagation through `Container` → `Editor` per `docs/tui.md:64–82`. Manual CJK test in PR description.

**Dependencies:** slice 6 (chrome rewrite establishes BodyZone hosting). Slice 4 recommended (stickToTail re-anchor on pane open).

**Risk + rollback:** Editor focus-stealing on overlay close (medium per design §15) — covered by Container-Focusable propagation. Revert returns send to modal-on-modal `ctx.ui.input` flow.

---

### Slice 8 — `k` y/N kill confirmation row

**Commit subject:** `feat(overlay): y/N confirmation before forceTerminate on k`

**Files touched:**
- `src/focused-stream-model.ts` (`pendingKillConfirm: string | null`, `beginKillConfirm(id)`, `cancelKillConfirm()`)
- `src/focused-stream-overlay.ts` (footer-row swap when `pendingKillConfirm` set; bind `y/Y`, `n/N`, Esc, Tab; "any other key cancels" rule)
- `tests/focused-stream-model.test.ts`
- `tests/focused-stream-overlay.test.ts`

**Behaviour:** per design §11 kill-confirmation flow.

**Tests added:**
- `focused-stream-model.test.ts`: extend — `beginKillConfirm sets pendingKillConfirm to focused id`, `cancelKillConfirm clears`, `pendingKillConfirm cleared on Tab cycle`.
- `focused-stream-overlay.test.ts`: extend — `k sets pendingKillConfirm`, `y while pending fires onKill and clears`, `n clears without firing onKill`, `Esc while pending clears (does not close overlay)`, `Tab while pending clears then cycles`, `arbitrary key while pending cancels and passes through to its binding`, `footer line shows "Kill <agentId>? [y/N]" while pending`.

**Acceptance:**
- Today: `k` calls `onKill` synchronously (`focused-stream-overlay.ts:199–205`). After this slice: `onKill` is only called via `y`/`Y` after the prompt.
- No popup, no overlay-on-overlay; footer-row swap is the only visual change.

**Dependencies:** slice 6 (footer is now its own zone — easier to swap rows).

**Risk + rollback:** if a user reflexively types `y` after `k` they'll still kill — by design. Revert restores instant-kill behaviour.

---

## 3. Sequencing rationale

- **1 → 2 → 3 are plumbing/safety.** Slice 1 (mount) is the largest UX win per LOC and is a prerequisite for slice 6's chrome arithmetic. Slice 2 (foreign-pid filter) is a safety net that ships independently of the parallel reconcile-startup work. Slice 3 (re-render) fixes the silent live-update lottery without touching the renderer.
- **4 → 5 are pure-model + pure-renderer wins** that don't require chrome to land. Sequencing them before slice 6 keeps slice 6 tightly scoped to layout — it only composes already-correct pieces.
- **6 is the structural rewrite.** Lands once the model + renderer pieces are stable; the rewrite then mostly composes existing pure modules per design §2, §12. Largest slice but lowest novelty.
- **7 → 8 ride on the chrome.** Slice 7 needs BodyZone/FooterZone to host the InputPane and footer-mode swap. Slice 8 needs FooterZone to swap rows cleanly.

Visible relief lands as early as slice 1; the "big visual reveal" is slice 6.

---

## 4. Cross-cutting concerns

- **Render purity (design §10, prior slice 11).** Across all slices, `render()` MUST remain side-effect-free. Mutations live in `handleInput` and the registry-onChange callback. Slice 3 widens the callback; slice 6 enforces `Component.invalidate()` semantics.
- **Footer-binding table (design §11).** New bindings (`Home/g`, `End/G`, `e/E`, `y/n`) thread through slices 4, 5, 8. Each slice extends `FOOTER_BINDINGS` (single source of truth at `focused-stream-overlay.ts:144–235`); critic check: hint table and dispatch stay aligned within each commit.
- **Theme slot usage (design §7, §15).** Border slot consumed by slice 6; fold slot added in slice 5. Both confirmed available — `docs/tui.md:412`.
- **Re-render contract (design §10).** Slices 3, 4, 6 must not register additional registry listeners — only the one in `installFocusedOverlayShortcut` per `focused-overlay-factory.ts:8–16` warning.
- **Reuse over rewrite of pure modules (design §12).** `transcript.ts`/`-classify`/`-style` are extended (slice 5) but not rewritten in slice 6.

---

## 5. Out-of-scope (do not slice)

- Search inside transcript (design §1 non-goals).
- Copy-to-clipboard, mouse, history scrubbing, persistent layout settings (design §1).
- General-purpose pi-tui scrollable-region primitive — flagged as upstream gap (design §2 closing note, §14).
- PTY / tmux ANSI snapshot harness — recommend follow-up slice with `node-pty` (design §13).
- Per-block fold cursor + Enter-to-expand (design §6, §11 — explicitly v2).
- Multi-pane layouts beyond transcript+input (design §1).
- Reconcile-startup parent-pid fix — owned by parallel slot.

---

## 6. Pre-flight checks (before slice 1)

| Check | Status |
|---|---|
| `Theme.fg` `border` slot exists | ✅ confirmed `docs/tui.md:412` (design §14 ✓) |
| `tui.terminal.rows` / `.columns` accessible from extension | ✅ confirmed `pi-tui/dist/terminal.d.ts:18-19`, `tui.d.ts:135` |
| `Editor` exported from `@earendil-works/pi-tui` | ✅ confirmed `pi-tui/dist/components/editor.d.ts:33,68` (constructor `(tui, theme: EditorTheme, options)`) |
| `EditorTheme` shape (`borderColor` + `selectList: SelectListTheme`) reachable from extension theme | ⚠️ verify in slice 7 — design §9 cribs the `setEditorComponent` factory pattern (`docs/tui.md:880`); minimal literal acceptable |
| `Container` accepts heterogeneous `Component` children with no native vertical-split height API | ✅ confirmed; pi-tui gap acknowledged (design §2 closing note) |
| `ctx.ui.notify(msg, level)` | ✅ used 5× in `src/index.ts` (oracle nit confirmed) |
| `parentPid` field on `Run`/`RunRecord` | ✅ already shipped (`src/types.ts:333, :453`, populated `src/runs.ts:766`); slice 2 reads `run.parentPid` directly |

Run pre-flight before slice 1: `npm test && npx tsc --noEmit` on `0acb87a` to confirm green baseline.

---

## 7. Risks the planner identified

1. **Slice 6 size.** Cleanly contained because pure renderers are reused, but the layout-test file is new and the rewrite touches the densest file in `src/`. Mitigation: slices 4 and 5 land first, shrinking slice 6's responsibilities to layout only.
2. **Slice 7 Editor theme literal.** Design defers to `setEditorComponent` factory pattern. If `EditorTheme.selectList` requires more shape than `theme.fg(...)` covers, slice 7 grows by ~30 LOC. Acceptable; flagged.
3. **Slice 4 `getMetrics` transcript-length source.** Until slice 6 introduces a slice cache, the overlay's `transcriptLength` getter recomputes by calling `renderTranscript()` on demand. Cheap because no I/O, but doubles work on every keystroke. Slice 6 collapses this to a cache read. Acceptable interim cost.
4. **Coalescer trailing-edge correctness under stickToTail.** Tested directly in slice 3 (`burst then quiesce paints final frame`). Slice 4's stickToTail tests reinforce.
5. **`Component.invalidate()` becoming load-bearing in slice 6.** Today no-op is fine; the moment a slice cache appears, `invalidate()` MUST clear it. Slice 6's acceptance includes a test that double-`invalidate` + render produces a fresh slice. Critic: enforce.
6. **Manual smoke is the only "looks right in tmux" check until a PTY harness exists.** Each slice with visible UX (1, 4, 5, 6, 7, 8) gets a screenshot in the PR description per design §13. **Non-merge-blocking** — flag-don't-fail policy applied uniformly across slices.

---

**Plan written to:** `docs/focused-overlay-redesign-plan.md`
