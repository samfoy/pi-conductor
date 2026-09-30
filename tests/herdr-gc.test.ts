import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi } from "./helpers/tmp.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { toRunRecord, DEFAULT_CONFIG } from "../src/types.ts";
import { executeReclaim } from "../src/gc/executor.ts";
import { planReclaim } from "../src/gc/policy.ts";
import { walkInventory } from "../src/gc/inventory.ts";
import { RunRegistry } from "../src/runs.ts";
sandboxPi();

test("H9 a stale transport exit flag cannot immortalize a freshly proven absent terminal child", async () => {
  const h = await fixture();
  h.run.transport = { ...h.run.transport!, childExited: false } as typeof h.run.transport;
  const inventory = await walkInventory(h.run.cwd, h.registry);
  const plan = planReclaim(inventory, h.config, Date.now());
  assert.equal(plan.actions[0].kind, "cold-archive");
  const result = await executeReclaim(plan.actions, h.run.cwd, new Set(), Date.now(), { currentRun: () => h.run, env: { CONDUCTOR_HERDR_BIN: "/h9/no-such-private-cli" } });
  assert.equal(result.archived.length, 1);
});


test("H9 terminal status change after inventory cancels even an otherwise matching plan", async () => {
  const h = await fixture(); h.run.status = "killed"; h.save();
  const result = await executeReclaim(h.plan.actions, h.run.cwd, new Set(), Date.now(), { env: { CONDUCTOR_HERDR_BIN: "/h9/no-such-private-cli" } });
  assert.equal(result.archived.length, 0); assert.equal(existsSync(h.run.transcriptPath), true);
});

async function fixture() {
  const h = herdrFixture("healthy");
  const transport = h.runtime.launch(h.run, [], h.run.cwd, { line() {}, close() {}, error() {}, initialDeliveryFailed() {} }, "probe", h.opts.core);
  h.run.transport = transport; await transport.ready; h.run.status = "completed";
  // ESRCH from an impossible positive PID is death evidence, never a signal target.
  h.run.herdr!.childPid = 2147483647;
  const helloPath = join(dirname(h.run.recordPath), "launch", `${h.run.herdr!.launchNonce}.json`);
  const hello = JSON.parse(readFileSync(helloPath, "utf8")); hello.pid = h.run.herdr!.childPid;
  writeFileSync(helloPath, JSON.stringify(hello));
  const save = () => writeFileSync(h.run.recordPath, JSON.stringify(toRunRecord(h.run)));
  save();
  const config = { ...DEFAULT_CONFIG.gc, transcriptSizeCapBytes: 1 };
  const inventory = await walkInventory(h.run.cwd, new RunRegistry());
  return { ...h, save, config, inventory, plan: planReclaim(inventory, config, Date.now()) };
}
test("H9 proven absent child is eligible for ordinary archive without a live server", async () => {
  const h = await fixture();
  assert.equal(h.plan.actions[0].kind, "cold-archive");
  const result = await executeReclaim(h.plan.actions, h.run.cwd, new Set(), Date.now(), { env: { CONDUCTOR_HERDR_BIN: "/h9/no-such-private-cli" } });
  assert.equal(result.archived.length, 1); assert.equal(existsSync(h.run.transcriptPath), false);
  assert.equal(existsSync(h.run.recordPath), true);
});
for (const change of ["nonce", "pid", "status", "effort"] as const) test(`H9 GC revalidates ${change} after inventory before reclaim`, async () => {
  const h = await fixture();
  const actions = [{ kind: "cold-archive" as const, id: h.run.id, reason: "test", bytesReclaimed: 1, herdr: { ...h.run.herdr! } }];
  if (change === "nonce") h.run.herdr!.launchNonce = "resumed";
  if (change === "pid") h.run.herdr!.childPid = process.pid;
  if (change === "status") h.run.status = "running";
  if (change === "effort") h.run.effort = { name: "protected" } as typeof h.run.effort;
  h.save();
  const result = await executeReclaim(actions, h.run.cwd, new Set(), Date.now());
  assert.equal(result.archived.length, 0, "stale plan must not delete current invocation evidence");
  assert.equal(existsSync(h.run.transcriptPath), true); assert.equal(result.failed.length, 1);
});
test("H9 bound worktree survives unavailable pane release and retains ownership records", async () => {
  const h = await fixture();
  h.run.worktreePath = join(h.run.cwd, "kept"); h.run.worktreeBranch = "unmerged";
  mkdirSync(h.run.worktreePath); writeFileSync(join(h.run.worktreePath, "work"), "owned work"); h.save();
  const result = await executeReclaim([{ kind: "delete", id: h.run.id, reason: "TTL", bytesReclaimed: 1, losesResume: true, herdr: { ...h.run.herdr! } }], h.run.cwd, new Set(), Date.now(), { env: { CONDUCTOR_HERDR_BIN: "/h9/no-such-private-cli" } });
  assert.equal(result.deleted.length, 0); assert.equal(existsSync(h.run.recordPath), true);
  assert.equal(readFileSync(join(h.run.worktreePath, "work"), "utf8"), "owned work");
});
