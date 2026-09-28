import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs, { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncBuiltinESMExports } from "node:module";
import { openEffort } from "../src/effort/open.ts";
import { effortDir, readEffort } from "../src/effort/store.ts";
import { RunRegistry, spawnRun } from "../src/runs.ts";
import { resolvePersonas } from "../src/personas.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
const project = fileURLToPath(new URL("..", import.meta.url));
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8", stdio: "pipe" }).trim();
function repo() {
  const cwd = tmpDir("effort-smoke-"); git(cwd, "init", "-b", "main");
  git(cwd, "config", "user.name", "T"); git(cwd, "config", "user.email", "t@t");
  mkdirSync(join(cwd, "pkg")); writeFileSync(join(cwd, "pkg", "file"), "base");
  writeFileSync(join(cwd, ".gitignore"), ".worktrees/\n");
  git(cwd, "add", "pkg", ".gitignore"); git(cwd, "commit", "-m", "base"); return cwd;
}
test("M1 two real concurrent claims produce one owner/ref; loser cannot roll back the winner", { timeout: 15000 }, async t => {
  const cwd = repo(); const before = git(cwd, "rev-parse", "HEAD");
  const index = readFileSync(join(cwd, ".git", "index"));
  const source = `import { openEffort } from ${JSON.stringify(new URL("../src/effort/open.ts", import.meta.url).href)};
    console.log("ready"); await new Promise(r => process.stdin.once("data", r)); process.stdin.pause();
    try { console.log(JSON.stringify({ ok: true, record: openEffort(${JSON.stringify(cwd)}, "race", "session-" + process.pid, { verify: "" }) })); }
    catch(e) { console.log(JSON.stringify({ ok: false, error: e.message })); }`;
  function claimant() {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: project, env: gitTestEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let exited = false; child.once("exit", () => { exited = true; });
    t.after(() => { if (!exited && child.signalCode === null) child.kill("SIGKILL"); });
    let ready!: () => void; const readiness = new Promise<void>(r => { ready = r; });
    let result: any; let stderr = "";
    child.stderr.on("data", b => { stderr += b; });
    createInterface({ input: child.stdout }).on("line", line => { if (line === "ready") ready(); else result = JSON.parse(line); });
    const done = new Promise<any>((resolve, reject) => { child.once("error", reject); child.once("close", code => { if (code === 0 && result) resolve(result); else reject(new Error(stderr || `claimant exit ${code}`)); }); });
    return { child, readiness, done };
  }
  const a = claimant(), b = claimant();
  await Promise.all([a.readiness, b.readiness]); a.child.stdin.end("go"); b.child.stdin.end("go");
  const results = await Promise.all([a.done, b.done]);
  assert.equal(results.filter(r => r.ok).length, 1);
  const winner = results.find(r => r.ok).record;
  assert.deepEqual(readEffort(cwd, "race"), winner);
  assert.equal(git(cwd, "rev-parse", "refs/heads/conductor-int/race"), before);
  assert.equal(git(cwd, "rev-parse", "HEAD"), before);
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
});

test("M1 persistence failure preserves an externally moved ref and its unresolved claim", { timeout: 10000 }, t => {
  const cwd = repo(); const base = git(cwd, "rev-parse", "HEAD");
  const branch = tmpDir("effort-foreign-"); git(cwd, "worktree", "add", "--detach", branch, base);
  writeFileSync(join(branch, "other"), "external"); git(branch, "add", "other"); git(branch, "commit", "-m", "external");
  const moved = git(branch, "rev-parse", "HEAD");
  t.mock.method(fs, "renameSync", () => {
    git(cwd, "update-ref", "refs/heads/conductor-int/failure", moved, base);
    throw new Error("injected persistence failure");
  }); syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => openEffort(cwd, "failure", "owner", { verify: "" }), /injected persistence failure/);
  assert.equal(git(cwd, "rev-parse", "refs/heads/conductor-int/failure"), moved, "failure rollback must never delete another actor's ref");
  assert.match(readFileSync(join(effortDir(cwd, "failure"), "effort.lock"), "utf8"), /owner/);
  assert.throws(() => openEffort(cwd, "failure", "other", { verify: "" }), /claim|owner/);
  assert.equal(git(cwd, "rev-parse", "HEAD"), base);
});

test("M1 real fake child and real hook share isolated subdir and private TMPDIR; completion stays unintegrated", { timeout: 15000 }, async () => {
  const cwd = repo(); const root = tmpDir("effort-real-child-"); const stub = join(root, "pi.mjs");
  const base = git(cwd, "rev-parse", "HEAD");
  writeFileSync(stub, `import { execFileSync } from "node:child_process";
    import { readFileSync, writeFileSync } from "node:fs";
    import { gitTestEnv } from ${JSON.stringify(new URL("./helpers/git-env.ts", import.meta.url).href)};
    const args = process.argv.slice(2); const session = args[args.indexOf("--session") + 1];
    const header = JSON.parse(readFileSync(session, "utf8").split("\\n")[0]);
    if (process.cwd() !== header.cwd) throw new Error("session/process cwd mismatch");
    writeFileSync("work", "valuable");
    execFileSync("git", ["add", "work"], { env: gitTestEnv() });
    execFileSync("git", ["commit", "-m", "work"], { env: gitTestEnv() });
    console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{type: "text", text: "Implemented and committed the requested change; the effort branch remains available for integration."}] } }));`);
  const saved = process.env.PI_BIN; process.env.PI_BIN = stub;
  try {
    openEffort(cwd, "real", "owner", { verify: "" });
    const persona = (await resolvePersonas({ cwd })).personas.get("builder")!;
    const { run, done } = spawnRun({ registry: new RunRegistry(), persona: { ...persona, worktree: false }, cwd: join(cwd, "pkg"), task: "write work", effort: "real", parentSessionId: "owner", mode: "background", timeoutMs: 10000,
      parentMessages: [{ role: "user", content: "context", timestamp: 0 }],
      onCompleteHook: 'pwd -P > "$CONDUCTOR_RUN_DIR/hook-cwd"; printf "%s" "$TMPDIR" > "$CONDUCTOR_RUN_DIR/hook-tmp"; test -f work' });
    await done;
    assert.equal(run.status, "completed", run.errorMessage ?? run.hookResult?.tailText);
    assert.equal(run.hookResult?.passed, true);
    assert.equal(readFileSync(join(dirname(run.recordPath), "hook-cwd"), "utf8").trim(), join(run.worktreePath!, "pkg"));
    assert.equal(readFileSync(join(dirname(run.recordPath), "hook-tmp"), "utf8"), join(dirname(run.recordPath), "tmp"));
    assert.equal(git(cwd, "show", `${run.worktreeBranch}:pkg/work`), "valuable");
    assert.equal(git(cwd, "rev-parse", "HEAD"), base); assert.equal(run.mergeResult, undefined);
    assert.match(run.worktreeKept!, /UNINTEGRATED/);
  } finally { if (saved === undefined) delete process.env.PI_BIN; else process.env.PI_BIN = saved; }
});
