/**
 * A resume is resolved from the run, not from the conductor:
 *
 *   (a) The persona's own frontmatter `on_complete_hook` gates a resumed
 *       terminal, as it gates the fresh spawn (resolveCloseHook's
 *       persona layer). Reconciled runs complete only through a resume,
 *       so this covers them too.
 *   (b) Every send path (ensemble_send, `/conductor send`, the overlay's
 *       executePromptAndSend) resolves persona, config and timeout from
 *       `run.cwd`. The conductor's cwd can be another project, whose
 *       personas differ or don't exist.
 *
 * The fixture persona `probe` exists only in the run's project, and its
 * frontmatter hook fails (exit 7), so a gated resume ends `hook_failed`
 * and an ungated one ends `completed`. PI_BIN is a stub that exits 0.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../src/config.ts";
import { registerCommands } from "../src/commands.ts";
import { resolvePersonas } from "../src/personas.ts";
import { executePromptAndSend } from "../src/prompt-and-send.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { resolveTimeoutMs, RunRegistry, sendCwd, sendToRun } from "../src/runs.ts";
import { registerTools } from "../src/tools.ts";
import { emptyUsage, isTerminal, type Run } from "../src/types.ts";
import { tmpDir } from "./helpers/tmp.ts";

const GATE = "exit 7";

interface Fixture {
  /** The run's project: holds the project-only `probe` persona. */
  project: string;
  /** The conductor's cwd: another project, without `probe`. */
  elsewhere: string;
  registry: RunRegistry;
  run: Run;
}

async function withResumableRun(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const root = realpathSync(tmpDir("conductor-send-run-cwd-"));
  const project = join(root, "project");
  const elsewhere = join(root, "elsewhere");
  const personas = join(project, ".pi", "conductor", "personas");
  mkdirSync(personas, { recursive: true });
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(
    join(personas, "probe.md"),
    `---\nname: probe\ndescription: project-only persona with a quality gate\ninherit_context: none\non_complete_hook: ${GATE}\n---\n\nYou are probe.\n`,
  );
  const stub = join(root, "pi-stub.mjs");
  writeFileSync(stub, "process.exit(0);\n");
  const runDir = join(root, "run");
  mkdirSync(runDir);
  const sessionPath = join(runDir, "session.jsonl");
  writeFileSync(sessionPath, "{}\n");
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN };
  process.env.HOME = join(root, "home");
  process.env.PI_BIN = stub;
  try {
    const registry = new RunRegistry();
    const run: Run = {
      id: "probe-r1",
      persona: "probe",
      task: "probe",
      mode: "background",
      status: "completed",
      startTime: 1_000,
      lastEventAt: 1_000,
      finishedAt: 2_000,
      exitCode: 0,
      messages: [],
      usage: emptyUsage(),
      cwd: project,
      sessionPath,
      recordPath: join(runDir, "record.json"),
      transcriptPath: join(runDir, "transcript.jsonl"),
      finalPath: join(runDir, "final.md"),
    };
    registry.register(run);
    await fn({ project, elsewhere, registry, run });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // No rmSync here: the ensemble_send tests settle on the registry flip,
    // before the run's record writes land, and an rm racing them failed
    // with ENOTEMPTY. tmpDir removes root at exit.
  }
}

function settled(registry: RunRegistry, run: Run): Promise<Run> {
  return new Promise((resolve) => {
    if (isTerminal(run.status)) return resolve(run);
    const unsub = registry.onChange((r) => {
      if (r.id === run.id && isTerminal(r.status)) {
        unsub();
        resolve(r);
      }
    });
  });
}

function assertGated(run: Run): void {
  assert.equal(run.status, "hook_failed", `the persona's frontmatter gate ran; status ${run.status}`);
  assert.equal(run.hookResult?.command, GATE);
  assert.equal(run.hookResult?.exitCode, 7);
}

test("sendToRun: a resume passes through the persona's frontmatter on_complete_hook", { timeout: 20_000 }, async () => {
  await withResumableRun(async ({ project, registry, run }) => {
    const persona = (await resolvePersonas({ cwd: project })).personas.get("probe");
    assert.ok(persona, "fixture persona resolves from the run's project");
    const result = sendToRun(run, "continue", { registry, timeoutMs: 10_000, persona });
    assert.equal(result.kind, "started", result.kind === "rejected" ? result.reason : "");
    if (result.kind === "started") assertGated(await result.done);
  });
});

test("ensemble_send: resolves the persona from run.cwd, not the conductor's cwd", { timeout: 20_000 }, async () => {
  await withResumableRun(async ({ elsewhere, registry, run }) => {
    const tools: Array<{ name: string; execute: (...a: any[]) => Promise<any> }> = [];
    registerTools({ registerTool: (t: any) => tools.push(t) } as any, {
      getCwd: () => elsewhere,
      getRegistry: () => registry,
      getQueue: () => new SpawnQueue(registry, 4),
      getModel: () => new FocusedStreamModel(registry),
      getParentMessages: () => [],
      openFocusedOverlay: () => {},
      registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
      pushCompletionNotification: () => {},
    } as any);
    const tool = tools.find((t) => t.name === "ensemble_send")!;
    const out = await tool.execute("call-1", { agent_id: run.id, message: "continue" }, undefined, undefined, {});
    assert.ok(!out.isError, JSON.stringify(out.content));
    assertGated(await settled(registry, run));
  });
});

test("/conductor send: resolves the persona from run.cwd, not the conductor's cwd", { timeout: 20_000 }, async () => {
  await withResumableRun(async ({ elsewhere, registry, run }) => {
    let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    registerCommands(
      { registerCommand: (name: string, spec: any) => name === "conductor" && (handler = spec.handler) } as any,
      { getCwd: () => elsewhere, getRegistry: () => registry, getQueue: () => new SpawnQueue(registry, 4) } as any,
    );
    const warnings: string[] = [];
    await handler!(`send ${run.id} continue`, {
      ui: { notify: (m: string, level?: string) => level === "warning" && warnings.push(m) },
    });
    assert.deepEqual(warnings, []);
    assertGated(await settled(registry, run));
  });
});

test("overlay send (executePromptAndSend): resolves the persona from run.cwd, not the conductor's cwd", { timeout: 20_000 }, async () => {
  await withResumableRun(async ({ elsewhere, registry, run }) => {
    await executePromptAndSend(
      {
        getCtx: () => ({ ui: { input: async () => undefined, notify: () => {} } }),
        registry,
        cwd: elsewhere,
        validateSendable: () => ({ ok: true }),
        loadConfig,
        resolvePersonas: (a) => resolvePersonas(a as any) as any,
        resolveTimeoutMs: (p, ov, cfg) => resolveTimeoutMs(p as any, ov as any, cfg as any),
        sendToRun: (r, m, o) => sendToRun(r, m, o as any) as any,
        pushCompletionNotification: () => {},
      },
      run.id,
      "continue",
    );
    assertGated(await settled(registry, run));
  });
});

test("sendCwd: a run's own cwd wins; a legacy record without one falls back to the conductor's", () => {
  const run = { cwd: "/runs/project" } as Run;
  assert.equal(sendCwd(run, "/conductor"), "/runs/project");
  assert.equal(sendCwd({ ...run, cwd: undefined as unknown as string }, "/conductor"), "/conductor");
  assert.equal(sendCwd({ ...run, cwd: "" }, "/conductor"), "/conductor");
});
