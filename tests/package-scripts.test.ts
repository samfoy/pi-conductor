/**
 * v0.20 M0c: `test:summary` isolates like `test`. It writes its output under
 * ${TMPDIR:-/tmp}, so parallel runs with their own TMPDIR don't overwrite
 * each other, and it sets the same CONDUCTOR_MEMORY_PATH, so the suite never
 * writes into the real memory store.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const scripts: Record<string, string> = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
).scripts;

test("test:summary sets the same CONDUCTOR_MEMORY_PATH as test", () => {
  const memory = scripts.test!.match(/CONDUCTOR_MEMORY_PATH=\S+/)?.[0];
  assert.ok(memory, "precondition: test overrides the memory path");
  assert.ok(scripts["test:summary"]!.includes(memory), scripts["test:summary"]);
});

test("test:summary writes and tails its output under ${TMPDIR:-/tmp}", () => {
  const summary = scripts["test:summary"]!;
  assert.doesNotMatch(summary, /(^|[\s>])\/tmp\//, "no hardcoded /tmp path");
  const out = '"${TMPDIR:-/tmp}/pi-test-out.txt"';
  assert.ok(summary.includes(`> ${out} 2>&1`), summary);
  assert.ok(summary.includes(`tail -10 ${out}`), summary);
});
