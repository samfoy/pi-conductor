/**
 * M6a: the native merger smokes fail closed on an inherited herdr scope before ANY repository
 * module evaluates. Each smoke file runs as a script in a child with injected HERDR flags that
 * point at a private refusing `herdr` shim and a private counting socket, never a live session.
 * An in-memory load hook marks every repository module that actually evaluates.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitTestEnv } from "./helpers/git-env.ts";
import { tmpDir } from "./helpers/tmp.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const guard = pathToFileURL(join(repo, "tests/helpers/no-live-scope.ts")).href;

function sandbox() {
  const dir = tmpDir("m6a-guard-");
  const calls = join(dir, "shim-calls.log"), shim = join(dir, "bin", "herdr");
  mkdirSync(join(dir, "bin")); mkdirSync(join(dir, "home")); writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  writeFileSync(shim, `#!/bin/sh\necho "$*" >> "${calls}"\nexit 97\n`, { mode: 0o755 });
  writeFileSync(join(dir, "counter.mjs"), `import { registerHooks } from "node:module";
import { writeFileSync } from "node:fs";
const evaluated = (globalThis.__m6aEvaluated = []);
process.on("exit", () => writeFileSync(${JSON.stringify(join(dir, "evaluated.json"))}, JSON.stringify(evaluated)));
registerHooks({ load(url, context, next) {
  const r = next(url, context);
  if (!url.startsWith(${JSON.stringify(pathToFileURL(repo).href)}) || r.source == null) return r;
  return { ...r, source: "globalThis.__m6aEvaluated.push(" + JSON.stringify(url) + ");\\n" + String(r.source) };
} });\n`);
  return { dir, calls, shim, evaluated: () => JSON.parse(readFileSync(join(dir, "evaluated.json"), "utf8")) as string[] };
}

for (const file of ["tests/effort-merger-smoke.test.ts", "tests/effort-merger-recovery-smoke.test.ts", "tests/helpers/merger-cleanup-fault.ts", "tests/native-startup-race.test.ts", "tests/delegation-native-smoke.test.ts",
  "tests/effort-reader-smoke.test.ts", "tests/effort-readers.test.ts"]) test(`M6a ${file} throws on an injected herdr scope before any repository module evaluates`, { timeout: 30000 }, async () => {
  const s = sandbox();
  const socketPath = join(s.dir, "fake-herdr.sock");
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  server.listen(socketPath); await once(server, "listening");
  try {
    const env = { ...gitTestEnv(), HOME: join(s.dir, "home"), TMPDIR: s.dir, PATH: `${join(s.dir, "bin")}:${process.env.PATH}`,
      HERDR_ENV: "1", HERDR_SOCKET_PATH: socketPath, HERDR_PANE_ID: "fake-pane", HERDR_TAB_ID: "fake-tab", HERDR_WORKSPACE_ID: "fake-workspace",
      HERDR_SESSION: "fake-session", HERDR_BIN_PATH: s.shim, CONDUCTOR_HERDR_BIN: s.shim };
    const child = spawn(process.execPath, ["--import", "tsx", "--import", join(s.dir, "counter.mjs"), join(repo, file)], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; child.stderr!.on("data", d => { stderr += d; });
    const [code] = await once(child, "exit");
    assert.notEqual(code, 0); assert.match(stderr, /live scope inherited \(HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID/);
    const evaluated = s.evaluated();
    assert.deepEqual(evaluated.filter(url => url.includes("/src/")), [], "0 src modules evaluated before the guard");
    assert.deepEqual(evaluated, [guard], "the guard was the first and only repository module to evaluate");
    assert.equal(existsSync(s.calls), false, "0 herdr CLI calls"); assert.equal(connections, 0, "0 socket connections");
  } finally { server.close(); }
});

test("M6a the guard routes a child's git to its cwd, never a hook's poisoned GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE", { timeout: 30000 }, () => {
  const s = sandbox();
  const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, env: gitTestEnv(), encoding: "utf8" });
  const dummy = join(s.dir, "dummy"), target = join(s.dir, "target");
  for (const r of [dummy, target]) { mkdirSync(r); git(r, "init", "-q", "-b", "main"); }
  writeFileSync(join(dummy, "f"), "x"); git(dummy, "add", "f");
  const index = () => createHash("sha256").update(readFileSync(join(dummy, ".git", "index"))).digest("hex");
  const before = index();
  writeFileSync(join(target, "x"), "x");
  writeFileSync(join(s.dir, "probe.ts"), `import ${JSON.stringify(guard)};\nimport { execFileSync } from "node:child_process";\nexecFileSync("git", ["add", "x"], { cwd: ${JSON.stringify(target)}, stdio: "ignore" });\n`);
  const poisoned = { ...gitTestEnv(), HOME: join(s.dir, "home"), GIT_DIR: join(dummy, ".git"), GIT_INDEX_FILE: join(dummy, ".git", "index"), GIT_WORK_TREE: dummy };
  const result = spawnSync(process.execPath, ["--import", "tsx", join(s.dir, "probe.ts")], { cwd: repo, env: poisoned, encoding: "utf8", timeout: 20000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(index(), before, "the poisoned dummy index is byte-unchanged");
  assert.equal(git(target, "ls-files").stdout.trim(), "x", "the child's git used its own cwd");
});
