import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { RunRegistry, sendToRun, spawnRun } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import { registerTools } from "../src/tools.ts";
import { buildCompletionMessage } from "../src/notifications.ts";
import type { Persona } from "../src/types.ts";

import { execFileSync } from "node:child_process";
import { gitTestEnv } from "./helpers/git-env.ts";
import { forceTerminate } from "../src/runs.ts";
const { piBin } = sandboxPi();
writeFileSync(piBin, `import {writeFileSync, appendFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
const args=process.argv.slice(2), flag=n=>args[args.indexOf(n)+1];
const dir=args.includes('--session-dir')?flag('--session-dir'):dirname(flag('--session'));
const session=args.includes('--session')?flag('--session'):join(dir,'fake.jsonl');
const emit=e=>process.stdout.write(JSON.stringify(e)+'\\n');
const finish=prompt=>{
 writeFileSync(join(dir,'receipt.json'),JSON.stringify({prompt,args,cwd:process.cwd()}));
 if(!args.includes('--session')) writeFileSync(session,JSON.stringify({type:'session',id:'fake-child',cwd:process.cwd()})+'\\n');
 const asking=!prompt.includes('<owner-answer')&&!prompt.includes('CONTROL');
 const message={role:'assistant',stopReason:asking?'toolUse':'stop',content:asking?[{type:'toolCall',name:'ask_owner',id:'smoke-ask',arguments:{question:'Use A or B?'}}]:[{type:'text',text:'Verified the chosen option and completed the original assignment with checks.'}]};
 appendFileSync(session,JSON.stringify({type:'message',message})+'\\n');
 emit({type:'message_end',message});
 if(asking){emit({type:'tool_execution_start',toolName:'ask_owner',toolCallId:'smoke-ask',args:{question:'Use A or B?'}});emit({type:'tool_execution_end',toolName:'ask_owner',toolCallId:'smoke-ask',isError:false,result:{terminate:true,details:{askId:'smoke-ask',question:'Use A or B?',evidence:''}}});}
 emit({type:'agent_end'});
 setTimeout(()=>{emit({type:'agent_settled'});if(args[1]!=='rpc')process.exit(0);},20);
};
if(args[1]!=='rpc')finish(args.at(-1));else{let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>{b+=c;let i;while((i=b.indexOf('\\n'))>=0){const cmd=JSON.parse(b.slice(0,i));b=b.slice(i+1);emit({type:'response',id:cmd.id,command:cmd.type,success:true});finish(cmd.message);}});process.stdin.on('end',()=>process.exit(0));}
`);
const persona = { name: "inspector", defaultReads: [], systemPrompt: "Probe", inheritContext: "none", description: "probe", inheritSkills: false, worktree: false, timeoutMinutes: 1, readOnly: true, source: "builtin", sourcePath: "test" } satisfies Persona;
for (const transport of ["print", "rpc", "large"]) {
  test(`A6 real fake-child ${transport}: no live blocked process, queued work starts, correlated answer completes once`, { timeout: 8000 }, async () => {
    const cwd = tmpDir("a6-smoke-"); const registry = new RunRegistry(); const queue = new SpawnQueue(registry, 1);
    const notices: string[] = [];
    const first = queue.enqueueOrSpawn({ persona, task: transport === "large" ? "x".repeat(100000) : "Need decision", cwd, mode: "background", timeoutMs: 4000, steerable: transport === "rpc", onComplete: r => notices.push(buildCompletionMessage(r).content) });
    assert.equal(first.kind, "spawned"); if (first.kind !== "spawned") return;
    const child = first.run.proc!; let exited = false; child.once("exit", () => { exited = true; }); const closed = once(child, "close");
    const second = queue.enqueueOrSpawn({ persona, task: "CONTROL independent work", cwd, mode: "background", timeoutMs: 4000 });
    assert.equal(second.kind, "queued");
    const blocked = await first.done;
    assert.ok(exited || child.signalCode !== null, "blocked result must not precede process exit");
    await closed;
    assert.equal(blocked.status, "blocked"); assert.ok(exited || child.signalCode !== null);
    assert.equal(blocked.proc, undefined); assert.equal(blocked.rpcStdinQueue?.writable ?? false, false);
    assert.equal(queue.size(), 0); assert.equal(notices.length, 1); assert.match(notices[0], /sub-agent-asked/);
    assert.equal(existsSync(blocked.finalPath), false);
    const successor = registry.list().find(r => r.id !== blocked.id)!; if (successor.proc) await once(successor.proc, "close");
    assert.equal(successor.status, "completed");
    const originalTask = blocked.task;
    const reply = sendToRun(blocked, "Use B", { registry, timeoutMs: 4000, onComplete: r => notices.push(buildCompletionMessage(r).content) });
    assert.equal(reply.kind, "started"); if (reply.kind !== "started") return;
    const resumed = reply.run.proc!; const resumeClosed = once(resumed, "close");
    await reply.done; await resumeClosed;
    assert.equal(reply.run.status, "completed"); assert.equal(reply.run.task, originalTask);
    const receipt = JSON.parse(readFileSync(join(dirname(blocked.sessionPath!), "receipt.json"), "utf8"));
    assert.match(receipt.prompt, /owner-answer.*smoke-ask.*Use A or B\?.*Use B/s);
    assert.equal(receipt.cwd, cwd); assert.ok(receipt.args.includes(blocked.sessionPath));
    assert.equal(notices.length, 2); assert.match(notices[1], /sub-agent-completed/);
  });
}

