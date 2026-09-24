/**
 * Smoke: `sendToRun` resumes with a provider-qualified `--model`.
 *
 * A bare model id served by two authenticated providers makes pi exit with
 * "Model ... is ambiguous across providers". Legacy records hold that bare
 * id, so the resume qualifies it from the session file when it can.
 *
 * Forks a real subprocess, but not pi: `PI_BIN` points at a stub that
 * records its argv and exits. HOME is sandboxed so config reads and record
 * writes stay inside a temp dir.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunRegistry, sendToRun } from "../src/runs.ts";
import { registerTools } from "../src/tools.ts";
import { registerCommands } from "../src/commands.ts";
import { executePromptAndSend } from "../src/prompt-and-send.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { emptyUsage, type Run } from "../src/types.ts";

type Send = (run: Run, registry: RunRegistry) => Promise<void>;

const directSend =
  (isRegisteredModel?: (provider: string, id: string) => boolean): Send =>
  async (run, registry) => {
    const result = sendToRun(run, "continue", { registry, timeoutMs: 10_000, isRegisteredModel });
    assert.equal(result.kind, "started", result.kind === "rejected" ? result.reason : "");
    if (result.kind === "started") await result.done;
  };

async function resumeArgv(
  model: string | undefined,
  sessionLines: object[],
  send: Send = directSend(),
): Promise<{ argv: string[]; run: Run }> {
  const root = mkdtempSync(join(tmpdir(), "conductor-resume-model-smoke-"));
  const argvOut = join(root, "argv.json");
  const stub = join(root, "pi-stub.mjs");
  writeFileSync(
    stub,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const sessionPath = join(root, "session.jsonl");
  writeFileSync(sessionPath, sessionLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN };
  process.env.HOME = root;
  process.env.PI_BIN = stub;
  try {
    const registry = new RunRegistry();
    const run: Run = {
      id: "builder-lvaf",
      persona: "builder",
      task: "probe",
      model,
      mode: "background",
      status: "completed",
      startTime: 1_700_000_000_000,
      lastEventAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      messages: [],
      usage: emptyUsage(),
      cwd: root,
      sessionPath,
      recordPath: join(root, "record.json"),
      transcriptPath: join(root, "transcript.jsonl"),
      finalPath: join(root, "final.md"),
    };
    registry.register(run);
    await send(run, registry);
    return { argv: JSON.parse(readFileSync(argvOut, "utf8")), run };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const modelArg = (argv: string[]): string | undefined =>
  argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined;

test("sendToRun: a legacy bare run.model is qualified from the session's assistant provider", { timeout: 15_000 }, async () => {
  const { argv, run } = await resumeArgv("anthropic.claude-opus-5-5", [
    { type: "session", version: 3, id: "s" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "pi-amazon-claude-provider",
        model: "anthropic.claude-opus-5-5",
      },
    },
  ]);
  assert.equal(modelArg(argv), "pi-amazon-claude-provider/anthropic.claude-opus-5-5");
  assert.equal(run.model, "pi-amazon-claude-provider/anthropic.claude-opus-5-5", "the record is upgraded too");
});

test("sendToRun: a bare run.model with no provider in the session passes through unchanged", { timeout: 15_000 }, async () => {
  const { argv } = await resumeArgv("anthropic.claude-opus-5-5", [
    { type: "message", message: { role: "assistant", content: [], model: "anthropic.claude-opus-5-5" } },
  ]);
  assert.equal(modelArg(argv), "anthropic.claude-opus-5-5");
});

test("sendToRun: an already-qualified run.model passes through unchanged", { timeout: 15_000 }, async () => {
  const { argv } = await resumeArgv("amazon-bedrock/us.openai.gpt-6-astra", [
    {
      type: "message",
      message: { role: "assistant", content: [], provider: "amazon-bedrock", model: "us.openai.gpt-6-astra" },
    },
  ]);
  assert.equal(modelArg(argv), "amazon-bedrock/us.openai.gpt-6-astra");
});

test("sendToRun: no run.model still emits no --model", { timeout: 15_000 }, async () => {
  const { argv } = await resumeArgv(undefined, [
    { type: "message", message: { role: "assistant", content: [], provider: "amazon-bedrock", model: "m" } },
  ]);
  assert.equal(modelArg(argv), undefined);
});

// ── Registry-aware resume: the four sendToRun call sites ─────────────
//
// On a host where pi no longer loads the session's provider, the bare id
// is the only form pi can resolve. Each call site hands sendToRun a
// predicate over its ctx.modelRegistry.

const OPUS = "anthropic.claude-opus-5-5";
const goneProviderSession = [
  { type: "message", message: { role: "assistant", content: [], provider: "amazon-claude-code", model: OPUS } },
];
/** A pi ModelRegistry stand-in that only knows amazon-bedrock's copy. */
const modelRegistry = {
  find: (provider: string, id: string) => (provider === "amazon-bedrock" && id === OPUS ? { provider, id } : undefined),
};

