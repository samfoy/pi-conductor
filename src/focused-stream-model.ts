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
    const all = this.registry.list();
    if (all.length === 0) {
      this._focusedId = undefined;
      return;
    }
    if (this._focusedId && all.some((r) => r.id === this._focusedId)) return;
    // Default focus = most recently started.
    const newest = all.slice().sort((a, b) => b.startTime - a.startTime)[0]!;
    this._focusedId = newest.id;
  }

  // ── Read-only accessors ────────────────────────────────────────────

  focused(): Run | undefined {
    if (!this._focusedId) return undefined;
    return this.registry.get(this._focusedId);
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
   * The runs visible for cycling. Today: every run in the registry, sorted
   * by startTime ascending so cycle order is stable. Future: filter to
   * non-terminal-only when a setting calls for it.
   */
  private activeList(): Run[] {
    return this.registry.list().slice().sort((a, b) => a.startTime - b.startTime);
  }
}