test("A6 registered foreground spawn returns a question, and ensemble_auto halts rather than waiting or advancing", { timeout: 10000 }, async () => {
  const cwd = tmpDir("a6-foreground-"); const registry = new RunRegistry(); const queue = new SpawnQueue(registry, 2); const tools = new Map<string, any>();
  registerTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, { getCwd: () => cwd, getRegistry: () => registry, getQueue: () => queue, getModel: () => new FocusedStreamModel(registry), getParentMessages: () => [], openFocusedOverlay() {}, pushCompletionNotification() {}, registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister() {} }) });
  const result = await tools.get("ensemble_spawn").execute("fg", { persona: "inspector", task: "Need decision", foreground: true }, undefined, undefined, { mode: "json" });
  assert.equal(result.details.status, "blocked"); assert.equal(result.details.pending_ask.askId, "smoke-ask"); assert.match(result.content[0].text, /Use A or B\?/); assert.doesNotMatch(result.content[0].text, /result-ref/);
  const auto = await tools.get("ensemble_auto").execute("auto", { goal: "Decision", max_steps: 4, steps: [{ persona: "inspector", task: "Need decision" }, { persona: "inspector", task: "CONTROL must not advance" }] }, undefined, undefined, { mode: "json" });
  assert.match(JSON.stringify(auto), /halted/); assert.match(JSON.stringify(auto), /owner question/);
  assert.equal(registry.list().length, 2, "no retry or next-step spawn");
});

for (const action of ["reply", "kill"]) {
  test(`A6 worktree ${action}: blocked keeps commits; only answered completion merges and runs hook once`, { timeout: 10000 }, async () => {
    const cwd = tmpDir("a6-worktree-");
    const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, env: gitTestEnv(), timeout: 5000, stdio: "pipe" }).toString().trim();
    git(cwd, "init", "-b", "master"); git(cwd, "config", "user.email", "test@example.com"); git(cwd, "config", "user.name", "Test");
    writeFileSync(join(cwd, "base.txt"), "base"); git(cwd, "add", "base.txt"); git(cwd, "commit", "-m", "test: base");
    const registry = new RunRegistry();
    const hookLog = join(cwd, "hook-count");
    const onCompleteHook = `${process.execPath} -e 'require("node:fs").appendFileSync(${JSON.stringify(hookLog)},"hook\\n")'`;
    const result = spawnRun({ registry, persona: { ...persona, worktree: true, readOnly: false, onCompleteHook }, task: "Need decision", cwd, mode: "background", timeoutMs: 5000, worktree: true, mergeStrategy: "squash" });
    const run = result.run;
    assert.ok(run.worktreePath, "actual isolated worktree created");
    const worktree = run.worktreePath!; const branch = run.worktreeBranch!;
    writeFileSync(join(worktree, "change.txt"), "assignment work"); git(worktree, "add", "change.txt"); git(worktree, "commit", "-m", "feat: chosen work");
    await result.done;
    assert.equal(run.status, "blocked"); assert.equal(existsSync(join(worktree, "change.txt")), true);
    assert.equal(existsSync(join(cwd, "change.txt")), false, "no early merge"); assert.equal(existsSync(hookLog), false, "no early hook");
    if (action === "kill") {
      forceTerminate(run, "killed", registry);
      assert.equal(run.pendingAsk, undefined); assert.equal(existsSync(worktree), true);
      assert.equal(git(cwd, "rev-parse", "--verify", branch).length, 40); assert.equal(existsSync(hookLog), false);
    } else {
      const sent = sendToRun(run, "Use A", { registry, timeoutMs: 5000, persona: { ...persona, onCompleteHook } });
      assert.equal(sent.kind, "started"); if (sent.kind !== "started") return;
      const child = sent.run.proc!; const close = once(child, "close"); await sent.done; await close;
      assert.equal(run.status, "completed", run.errorMessage);
      assert.equal(readFileSync(join(cwd, "change.txt"), "utf8"), "assignment work");
      assert.equal(readFileSync(hookLog, "utf8"), "hook\n");
      assert.equal(git(cwd, "rev-list", "--count", "master"), "2", "exactly one merged commit");
    }
  });
}