test("sendToRun: an unregistered session provider leaves the bare id, and repairs a persisted prefix", { timeout: 15_000 }, async () => {
  const isRegistered = (p: string, id: string) => modelRegistry.find(p, id) !== undefined;
  const bare = await resumeArgv(OPUS, goneProviderSession, directSend(isRegistered));
  assert.equal(modelArg(bare.argv), OPUS);
  assert.equal(bare.run.model, OPUS);
  const persisted = await resumeArgv(`amazon-claude-code/${OPUS}`, goneProviderSession, directSend(isRegistered));
  assert.equal(modelArg(persisted.argv), OPUS);
  assert.equal(persisted.run.model, OPUS, "the next record write stores the repaired id");
});

test("ensemble_send: passes ctx.modelRegistry to the resume", { timeout: 15_000 }, async () => {
  const send: Send = async (run, registry) => {
    const tools: Array<{ name: string; execute: (...a: any[]) => Promise<any> }> = [];
    registerTools({ registerTool: (t: any) => tools.push(t) } as any, {
      getCwd: () => run.cwd,
      getRegistry: () => registry,
      getQueue: () => new SpawnQueue(registry, 4),
      getModel: () => new FocusedStreamModel(registry),
      getParentMessages: () => [],
      openFocusedOverlay: () => {},
      registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
      pushCompletionNotification: () => {},
    } as any);
    const tool = tools.find((t) => t.name === "ensemble_send")!;
    const out = await tool.execute("call-1", { agent_id: run.id, message: "continue" }, undefined, undefined, { modelRegistry });
    assert.ok(!out.isError, JSON.stringify(out.content));
  };
  const { argv } = await resumeArgv(`amazon-claude-code/${OPUS}`, goneProviderSession, send);
  assert.equal(modelArg(argv), OPUS);
});

test("/conductor send: passes ctx.modelRegistry to the resume", { timeout: 15_000 }, async () => {
  const send: Send = async (run, registry) => {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    registerCommands(
      { registerCommand: (name: string, spec: any) => name === "conductor" && (handler = spec.handler) } as any,
      { getCwd: () => run.cwd, getRegistry: () => registry, getQueue: () => new SpawnQueue(registry, 4) } as any,
    );
    const warnings: string[] = [];
    await handler!(`send ${run.id} continue`, {
      modelRegistry,
      ui: { notify: (m: string, level?: string) => level === "warning" && warnings.push(m) },
    });
    assert.deepEqual(warnings, []);
    await new Promise<void>((resolve) => {
      if (run.status !== "running") return resolve();
      const unsub = registry.onChange((r) => r.status !== "running" && (unsub(), resolve()));
    });
  };
  const { argv } = await resumeArgv(OPUS, goneProviderSession, send);
  assert.equal(modelArg(argv), OPUS);
});

test("overlay send (executePromptAndSend): passes the ctx's modelRegistry to the resume", { timeout: 15_000 }, async () => {
  const send: Send = async (run, registry) => {
    let done: Promise<unknown> = Promise.resolve();
    await executePromptAndSend(
      {
        getCtx: () => ({ modelRegistry, ui: { input: async () => undefined, notify: () => {} } }),
        registry,
        cwd: run.cwd,
        validateSendable: () => ({ ok: true }),
        loadConfig: () => ({ personaOverrides: {} }),
        resolvePersonas: async () => ({ personas: new Map() }),
        resolveTimeoutMs: () => 10_000,
        sendToRun: (r, m, o) => {
          const result = sendToRun(r, m, o);
          if (result.kind === "started") done = result.done;
          return result as any;
        },
        pushCompletionNotification: () => {},
      },
      run.id,
      "continue",
    );
    await done;
  };
  const { argv } = await resumeArgv(`amazon-claude-code/${OPUS}`, goneProviderSession, send);
  assert.equal(modelArg(argv), OPUS);
});
