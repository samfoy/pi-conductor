/**
 * A conductor child (CONDUCTOR_SUBAGENT=1) shares the lead's runs root, so
 * its session_start must never run the auto GC over it: GC archives and
 * deletes run dirs and reclaims worktrees the lead still owns. Manual
 * `/conductor gc` is a separate path and stays available.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { lastGcMarkerPath } from "../src/gc/last-gc.ts";
import { loadConductor, stubCtx } from "./helpers/stub-pi.ts";

/** Whether session_start's deferred work ran GC (it stamps `.last-gc`). */
async function gcRanOnSessionStart(child: boolean): Promise<boolean> {
  const root = mkdtempSync(join(tmpdir(), "conductor-session-start-gc-"));
  const saved = { HOME: process.env.HOME, CONDUCTOR_SUBAGENT: process.env.CONDUCTOR_SUBAGENT };
  const realSetImmediate = globalThis.setImmediate;
  process.env.HOME = join(root, "home");
  if (child) process.env.CONDUCTOR_SUBAGENT = "1";
  else delete process.env.CONDUCTOR_SUBAGENT;
  try {
    const conf = join(root, "home", ".pi", "agent", "extensions", "conductor");
    mkdirSync(conf, { recursive: true });
    writeFileSync(
      join(conf, "config.json"),
      JSON.stringify({ gc: { enabled: true, autoOnSessionStart: true, autoDebounceHours: 0 } }),
    );
    const runsRoot = join(root, "home", ".pi", "agent", "conductor", "runs");
    mkdirSync(runsRoot, { recursive: true });

    const fire = loadConductor();
    const deferred: Array<() => unknown> = [];
    globalThis.setImmediate = ((cb: (...a: unknown[]) => unknown, ...args: unknown[]) => {
      deferred.push(() => cb(...args));
      return { unref: () => {}, ref: () => {}, hasRef: () => false } as unknown as NodeJS.Immediate;
    }) as typeof setImmediate;
    try {
      await fire("session_start", {}, stubCtx(root));
    } finally {
      globalThis.setImmediate = realSetImmediate;
    }
    await fire("session_shutdown", { reason: "reload" }, stubCtx(root));
    await Promise.all(deferred.map((run) => run()));
    return existsSync(lastGcMarkerPath(runsRoot));
  } finally {
    globalThis.setImmediate = realSetImmediate;
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

test("a lead session_start runs the auto GC (positive control)", async () => {
  assert.equal(await gcRanOnSessionStart(false), true);
});

test("a child session_start never runs the auto GC over the shared runs root", async () => {
  assert.equal(await gcRanOnSessionStart(true), false);
});
