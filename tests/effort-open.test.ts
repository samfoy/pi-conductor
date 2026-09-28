import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openEffort, effortOwner } from "../src/effort/open.ts";
import { resolveEffortPolicy } from "../src/effort/policy.ts";
import { effortDir, readEffort } from "../src/effort/store.ts";
import { loadConfig, userConfigPath } from "../src/config.ts";
import { dirname } from "node:path";
import { registerTools } from "../src/tools.ts";
import { RunRegistry } from "../src/runs.ts";
import { gitTestEnv } from "./helpers/git-env.ts";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8" }).trim();
function repo() {
  const cwd = tmpDir("effort-open-");
  git(cwd, "init", "-b", "main");
  writeFileSync(join(cwd, "file"), "base\n");
  git(cwd, "add", "file");
  git(cwd, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-m", "base");
  return cwd;
}
function harness(cwd: string, session = "owner") {
  const tools = new Map<string, any>(); // Pi registration boundary
  registerTools({ registerTool: (t: any) => tools.set(t.name, t) } as any, {
    getCwd: () => cwd, getSessionId: () => session, getRegistry: () => new RunRegistry(),
  } as any, {});
  const tool = tools.get("ensemble_effort");
  assert.ok(tool, "ensemble_effort must be registered for the lead");
  return (params: unknown) => tool.execute("open", params);
}

test("M1 open captures an unchecked-out ref, frozen policy and owner without changing checkout", { timeout: 10000 }, async () => {
  const cwd = repo();
  const call = harness(cwd);
  const base = git(cwd, "rev-parse", "HEAD");
  const index = readFileSync(join(cwd, ".git", "index"));
  const opened = await call({ action: "open", effort: "feature", verify: "", land: "base" });
  assert.equal(opened.details.effort.baseOid, base, opened.content[0].text);
  assert.equal(opened.details.effort.baseBranch, "main");
  assert.equal(opened.details.effort.gitRoot, cwd);
  assert.equal(opened.details.effort.owner.sessionId, "owner");
  assert.equal(opened.details.effort.owner.pid, process.pid);
  assert.equal(typeof opened.details.effort.owner.startTime, "number");
  assert.equal(opened.details.effort.policy.verify, "");
  assert.equal(opened.details.effort.policy.land, "base");
  assert.deepEqual(opened.details.effort.members, []);
  assert.equal(git(cwd, "rev-parse", "refs/heads/conductor-int/feature"), base);
  assert.doesNotMatch(git(cwd, "worktree", "list", "--porcelain"), /branch refs\/heads\/conductor-int/);
  assert.equal(git(cwd, "rev-parse", "HEAD"), base);
  assert.equal(git(cwd, "symbolic-ref", "--short", "HEAD"), "main");
  assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
  assert.equal(readFileSync(join(cwd, "file"), "utf8"), "base\n");
  assert.match(opened.content[0].text, /UNINTEGRATED/);
  assert.match(opened.content[0].text, /baseline.*not.*verif/i);
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "conductor.json"), JSON.stringify({ efforts: { verify: "changed" } }));
  assert.equal((await call({ action: "status", effort: "feature" })).details.effort.policy.verify, "");
});

test("M1 competing opens have one winner and never replace the winning ref/record", { timeout: 10000 }, async () => {
  const cwd = repo();
  const a = harness(cwd, "a"), b = harness(cwd, "b");
  const results = await Promise.all([a({ action: "open", effort: "race", verify: "" }), b({ action: "open", effort: "race", verify: "" })]);
  assert.equal(results.filter(r => !r.details.error).length, 1);
  assert.match(results.find(r => r.details.error).content[0].text, /owned|exist|claim/i);
  const status = await a({ action: "status", effort: "race" });
  assert.equal(status.details.effort.owner.sessionId, "a");
});

