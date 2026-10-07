// M6b fixtures shared by tests/effort-resolve.test.ts and tests/effort-resolve-smoke.test.ts.
import type test from "node:test";
import { registerCommands } from "../../src/commands.ts";
import { settleRun } from "../../src/run-pipeline.ts";
import { SpawnQueue } from "../../src/queue.ts";
import type { Run } from "../../src/types.ts";
import type { mergerFixture } from "./effort-merger.ts";
import { preserveTmpDirs } from "./tmp.ts";

export type Fixture = ReturnType<typeof mergerFixture>;

/**
 * The pipeline's own tail for a settled first generation: one card through the delivery ledger.
 * `during` runs inside that card's dispatch, while delivery is still "intent".
 */
export async function conflicted(f: Fixture, a: Run, cards: string[], during?: (r: Run) => void) {
  const outcome = await f.registry.integrations.enqueue(a, () => f.registry.notify(a));
  a.mergeResult = outcome.mergeResult; a.landedCommit = outcome.landedCommit;
  if (!outcome.mergeResult.success) a.errorMessage = `effort integration failed: ${outcome.mergeResult.reason ?? "error"}. ${outcome.mergeResult.errorMessage ?? "Work and evidence preserved."}`;
  await settleRun(a, outcome.terminal, 0, { registry: f.registry, onComplete: r => { cards.push(`${r.id}:${r.status}`); during?.(r); } });
  return outcome;
}

/** The production `/conductor` handler with a fake UI; nothing else from the lead is wired. */
export function command(f: Fixture, cards: string[]) {
  let handler!: (args: string, ctx: unknown) => Promise<void>;
  const state = { session: "owner" };
  registerCommands({ registerCommand: (name: string, spec: { handler: typeof handler }) => { if (name === "conductor") handler = spec.handler; } } as never, {
    getCwd: () => f.root, getRegistry: () => f.registry, getQueue: () => new SpawnQueue(f.registry, 4, 1), getConductorMode: () => true, setConductorMode: () => {},
    openFocusedOverlay: () => {}, getSessionId: () => state.session, pushCompletionNotification: (r: Run) => cards.push(`${r.id}:${r.status}`),
  } as never);
  const notes: { message: string; level: string }[] = [], prompts: { title: string; body: string }[] = [];
  const ctx = (answer: () => Promise<boolean> | boolean, hasUI = true) => ({ hasUI, ui: {
    notify: (message: string, level = "info") => { notes.push({ message, level }); },
    confirm: async (title: string, body: string) => { prompts.push({ title, body }); return answer(); },
  } });
  return { state, notes, prompts, ctx, resolve: (args: string, c: ReturnType<typeof ctx>) => handler(`effort resolve ${args}`, c) };
}

/** Failure evidence is preserved before any cleanup or assertion runs in t.after. */
export async function preserving<T>(t: test.TestContext, body: () => Promise<T>): Promise<T> {
  try { return await body(); }
  catch (error) { t.diagnostic(`preserved fixture roots: ${preserveTmpDirs().join(" ")}`); throw error; }
}
