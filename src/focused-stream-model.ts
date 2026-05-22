/**
 * Pure navigation/fold/scroll state for the focused-stream overlay.
 *
 * The overlay Component holds a single instance, mutates it via the methods
 * here, and asks for the current view (focused run, scroll offset, fold
 * flags, etc.) when re-rendering. No TUI imports — this is the model layer.
 *
 * State per agent: scroll offset.
 * State global: collapseToolCalls, showThinking, focused id.
 */

import type { RunRegistry } from "./runs.ts";
import type { Run } from "./types.ts";

export class FocusedStreamModel {
  private _focusedId: string | undefined;
  private _collapseToolCalls = true;
  private _showThinking = false;
  private _scrollPerAgent = new Map<string, number>();

  constructor(private registry: RunRegistry) {
    this.refresh();
  }

  /** Re-evaluate focused run against the current registry state. */
  refresh(): void {
    const locals = this.activeList();
    if (locals.length === 0) {
      this._focusedId = undefined;
      return;
    }
    if (this._focusedId && locals.some((r) => r.id === this._focusedId)) return;
    // Default focus = most recently started LOCAL run.
    const newest = locals.slice().sort((a, b) => b.startTime - a.startTime)[0]!;
    this._focusedId = newest.id;
  }

  // ── Read-only accessors ────────────────────────────────────────────

  focused(): Run | undefined {
    if (!this._focusedId) return undefined;
    const run = this.registry.get(this._focusedId);
    if (!run) return undefined;
    // Defence-in-depth: gate inline so a stale _focusedId from before a
    // run was rewritten as foreign cannot surface between refreshes.
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
    this._scrollPerAgent.set(this._focusedId, cur + Math.floor(n));
  }

  scrollUp(n: number): void {
    if (!Number.isFinite(n) || n <= 0) return;
    if (!this._focusedId) return;
    const cur = this._scrollPerAgent.get(this._focusedId) ?? 0;
    this._scrollPerAgent.set(this._focusedId, Math.max(0, cur - Math.floor(n)));
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
}
