/**
 * A watchdog hard-stall kill must post the run's `<sub-agent-completed>`
 * card, like a natural exit, a timeout or a turn-limit kill. Witness:
 * builder-1j0j (2026-09-24) got its soft and hard `<sub-agent-stalled>`
 * advisories, then died with record.json `killed`, and the conductor never
 * heard: the kill called forceTerminate without the run's onComplete, and
 * the close handler skips onComplete once forceTerminate has settled a run.
 * `ensemble_kill` stays silent, per its contract.
 *
 * Drives the real extension: ensemble_spawn with a PI_BIN stub that stays
 * alive and silent, a shifted Date.now, and the watchdog's own interval
 * callback. Forks a real (non-pi) subprocess, hence the explicit timeout.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import conductor from "../src/index.ts";
import { stubCtx } from "./helpers/stub-pi.ts";

const HARD_MS = 600_000; // DEFAULT_CONFIG.watchdog.defaultHardSeconds
const WATCHDOG_TICK_MS = 30_000; // DEFAULT_CONFIG.watchdog.tickIntervalSeconds

interface Harness {
  fire: (ev: string, event: unknown, ctx: unknown) => Promise<void>;
  tools: Map<string, { execute: (...a: any[]) => Promise<any> }>;
  messages: Array<{ details?: { kind?: string; id?: string; status?: string; severity?: string } }>;
}

function loadWithTools(): Harness {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, { execute: (...a: any[]) => Promise<any> }>();
  const messages: Harness["messages"] = [];
  conductor({
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) =>
      void handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
    registerTool: (t: any) => void tools.set(t.name, t),
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerShortcut: () => {},
    sendMessage: (m: any) => void messages.push(m),
    appendEntry: () => {},
  } as any);
  return {
    tools,
    messages,
    fire: async (ev, event, ctx) => {
      for (const h of handlers.get(ev) ?? []) await h(event, ctx);
    },
  };
}

async function until(what: string, ok: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function stallKill(tool: "watchdog" | "ensemble_kill"): Promise<Harness["messages"]> {
  const root = mkdtempSync(join(tmpdir(), "conductor-watchdog-card-"));
  const memoryPath = join(root, "memory.jsonl");
  const saved = {
    HOME: process.env.HOME,
    PI_BIN: process.env.PI_BIN,
    CONDUCTOR_SUBAGENT: process.env.CONDUCTOR_SUBAGENT,
    CONDUCTOR_MEMORY_PATH: process.env.CONDUCTOR_MEMORY_PATH,
  };
  const real = { now: Date.now, setInterval: globalThis.setInterval };
  let offset = 0;
  const ticks: Array<() => void> = [];
  const h = loadWithTools();
  process.env.HOME = join(root, "home");
  process.env.CONDUCTOR_MEMORY_PATH = memoryPath;
  delete process.env.CONDUCTOR_SUBAGENT;
  const stub = join(root, "pi-stub.mjs");
  writeFileSync(stub, "setInterval(() => {}, 1000);\n"); // alive, silent, dies on SIGTERM
  process.env.PI_BIN = stub;
  const ctx = stubCtx(root);
  try {
    const conf = join(root, "home", ".pi", "agent", "extensions", "conductor");
    mkdirSync(conf, { recursive: true });
    writeFileSync(join(conf, "config.json"), JSON.stringify({ gc: { enabled: false } }));
    Date.now = () => real.now() + offset;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      if (ms === WATCHDOG_TICK_MS) ticks.push(fn);
      return real.setInterval(fn, ms);
    }) as typeof setInterval;
    try {
      await h.fire("session_start", {}, ctx);
    } finally {
      globalThis.setInterval = real.setInterval;
    }
    assert.equal(ticks.length, 1, "captured the watchdog's tick");

    const spawned = await h.tools.get("ensemble_spawn")!.execute(
      "call-1",
      { persona: "oracle", task: "hang", foreground: false, kill_on_stall: true },
      undefined,
      undefined,
      ctx,
    );
    assert.ok(!spawned.isError, JSON.stringify(spawned.content));
    const id: string = spawned.details.agent_id;
    const recordPath = join(root, "home", ".pi", "agent", "conductor", "runs", id, "record.json");
    await until("the stub to start", () => existsSync(recordPath) && JSON.parse(readFileSync(recordPath, "utf8")).pid);

    if (tool === "watchdog") {
      offset = HARD_MS + 60_000;
      ticks[0]!();
    } else {
      const out = await h.tools.get("ensemble_kill")!.execute("call-2", { agent_id: id }, undefined, undefined, ctx);
      assert.ok(!out.isError, JSON.stringify(out.content));
    }
    await until("record.json to say killed", () => JSON.parse(readFileSync(recordPath, "utf8")).status === "killed");
    // The close handler records the outcome after the stub exits; by then
    // any duplicate card from that path would have been sent.
    await until("the close handler", () => existsSync(memoryPath) && readFileSync(memoryPath, "utf8").includes(`"status":"killed"`));
    return h.messages.filter((m) => m.details?.id === id);
  } finally {
    Date.now = real.now;
    globalThis.setInterval = real.setInterval;
    await h.fire("session_shutdown", { reason: "reload" }, ctx);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("watchdog: a hard-stall kill of a background run posts exactly one killed completion card", { timeout: 30_000 }, async () => {
  const messages = await stallKill("watchdog");
  assert.ok(
    messages.some((m) => m.details?.kind === "stalled" && m.details.severity === "hard"),
    "the hard advisory still lands first",
  );
  const cards = messages.filter((m) => m.details?.kind === "completed");
  assert.equal(cards.length, 1, `completion cards: ${JSON.stringify(cards.map((c) => c.details))}`);
  assert.equal(cards[0]!.details!.status, "killed");
});

test("ensemble_kill: a tool kill of the same background run stays silent", { timeout: 30_000 }, async () => {
  const messages = await stallKill("ensemble_kill");
  assert.deepEqual(messages.filter((m) => m.details?.kind === "completed"), []);
});
