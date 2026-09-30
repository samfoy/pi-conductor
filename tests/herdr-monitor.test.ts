import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

test("H7 monitor probes every 5s, scans every 30s, drains before gone independently of watchdog", async () => {
  assert.ok(existsSync(new URL("../src/herdr/monitor.ts", import.meta.url)), "H7 monitor exists");
  const { HerdrMonitor } = await import("../src/herdr/monitor.ts");
  let time = 0, active = true, state: "alive" | "gone" | "unknown" = "alive";
  const calls: string[] = [];
  const monitor = new HerdrMonitor({ now: () => time, active: () => active,
    probe: () => { calls.push("probe"); return state; }, scan: async () => { calls.push("scan"); },
    drain: () => calls.push("drain"), gone: () => calls.push("gone") });
  await monitor.tick(); assert.equal(calls.length, 0);
  time = 5000; await monitor.tick(); assert.deepEqual(calls, ["probe"]);
  time = 30000; await monitor.tick(); assert.deepEqual(calls.slice(-2), ["probe", "scan"]);
  state = "unknown"; time = 35000; await monitor.tick(); assert.ok(!calls.includes("gone"));
  state = "gone"; time = 40000; await monitor.tick(); assert.deepEqual(calls.slice(-3), ["probe", "drain", "gone"]);
  const count = calls.length; time = 70000; await monitor.tick(); assert.equal(calls.length, count);
  monitor.close(); active = false;
});
for (const status of ["integrating", "terminal", "blocked"]) test(`H7 monitor has no CLI churn after ${status}`, async () => {
  const { HerdrMonitor } = await import("../src/herdr/monitor.ts");
  let time = 0;
  const monitor = new HerdrMonitor({ now: () => time, active: () => false,
    probe: () => { assert.fail("no probe"); }, scan: async () => { assert.fail("no scan"); }, drain() {}, gone() {} });
  time = 30000; await monitor.tick(); monitor.close();
});
