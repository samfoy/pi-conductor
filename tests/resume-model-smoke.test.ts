/**
 * Smoke: `sendToRun` resumes with a provider-qualified `--model`.
 *
 * A bare model id served by two authenticated providers makes pi exit with
 * "Model ... is ambiguous across providers". Legacy records hold that bare
 * id, so the resume qualifies it from the session file when it can.
 *
 * Forks a real subprocess, but not pi: `PI_BIN` points at a stub that
 * records its argv and exits. HOME is sandboxed so config reads and record
 * writes stay inside a temp dir.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RunRegistry, sendToRun } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

async function resumeArgv(model: string | undefined, sessionLines: object[]): Promise<{ argv: string[]; run: Run }> {
  const root = mkdtempSync(join(tmpdir(), "conductor-resume-model-smoke-"));
  const argvOut = join(root, "argv.json");
  const stub = join(root, "pi-stub.mjs");
  writeFileSync(
    stub,
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));\n`,
  );
  const sessionPath = join(root, "session.jsonl");
  writeFileSync(sessionPath, sessionLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN };
  process.env.HOME = root;
  process.env.PI_BIN = stub;
  try {
    const registry = new RunRegistry();
    const run: Run = {
      id: "builder-lvaf",
      persona: "builder",
      task: "probe",
      model,
      mode: "background",
      status: "completed",
      startTime: 1_700_000_000_000,
      lastEventAt: 1_700_000_000_000,
      finishedAt: 1_700_000_001_000,
      messages: [],
      usage: emptyUsage(),
      cwd: root,
      sessionPath,
      recordPath: join(root, "record.json"),
      transcriptPath: join(root, "transcript.jsonl"),
      finalPath: join(root, "final.md"),
    };
    registry.register(run);
    const result = sendToRun(run, "continue", { registry, timeoutMs: 10_000 });
    assert.equal(result.kind, "started", result.kind === "rejected" ? result.reason : "");
    if (result.kind === "started") await result.done;
    return { argv: JSON.parse(readFileSync(argvOut, "utf8")), run };
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
}

const modelArg = (argv: string[]): string | undefined =>
  argv.includes("--model") ? argv[argv.indexOf("--model") + 1] : undefined;

test("sendToRun: a legacy bare run.model is qualified from the session's assistant provider", { timeout: 15_000 }, async () => {
  const { argv, run } = await resumeArgv("anthropic.claude-opus-5-5", [
    { type: "session", version: 3, id: "s" },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [],
        api: "anthropic-messages",
        provider: "pi-amazon-claude-provider",
        model: "anthropic.claude-opus-5-5",
      },
    },
  ]);
  assert.equal(modelArg(argv), "pi-amazon-claude-provider/anthropic.claude-opus-5-5");
  assert.equal(run.model, "pi-amazon-claude-provider/anthropic.claude-opus-5-5", "the record is upgraded too");
});

test("sendToRun: a bare run.model with no provider in the session passes through unchanged", { timeout: 15_000 }, async () => {
  const { argv } = await resumeArgv("anthropic.claude-opus-5-5", [
    { type: "message", message: { role: "assistant", content: [], model: "anthropic.claude-opus-5-5" } },
  ]);
  assert.equal(modelArg(argv), "anthropic.claude-opus-5-5");
});

test("sendToRun: an already-qualified run.model passes through unchanged", { timeout: 15_000 }, async () => {
  const { argv } = await resumeArgv("amazon-bedrock/us.openai.gpt-6-astra", [
    {
      type: "message",
      message: { role: "assistant", content: [], provider: "amazon-bedrock", model: "us.openai.gpt-6-astra" },
    },
  ]);
  assert.equal(modelArg(argv), "amazon-bedrock/us.openai.gpt-6-astra");
});

test("sendToRun: no run.model still emits no --model", { timeout: 15_000 }, async () => {
  const { argv } = await resumeArgv(undefined, [
    { type: "message", message: { role: "assistant", content: [], provider: "amazon-bedrock", model: "m" } },
  ]);
  assert.equal(modelArg(argv), undefined);
});
