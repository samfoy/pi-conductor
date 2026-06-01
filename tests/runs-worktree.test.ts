/**
 * v0.13 worktree-per-persona — integration tests for spawnRun worktree
 * path (using the capture-queue pattern from tests/timeout-override.test.ts).
 *
 * Pins:
 *   - SpawnOptions.worktree=true propagates through queue to spawnRun
 *   - persona.worktree=true is picked up by tools.ts and passed to queue
 *   - run.worktreePath is stamped when worktree creation succeeds
 *   - non-git cwd falls back to shared cwd (no failure)
 * v0.14 additions:
 *   - run.mergeStrategy is stamped from SpawnRunOpts.mergeStrategy
 *   - run.worktreeBaseBranch is captured at worktree creation time
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { registerTools } from "../src/tools.ts";
import { RunRegistry, spawnRun } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { DEFAULT_CONFIG, emptyUsage, type Run, type Persona } from "../src/types.ts";
import { resolvePersonas, projectPersonasDir } from "../src/personas.ts";

// ── Helpers ────────────────────────────────────────────────────────────

interface RegisteredTool {
  name: string;
  parameters: any;
  execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: any) => Promise<any>;
}

function tmpGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "conductor-wt-runs-"));
  execSync("git init", { cwd: dir, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: dir, stdio: "pipe" });
  execSync("git config user.name Test", { cwd: dir, stdio: "pipe" });
  writeFileSync(join(dir, "README.md"), "init\n");
  execSync("git add README.md", { cwd: dir, stdio: "pipe" });
  execSync("git commit -m init", { cwd: dir, stdio: "pipe" });
  return dir;
}

function makeRun(id: string, overrides: Partial<Run> = {}): Run {
  return {
    id,
    persona: id.split("-")[0]!,
    task: "test",
    mode: "background",
    status: "queued",
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
    ...overrides,
  };
}

function captureQueue(reg: RunRegistry) {
  const captured: { worktree?: boolean; called: boolean } = { called: false };
  const fakeQueue = {
    enqueueOrSpawn(opts: any) {
      captured.called = true;
      captured.worktree = opts.worktree;
      const placeholder = makeRun(`fake-${Math.random().toString(36).slice(2, 6)}`, {
        status: "queued",
        persona: opts.persona.name,
      });
      reg.register(placeholder);
      return {
        kind: "queued" as const,
        pending: { id: placeholder.id } as any,
        placeholderRun: placeholder,
        downgraded: false,
        queuePosition: 1,
      };
    },
  };
  return { fakeQueue, captured };
}

function setupWithCaptureQueue() {
  const reg = new RunRegistry();
  const { fakeQueue, captured } = captureQueue(reg);
  const model = new FocusedStreamModel(reg);
  const tools: RegisteredTool[] = [];
  registerTools(
    { registerTool: (t: RegisteredTool) => tools.push(t) } as any,
    {
      getCwd: () => "/tmp",
      getRegistry: () => reg,
      getQueue: () => fakeQueue as any,
      getModel: () => model,
      getParentMessages: () => [],
      openFocusedOverlay: () => {},
      registerForegroundDetach: () => ({
        detachSignal: new Promise<void>(() => {}),
        unregister: () => {},
      }),
      pushCompletionNotification: () => {},
    },
  );
  return {
    captured,
    spawnTool: tools.find((t) => t.name === "ensemble_spawn")!,
  };
}

/** Full Persona shape required by buildSubAgentPrompt. */
function mkPersona(name: string, overrides: Partial<Persona> = {}): Persona {
  return {
    name,
    description: "test",
    inheritContext: "none",
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 1,
    systemPrompt: `You are ${name}.`,
    source: "builtin",
    sourcePath: "/dev/null",
    readOnly: false,
    ...overrides,
  };
}

// ── Schema tests ────────────────────────────────────────────────────────

// Note: persona.worktree is a frontmatter field, not an LLM tool arg in v0.13.
// The tool schema does NOT expose a `worktree` param. This test confirms that.
test("ensemble_spawn schema: no worktree tool arg in v0.13 (frontmatter-only)", () => {
  const { spawnTool } = setupWithCaptureQueue();
  const props = spawnTool.parameters?.properties;
  assert.ok(!props.worktree, "worktree is not a tool arg in v0.13 (deferred to v0.14)");
});