for (const params of [{ effort: "../escape", verify: "" }, { effort: "Upper", verify: "" }, { effort: "missing" }]) {
  test(`M1 invalid open ${params.effort} has no ref effects`, { timeout: 10000 }, async () => {
    const cwd = repo();
    const result = await harness(cwd)({ action: "open", ...params });
    assert.ok(result.details.error, result.content[0].text);
    assert.equal(git(cwd, "for-each-ref", "--format=%(refname)", "refs/heads/conductor-int"), "");
  });
}

for (const scenario of ["non-git", "Brazil", "external", "detached"] as const) {
  test(`M1 ${scenario} open refused before creating a record`, { timeout: 10000 }, async () => {
    const cwd = scenario === "non-git" ? tmpDir("not-git-") : repo();
    if (scenario === "Brazil") mkdirSync(join(cwd, ".brazil"));
    if (scenario === "external") { mkdirSync(join(cwd, ".pi")); writeFileSync(join(cwd, ".pi", "conductor.json"), '{"worktreeMode":"external"}'); }
    if (scenario === "detached") git(cwd, "checkout", "--detach");
    const result = await harness(cwd)({ action: "open", effort: "invalid", verify: "" });
    assert.ok(result.details.error, result.content[0].text);
    assert.equal(readEffort(cwd, "invalid"), undefined);
  });
}
test("M1 config precedence and explicit override freeze only validated policy", { timeout: 10000 }, () => {
  const cwd = repo();
  mkdirSync(dirname(userConfigPath()), { recursive: true });
  writeFileSync(userConfigPath(), JSON.stringify({ efforts: { verify: "user", maxParallel: 3, merger: "ask", generated: { paths: ["dist/**"], command: "build" } } }));
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "conductor.json"), JSON.stringify({ efforts: { verify: "project", land: "base" } }));
  const cfg = loadConfig(cwd);
  const policy = resolveEffortPolicy(cfg.efforts, { verify: "explicit" });
  assert.equal(policy.verify, "explicit"); assert.equal(policy.maxParallel, 3); assert.equal(policy.merger, "ask"); assert.equal(policy.land, "base"); assert.equal(policy.history, "squash");
  assert.equal(resolveEffortPolicy(cfg.efforts).verify, "project");
  cfg.efforts!.generated!.paths.push("src/**");
  assert.deepEqual(policy.generated!.paths, ["dist/**"], "capture does not retain mutable config arrays");
  writeFileSync(userConfigPath(), "{}");
  for (const invalid of [{ verify: 4 }, { verify: "", maxParallel: 0 }, { verify: "", merger: "bad" }, { verify: "", land: "bad" }, { verify: "", history: "merge" }, { verify: "", generated: { paths: ["../src/**"], command: "build" } }]) assert.throws(() => resolveEffortPolicy(invalid as any));
});
test("M1 stale/ambiguous owner and conflicting record/ref fail closed", { timeout: 10000 }, () => {
  const cwd = repo(); const r = openEffort(cwd, "stale", "owner", { verify: "" });
  const recordPath = join(effortDir(cwd, "stale"), "effort.json");
  const stale = { ...r, owner: { ...r.owner, pid: 99999999, startTime: 1 } };
  writeFileSync(recordPath, JSON.stringify(stale));
  assert.throws(() => openEffort(cwd, "stale", "new-owner", { verify: "" }), /exists/);
  assert.deepEqual(JSON.parse(readFileSync(recordPath, "utf8")), stale);
  git(cwd, "update-ref", "refs/heads/conductor-int/foreign", r.baseOid, "");
  assert.throws(() => openEffort(cwd, "foreign", "owner", { verify: "" }), /exist|lock ref/);
  assert.equal(git(cwd, "rev-parse", "refs/heads/conductor-int/foreign"), r.baseOid);
  writeFileSync(recordPath, JSON.stringify({ ...r, gitRoot: "/another" }));
  assert.throws(() => readEffort(cwd, "stale"), /identity/);
});

test("M1 owner identity is stable without a Linux OS fingerprint", t => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: "darwin" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  const owner = effortOwner("portable");
  assert.equal(owner.startTime, performance.timeOrigin);
  assert.deepEqual(effortOwner("portable"), owner);
});
