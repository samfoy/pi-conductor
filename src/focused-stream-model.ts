/**
 * Pure navigation/fold/scroll state for the focused-stream overlay.
 *
 * The overlay Component holds a single instance, mutates it via the methods
 * here, and asks for the current view (focused run, scroll offset, fold
 * flags, etc.) when re-rendering. No TUI imports — this is the model layer.
 *
 * State per agent: scroll offset, stickToTail latch.
 * State global: collapseToolCalls, showThinking, focused id.
 */

import type { RunRegistry } from "./runs.ts";
import type { Run } from "./types.ts";

/**
 * Slice 4: viewport metrics injection. The model needs to know the
 * renderable body height (`bodyRows`) and the total transcript line
 * count (`transcriptLength`) to clamp `scrollDown` at the bottom and
 * to drive `stickToTail` auto-follow.
 *
 * `Component.handleInput(data)` has NO width/height parameter, so we
 * cannot pass these as args at keystroke time. The agreed data path
 * (oracle gate fix, plan §Slice 4) is a closure injected at model
 * construction. The factory builds it from `tui.terminal.rows`
 * (live, less chrome) and the overlay's `getTranscriptLength()`
 * (populated as a side-output of render — pure memoization, see
 * design §10).
 */
export interface FocusedStreamMetrics {
  /** Renderable body height in lines (chrome already subtracted). */
  readonly bodyRows: number;
  /** Total transcript line count for the focused run. */
  readonly transcriptLength: number;
}

export interface FocusedStreamModelOptions {
  /**
   * Optional viewport-metrics provider. When omitted, the model
   * defaults to a "do not clamp" behaviour (`bodyRows: 0`,
   * `transcriptLength: Infinity` → bottom = +∞), which preserves the
   * pre-slice unbounded-scroll semantics for tests/callsites that
   * don't care about clamping.
   */
  readonly getMetrics?: () => FocusedStreamMetrics;
}

const NO_CLAMP_METRICS: FocusedStreamMetrics = {
  bodyRows: 0,
  transcriptLength: Number.POSITIVE_INFINITY,
};

export class FocusedStreamModel {
  private _focusedId: string | undefined;
  private _collapseToolCalls = true;
  private _showThinking = false;
  private _scrollPerAgent = new Map<string, number>();
  private _stickToTailPerAgent = new Map<string, boolean>();
  private _getMetrics: () => FocusedStreamMetrics;

  constructor(
    private registry: RunRegistry,
    opts: FocusedStreamModelOptions = {},
  ) {
    this._getMetrics = opts.getMetrics ?? (() => NO_CLAMP_METRICS);
    this.refresh();
  }

  /**
   * Slice 4: late-bind the metrics source after construction. The
   * overlay component must exist before its `getTranscriptLength()` is
   * reachable, so the factory constructs the overlay first and then
   * wires this closure. Tests that construct the model with a fully
   * formed metrics provider can pass it via `opts.getMetrics` instead.
   */
  setMetricsSource(getMetrics: () => FocusedStreamMetrics): void {
    this._getMetrics = getMetrics;
  }

  /**
   * Re-evaluate focused run against the current registry state. When
   * the focused agent has `stickToTail=true` latched, also re-snap the
   * scroll offset to the new bottom (the transcript may have grown
   * since the previous refresh).
   */
  refresh(): void {
    const locals = this.activeList();
    if (locals.length === 0) {
      this._focusedId = undefined;
      return;
    }
    if (!this._focusedId || !locals.some((r) => r.id === this._focusedId)) {
      // Default focus = most recently started LOCAL run.
      const newest = locals.slice().sort((a, b) => b.startTime - a.startTime)[0]!;
      this._focusedId = newest.id;
    }
    // Auto-follow: if the focused agent is latched at tail, re-snap the
    // offset to the new bottom (transcript may have grown).
    if (this._focusedId && this._stickToTailPerAgent.get(this._focusedId) === true) {
      this._scrollPerAgent.set(this._focusedId, this.bottom());
    }
  }

  // ── Read-only accessors ────────────────────────────────────────────

  focused(): Run | undefined {
    if (!this._focusedId) return undefined;
    const run = this.registry.get(this._focusedId);
    if (!run) return undefined;
    if (!this.isLocal(run)) return undefined;
    return run;
  }

  collapseToolCalls(): boolean {
    return this._collapseToolCalls;
  }

  showThinking(): boolean {
    return this._showThinking;
  }

  scrollOffset(): number {
    if (!this._focusedId) return 0;
    return this._scrollPerAgent.get(this._focusedId) ?? 0;
  }

  /**
   * Slice 4: read-only access to the per-agent stickToTail latch. When
   * `id` is omitted, returns the focused agent's flag (or `false` when
   * nothing is focused).
   */
  stickToTail(id?: string): boolean {
    const key = id ?? this._focusedId;
    if (!key) return false;
    return this._stickToTailPerAgent.get(key) === true;
  }

