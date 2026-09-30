import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./tmp.ts";
import { HerdrRuntime } from "../../src/herdr/runtime.ts";
import { readInbox, writeInboxAck } from "../../src/herdr/inbox.ts";
import { emptyUsage, type Run } from "../../src/types.ts";
import { RunRegistry } from "../../src/runs.ts";
import type { HerdrCli } from "../../src/herdr/cli.ts";

export function herdrFixture(mode = "healthy") {
  const cwd = tmpDir("h7-pipeline-"), dir = join(cwd, "oracle-h7"); mkdirSync(dir);
  const run: Run = { id: "oracle-h7", runtime: "herdr", persona: "oracle", task: "probe", mode: "background", status: "running", startTime: Date.now(), lastEventAt: Date.now(), cwd,
    messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  const registry = new RunRegistry(); registry.register(run);
  const pane = { pane_id: "owned", terminal_id: "term", workspace_id: "workspace", tab_id: "tab", agent: null as string | null, agent_session: null as unknown };
  let time = 0, gone = false, unknown = false;
  const calls: string[] = [], signals: string[] = [];
  let onSleep = () => {};
  const emit = (event: object, nonce = run.herdr!.launchNonce) => appendFileSync(run.transcriptPath, JSON.stringify({ ...event, _c: { n: nonce } }) + "\n");
  const exit = () => { gone = true; pane.agent = null; pane.agent_session = null; };
  const cli: HerdrCli = { socketPath: join(cwd, "fake.socket"), async text() { return "fake"; }, async json(args) {
    calls.push(args.slice(0, 2).join(" "));
    if (args[0] === "tab") return { type: "tab_created", root_pane: { ...pane }, tab: { tab_id: "tab", workspace_id: "workspace", label: run.id, pane_count: 1 } };
    if (args[1] === "get") return { type: "pane_info", pane: { ...pane } };
    if (args[1] === "close") { assert.ok(gone, "pane never closes before child exit"); assert.equal(pane.agent, null); return { type: "ok" }; }
    assert.equal(args[1], "start");
    const binding = JSON.parse(readFileSync(run.recordPath, "utf8")).herdr;
    const request = readInbox(dir, binding.launchNonce)[0].request;
    pane.agent = "pi"; pane.agent_session = { kind: "path", value: binding.sessionFile, agent: "pi", source: "integration" };
    const hello = { ...binding, v: 1, bridgeProtocol: 1, pid: 12345, pidStartTime: 77, at: 0, piVersion: "0.87.1", conductorVersion: "test" };
    mkdirSync(join(dir, "launch")); writeFileSync(join(dir, "launch", `${binding.launchNonce}.json`), JSON.stringify(hello));
    emit({ type: "conductor_child", event: "launch", ...hello });
    emit({ type: "agent_settled" }); // unaccepted human turn cannot complete the assignment
    if (mode !== "preaccept-death") {
      emit({ type: "agent_start", initialRequestId: request.requestId });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Final verified evidence 漢🙂 with sufficient substance." }], stopReason: "stop", usage: { input: 12, output: 7, cost: { total: 0.01 } } } });
      emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FOREIGN" }] } }, "foreign");
      if (mode === "ask") {
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "question", name: "ask_owner", arguments: { question: "Choose?" } }], stopReason: "toolUse" } });
        emit({ type: "tool_execution_start", toolName: "ask_owner", toolCallId: "question", args: { question: "Choose?" } });
        emit({ type: "tool_execution_end", toolName: "ask_owner", toolCallId: "question", isError: false, result: { details: { askId: "question", question: "Choose?", evidence: "original evidence" } } });
      }
      if (!["crash", "partial", "running"].includes(mode)) emit({ type: "agent_settled" });
      if (mode === "partial") appendFileSync(run.transcriptPath, JSON.stringify({ type: "agent_settled", _c: { n: binding.launchNonce } }));
      writeInboxAck(dir, request); // deliberately after fast settled/start
    }
    const agent = { ...pane };
    if (["healthy", "crash", "partial", "preaccept-death"].includes(mode)) exit();
    return { type: "agent_started", agent };
  } };
  const runtime = new HerdrRuntime({ cli, workspaceId: "workspace", env: {}, trustArgs: () => [], piVersion: "0.87.1", platform: "linux", now: () => time,
    sleep: async ms => { time += ms; onSleep(); }, probe: pid => ({ pid, state: unknown ? "unknown" : gone ? "gone" : "alive", startTime: 77 }),
    signal: (_pid, signal) => { signals.push(signal); if (mode !== "stubborn") exit(); } });
  return { run, registry, runtime, pane, calls, signals, emit, exit, advance: (ms: number) => { time += ms; }, gone: () => gone, unknown: () => { unknown = true; }, onSleep: (fn: () => void) => { onSleep = fn; },
    opts: { registry, runtime, cwd, steerable: false, timeoutMs: 4000, initialPrompt: "probe", core: { kind: "fresh" as const, sessionDir: join(dir, "session"), systemPrompt: "probe" } } };
}
