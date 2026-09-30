/**
 * Pane env and Pi argv from one real `HerdrRuntime.launch`, against an
 * in-process fake CLI that records `tab create` and `agent start` and refuses
 * everything else, so no herdr server or child ever runs. The launch stops at
 * an unconfirmed start; nothing is published.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { HerdrCliError, type HerdrCli } from "../../src/herdr/cli.ts";
import type { PiCoreArgsOptions } from "../../src/runs.ts";
import type { RunSink } from "../../src/runtime.ts";
import type { Run } from "../../src/types.ts";

export async function herdrLaunchArgv(run: Run, core: PiCoreArgsOptions, env: NodeJS.ProcessEnv): Promise<{ paneEnv: Record<string, string>; argv: string[] }> {
  const { HerdrRuntime } = await import("../../src/herdr/runtime.ts");
  const pane = { pane_id: "pane-n1", terminal_id: "term-n1", workspace_id: "ws-n1", tab_id: "tab-n1", agent: null, agent_session: null };
  const calls: string[][] = [];
  const cli: HerdrCli = { socketPath: join(run.cwd, "fake.sock"), async text() { return ""; }, async json(args) {
    calls.push([...args]);
    if (args[0] === "tab") return { type: "tab_created", root_pane: { ...pane }, tab: { tab_id: pane.tab_id, workspace_id: pane.workspace_id, label: run.id, pane_count: 1 } };
    if (args[1] === "get") return { type: "pane_info", pane: { ...pane } };
    throw new HerdrCliError("remote", undefined, "n1_stop_before_start");
  } };
  const runtime = new HerdrRuntime({ cli, workspaceId: pane.workspace_id, env, trustArgs: () => [], piVersion: "0.87.1", platform: "linux",
    now: () => 0, sleep: async () => {}, probe: (pid) => ({ pid, state: "alive", startTime: 1 }), signal: () => {} });
  const sink: RunSink = { line() {}, close() {}, error() {}, initialDeliveryFailed() {} };
  const transport = runtime.launch(run, [], run.cwd, sink, "task", core);
  await assert.rejects((transport as { ready: Promise<unknown> }).ready, /agent start outcome unconfirmed/);
  const tab = calls.find((c) => c[0] === "tab");
  const start = calls.find((c) => c[1] === "start");
  assert.ok(tab && start, `launch reached tab create and agent start: ${JSON.stringify(calls)}`);
  return {
    paneEnv: Object.fromEntries(tab.flatMap((a, i) => tab[i - 1] === "--env" ? [a.split(/=(.*)/s).slice(0, 2)] : [])),
    argv: start.slice(start.indexOf("--") + 1),
  };
}
