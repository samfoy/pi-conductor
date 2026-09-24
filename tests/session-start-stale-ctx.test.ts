/**
 * pi invalidates an extension ctx on reload, session replacement and
 * print-mode exit: every getter then throws "This extension ctx is stale
 * …". Work deferred past session_start, or past an await, must not read
 * the ctx then. A throw there is uncaught and kills pi (`pi -p
 * "/conductor list"` exited 1).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executePromptAndSend } from "../src/prompt-and-send.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, toRunRecord, type Run } from "../src/types.ts";
import { loadConductor, stubCtx } from "./helpers/stub-pi.ts";

const STALE = "This extension ctx is stale after session replacement or reload.";

/** `ctx` whose getters throw like pi's once `markStale()` has run. */
function staleable<T extends object>(ctx: T): { ctx: T; markStale: () => void } {
  let stale = false;
  const guarded = {} as T;
  for (const key of Object.keys(ctx) as Array<keyof T>) {
    Object.defineProperty(guarded, key, {
      get: () => {
        if (stale) throw new Error(STALE);
        return ctx[key];
      },
    });
  }
  return { ctx: guarded, markStale: () => void (stale = true) };
}

function runningRecord(runsRoot: string, id: string, over: Partial<Run>): string {
  const dir = join(runsRoot, id);
  mkdirSync(dir, { recursive: true });
  const record = toRunRecord({
    id,
    persona: "builder",
    task: "t",
    mode: "background",
    status: "running",
    startTime: 1_000,
    lastEventAt: 1_000,
    pid: 999_999,
    messages: [],
    usage: emptyUsage(),
    cwd: dir,
    recordPath: join(dir, "record.json"),
    transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"),
    ...over,
  });
  writeFileSync(record.recordPath, JSON.stringify(record));
  return record.recordPath;
}

test("session_start's deferred reconcile runs on the session id captured before the ctx went stale", async () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-stale-ctx-"));
  const saved = { HOME: process.env.HOME, CONDUCTOR_SUBAGENT: process.env.CONDUCTOR_SUBAGENT };
  const realSetImmediate = globalThis.setImmediate;
  process.env.HOME = join(root, "home");
  delete process.env.CONDUCTOR_SUBAGENT;
  try {
    const conf = join(root, "home", ".pi", "agent", "extensions", "conductor");
    mkdirSync(conf, { recursive: true });
    writeFileSync(join(conf, "config.json"), JSON.stringify({ gc: { enabled: false } }));
    const runsRoot = join(root, "home", ".pi", "agent", "conductor", "runs");
    // A dead orphan with no owner: any reconcile pass kills it.
    const orphan = runningRecord(runsRoot, "builder-dead", {});
    // A sibling slot's run in this same pid: only the session id ("sess")
    // tells it apart. Without it, reconcile would claim and kill it.
    const sibling = runningRecord(runsRoot, "builder-sibling", {
      parentPid: process.pid,
      parentSessionId: "sibling-session",
    });

    const fire = loadConductor();
    const { ctx, markStale } = staleable(stubCtx(root));
    const deferred: Array<() => unknown> = [];
    globalThis.setImmediate = ((cb: (...a: unknown[]) => unknown, ...args: unknown[]) => {
      deferred.push(() => cb(...args));
      return { unref: () => {}, ref: () => {}, hasRef: () => false } as unknown as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      await fire("session_start", {}, ctx);
    } finally {
      globalThis.setImmediate = realSetImmediate;
    }
    // A reload before the next tick: pi fires session_shutdown, then
    // invalidates the old ctx, then the deferred work runs.
    await fire("session_shutdown", { reason: "reload" }, stubCtx(root));
    markStale();
    await Promise.all(deferred.map((run) => run()));

    const status = (path: string) => JSON.parse(readFileSync(path, "utf8")).status;
    assert.equal(status(orphan), "killed", "the reconcile pass ran");
    assert.equal(status(sibling), "running", "it scoped ownership on the captured session id");
  } finally {
    globalThis.setImmediate = realSetImmediate;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("overlay send: a reload during the input prompt doesn't lose the model registry or throw", async () => {
  const registry = new RunRegistry();
  const run: Run = {
    id: "oracle-1",
    persona: "oracle",
    task: "t",
    mode: "background",
    status: "completed",
    startTime: 0,
    lastEventAt: 0,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
  };
  registry.register(run);
  const modelRegistry = { find: (p: string, id: string) => (p === "amazon-bedrock" && id === "m" ? {} : undefined) };
  let markStale = () => {};
  const guarded = staleable({
    modelRegistry,
    ui: {
      // The user types while pi reloads underneath the prompt.
      input: async () => {
        markStale();
        return "go on";
      },
      notify: () => {},
    },
  });
  markStale = guarded.markStale;
  const sends: Array<{ message: string; isRegisteredModel?: (p: string, id: string) => boolean }> = [];

  await executePromptAndSend(
    {
      getCtx: () => guarded.ctx,
      registry,
      cwd: "/tmp",
      validateSendable: () => ({ ok: true }),
      loadConfig: () => ({ personaOverrides: {} }),
      resolvePersonas: async () => ({ personas: new Map() }),
      resolveTimeoutMs: () => 1_000,
      sendToRun: (_r, message, o) => {
        sends.push({ message, isRegisteredModel: o.isRegisteredModel });
        return { kind: "queued" };
      },
      pushCompletionNotification: () => {},
    },
    run.id,
  );

  assert.equal(sends.length, 1, "the typed message is still sent");
  assert.equal(sends[0]!.message, "go on");
  assert.equal(sends[0]!.isRegisteredModel?.("amazon-bedrock", "m"), true, "with the registry read before the prompt");
});
