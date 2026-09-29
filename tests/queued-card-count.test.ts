/**
 * A queued background spawn posts exactly one `<sub-agent-completed>` card.
 * Witness: critic-fg05 (2026-09-24). With the write-capable cap at 1, a second
 * background builder queues; on drain it carries its own
 * `onComplete: pushCompletionNotification`, and ensemble_spawn's queued branch
 * also hung a registry listener that posted a card on any terminal. Natural
 * exits and timeouts got two cards, and so did watchdog kills after 3b52bcd.
 *
 * The listener stays for a foreground spawn auto-downgraded to background: it
 * has no onComplete of its own, so the listener is its only card. Tool kills of
 * a queued background run stay silent, per the ensemble_kill contract.
 *
 * Drives the real extension against a PI_BIN stub (a real non-pi subprocess),
 * hence the explicit timeouts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import conductor from "../src/index.ts";
import { stubCtx } from "./helpers/stub-pi.ts";
import { tmpDir } from "./helpers/tmp.ts";

const HARD_MS = 600_000; // DEFAULT_CONFIG.watchdog.defaultHardSeconds
const WATCHDOG_TICK_MS = 30_000; // DEFAULT_CONFIG.watchdog.tickIntervalSeconds
const TIMEOUT_MS = 60_000; // timeout_minutes: 1

type Card = { details?: { kind?: string; id?: string; status?: string } };
type End = "watchdog" | "natural" | "timeout" | "kill-running" | "kill-queued";

function loadWithTools() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, { execute: (...a: any[]) => Promise<any> }>();
  const messages: Card[] = [];
  conductor({
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) =>
      void handlers.set(ev, [...(handlers.get(ev) ?? []), h]),
    registerFlag() {}, getFlag() {},
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
    fire: async (ev: string, event: unknown, ctx: unknown) => {
      for (const h of handlers.get(ev) ?? []) await h(event, ctx);
    },
  };
}

async function until(what: string, ok: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ok()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * Spawn builder A (holds the only write-capable slot), then builder B, which
 * queues. Drain by killing A, end B the requested way, and return B's
 * completion cards once every terminal path has run.
 */
