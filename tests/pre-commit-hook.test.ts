/**
 * Tests for the pre-commit hook's build-and-stage behavior.
 *
 * The hook lives at `hooks/pre-commit`. Behavior under test:
 *   1. When staged files include any path under `src/`, the hook runs
 *      `npm run build` and stages `dist/index.js` + `dist/index.js.map`.
 *   2. When staged files do NOT include `src/`, the hook does NOT run
 *      `npm run build` (zero cost in the common case).
 *   3. The hook still runs `npm test` regardless.
 *   4. If `npm run build` fails, the hook aborts with non-zero exit
 *      before reaching the test step.
 *
 * Approach: spawn the real hook in a tmpdir-scoped fake repo. Stub `npm`
 * via PATH so the test is fast (~ms) and deterministic — no real build,
 * no real test run. Stub records every invocation; assertions check the
 * recorded log.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  existsSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK_PATH = fileURLToPath(new URL("../hooks/pre-commit", import.meta.url));

interface Fx {
  root: string;
  hook: string;
  npmLog: string;
  stubBin: string;
}

function setup(opts: { npmExitCode?: number; failOn?: string } = {}): Fx {
  const root = mkdtempSync(join(tmpdir(), "conductor-precommit-test-"));
  const hook = join(root, "pre-commit");
  copyFileSync(HOOK_PATH, hook);
  chmodSync(hook, 0o755);

  // Initialize a real git repo so `git diff --cached` and `git add` work.
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@test.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });

  // Minimum the hook expects: package.json + node_modules placeholder.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", version: "0.0.0" }));
  mkdirSync(join(root, "node_modules"));

  // Source layout the hook discriminates on.
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "dist"));
  mkdirSync(join(root, "docs"));
  // Pre-create dist outputs the real `npm run build` would emit, so the
  // hook's `git add dist/...` step has files to stage.
  writeFileSync(join(root, "dist", "index.js"), "// stub bundle\n");
  writeFileSync(join(root, "dist", "index.js.map"), "{}\n");

  // Initial commit so `git diff --cached` works against HEAD.
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root });

  // Stub `npm` on PATH. Records every invocation; can be told to fail on
  // a specific subcommand via NPM_FAIL_ON env.
  const stubBin = join(root, "stubbin");
  mkdirSync(stubBin);
  const npmLog = join(root, "npm.log");
  const failOn = opts.failOn ?? "";
  const exitCode = opts.npmExitCode ?? 0;
  const stub = `#!/usr/bin/env bash
set -u
echo "$@" >> "${npmLog}"
if [[ -n "${failOn}" ]] && [[ "$*" == *"${failOn}"* ]]; then
  exit ${exitCode || 1}
fi
exit 0
`;
  writeFileSync(join(stubBin, "npm"), stub);
  chmodSync(join(stubBin, "npm"), 0o755);

  return { root, hook, npmLog, stubBin };
}

function teardown(fx: Fx): void {
  try {
    rmSync(fx.root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function runHook(fx: Fx): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("bash", [fx.hook], {
    cwd: fx.root,
    env: {
      ...process.env,
      PATH: `${fx.stubBin}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf8",
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function npmCalls(fx: Fx): string[] {
  if (!existsSync(fx.npmLog)) return [];
  return readFileSync(fx.npmLog, "utf8").split("\n").filter((l) => l.length > 0);
}

function stagedFiles(fx: Fx): string[] {
  const out = execFileSync("git", ["diff", "--cached", "--name-only"], {
    cwd: fx.root,
    encoding: "utf8",
  });
  return out.split("\n").filter((l) => l.length > 0).sort();
}

test("pre-commit hook: src/ change triggers `npm run build` and stages dist/", () => {
  const fx = setup();
  try {
    writeFileSync(join(fx.root, "src", "foo.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "src/foo.ts"], { cwd: fx.root });

    const result = runHook(fx);
    assert.equal(result.status, 0, `hook should pass, got: ${result.stderr}`);

    const calls = npmCalls(fx);
    const buildCalls = calls.filter((c) => c.includes("run build"));
    assert.equal(buildCalls.length, 1, `expected exactly one 'npm run build' call, got: ${JSON.stringify(calls)}`);

    const staged = stagedFiles(fx);
    assert.ok(staged.includes("dist/index.js"), `dist/index.js should be staged; staged=${JSON.stringify(staged)}`);
    assert.ok(
      staged.includes("dist/index.js.map"),
      `dist/index.js.map should be staged; staged=${JSON.stringify(staged)}`,
    );
  } finally {
    teardown(fx);
  }
});

test("pre-commit hook: docs-only change does NOT trigger `npm run build`", () => {
  const fx = setup();
  try {
    writeFileSync(join(fx.root, "docs", "note.md"), "doc content\n");
    execFileSync("git", ["add", "docs/note.md"], { cwd: fx.root });

    const result = runHook(fx);
    assert.equal(result.status, 0, `hook should pass, got: ${result.stderr}`);

    const calls = npmCalls(fx);
    const buildCalls = calls.filter((c) => c.includes("run build"));
    assert.equal(
      buildCalls.length,
      0,
      `docs-only commit must not rebuild dist/, but got: ${JSON.stringify(calls)}`,
    );

    const staged = stagedFiles(fx);
    assert.deepEqual(
      staged,
      ["docs/note.md"],
      `only the doc should be staged; staged=${JSON.stringify(staged)}`,
    );
  } finally {
    teardown(fx);
  }
});

test("pre-commit hook: still runs `npm test` regardless of staged paths", () => {
  const fx = setup();
  try {
    writeFileSync(join(fx.root, "docs", "note.md"), "doc content\n");
    execFileSync("git", ["add", "docs/note.md"], { cwd: fx.root });

    const result = runHook(fx);
    assert.equal(result.status, 0, `hook should pass, got: ${result.stderr}`);

    const calls = npmCalls(fx);
    const testCalls = calls.filter((c) => c.includes("test"));
    assert.ok(testCalls.length >= 1, `expected at least one 'npm test' call, got: ${JSON.stringify(calls)}`);
  } finally {
    teardown(fx);
  }
});

test("pre-commit hook: build failure aborts before tests run", () => {
  const fx = setup({ failOn: "run build" });
  try {
    writeFileSync(join(fx.root, "src", "foo.ts"), "export const x = 1;\n");
    execFileSync("git", ["add", "src/foo.ts"], { cwd: fx.root });

    const result = runHook(fx);
    assert.notEqual(result.status, 0, "hook should reject when build fails");

    const calls = npmCalls(fx);
    const buildCalls = calls.filter((c) => c.includes("run build"));
    assert.equal(buildCalls.length, 1, `build should be attempted once; got: ${JSON.stringify(calls)}`);
    const testCalls = calls.filter((c) => c.includes("test"));
    assert.equal(testCalls.length, 0, `tests must not run after build failure; got: ${JSON.stringify(calls)}`);
  } finally {
    teardown(fx);
  }
});
