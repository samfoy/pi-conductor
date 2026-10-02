/**
 * N5: delegation on herdr through the executable multi-pane fake herdr. A herdr
 * parent's nonce-stamped tee feeds the same broker; leaves resolve their runtime
 * through the normal cascade and, on herdr, split the parent's proven pane (first
 * right, later down from the previous proven leaf). An unproven or subprocess parent
 * gets an own-tab leaf with a diagnostic and zero splits. Release closes own panes only.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi } from "./helpers/tmp.ts";
import { delegationHarness, until } from "./helpers/herdr-delegation.ts";
import { forceTerminate, getFinalText, releaseRunPane, runsRoot, spawnRun } from "../src/runs.ts";
import { handleSessionShutdown } from "../src/shutdown.ts";
import { delegatePaths, subtreeCost } from "../src/delegation.ts";
import { isTerminal, type Run } from "../src/types.ts";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { emptyUsage } from "../src/types.ts";
import { createSplitPane } from "../src/herdr/placement.ts";
import type { HerdrCli } from "../src/herdr/cli.ts";
import type { HerdrBinding } from "../src/herdr/identity.ts";

sandboxPi();
const response = (run: Run, id: string) => JSON.parse(readFileSync(delegatePaths(dirname(run.recordPath), id).response, "utf8"));
const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];
const envFlags = (args: string[]) => Object.fromEntries(args.flatMap((a, i) => a === "--env" ? [args[i + 1]!.split(/=(.*)/s).slice(0, 2)] : []));

test("N5 herdr parent fan-out: tee -> broker -> split leaves right then down; foreign, start-only and repeat updates never spawn", { timeout: 90000 }, async t => {
  const h = await delegationHarness(t);
  const { run: parent, done } = await h.spawnParent("N5-PARENT fanout");
  assert.equal(parent.runtime, "herdr");
  await until(() => h.running() === 2, "both leaves running at once (fan-out)");
  h.release("release-leaves");
  await done;
  assert.equal(parent.status, "completed", parent.errorMessage);
  const final = getFinalText(parent.messages);
  assert.match(final, /d_scout: completed \S+ LEAF scout done depth=2 allow=none/);
  assert.match(final, /d_auditor: completed \S+ LEAF auditor done depth=2 allow=none/);
  assert.match(final, /d_denied: ERROR persona writer is not in this run's delegation allowlist/);
  assert.deepEqual(readdirSync(join(dirname(parent.recordPath), "delegate")).sort(),
    ["d_auditor.claim.json", "d_auditor.json", "d_denied.claim.json", "d_denied.json", "d_scout.claim.json", "d_scout.json"], "no claim for start-only or foreign calls");

  const leaves = h.leaves(parent);
  assert.deepEqual(leaves.map(l => l.delegateToolCallId).sort(), ["d_auditor", "d_scout"], "the repeat update spawned nothing");
  const [first, second] = leaves;
  const pb = parent.herdr!;
  const splits = h.splits();
  assert.equal(splits.length, 2);
  assert.deepEqual([flag(splits[0]!, "--pane"), flag(splits[0]!, "--direction")], [pb.paneId, "right"], "first leaf splits right from the parent");
  assert.deepEqual([flag(splits[1]!, "--pane"), flag(splits[1]!, "--direction")], [first!.herdr!.paneId, "down"], "later leaf splits down from the previous leaf");
  for (const [i, leaf] of [first!, second!].entries()) {
    assert.equal(leaf.runtime, "herdr"); assert.equal(leaf.status, "completed", leaf.errorMessage);
    const b = leaf.herdr!;
    assert.deepEqual([b.createdTab, b.tabId, b.workspaceId, b.placementWarning], [false, pb.tabId, pb.workspaceId, undefined]);
    assert.notEqual(b.terminalId, pb.terminalId); assert.notEqual(b.paneId, pb.paneId);
    const env = envFlags(splits[i]!);
    assert.equal(env.CONDUCTOR_DEPTH, "2"); assert.equal(env.CONDUCTOR_DELEGATE_ALLOW, undefined, "a leaf pane never gets an allowlist");
    assert.equal(env.CONDUCTOR_RUN_DIR, dirname(leaf.recordPath));
    assert.equal(flag(splits[i]!, "--cwd"), h.cwd, "the parent's effective cwd");
    assert.equal(leaf.worktreePath, undefined);
    const record = JSON.parse(readFileSync(leaf.recordPath, "utf8"));
    assert.deepEqual([record.depth, record.parentRunId, record.runtime], [2, parent.id, "herdr"]);
    for (const name of ["delegate", "ask_owner", "edit", "write"]) assert.ok(record.excludeTools.includes(name), name);
    assert.equal(response(parent, leaf.delegateToolCallId!).agentId, leaf.id);
  }
  assert.equal(h.state().tabs[pb.tabId]!.pane_count, 3, "parent plus two leaves in one tab");
  assert.equal(h.cards(), 1, "the lead gets the parent's card only");
  assert.equal(parent.pendingDelegations, 0);
  assert.equal(h.launched().length, h.state().calls.filter(c => c.args[0] === "agent" && c.args[1] === "start").length, "one pane child per agent start, nothing else");
  assert.ok(Math.abs(subtreeCost(parent, h.registry.list()) - (parent.usage.cost + 0.04)) < 1e-9, "each leaf's cost counted once");

  // A leaf's release closes its own pane, never the parent's, a sibling's or the tab.
  assert.equal(await releaseRunPane(first!), true);
  assert.deepEqual(h.state().closed, [first!.herdr!.paneId]);
  assert.ok(h.state().panes[pb.paneId] && h.state().panes[second!.herdr!.paneId]);
  assert.equal(h.state().tabs[pb.tabId]!.pane_count, 2);

  // Quit closes each remaining own pane once; herdr drops the emptied tab itself; the lead's pane stays.
  await handleSessionShutdown({ reason: "quit" }, { runs: h.registry.list(), resetSanitizer() {}, terminateHerdr: r => forceTerminate(r, "killed", h.registry) });
  const s = h.state();
  assert.deepEqual([...s.closed!].sort(), [first!.herdr!.paneId, second!.herdr!.paneId, pb.paneId].sort());
  assert.deepEqual(s.removedTabs, [pb.tabId]);
  assert.ok(s.panes["w1:p1"], "the lead's own pane is never closed");
  assert.ok(!s.calls.some(c => c.args[0] === "tab" && c.args[1] !== "create"), "no tab close; nothing but own panes");
  assert.ok(!s.calls.some(c => ["split", "close"].includes(c.args[1]!) && c.args.includes("w1:p1")));
});

test("N5 placement: a previous leaf splits down only while proven; any single parent identity mismatch means zero splits and an own tab with a diagnostic", { timeout: 120000 }, async t => {
  const h = await delegationHarness(t);
  const steps = 7;
  const { run: parent, done } = await h.spawnParent(`N5-PARENT gate${steps}`);
  assert.ok(parent.transport?.kind === "herdr"); await parent.transport.ready;
  const manifest = h.manifestOf(parent)!;
  const pb = parent.herdr!;
  const go = async (i: number) => {
    const before = h.state().calls.length;
    h.release(`${manifest.split("/").pop()}.go-${i}`);
    await until(() => existsSync(delegatePaths(dirname(parent.recordPath), `d_g${i}`).response), `step ${i} answered`);
    const leaf = h.leaves(parent).find(l => l.delegateToolCallId === `d_g${i}`)!;
    assert.equal(response(parent, `d_g${i}`).ok, true, JSON.stringify(response(parent, `d_g${i}`)));
    return { leaf, calls: h.state().calls.slice(before).map(c => c.args) };
  };
  const placed = (calls: string[][]) => calls.filter(a => a[0] === "pane" && a[1] === "split" || a[0] === "tab").map(a => a[0] === "tab" ? "tab" : `${flag(a, "--pane")} ${flag(a, "--direction")}`);
  const s0 = await go(0);
  assert.deepEqual(placed(s0.calls), [`${pb.paneId} right`]);
  const s1 = await go(1);
  assert.deepEqual(placed(s1.calls), [`${s0.leaf.herdr!.paneId} down`]);
  // The previous leaf's pane no longer proves its identity: start a fresh column from the parent.
  h.edit(s => { s.report = { [s1.leaf.herdr!.paneId]: { terminal_id: "replaced" } }; });
  const s2 = await go(2);
  assert.deepEqual(placed(s2.calls), [`${pb.paneId} right`]);
  h.edit(s => { s.report = {}; });
  for (const [i, field] of (["pane_id", "terminal_id", "workspace_id", "tab_id"] as const).entries()) {
    h.edit(s => { s.report = { [pb.paneId]: { [field]: `other-${field}` } }; });
    const step = await go(3 + i);
    h.edit(s => { s.report = {}; });
    assert.deepEqual(placed(step.calls), ["tab"], `${field} mismatch: zero splits`);
    const b = step.leaf.herdr!;
    assert.equal(b.createdTab, true);
    assert.match(b.placementWarning ?? "", /parent pane unproven \(pane identity mismatch\); leaf placed in its own tab/);
    assert.equal(envFlags(step.calls.find(a => a[0] === "tab")!).CONDUCTOR_DEPTH, "2");
    assert.equal(envFlags(step.calls.find(a => a[0] === "tab")!).CONDUCTOR_DELEGATE_ALLOW, undefined);
    assert.match(response(parent, `d_g${3 + i}`).envelope, /<warning reason="placement">parent pane unproven/);
  }
  await done;
  assert.equal(parent.status, "completed", parent.errorMessage);
  assert.equal(h.splits().length, 3, "exactly the three proven splits");
});

test("N5 a subprocess parent's herdr leaf gets its own tab plus a diagnostic; its release lets herdr drop the tab", { timeout: 60000 }, async t => {
  const h = await delegationHarness(t);
  const id = "lead-subprocess", dir = join(runsRoot(), id); mkdirSync(dir, { recursive: true });
  const parent: Run = { id, runtime: "subprocess", persona: "lead", task: "t", cwd: h.cwd, mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(),
    messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"), depth: 1, delegateAllow: ["scout"] };
  h.registry.register(parent);
  const scout = (await h.roster()).get("scout")!;
  const { run: leaf, done } = spawnRun({ registry: h.registry, persona: scout, task: "N5-LEAF scout once", cwd: h.cwd, mode: "background", timeoutMs: 30000, runtimeEnv: h.env,
    delegation: { parentRunId: id, delegateToolCallId: "d_sub" } });
  await done;
  assert.equal(leaf.status, "completed", leaf.errorMessage);
  assert.equal(h.splits().length, 0);
  const b = leaf.herdr!;
  assert.equal(b.createdTab, true);
  assert.match(b.placementWarning ?? "", /parent lead-subprocess has no herdr pane \(subprocess runtime\); leaf placed in its own tab/);
  const created = h.tabCreates()[0]!;
  assert.equal(envFlags(created).CONDUCTOR_DEPTH, "2"); assert.equal(envFlags(created).CONDUCTOR_DELEGATE_ALLOW, undefined);
  assert.equal(await releaseRunPane(leaf), true);
  assert.deepEqual(h.state().closed, [b.paneId]);
  assert.deepEqual(h.state().removedTabs, [b.tabId], "herdr removed the emptied tab; the conductor closed no tab");
  assert.ok(!h.state().calls.some(c => c.args[0] === "tab" && c.args[1] !== "create"));
  assert.ok(isTerminal(leaf.status));
});

test("N5 createSplitPane accepts a new pane only in the anchor's own workspace and tab, even when herdr's answer is otherwise well formed", async () => {
  const anchor: HerdrBinding = { runId: "lead-a", launchNonce: "n0", sessionId: "s0", sessionFile: "/runs/lead-a/session/n0.jsonl", socketPath: "/fake/herdr.sock",
    workspaceId: "w1", tabId: "w1:t1", paneId: "w1:p1", terminalId: "term_1", createdTab: true };
  const invocation = { runId: "scout-a", launchNonce: "n1", sessionId: "s1", sessionFile: "/runs/scout-a/session/n1.jsonl" };
  const split = async (over: Record<string, string>) => {
    const pane = { pane_id: "w1:p2", terminal_id: "term_2", workspace_id: "w1", tab_id: "w1:t1", agent: null, ...over };
    const calls: string[] = [];
    // A schema-valid herdr: the split answers pane_info and pane get reports that same pane, empty.
    const cli = { socketPath: anchor.socketPath, async text() { return ""; },
      async json(args: readonly string[]) { calls.push(args.slice(0, 2).join(" ")); return { type: "pane_info", pane: { ...pane } }; } } as unknown as HerdrCli;
    const outcome = await createSplitPane(cli, { anchor, direction: "right", cwd: "/work", invocation, env: { CONDUCTOR_DEPTH: "2" }, known: [] }).then(b => b, (e: Error) => e);
    return { outcome, calls };
  };
  const ok = await split({});
  assert.ok(!(ok.outcome instanceof Error), `positive control: the well-formed same-tab pane is accepted (${String(ok.outcome)})`);
  assert.deepEqual([ok.outcome.tabId, ok.outcome.workspaceId, ok.outcome.paneId, ok.outcome.createdTab], ["w1:t1", "w1", "w1:p2", false]);
  assert.deepEqual(ok.calls, ["pane split", "pane get"]);
  for (const [why, over] of [["another tab", { tab_id: "w1:t9" }], ["another workspace", { workspace_id: "w9" }]] as const) {
    const { outcome, calls } = await split(over);
    assert.ok(outcome instanceof Error && /herdr: protocol/.test(outcome.message), `${why}: refused, got ${String(outcome)}`);
    assert.deepEqual(calls, ["pane split"], `${why}: refused before the pane is ever used`);
  }
});

test("N5 fixture: the harness launches a pane child only for a well-formed agent-start request, never a sidecar or a malformed file", { timeout: 15000 }, async t => {
  const h = await delegationHarness(t);
  const { paneRequest } = await import("./helpers/herdr-delegation.ts");
  const valid = { runDir: "/runs/x", nonce: "n", paneId: "w1:p9", socketPath: "/s", cwd: "/w", argv: ["--session", "/runs/x/session/n.jsonl"], paneEnv: {} };
  writeFileSync(join(h.manifests, "0007-w1_p9.json.tools.json"), JSON.stringify(valid)); // a native child's tool-surface sidecar
  writeFileSync(join(h.manifests, "0008-w1_p9.json"), JSON.stringify({ paneId: "w1:p9" })); // request-named but not a request
  writeFileSync(join(h.manifests, "0009-w1_p9.json.ready"), "123");
  await new Promise(r => setTimeout(r, 200)); // twenty watcher passes
  assert.deepEqual(h.launched(), [], "nothing launched");
  // Positive control, outside the watched directory: the same bytes under a request name are a request.
  const probeDir = mkdtempSync(join(h.root, "probe-"));
  writeFileSync(join(probeDir, "0001-w1_p9.json"), JSON.stringify(valid));
  assert.equal(paneRequest(probeDir, "0001-w1_p9.json")?.paneId, "w1:p9");
});