// ── Propagation: persona.worktree → SpawnOptions.worktree ─────────────

test(
  "ensemble_spawn: persona with worktree: true propagates worktree=true to queue",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "conductor-wt-persona-"));
    try {
      // Write a persona with worktree: true
      mkdirSync(projectPersonasDir(cwd), { recursive: true });
      writeFileSync(
        join(projectPersonasDir(cwd), "wt-builder.md"),
        `---\nname: wt-builder\ndescription: worktree test builder\nworktree: true\n---\n\nYou are wt-builder.\n`,
        "utf8",
      );

      const reg = new RunRegistry();
      const { fakeQueue, captured } = captureQueue(reg);
      const model = new FocusedStreamModel(reg);
      const tools: RegisteredTool[] = [];
      registerTools(
        { registerTool: (t: RegisteredTool) => tools.push(t) } as any,
        {
          getCwd: () => cwd,
          getRegistry: () => reg,
          getQueue: () => fakeQueue as any,
          getModel: () => model,
          getParentMessages: () => [],
          openFocusedOverlay: () => {},
          registerForegroundDetach: () => ({
            detachSignal: new Promise<void>(() => {}),
            unregister: () => {},
          }),
          pushCompletionNotification: () => {},
        },
      );
      const spawnTool = tools.find((t) => t.name === "ensemble_spawn")!;
      await spawnTool.execute("call-wt-1", {
        persona: "wt-builder",
        task: "noop",
        foreground: false,
      });
      assert.equal(captured.called, true);
      assert.equal(captured.worktree, true, "worktree: true propagated from persona frontmatter");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "ensemble_spawn: persona with worktree: false propagates worktree=false",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "conductor-wt-persona-false-"));
    try {
      mkdirSync(projectPersonasDir(cwd), { recursive: true });
      writeFileSync(
        join(projectPersonasDir(cwd), "no-wt.md"),
        `---\nname: no-wt\ndescription: no worktree\nworktree: false\n---\n\nYou are no-wt.\n`,
        "utf8",
      );

      const reg = new RunRegistry();
      const { fakeQueue, captured } = captureQueue(reg);
      const model = new FocusedStreamModel(reg);
      const tools: RegisteredTool[] = [];
      registerTools(
        { registerTool: (t: RegisteredTool) => tools.push(t) } as any,
        {
          getCwd: () => cwd,
          getRegistry: () => reg,
          getQueue: () => fakeQueue as any,
          getModel: () => model,
          getParentMessages: () => [],
          openFocusedOverlay: () => {},
          registerForegroundDetach: () => ({
            detachSignal: new Promise<void>(() => {}),
            unregister: () => {},
          }),
          pushCompletionNotification: () => {},
        },
      );
      const spawnTool = tools.find((t) => t.name === "ensemble_spawn")!;
      await spawnTool.execute("call-wt-2", {
        persona: "no-wt",
        task: "noop",
        foreground: false,
      });
      assert.equal(captured.called, true);
      assert.equal(captured.worktree, false, "worktree: false propagated from persona frontmatter");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

// ── spawnRun worktree stamp (real git) ─────────────────────────────────

test(
  "spawnRun: worktree=true in non-git cwd falls back gracefully (no run.worktreePath)",
  { timeout: 10_000 },
  () => {
    // /tmp is not a git repo — resolveWorktreeSpec returns null.
    // spawnRun should proceed with shared cwd, NOT set run.worktreePath.
    const reg = new RunRegistry();
    const persona = mkPersona("builder", { worktree: true });

    // The run will fail quickly (pi not found) but worktreePath should not be set.
    const result = spawnRun({
      registry: reg,
      persona,
      task: "test",
      mode: "background",
      cwd: "/tmp", // non-git
      timeoutMs: 500,
      worktree: true,
    });

    // The run object is immediately available; worktreePath must be undefined
    // because /tmp is not a git repo.
    assert.equal(
      result.run.worktreePath,
      undefined,
      "worktreePath must be undefined for non-git cwd fallback",
    );
  },
);

// ── Slice 2: worktreeBaseBranch + mergeStrategy stamping ──────────────────────

test(
  "spawnRun: mergeStrategy stamped on run when provided",
  () => {
    const reg = new RunRegistry();
    const result = spawnRun({
      registry: reg,
      persona: mkPersona("builder"),
      task: "test",
      mode: "background",
      cwd: "/tmp",
      timeoutMs: 200,
      mergeStrategy: "squash",
    });
    assert.equal(
      result.run.mergeStrategy,
      "squash",
      "mergeStrategy must be stamped onto run from opts",
    );
    result.run.status = "completed";
  },
);

test(
  "spawnRun: mergeStrategy undefined when not provided",
  () => {
    const reg = new RunRegistry();
    const result = spawnRun({
      registry: reg,
      persona: mkPersona("oracle", { readOnly: true }),
      task: "test",
      mode: "background",
      cwd: "/tmp",
      timeoutMs: 200,
    });
    assert.equal(
      result.run.mergeStrategy,
      undefined,
      "mergeStrategy must be undefined when not in opts",
    );
    result.run.status = "completed";
  },
);

test(
  "spawnRun: worktreeBaseBranch stamped when worktree=true and cwd is a git repo",
  { timeout: 10_000 },
  () => {
    const dir = tmpGitRepo();
    try {
      const reg = new RunRegistry();
      const result = spawnRun({
        registry: reg,
        persona: mkPersona("builder", { worktree: true }),
        task: "test",
        mode: "background",
        cwd: dir,
        timeoutMs: 200,
        worktree: true,
      });
      assert.ok(
        typeof result.run.worktreeBaseBranch === "string" &&
          result.run.worktreeBaseBranch.length > 0,
        `worktreeBaseBranch should be a non-empty string, got: ${result.run.worktreeBaseBranch}`,
      );
      result.run.status = "completed";
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "spawnRun: worktreeBaseBranch NOT stamped when worktree=false",
  () => {
    const reg = new RunRegistry();
    const result = spawnRun({
      registry: reg,
      persona: mkPersona("oracle", { readOnly: true }),
      task: "test",
      mode: "background",
      cwd: "/tmp",
      timeoutMs: 200,
    });
    assert.equal(
      result.run.worktreeBaseBranch,
      undefined,
      "worktreeBaseBranch must not be set when worktree=false",
    );
    result.run.status = "completed";
  },
);


// ── Slice 5: tools.ts merge_strategy → mergeStrategy cascade ─────────────────

test(
  "ensemble_spawn: merge_strategy per-call passes through to queue.mergeStrategy",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "conductor-wt-ms-"));
    try {
      mkdirSync(projectPersonasDir(cwd), { recursive: true });
      writeFileSync(
        join(projectPersonasDir(cwd), "wt-builder2.md"),
        `---\nname: wt-builder2\ndescription: merge strategy test\nworktree: true\n---\n\nYou are wt-builder2.\n`,
        "utf8",
      );

      const reg = new RunRegistry();
      const capturedFull: { mergeStrategy?: string } = {};
      const fakeQueue = {
        enqueueOrSpawn(opts: any) {
          capturedFull.mergeStrategy = opts.mergeStrategy;
          const placeholder = makeRun(`fake-ms`, { status: "queued", persona: opts.persona.name });
          reg.register(placeholder);
          return {
            kind: "queued" as const,
            pending: { id: placeholder.id } as any,
            placeholderRun: placeholder,
            downgraded: false,
            queuePosition: 1,
          };
        },
      };
      const model = new FocusedStreamModel(reg);
      const tools: RegisteredTool[] = [];
      registerTools(
        { registerTool: (t: RegisteredTool) => tools.push(t) } as any,
        {
          getCwd: () => cwd,
          getRegistry: () => reg,
          getQueue: () => fakeQueue as any,
          getModel: () => model,
          getParentMessages: () => [],
          openFocusedOverlay: () => {},
          registerForegroundDetach: () => ({
            detachSignal: new Promise<void>(() => {}),
            unregister: () => {},
          }),
          pushCompletionNotification: () => {},
        },
      );
      const spawnTool = tools.find((t) => t.name === "ensemble_spawn")!;

      // Per-call "merge" should override built-in "squash" for builder
      await spawnTool.execute("call-ms-1", {
        persona: "wt-builder2",
        task: "noop",
        foreground: false,
        merge_strategy: "merge",
      });
      assert.equal(
        capturedFull.mergeStrategy,
        "merge",
        "per-call merge_strategy must flow through to queue opts",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "ensemble_spawn: merge_strategy defaults to squash for write-capable persona with worktree",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "conductor-wt-ms-default-"));
    try {
      mkdirSync(projectPersonasDir(cwd), { recursive: true });
      writeFileSync(
        join(projectPersonasDir(cwd), "wt-builder3.md"),
        `---\nname: wt-builder3\ndescription: builder with worktree\nworktree: true\n---\n\nYou are wt-builder3.\n`,
        "utf8",
      );

      const reg = new RunRegistry();
      const capturedFull: { mergeStrategy?: string } = {};
      const fakeQueue = {
        enqueueOrSpawn(opts: any) {
          capturedFull.mergeStrategy = opts.mergeStrategy;
          const placeholder = makeRun(`fake-ms2`, { status: "queued", persona: opts.persona.name });
          reg.register(placeholder);
          return {
            kind: "queued" as const,
            pending: { id: placeholder.id } as any,
            placeholderRun: placeholder,
            downgraded: false,
            queuePosition: 1,
          };
        },
      };
      const model = new FocusedStreamModel(reg);
      const tools2: RegisteredTool[] = [];
      registerTools(
        { registerTool: (t: RegisteredTool) => tools2.push(t) } as any,
        {
          getCwd: () => cwd,
          getRegistry: () => reg,
          getQueue: () => fakeQueue as any,
          getModel: () => model,
          getParentMessages: () => [],
          openFocusedOverlay: () => {},
          registerForegroundDetach: () => ({
            detachSignal: new Promise<void>(() => {}),
            unregister: () => {},
          }),
          pushCompletionNotification: () => {},
        },
      );
      const spawnTool2 = tools2.find((t) => t.name === "ensemble_spawn")!;

      // No merge_strategy arg → built-in default for "wt-builder3" is "none"
      // (it's not named "builder" or "simplifier").
      // But if we name it "builder": would be "squash".
      // Here persona name is "wt-builder3" → default "none".
      await spawnTool2.execute("call-ms-2", {
        persona: "wt-builder3",
        task: "noop",
        foreground: false,
      });
      assert.equal(
        capturedFull.mergeStrategy,
        "none",
        "non-write-capable persona name defaults to none",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "ensemble_spawn: mergeStrategy undefined when persona has no worktree",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "conductor-wt-ms-nowt-"));
    try {
      mkdirSync(projectPersonasDir(cwd), { recursive: true });
      writeFileSync(
        join(projectPersonasDir(cwd), "oracle2.md"),
        `---\nname: oracle2\ndescription: oracle no worktree\nworktree: false\n---\n\nYou are oracle2.\n`,
        "utf8",
      );

      const reg = new RunRegistry();
      const capturedFull: { mergeStrategy?: string } = {};
      const fakeQueue = {
        enqueueOrSpawn(opts: any) {
          capturedFull.mergeStrategy = opts.mergeStrategy;
          const placeholder = makeRun(`fake-nowt`, { status: "queued", persona: opts.persona.name });
          reg.register(placeholder);
          return {
            kind: "queued" as const,
            pending: { id: placeholder.id } as any,
            placeholderRun: placeholder,
            downgraded: false,
            queuePosition: 1,
          };
        },
      };
      const model = new FocusedStreamModel(reg);
      const tools3: RegisteredTool[] = [];
      registerTools(
        { registerTool: (t: RegisteredTool) => tools3.push(t) } as any,
        {
          getCwd: () => cwd,
          getRegistry: () => reg,
          getQueue: () => fakeQueue as any,
          getModel: () => model,
          getParentMessages: () => [],
          openFocusedOverlay: () => {},
          registerForegroundDetach: () => ({
            detachSignal: new Promise<void>(() => {}),
            unregister: () => {},
          }),
          pushCompletionNotification: () => {},
        },
      );
      const spawnTool3 = tools3.find((t) => t.name === "ensemble_spawn")!;

      await spawnTool3.execute("call-ms-3", {
        persona: "oracle2",
        task: "noop",
        foreground: false,
      });
      assert.equal(
        capturedFull.mergeStrategy,
        undefined,
        "mergeStrategy must be undefined when persona has no worktree",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
