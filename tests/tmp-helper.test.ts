/**
 * tests/helpers/tmp.ts: a tmpDir() is removed when its process exits, along
 * with anything a late fire-and-forget write put in it after the test that
 * made it had ended. Forks a real node subprocess, hence the timeout.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const helper = pathToFileURL(join(import.meta.dirname, "helpers", "tmp.ts")).href;

test("tmpDir: the dir, and a late write into it, are gone once the process exits", { timeout: 15_000 }, () => {
  const priv = mkdtempSync(join(tmpdir(), "conductor-tmp-helper-"));
  try {
    const script =
      `import { mkdirSync, writeFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `import { tmpDir } from ${JSON.stringify(helper)};\n` +
      `const dir = tmpDir("probe-");\n` +
      `writeFileSync(join(dir, "f"), "x");\n` +
      // A run's record write landing after its test has already cleaned up.
      `setTimeout(() => { mkdirSync(join(dir, "runs", "r1"), { recursive: true }); writeFileSync(join(dir, "runs", "r1", "record.json"), "{}"); }, 30);\n` +
      `process.stdout.write(dir);\n`;
    const made = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      env: { ...process.env, TMPDIR: priv },
      encoding: "utf8",
    });
    assert.ok(made.startsWith(join(priv, "probe-")), `made ${made}`);
    // tsx keeps its compile cache (tsx-<uid>) in TMPDIR too; that isn't ours.
    assert.deepEqual(readdirSync(priv).filter((e) => e.startsWith("probe-")), [], "nothing left behind");
  } finally {
    rmSync(priv, { recursive: true, force: true });
  }
});

test("sandboxPi: HOME and PI_BIN point into a temp dir, the stub fails at once, and both go at exit", { timeout: 15_000 }, () => {
  const priv = mkdtempSync(join(tmpdir(), "conductor-tmp-helper-"));
  try {
    const script =
      `import { spawnSync } from "node:child_process";\n` +
      `import { sandboxPi } from ${JSON.stringify(helper)};\n` +
      `const got = sandboxPi();\n` +
      `const stub = spawnSync(process.execPath, [process.env.PI_BIN]);\n` +
      `process.stdout.write(JSON.stringify({ ...got, HOME: process.env.HOME, PI_BIN: process.env.PI_BIN, status: stub.status }));\n`;
    const out = JSON.parse(
      execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        env: { ...process.env, TMPDIR: priv },
        encoding: "utf8",
      }),
    );
    assert.equal(out.HOME, out.home);
    assert.equal(out.PI_BIN, out.piBin);
    assert.ok(out.home.startsWith(join(priv, "conductor-sandbox-pi-")), out.home);
    assert.equal(out.status, 1, "the stub exits 1, like an unconfigured pi");
    assert.deepEqual(readdirSync(priv).filter((e) => e.startsWith("conductor-sandbox-pi-")), []);
  } finally {
    rmSync(priv, { recursive: true, force: true });
  }
});
