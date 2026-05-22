/**
 * Slice 7: promptAndSendToRun extracted-and-extended unit tests.
 *
 * The function now accepts an optional `presuppliedText`. When set
 * and non-empty after trim, the `ctx.ui.input` modal is skipped; the
 * remainder of the dispatch (validateSendable, persona resolution,
 * resolveTimeoutMs, sendToRun + onComplete, rejection notify) MUST
 * still run unchanged.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { executePromptAndSend } from "../src/prompt-and-send.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(): Run {
  return {
    id: "oracle-1",
    persona: "oracle",
    task: "t",
    mode: "background",
    status: "running",
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
  };
}

interface Captured {
  validateSendableCalls: number;
  resolvePersonasCalls: number;
  resolveTimeoutMsCalls: number;
  sendToRunCalls: { runId: string; message: string }[];
  notifies: { msg: string; kind: string }[];
  uiInputCalls: number;
  pushCompletions: Run[];
}

function makeDeps(opts: {
  validateOk?: boolean;
  sendKind?: "queued" | "rejected";
  rejectReason?: string;
  ctx?: { ui: { input: (...a: any[]) => any; notify: (...a: any[]) => any } } | null;
} = {}): {
  cap: Captured;
  deps: Parameters<typeof executePromptAndSend>[0];
  run: Run;
} {
  const cap: Captured = {
    validateSendableCalls: 0,
    resolvePersonasCalls: 0,
    resolveTimeoutMsCalls: 0,
    sendToRunCalls: [],
    notifies: [],
    uiInputCalls: 0,
    pushCompletions: [],
  };
  const run = makeRun();
  const registry = new RunRegistry();
  registry.register(run);
  const ctx = opts.ctx === undefined
    ? {
        ui: {
          input: async (..._a: any[]) => {
            cap.uiInputCalls += 1;
            return "from-modal";
          },
          notify: (msg: string, kind: string) => {
            cap.notifies.push({ msg, kind });
          },
        },
      }
    : opts.ctx;
  const deps = {
    getCtx: () => ctx,
    registry,
    cwd: "/tmp",
    validateSendable: (_r: Run) => {
      cap.validateSendableCalls += 1;
      return opts.validateOk === false
        ? ({ ok: false as const, reason: "not sendable" })
        : ({ ok: true as const });
    },
    loadConfig: (_cwd: string) => ({ personaOverrides: { oracle: { foo: 1 } } } as any),
    resolvePersonas: async (_a: any) => {
      cap.resolvePersonasCalls += 1;
      return { personas: new Map([["oracle", { name: "oracle" } as any]]) } as any;
    },
    resolveTimeoutMs: (_p: any, _ov: any, _cfg: any) => {
      cap.resolveTimeoutMsCalls += 1;
      return 60_000;
    },
    sendToRun: (r: Run, msg: string, sendOpts: { onComplete?: (r: Run) => void }) => {
      cap.sendToRunCalls.push({ runId: r.id, message: msg });
      sendOpts.onComplete?.(r);
      return opts.sendKind === "rejected"
        ? ({ kind: "rejected" as const, reason: opts.rejectReason ?? "rejected!" })
        : ({ kind: "queued" as const });
    },
    pushCompletionNotification: (r: Run) => {
      cap.pushCompletions.push(r);
    },
  };
  return { cap, deps, run };
}

test("promptAndSendToRun: presuppliedText empty after trim → no sendToRun call, no notify", async () => {
  const { cap, deps } = makeDeps();
  await executePromptAndSend(deps, "oracle-1", "   \t  ");
  assert.equal(cap.uiInputCalls, 0, "no modal");
  assert.equal(cap.sendToRunCalls.length, 0);
  assert.equal(cap.notifies.length, 0);
});

test("promptAndSendToRun: presuppliedText non-empty → ctx.ui.input is NOT called", async () => {
  const { cap, deps } = makeDeps();
  await executePromptAndSend(deps, "oracle-1", "hello");
  assert.equal(cap.uiInputCalls, 0, "modal must be skipped when text is presupplied");
});

test("promptAndSendToRun: presuppliedText non-empty → validateSendable still runs", async () => {
  const { cap, deps } = makeDeps();
  await executePromptAndSend(deps, "oracle-1", "hello");
  assert.equal(cap.validateSendableCalls, 1);
});

test("promptAndSendToRun: presuppliedText non-empty → sendToRun called with trimmed text", async () => {
  const { cap, deps } = makeDeps();
  await executePromptAndSend(deps, "oracle-1", "  hello  ");
  assert.deepEqual(cap.sendToRunCalls, [{ runId: "oracle-1", message: "hello" }]);
});

test("promptAndSendToRun: presuppliedText non-empty → persona resolution still runs", async () => {
  const { cap, deps } = makeDeps();
  await executePromptAndSend(deps, "oracle-1", "hello");
  assert.equal(cap.resolvePersonasCalls, 1);
  assert.equal(cap.resolveTimeoutMsCalls, 1);
});

test("promptAndSendToRun: rejection branch still notifies", async () => {
  const { cap, deps } = makeDeps({ sendKind: "rejected", rejectReason: "queue full" });
  await executePromptAndSend(deps, "oracle-1", "hello");
  assert.deepEqual(cap.notifies, [{ msg: "queue full", kind: "warning" }]);
});

test("promptAndSendToRun: pushCompletionNotification wired through onComplete", async () => {
  const { cap, deps } = makeDeps();
  await executePromptAndSend(deps, "oracle-1", "hello");
  assert.equal(cap.pushCompletions.length, 1);
  assert.equal(cap.pushCompletions[0]!.id, "oracle-1");
});
