/**
 * Tests for `scripts/check-no-mutation-markers.sh`.
 *
 * The script greps STAGED TypeScript files under `src/` for residual WDD
 * mutation markers (`// MUTATION:` / `// MUTATE:`) and rejects the commit
 * via exit 1 if any are present.
 *
 * Three cases pinned:
 *   1. Clean staged tree → exit 0.
 *   2. Marker present in staged src/ file → exit 1, file path on stderr.
 *   3. Marker present but file unstaged (working tree only) → exit 0.
 *
 * Each test sets up an ephemeral git repo in a tmp dir and runs the
 * actual shell script via spawnSync. Cleans up in finally.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const SCRIPT = resolve(
  new URL(".", import.meta.url).pathname,
  "..",
  "scripts",
  "check-no-mutation-markers.sh",
);

interface Fx {
  repo: string;
}

function setup(): Fx {
  const repo = mkdtempSync(join(tmpdir(), "conductor-mutmark-"));
  // Init a clean git repo with a deterministic identity.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" };
  spawnSync("git", ["init", "-q"], { cwd: repo, env });
  spawnSync("git", ["config", "user.email", "t@t"], { cwd: repo, env });
  spawnSync("git", ["config", "user.name", "t"], { cwd: repo, env });
  spawnSync("git", ["config", "commit.gpgsign", "false"], { cwd: repo, env });
  mkdirSync(join(repo, "src"), { recursive: true });
  return { repo };
}

function teardown(fx: Fx): void {
  rmSync(fx.repo, { recursive: true, force: true });
}

function run(fx: Fx): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("bash", [SCRIPT], {
    cwd: fx.repo,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
  return {
    code: r.status ?? -1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function gitAdd(fx: Fx, path: string): void {
  spawnSync("git", ["add", path], {
    cwd: fx.repo,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" },
  });
}

test("check-no-mutation-markers: clean staged tree exits 0", () => {
  const fx = setup();
  try {
    writeFileSync(
      join(fx.repo, "src", "clean.ts"),
      "export const x = 1;\n// regular comment, nothing to see\n",
    );
    gitAdd(fx, "src/clean.ts");
    const r = run(fx);
    assert.equal(r.code, 0, `expected exit 0, got ${r.code} (stderr: ${r.stderr})`);
  } finally {
    teardown(fx);
  }
});

test("check-no-mutation-markers: marker in staged src/ file exits 1 and prints path", () => {
  const fx = setup();
  try {
    writeFileSync(
      join(fx.repo, "src", "dirty.ts"),
      "export const x = 1;\n// MUTATION: drop the next line\nexport const y = 2;\n",
    );
    gitAdd(fx, "src/dirty.ts");
    const r = run(fx);
    assert.equal(r.code, 1, `expected exit 1, got ${r.code}`);
    assert.match(r.stderr, /src\/dirty\.ts/, "stderr should name the offending file");
    assert.match(r.stderr, /MUTATION/, "stderr should echo the offending line");
  } finally {
    teardown(fx);
  }
});

test("check-no-mutation-markers: marker in unstaged working-tree file exits 0", () => {
  const fx = setup();
  try {
    // Write the marker but DON'T stage it.
    writeFileSync(
      join(fx.repo, "src", "unstaged.ts"),
      "export const x = 1;\n// MUTATE: forgot to revert\n",
    );
    // Stage a different, clean file so `staged_files` is non-empty —
    // exercises the "scoped to staged" guarantee.
    writeFileSync(join(fx.repo, "src", "other.ts"), "export const ok = 1;\n");
    gitAdd(fx, "src/other.ts");
    const r = run(fx);
    assert.equal(
      r.code,
      0,
      `expected exit 0 (only staged content is checked), got ${r.code} (stderr: ${r.stderr})`,
    );
  } finally {
    teardown(fx);
  }
});
