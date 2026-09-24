/**
 * The pi subprocess stdout is split into JSON event lines. A pipe hands
 * over arbitrary byte chunks, so a multibyte UTF-8 character can straddle
 * two of them; decoding each chunk on its own turns both halves into
 * U+FFFD and corrupts the event.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLineDecoder, getFinalText, RunRegistry, spawnRun } from "../src/runs.ts";
import type { Persona } from "../src/types.ts";

const EVENT = JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text: "done 🎉 ✓" }], model: "m" },
});

/** Split `line + "\n"` inside the 4-byte emoji (F0 9F 8E 89). */
function splitMidEmoji(line: string): [Buffer, Buffer] {
  const bytes = Buffer.from(line + "\n", "utf8");
  const at = bytes.indexOf(Buffer.from("🎉", "utf8")) + 2;
  return [bytes.subarray(0, at), bytes.subarray(at)];
}

test("createLineDecoder: a 4-byte character split across chunks decodes intact", () => {
  const lines: string[] = [];
  const decoder = createLineDecoder((l) => lines.push(l));
  const [a, b] = splitMidEmoji(EVENT);
  decoder.write(a);
  assert.deepEqual(lines, [], "no newline yet");
  decoder.write(b);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]!).message.content[0].text, "done 🎉 ✓");
  assert.equal(decoder.end(), "");
});

test("createLineDecoder: one byte per chunk still yields the same lines, and end() returns the tail", () => {
  const lines: string[] = [];
  const decoder = createLineDecoder((l) => lines.push(l));
  for (const byte of Buffer.from(`${EVENT}\n{"tail":"é`, "utf8")) decoder.write(Buffer.from([byte]));
  assert.deepEqual(lines, [EVENT]);
  assert.equal(decoder.end(), '{"tail":"é');
});

test("spawnRun: an event line split mid-character by the pipe reaches the run intact", { timeout: 15_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-stdout-multibyte-"));
  const stub = join(root, "pi-stub.mjs");
  const [a, b] = splitMidEmoji(EVENT);
  // Two writes 50 ms apart, so the parent sees two data events.
  writeFileSync(
    stub,
    `const a = Buffer.from(${JSON.stringify(a.toString("base64"))}, "base64");\n` +
      `const b = Buffer.from(${JSON.stringify(b.toString("base64"))}, "base64");\n` +
      `process.stdout.write(a, () => setTimeout(() => process.stdout.write(b, () => process.exit(0)), 50));\n`,
  );
  const saved = { HOME: process.env.HOME, PI_BIN: process.env.PI_BIN };
  process.env.HOME = root;
  process.env.PI_BIN = stub;
  try {
    const persona: Persona = {
      name: "scout",
      description: "probe",
      inheritContext: "none",
      inheritSkills: false,
      defaultReads: [],
      worktree: false,
      timeoutMinutes: 1,
      systemPrompt: "You are scout.",
      source: "builtin",
      sourcePath: "/fake/scout.md",
      readOnly: false,
    };
    const { done } = spawnRun({ registry: new RunRegistry(), persona, task: "probe", mode: "background", cwd: root, timeoutMs: 10_000 });
    const run = await done;
    assert.equal(getFinalText(run.messages), "done 🎉 ✓");
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
