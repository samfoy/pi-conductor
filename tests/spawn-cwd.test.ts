/**
 * Per-spawn `cwd` on ensemble_spawn and on each ensemble_auto step: path
 * validation before any Run exists, and persona/config resolution at the
 * spawn cwd rather than the conductor's. A capture queue stands in for
 * the real one, so no subprocess is forked.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { projectPersonasDir } from "../src/personas.ts";
import { emptyUsage, type Run } from "../src/types.ts";

interface Sandbox {
  root: string;
  conductorCwd: string;
  repo: string;
}

function withSandbox<T>(fn: (s: Sandbox) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "conductor-spawn-cwd-"));
  const conductorCwd = join(root, "conductor");
  const repo = join(root, "repo");
  mkdirSync(join(root, "home"), { recursive: true });
  mkdirSync(conductorCwd);
  // A project persona and project config that exist ONLY under the spawn cwd.
  mkdirSync(projectPersonasDir(repo), { recursive: true });
  writeFileSync(
    join(projectPersonasDir(repo), "probe.md"),
    "---\nname: probe\ndescription: project-only persona\n---\n\nYou are probe.\n",
  );
  writeFileSync(
    join(repo, ".pi", "conductor.json"),
    JSON.stringify({ personaOverrides: { probe: { timeoutMinutes: 7, model: "prov/project-model" } } }),
  );
  const saved = { HOME: process.env.HOME, CONDUCTOR_SUBAGENT: process.env.CONDUCTOR_SUBAGENT };
  process.env.HOME = join(root, "home");
  delete process.env.CONDUCTOR_SUBAGENT;
  return fn({ root, conductorCwd, repo }).finally(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });
}

function makeRun(id: string, over: Partial<Run> = {}): Run {
  return {
    id,
    persona: "probe",
    task: "t",
    mode: "background",
    status: "running",
    startTime: 1,
    lastEventAt: 1,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: `/tmp/${id}/record.json`,
    transcriptPath: `/tmp/${id}/transcript.jsonl`,
    finalPath: `/tmp/${id}/final.md`,
    ...over,
  };
}

/** Registers the conductor tools over a queue that records each spawn and completes it at once. */
function harness(conductorCwd: string) {
  const reg = new RunRegistry();
  const calls: any[] = [];
  const queue = {
    enqueueOrSpawn(o: any) {
      calls.push(o);
      const run = makeRun(`${o.persona.name}-${calls.length}`, {
        persona: o.persona.name,
        cwd: o.cwd,
        status: "completed",
      });
      reg.register(run);
      return { kind: "spawned" as const, run, done: Promise.resolve(run) };
    },
  };
  const tools = new Map<string, { execute: (id: string, p: unknown) => Promise<any> }>();
  registerTools({ registerTool: (t: any) => void tools.set(t.name, t) } as any, {
    getCwd: () => conductorCwd,
    getRegistry: () => reg,
    getQueue: () => queue as any,
    getModel: () => new FocusedStreamModel(reg),
    getParentMessages: () => [],
    openFocusedOverlay: () => {},
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
    pushCompletionNotification: () => {},
  });
  return { reg, calls, spawn: tools.get("ensemble_spawn")!, auto: tools.get("ensemble_auto")! };
}

// ── ensemble_spawn ───────────────────────────────────────────────────

for (const [label, arg] of [
  ["a missing directory", "does-not-exist"],
  ["a file", "file.txt"],
] as const) {
  test(`ensemble_spawn: cwd pointing at ${label} is rejected before any Run is registered`, () =>
    withSandbox(async ({ conductorCwd }) => {
      writeFileSync(join(conductorCwd, "file.txt"), "x");
      const h = harness(conductorCwd);
      const r = await h.spawn.execute("c1", { persona: "inspector", task: "t", foreground: false, cwd: arg });
      assert.match(r.content[0].text, /cwd/);
      assert.equal(h.calls.length, 0, "queue never called");
      assert.deepEqual(h.reg.list(), [], "no Run registered");
    }));
}

test("ensemble_spawn: personas, config, and the spawned cwd all come from the spawn cwd", () =>
  withSandbox(async ({ conductorCwd, repo }) => {
    const h = harness(conductorCwd);

    const without = await h.spawn.execute("c1", { persona: "probe", task: "t", foreground: false });
    assert.match(without.content[0].text, /not found/, "probe exists only under the spawn cwd");

    await h.spawn.execute("c2", { persona: "probe", task: "t", foreground: false, cwd: repo, chain: false });
    assert.equal(h.calls.length, 1);
    const o = h.calls[0];
    assert.equal(o.cwd, repo);
    assert.equal(o.persona.source, "project");
    assert.equal(o.timeoutMs, 7 * 60_000, "project config under the spawn cwd drives the timeout");
    assert.equal(o.model, "prov/project-model");
  }));

test("ensemble_spawn: ~ and relative cwd resolve against HOME and the conductor cwd", () =>
  withSandbox(async ({ root, conductorCwd }) => {
    mkdirSync(join(conductorCwd, "sub"));
    mkdirSync(join(root, "home", "proj"));
    const h = harness(conductorCwd);
    await h.spawn.execute("c1", { persona: "inspector", task: "t", foreground: false, cwd: "sub" });
    await h.spawn.execute("c2", { persona: "inspector", task: "t", foreground: false, cwd: "~/proj" });
    await h.spawn.execute("c3", { persona: "inspector", task: "t", foreground: false });
    assert.deepEqual(
      h.calls.map((o) => o.cwd),
      [join(conductorCwd, "sub"), join(root, "home", "proj"), conductorCwd],
    );
  }));

// ── ensemble_auto ────────────────────────────────────────────────────

test("ensemble_auto: each step spawns in its own cwd, resolving personas there", () =>
  withSandbox(async ({ conductorCwd, repo }) => {
    const h = harness(conductorCwd);
    const r = await h.auto.execute("a1", {
      goal: "g",
      max_steps: 4,
      steps: [
        { persona: "probe", task: "one", cwd: repo },
        { persona: "inspector", task: "two" },
      ],
    });
    assert.equal(r.details.status, "done", r.content[0].text);
    assert.deepEqual(
      h.calls.map((o) => [o.persona.name, o.cwd]),
      [
        ["probe", repo],
        ["inspector", conductorCwd],
      ],
    );
    assert.equal(h.calls[0].timeoutMs, 7 * 60_000, "step config comes from the step cwd");
  }));

test("ensemble_auto: an invalid step cwd halts the plan before any spawn", () =>
  withSandbox(async ({ conductorCwd }) => {
    const h = harness(conductorCwd);
    const r = await h.auto.execute("a2", {
      goal: "g",
      max_steps: 4,
      steps: [
        { persona: "inspector", task: "one" },
        { persona: "inspector", task: "two", cwd: "nowhere" },
      ],
    });
    assert.equal(r.details.status, "halted");
    assert.match(r.details.haltReason, /step 2.*does not exist/);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(h.reg.list(), []);
  }));

test("ensemble_auto: a persona that exists only under another step's cwd is unknown in this step", () =>
  withSandbox(async ({ conductorCwd, repo }) => {
    const h = harness(conductorCwd);
    const r = await h.auto.execute("a3", {
      goal: "g",
      max_steps: 4,
      steps: [
        { persona: "probe", task: "one", cwd: repo },
        { persona: "probe", task: "two" },
      ],
    });
    assert.equal(r.details.status, "halted");
    assert.match(r.details.haltReason, /unknown persona/);
    assert.equal(h.calls.length, 0);
  }));
