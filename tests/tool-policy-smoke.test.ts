/**
 * Smoke: `spawnRun` stamps the persona's effective tool policy on the
 * Run + record.json and hands the same flags to the child argv.
 *
 * Forks a real subprocess, but not pi: `PI_BIN` points at a stub that
 * records its argv and exits. HOME is sandboxed so the run dir and
 * config reads stay inside a temp dir.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnRun, RunRegistry } from "../src/runs.ts";
import { CONDUCTOR_LLM_TOOL_NAMES, type Persona } from "../src/types.ts";

test("spawnRun: stamps tools/excludeTools on the Run and record, and passes them to the child", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-tool-policy-smoke-"));
  const argvOut = join(root, "argv.json");
  const stub = join(root, "pi-stub.mjs");
  writeFileSync(
    stub,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN };
  process.env.HOME = root;
  process.env.PI_BIN = stub;
  try {
    const persona: Persona = {
      name: "critic",
      description: "probe",
      inheritContext: "none",
      inheritSkills: false,
      defaultReads: [],
      worktree: false,
      timeoutMinutes: 1,
      systemPrompt: "You are critic.",
      source: "builtin",
      sourcePath: "/fake/critic.md",
      readOnly: false,
      tools: ["read", "bash"],
      excludeTools: ["edit"],
    };
    const { run, done } = spawnRun({
      registry: new RunRegistry(),
      persona,
      task: "probe",
      mode: "background",
      cwd: root,
      timeoutMs: 10_000,
    });
    const expectedExclude = ["edit", ...CONDUCTOR_LLM_TOOL_NAMES];
    assert.deepEqual(run.tools, ["read", "bash"]);
    assert.deepEqual(run.excludeTools, expectedExclude);

    await done;
    const argv: string[] = JSON.parse(readFileSync(argvOut, "utf8"));
    assert.equal(argv[argv.indexOf("--tools") + 1], "read,bash");
    assert.equal(argv[argv.indexOf("--exclude-tools") + 1], expectedExclude.join(","));

    const record = JSON.parse(readFileSync(run.recordPath, "utf8"));
    assert.deepEqual(record.tools, ["read", "bash"]);
    assert.deepEqual(record.excludeTools, expectedExclude);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
