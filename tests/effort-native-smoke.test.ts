import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fixture, git, until } from "./helpers/effort-integration.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { RunRegistry, spawnRun, forceTerminate, availableActions } from "../src/runs.ts";
import { resolvePersonas } from "../src/personas.ts";
import { resultRef } from "../src/file-evidence.ts";
import { buildCompletionMessage } from "../src/notifications.ts";

sandboxPi();
for (const action of ["accept", "kill"] as const) test(`native writer ${action}: process exit and persona hook precede integration; settlement happens once`, { timeout: 20000 }, async t => {
  const f = fixture(t, 'if test -f native-change; then while test ! -f "$CONDUCTOR_RUN_DIR/release"; do sleep 0.02; done; fi; git rev-parse HEAD');
  const wrapper = join(tmpDir("m2-native-"), "pi.mjs");
  writeFileSync(wrapper, `import { register } from ${JSON.stringify(import.meta.resolve("tsx/esm/api"))}; register(); await import(${JSON.stringify(new URL("./helpers/native-owner-child.ts", import.meta.url).href)});`);
  const saved = process.env.PI_BIN; process.env.PI_BIN = wrapper;
  t.after(() => { if (saved === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = saved; });
  const registry = new RunRegistry(); const persona = (await resolvePersonas({ cwd: f.root })).personas.get("builder")!;
  const cards: ReturnType<typeof buildCompletionMessage>[] = []; let doneCount = 0, chainCount = 0, retryCount = 0, completedChanges = 0;
  registry.onChange(r => { if (r.status === "completed") completedChanges++; });
  const { run, done } = spawnRun({ registry, persona, task: "CONTROL complete the assignment", cwd: f.root, effort: "probe", parentSessionId: "owner", mode: "background", timeoutMs: 10000,
    onCompleteHook: 'if kill -0 "$(cat "$CONDUCTOR_RUN_DIR/child-pid")" 2>/dev/null; then echo child-still-alive >&2; exit 1; fi; echo work > native-change; git add native-change; git commit -m native-change',
    onComplete: r => { cards.push(buildCompletionMessage(r)); }, onChain: () => chainCount++, onRetry: () => retryCount++ });
  writeFileSync(join(dirname(run.recordPath), "child-pid"), String(run.pid));
  const child = run.proc!; let exited = false; child.once("exit", () => { exited = true; });
  t.after(async () => {
    run.integrationSuspended = true;
    await run.integrationControl?.suspend();
    if (!exited && child.signalCode === null) child.kill("SIGKILL");
  });
  void done.then(() => { doneCount++; });
  await until(registry, run, r => r.integration?.state === "verifying" && !!r.integration.logPath?.includes("verify-1.log"), 15000);
  assert.ok(exited || child.signalCode !== null, "child exit precedes candidate use");
  assert.equal(run.hookResult?.passed, true, run.hookResult?.tailText);
  assert.equal(run.status, "integrating"); assert.equal(registry.countActive(), 0);
  assert.equal(cards.length, 0); assert.equal(doneCount, 0); assert.equal(completedChanges, 0);
  assert.equal(existsSync(run.finalPath), false); assert.equal(resultRef(run), undefined);
  assert.equal(JSON.parse(readFileSync(run.recordPath, "utf8")).status, "integrating");
  assert.deepEqual(availableActions(run, true, "owner"), ["kill", "focus"]);
  if (action === "accept") writeFileSync(join(dirname(run.recordPath), "release"), "go");
  else { forceTerminate(run, "killed", registry); forceTerminate(run, "killed", registry); }
  await done;
  assert.equal(run.status, action === "accept" ? "completed" : "killed");
  assert.equal(cards.length, 1); assert.equal(doneCount, 1); assert.equal(chainCount, 0); assert.equal(retryCount, 0);
  if (action === "accept") {
    assert.equal(git(f.root, "rev-parse", f.record.intRef), run.landedCommit);
    assert.equal(git(f.root, "show", `${run.landedCommit}:native-change`), "work");
    assert.equal(readFileSync(run.integration!.verify!.logPath, "utf8").trim(), run.landedCommit);
    t.diagnostic(`T_verify=${run.integration!.verify!.durationMs}ms; exact post-hook OID=${run.landedCommit}`);
  } else f.unchanged();
});
