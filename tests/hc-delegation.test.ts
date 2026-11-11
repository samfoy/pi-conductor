import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { fakeHc, fakeHcBin } from "./helpers/fake-hc.ts";
import { until } from "./helpers/hc-launch.ts";
import { projectPersonasDir, resolvePersonas } from "../src/personas.ts";
import { RunRegistry, getFinalText, spawnRun } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { DelegationBroker } from "../src/delegation-broker.ts";
import { delegatePaths } from "../src/delegation.ts";
import { resolveHcContext } from "../src/hc/context.ts";
import { hcTab } from "../src/hc/host.ts";
import type { HcBinding } from "../src/herdr/identity.ts";
import type { Run } from "../src/types.ts";

sandboxPi();
const child = fileURLToPath(new URL("./fixtures/hc-delegation-child.mjs", import.meta.url));
const doc = (name: string, fm: string) => `---\nname: ${name}\ndescription: probe\n${fm}---\nYou are ${name}.\n`;

async function hcDelegation(t: TestContext) {
  const f = await fakeHc();
  const lead = await f.cli.run({ name: "lead", cwd: "/tmp", labels: { "herdr.space": "sp-lead" }, argv: ["pi"] });
  f.patch({ spawn: true });
  const root = tmpDir("hc-n5-"), manifests = join(root, "m"), cwd = join(root, "project");
  mkdirSync(manifests); mkdirSync(projectPersonasDir(cwd), { recursive: true });
  for (const [file, text] of Object.entries({ "lead.md": doc("lead", "agents:\n  - scout\n  - auditor\n"), "scout.md": doc("scout", "read_only: true\n"),
    "auditor.md": doc("auditor", "read_only: true\n"), "writer.md": doc("writer", "") })) writeFileSync(join(projectPersonasDir(cwd), file), text);
  const env = { ...gitTestEnv(), HC_TERMINAL_ID: lead.address, HC_TERMINAL_SOCKET: f.socketPath, CONDUCTOR_HC_BIN: fakeHcBin, FAKE_HC_STATE: f.statePath, FAKE_HC_MANIFESTS: manifests };
  await resolveHcContext(env, [process.execPath, child]);
  const registry = new RunRegistry(), queue = new SpawnQueue(registry, 4, 1);
  registry.delegation = new DelegationBroker({ registry, queue, env });
  t.after(async () => {
    for (const run of registry.list()) {
      run.herdrPipeline?.suspend(); clearTimeout(run.timeoutTimer);
      if (run.transport?.kind === "herdr") await run.transport.detach?.().catch(() => {});
    }
    for (const terminal of Object.values(f.terminals())) if (terminal.name !== "lead") try { process.kill(terminal.pid, "SIGKILL"); } catch { /* already gone */ }
  });
  const spawnParent = async (task: string) => spawnRun({ registry, persona: (await resolvePersonas({ cwd })).personas.get("lead")!, task, cwd, mode: "background", timeoutMs: 90000, runtimeEnv: env });
  const leaves = (parent: Run) => registry.list().filter(r => r.parentRunId === parent.id);
  const manifestOf = (run: Run) => join(manifests, `${run.herdr!.launchNonce}.json`);
  const response = (parent: Run, id: string) => JSON.parse(readFileSync(delegatePaths(dirname(parent.recordPath), id).response, "utf8"));
  return { ...f, lead: lead.address, manifests, registry, spawnParent, leaves, manifestOf, response };
}

test("N5 on hc: a proven parent's leaves share its herdr.tab and space and name the parent's terminal as their parent", { timeout: 120000 }, async t => {
  const h = await hcDelegation(t);
  const { run: parent, done } = await h.spawnParent("N5-PARENT fanout");
  await until(() => readdirSync(h.manifests).filter(f => f.startsWith("leaf-running-")).length === 2, "both leaves running", 90000);
  writeFileSync(join(h.manifests, "release-leaves"), "go");
  await done;
  assert.equal(parent.status, "completed", parent.errorMessage);
  assert.match(getFinalText(parent.messages), /d_scout: completed \S+ LEAF scout done depth=2 allow=none/);
  assert.match(getFinalText(parent.messages), /d_denied: ERROR persona writer is not in this run's delegation allowlist/);
  const pb = parent.herdr as HcBinding;
  assert.deepEqual([pb.host, pb.parentAddress, pb.space, pb.tab], ["hc", h.lead, "sp-lead", hcTab(parent.id)]);
  const leaves = h.leaves(parent);
  assert.equal(leaves.length, 2);
  for (const leaf of leaves) {
    assert.equal(leaf.status, "completed", leaf.errorMessage);
    const b = leaf.herdr as HcBinding;
    assert.deepEqual([b.host, b.parentAddress, b.tab, b.space, b.createdTab, b.placementWarning], ["hc", pb.address, pb.tab, "sp-lead", false, undefined]);
    const terminal = h.terminals()[b.address!];
    assert.equal(terminal.parent, pb.address, "the leaf terminal hangs under its delegator's terminal");
    assert.deepEqual([terminal.labels["herdr.tab"], terminal.labels["herdr.space"]], [pb.tab, "sp-lead"]);
    assert.doesNotMatch(h.response(parent, leaf.delegateToolCallId!).envelope, /reason="placement"/);
  }
});

test("N5 on hc: an unproven parent terminal gives the leaf its own tab under the lead, plus the placement warning in its envelope", { timeout: 120000 }, async t => {
  const h = await hcDelegation(t);
  const { run: parent, done } = await h.spawnParent("N5-PARENT gate1");
  await until(() => parent.transport?.kind === "herdr" && !!parent.transport.observable && existsSync(h.manifestOf(parent)), "parent ready", 90000);
  const pb = parent.herdr as HcBinding;
  const labels = h.terminals()[pb.address!].labels;
  h.patch({ report: { [pb.address!]: { labels: { ...labels, "conductor.nonce": "someone-else" } } } });
  writeFileSync(`${h.manifestOf(parent)}.go-0`, "go");
  await until(() => existsSync(delegatePaths(dirname(parent.recordPath), "d_g0").response), "leaf answered", 90000);
  h.patch({ report: {} });
  await done;
  assert.equal(parent.status, "completed", parent.errorMessage);
  const [leaf] = h.leaves(parent);
  const b = leaf!.herdr as HcBinding;
  assert.deepEqual([b.parentAddress, b.tab, b.space, b.createdTab], [h.lead, hcTab(leaf!.id), "sp-lead", true]);
  assert.match(b.placementWarning ?? "", /parent terminal unproven \(terminal labels mismatch\); leaf placed in its own tab/);
  assert.equal(h.terminals()[b.address!].parent, h.lead);
  assert.match(h.response(parent, "d_g0").envelope, /<warning reason="placement">parent terminal unproven \(terminal labels mismatch\)/);
});
