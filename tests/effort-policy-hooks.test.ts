import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runHook } from "../src/hook-runner.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
test("effort runner bounds a single oversized unterminated output chunk", async () => {
  const dir = tmpDir("m2-output-");
  const proc = Object.assign(new EventEmitter(), { pid: 123, stdout: new PassThrough(), stderr: new PassThrough() });
  const result = await runHook({ resolved: { command: "probe", source: "project", timeoutSeconds: 1 }, runId: "probe", persona: "builder", runDir: dir, parentCwd: dir, finalPath: "unused", transcriptPath: "unused",
    deps: { maxLogBytes: 512, killGroup() {}, spawn: (() => { queueMicrotask(() => { proc.stdout.write("x".repeat(6000)); proc.emit("close", null, "SIGTERM"); }); return proc; }) as unknown as typeof cp.spawn } });
  assert.equal(result.failureKind, "runaway_output");
  assert.ok(readFileSync(result.logPath).length <= 512, "log cannot grow past the stream cap");
  assert.ok(result.tailBytes <= 4096, "single-line tail is bounded");
});

import { classifyStepOutcome } from "../src/autonomous.ts";
for (const status of ["integrating", "merge_conflict"] as const) test(`${status} never retries a builder even with user-retryable failure classes`, () => {
  assert.equal(classifyStepOutcome({ status, failureClass: "logic" }, "task", 0, { maxAttempts: 3, retryableClasses: ["logic"] }).kind, "escalate");
});

test("effort hook options delete inherited git/herdr variables and preserve persona log", async t => {
  const dir = tmpDir("m2-hook-");
  const previous = { ...process.env };
  process.env.GIT_INDEX_FILE = "/foreign/index";
  process.env.HERDR_SOCKET_PATH = "/foreign/socket";
  t.after(() => { process.env = previous; });
  let env: NodeJS.ProcessEnv | undefined;
  const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
  const result = await runHook({
    resolved: { command: "probe", timeoutSeconds: 1, source: "per-call" },
    runId: "builder-probe", persona: "builder", runDir: dir, parentCwd: dir,
    finalPath: join(dir, "final.md"), transcriptPath: join(dir, "transcript.jsonl"),
    logPath: join(dir, "verify.log"), extraEnv: { GIT_INDEX_FILE: undefined, HERDR_SOCKET_PATH: undefined, CONDUCTOR_EFFORT: "probe" },
    deps: { spawn: ((_cmd: string, opts: cp.SpawnOptions) => {
      env = opts.env;
      queueMicrotask(() => { proc.stdout.write("verified\n"); proc.emit("close", 0, null); });
      return proc;
    }) as unknown as typeof cp.spawn },
  } as Parameters<typeof runHook>[0]);
  assert.equal(env?.GIT_INDEX_FILE, undefined, "effort command must not inherit another checkout's index");
  assert.equal(env?.HERDR_SOCKET_PATH, undefined);
  assert.equal(env?.CONDUCTOR_EFFORT, "probe");
  assert.equal(result.logPath, join(dir, "verify.log"));
  assert.equal(existsSync(join(dir, "hook.log")), false);
  assert.equal(readFileSync(result.logPath, "utf8"), "verified\n");
});