async function queuedB(end: End, bForeground = false): Promise<{ cards: Card[]; bStatus: string | undefined }> {
  const root = tmpDir("conductor-queued-card-");
  const memoryPath = join(root, "memory.jsonl");
  const saved = {
    HOME: process.env.HOME,
    PI_BIN: process.env.PI_BIN,
    CONDUCTOR_SUBAGENT: process.env.CONDUCTOR_SUBAGENT,
    CONDUCTOR_MEMORY_PATH: process.env.CONDUCTOR_MEMORY_PATH,
  };
  const real = { now: Date.now, setInterval: globalThis.setInterval, setTimeout: globalThis.setTimeout };
  let offset = 0;
  const ticks: Array<() => void> = [];
  const timeouts: Array<() => void> = [];
  const h = loadWithTools();
  process.env.HOME = join(root, "home");
  process.env.CONDUCTOR_MEMORY_PATH = memoryPath;
  delete process.env.CONDUCTOR_SUBAGENT;
  const stub = join(root, "pi-stub.mjs");
  // QUICKEXIT tasks exit 0 at once; the rest stay alive and silent until SIGTERM.
  writeFileSync(stub, `if (process.argv.some((a) => a.includes("QUICKEXIT"))) process.exit(0);\nsetInterval(() => {}, 1000);\n`);
  process.env.PI_BIN = stub;
  const ctx = stubCtx(root);
  const runs = join(root, "home", ".pi", "agent", "conductor", "runs");
  // record.json takes concurrent unordered writes; use it for the pid only.
  const pid = (id: string) => {
    try {
      return JSON.parse(readFileSync(join(runs, id, "record.json"), "utf8")).pid;
    } catch {
      return undefined;
    }
  };
  const statusOf = async (id: string): Promise<string | undefined> => {
    const { details } = await h.tools.get("ensemble_status")!.execute("s", {}, undefined, undefined, ctx);
    return [...details.running, ...details.queued, ...details.finished].find((r: { id: string }) => r.id === id)?.status;
  };
  const outcomes = () => (existsSync(memoryPath) ? readFileSync(memoryPath, "utf8").trim().split("\n").length : 0);
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

    const spawn = h.tools.get("ensemble_spawn")!;
    const kill = h.tools.get("ensemble_kill")!;
    const a = await spawn.execute("c1", { persona: "builder", task: "hold the slot", foreground: false, chain: false }, undefined, undefined, ctx);
    assert.ok(!a.isError, JSON.stringify(a.content));
    const aId: string = a.details.agent_id;
    const b = await spawn.execute(
      "c2",
      {
        persona: "builder",
        task: end === "natural" ? "QUICKEXIT now" : "hang",
        foreground: bForeground,
        kill_on_stall: true,
        chain: false, // a completed builder would chain a critic into the next test
        ...(end === "timeout" ? { timeout_minutes: 1 } : {}),
      },
      undefined,
      undefined,
      ctx,
    );
    assert.equal(b.details.status, bForeground ? "queued-as-background" : "queued", JSON.stringify(b.details));
    const bId: string = b.details.agent_id;
    await until("A to start", () => Boolean(pid(aId)));

    if (end === "kill-queued") {
      const out = await kill.execute("c3", { agent_id: bId }, undefined, undefined, ctx);
      assert.ok(!out.isError, JSON.stringify(out.content));
      await kill.execute("c4", { agent_id: aId }, undefined, undefined, ctx);
      await until("A's close handler", () => outcomes() === 1);
    } else {
      // Killing A drains the queue: B spawns synchronously inside this call,
      // which is when its hard-timeout timer is armed.
      globalThis.setTimeout = ((fn: () => void, ms?: number) => {
        if (ms === TIMEOUT_MS) timeouts.push(fn);
        return real.setTimeout(fn, ms);
      }) as typeof setTimeout;
      try {
        await kill.execute("c3", { agent_id: aId }, undefined, undefined, ctx);
      } finally {
        globalThis.setTimeout = real.setTimeout;
      }
      if (end !== "natural") await until("B to start", () => Boolean(pid(bId)));
      if (end === "watchdog") {
        offset = HARD_MS + 60_000;
        ticks[0]!();
      } else if (end === "timeout") {
        assert.equal(timeouts.length, 1, "captured B's hard-timeout timer");
        timeouts[0]!();
      } else if (end === "kill-running") {
        await kill.execute("c4", { agent_id: bId }, undefined, undefined, ctx);
      }
      // Both close handlers record an outcome after every card path has run.
      await until("A's and B's close handlers", () => outcomes() === 2);
    }
    return {
      cards: h.messages.filter((m) => m.details?.id === bId && m.details?.kind === "completed"),
      bStatus: await statusOf(bId),
    };
  } finally {
    Date.now = real.now;
    globalThis.setInterval = real.setInterval;
    globalThis.setTimeout = real.setTimeout;
    await h.fire("session_shutdown", { reason: "reload" }, ctx);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const describeCards = (cards: Card[]) => JSON.stringify(cards.map((c) => c.details?.status));

for (const [end, status] of [
  ["watchdog", "killed"],
  ["natural", "completed"],
  ["timeout", "timeout"],
] as const) {
  test(`queued background spawn: a ${end} end posts exactly one completion card`, { timeout: 30_000 }, async () => {
    const { cards, bStatus } = await queuedB(end);
    assert.equal(bStatus, status);
    assert.equal(cards.length, 1, `completion cards: ${describeCards(cards)}`);
    assert.equal(cards[0]!.details!.status, status);
  });
}

test("queued background spawn: ensemble_kill after it drained stays silent", { timeout: 30_000 }, async () => {
  const { cards, bStatus } = await queuedB("kill-running");
  assert.equal(bStatus, "killed");
  assert.deepEqual(cards, []);
});

test("queued background spawn: ensemble_kill while still queued stays silent", { timeout: 30_000 }, async () => {
  const { cards } = await queuedB("kill-queued");
  assert.deepEqual(cards, []);
});

test("downgraded foreground spawn: its only card comes from the queued-branch listener", { timeout: 30_000 }, async () => {
  const { cards, bStatus } = await queuedB("natural", true);
  assert.equal(bStatus, "completed");
  assert.equal(cards.length, 1, `completion cards: ${describeCards(cards)}`);
  assert.equal(cards[0]!.details!.status, "completed");
});