  /** Number of runs the model knows about (visible to cycle). */
  agentCount(): number {
    return this.activeList().length;
  }

  // ── Mutators ───────────────────────────────────────────────────────

  /** Set focus to a specific run id. Returns true if found. */
  focus(id: string): boolean {
    const list = this.activeList();
    if (!list.some((r) => r.id === id)) return false;
    this._focusedId = id;
    return true;
  }

  /** Cycle to the next run in the list (wraps). */
  cycleNext(): void {
    const list = this.activeList();
    if (list.length === 0) return;
    const idx = list.findIndex((r) => r.id === this._focusedId);
    const next = list[(idx + 1) % list.length] ?? list[0]!;
    this._focusedId = next.id;
  }

  /** Cycle to the previous run in the list (wraps). */
  cyclePrev(): void {
    const list = this.activeList();
    if (list.length === 0) return;
    const idx = list.findIndex((r) => r.id === this._focusedId);
    const prevIdx = idx <= 0 ? list.length - 1 : idx - 1;
    this._focusedId = list[prevIdx]!.id;
  }

  scrollDown(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    if (!this._focusedId) return;
    const cur = this._scrollPerAgent.get(this._focusedId) ?? 0;
    const bottom = this.bottom();
    // Re-clamp the existing offset under the current metrics first
    // (handles the resize case where bodyRows shrunk between mutations
    // and the cached offset is now past the new bottom), then apply n,
    // then clamp the result.
    const clampedCur = Math.min(cur, bottom);
    const next = Math.min(clampedCur + Math.floor(n), bottom);
    this._scrollPerAgent.set(this._focusedId, next);
    // Latch stickToTail when the user organically reaches the bottom.
    if (next >= bottom && bottom > 0) {
      this._stickToTailPerAgent.set(this._focusedId, true);
    } else if (next < bottom) {
      // If we land short of bottom (clamped n smaller than the gap),
      // do NOT latch — current latch state is preserved.
    }
  }

  scrollUp(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    if (!this._focusedId) return;
    const cur = this._scrollPerAgent.get(this._focusedId) ?? 0;
    this._scrollPerAgent.set(this._focusedId, Math.max(0, cur - Math.floor(n)));
    // User-up always un-latches.
    this._stickToTailPerAgent.set(this._focusedId, false);
  }

  /**
   * Slice 4: snap to the bottom of the focused agent's transcript and
   * latch `stickToTail=true`. Bound to `End`/`G` by the overlay
   * Component.
   */
  jumpToTail(): void {
    if (!this._focusedId) return;
    this._scrollPerAgent.set(this._focusedId, this.bottom());
    this._stickToTailPerAgent.set(this._focusedId, true);
  }

  /**
   * Slice 4: snap to the top of the focused agent's transcript and
   * un-latch `stickToTail`. Bound to `Home`/`g` by the overlay
   * Component.
   */
  jumpToHome(): void {
    if (!this._focusedId) return;
    this._scrollPerAgent.set(this._focusedId, 0);
    this._stickToTailPerAgent.set(this._focusedId, false);
  }

  toggleCollapseToolCalls(): void {
    this._collapseToolCalls = !this._collapseToolCalls;
  }

  toggleShowThinking(): void {
    this._showThinking = !this._showThinking;
  }

  // ── Internal ───────────────────────────────────────────────────────

  /**
   * The runs visible for cycling. Today: every LOCAL run in the registry,
   * sorted by startTime ascending so cycle order is stable. "Local" =
   * owned by this conductor host process — see `isLocal`.
   */
  private activeList(): Run[] {
    return this.registry
      .list()
      .filter((r) => this.isLocal(r))
      .sort((a, b) => a.startTime - b.startTime);
  }

  /**
   * Defence-in-depth gate against foreign-pid runs. The reconcile-startup
   * ownership filter at `src/reconcile-startup.ts:248` is the primary
   * guard — no foreign record should reach the local RunRegistry once
   * that fix is verified end-to-end. We keep this model-level filter as
   * a belt-and-braces defence: if a foreign run somehow lands in the
   * registry (race, future refactor, manual injection), the focused-
   * stream overlay must not surface it for cycling, sending, or killing.
   *
   * - `parentPid === undefined` → legacy record predating the field;
   *   trust as local for back-compat. New spawns always populate the
   *   field via `src/runs.ts:766`.
   * - `parentPid === process.pid` → owned by this host. Local.
   * - anything else → foreign sibling-session run; filter out.
   */
  private isLocal(run: Run): boolean {
    return run.parentPid === undefined || run.parentPid === process.pid;
  }

  /**
   * Slice 4: compute the renderable bottom for the focused agent based
   * on the injected `getMetrics` closure. `bottom = max(0, transcriptLength - bodyRows)`.
   */
  private bottom(): number {
    const m = this._getMetrics();
    return Math.max(0, m.transcriptLength - m.bodyRows);
  }
}
