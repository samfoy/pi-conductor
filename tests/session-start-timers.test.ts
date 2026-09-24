/**
 * pi can fire session_start twice without a session_shutdown between
 * them (e.g. a session switch). Each start must replace the intervals the
 * previous one armed, not stack another copy.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConductor, stubCtx } from "./helpers/stub-pi.ts";

test("session_start twice without a shutdown keeps one set of intervals; shutdown clears them all", async () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-session-timers-"));
  const saved = { HOME: process.env.HOME, CONDUCTOR_SUBAGENT: process.env.CONDUCTOR_SUBAGENT };
  const real = { setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval, clearTimeout: globalThis.clearTimeout };
  const live = new Set<unknown>();
  process.env.HOME = join(root, "home");
  delete process.env.CONDUCTOR_SUBAGENT;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const handle = real.setInterval(...args);
    live.add(handle);
    return handle;
  }) as typeof setInterval;
  // Node lets clearTimeout cancel an interval too.
  globalThis.clearInterval = ((h?: NodeJS.Timeout) => void (live.delete(h), real.clearInterval(h))) as typeof clearInterval;
  globalThis.clearTimeout = ((h?: NodeJS.Timeout) => void (live.delete(h), real.clearTimeout(h))) as typeof clearTimeout;
  try {
    const conf = join(root, "home", ".pi", "agent", "extensions", "conductor");
    mkdirSync(conf, { recursive: true });
    writeFileSync(join(conf, "config.json"), JSON.stringify({ gc: { enabled: false } }));
    const fire = loadConductor();
    const ctx = stubCtx(root);

    await fire("session_start", {}, ctx);
    const afterFirst = live.size;
    assert.ok(afterFirst >= 2, `watchdog + wake-recheck intervals armed; got ${afterFirst}`);

    await fire("session_start", {}, ctx);
    assert.equal(live.size, afterFirst, "the second start replaced its intervals instead of adding more");

    await fire("session_shutdown", { reason: "reload" }, ctx);
    assert.equal(live.size, 0, "shutdown clears every interval");
  } finally {
    for (const h of live) real.clearInterval(h as NodeJS.Timeout);
    Object.assign(globalThis, real);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
