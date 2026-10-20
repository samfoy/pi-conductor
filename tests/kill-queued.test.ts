/**
 * A queued run is killable whatever its runtime.
 *
 * A queued run has no process, transport or session yet. ensemble_kill on
 * a queued herdr run used to be refused with "herdr runtime unavailable
 * here: stream is not attached", because the herdr transport gate ran
 * before the kill branch. Kill dequeues it: it never starts, it is
 * `killed`, it emits the usual terminal event, and it frees no slot.
 *
 * The spawner is a spy, so no real pi and no herdr pane is ever launched;
 * the herdr runtime is selected from a faked env passed as runtimeEnv.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { registerTools } from "../src/tools.ts";
import { RunRegistry, type SpawnOptions } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { CHANNEL, ConductorEventEmitter } from "../src/conductor-events.ts";
import { emptyUsage, type Persona, type Run } from "../src/types.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();

const FAKE_HERDR_ENV = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/kill-queued-no-socket", HERDR_PANE_ID: "pane" };

const persona: Persona = {
  name: "scout", description: "probe", inheritContext: "none", inheritSkills: false, defaultReads: [],
  worktree: false, timeoutMinutes: 1, systemPrompt: "You are scout.", source: "project",
  sourcePath: "/fake/scout.md", readOnly: true,
};

function harness() {
  const cwd = tmpDir("kill-queued-");
  const registry = new RunRegistry();
  const spawned: string[] = [];
  const spy = (o: SpawnOptions): { run: Run; done: Promise<Run> } => {
    const id = o.preAllocatedId ?? o.task;
    spawned.push(id);
    const run = registry.get(id) ?? { id, persona: o.persona.name, task: o.task, mode: "background", status: "running",
      runtime: o.runtime, startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: emptyUsage(), cwd,
      recordPath: `${cwd}/${id}/record.json`, transcriptPath: `${cwd}/${id}/transcript.jsonl`, finalPath: `${cwd}/${id}/final.md` } as Run;
    run.status = "running";
    if (!registry.get(id)) registry.register(run);
    return { run, done: new Promise<Run>(() => {}) };
  };
  const queue = new SpawnQueue(registry, 1, 1, spy);
  const model = new FocusedStreamModel(registry);
  const events: { channel: string; data: any }[] = [];
  const emitter = new ConductorEventEmitter({ emit: (channel, data) => events.push({ channel, data }), on: () => () => {} });
  const tools = new Map<string, any>();
  registerTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any, {
    getCwd: () => cwd, getRegistry: () => registry, getQueue: () => queue, getModel: () => model,
    getParentMessages: () => [], openFocusedOverlay: () => {}, pushCompletionNotification: () => {},
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
  });
  const call = (name: string, params: Record<string, unknown> = {}) =>
    tools.get(`ensemble_${name}`).execute("call", params, undefined, undefined, { mode: "json", hasUI: false });
  const enqueue = (task: string, runtimeEnv: Record<string, string>) =>
    queue.enqueueOrSpawn({ persona, task, cwd, mode: "background", timeoutMs: 60_000, runtimeEnv, events: emitter });
  return { registry, queue, spawned, events, call, enqueue };
}

const text = (result: any): string => result.content.map((c: any) => c.text).join("\n");

for (const runtime of ["herdr", "subprocess"] as const) {
  test(`a queued ${runtime} run is killable: it never starts and frees no slot`, { timeout: 5000 }, async () => {
    const h = harness();
    const env = runtime === "herdr" ? FAKE_HERDR_ENV : {};
    assert.equal(h.enqueue("holder", env).kind, "spawned");
    const victim = h.enqueue("victim", env);
    const next = h.enqueue("next", env);
    assert.ok(victim.kind === "queued" && next.kind === "queued", "maxConcurrent 1: both wait");
    const id = victim.placeholderRun.id, nextId = next.placeholderRun.id;
    assert.equal(victim.placeholderRun.runtime, runtime);
    assert.equal(victim.placeholderRun.transport, undefined, "a queued run has no transport");

    const before = await h.call("status", { agent_id: id });
    assert.deepEqual(before.details.queued.map((r: any) => r.available_actions), [["kill"]]);

    const result = await h.call("kill", { agent_id: id });
    assert.equal(result.details.error, undefined, `kill refused: ${text(result)}`);
    assert.equal(result.details.status, "killed");
    assert.doesNotMatch(text(result), /stream is not attached|child exit requires proof/);
    const run = h.registry.get(id)!;
    assert.equal(run.status, "killed");
    assert.equal(run.herdrExitUnconfirmed, undefined, "a run that never launched has no child exit to confirm");

    // Dequeued, never started, and no slot freed: the holder still runs and next still waits.
    assert.deepEqual(h.queue.list().map(p => p.id), [nextId]);
    assert.deepEqual(h.spawned, ["holder"]);
    assert.equal(h.registry.get("holder")!.status, "running");
    assert.equal(h.registry.get(nextId)!.status, "queued", "killing a queued run frees no slot");

    // The usual terminal event for a kill.
    const failed = h.events.filter(e => e.channel === CHANNEL.failed);
    assert.deepEqual(failed.map(e => [e.data.id, e.data.status]), [[id, "killed"]]);

    // ensemble_status lists it under Killed.
    const after = await h.call("status");
    assert.deepEqual(after.details.finished.map((r: any) => [r.id, r.status]), [[id, "killed"]]);
    assert.match(text(after), new RegExp(`Killed:\\n\\s+${id}\\b`));

    // When the slot frees, the queue drains past the killed run.
    const holder = h.registry.get("holder")!;
    holder.status = "completed";
    h.registry.notify(holder);
    assert.deepEqual(h.spawned, ["holder", nextId]);
    assert.equal(run.status, "killed");
  });
}

test("a queued herdr run refuses every other action as queued, not as a missing stream", { timeout: 5000 }, async () => {
  const h = harness();
  h.enqueue("holder", FAKE_HERDR_ENV);
  const victim = h.enqueue("victim", FAKE_HERDR_ENV);
  assert.equal(victim.kind, "queued");
  const id = victim.kind === "queued" ? victim.placeholderRun.id : "";
  const refusals = [
    await h.call("send", { agent_id: id, message: "hello", foreground: false }),
    await h.call("send", { agent_id: id, message: "hello", foreground: false, streaming_behavior: "steer" }),
    await h.call("send", { agent_id: id, message: "hello", foreground: false, streaming_behavior: "follow_up" }),
    await h.call("pause", { agent_id: id }),
    await h.call("resume", { agent_id: id }),
  ];
  for (const r of refusals) {
    assert.ok(r.details.error, `expected a refusal, got: ${text(r)}`);
    assert.match(text(r), /queued/);
    assert.doesNotMatch(text(r), /stream is not attached/);
  }
  assert.equal(h.registry.get(id)!.status, "queued", "refusals change nothing");
  assert.deepEqual(h.queue.list().map(p => p.id), [id]);
});
