import test from "node:test";
import assert from "node:assert/strict";

import { summarizeToolArgs } from "../src/tool-summary.ts";

// summarizeToolArgs is the *core* helper — no `$ ` prefix, no shortenPath.
// Mirrors the prior `summarizeArgs` semantics from src/transcript.ts so the
// transcript renderer behavior is preserved byte-for-byte across the dedup.

test("summarizeToolArgs: bash returns the command literal", () => {
  assert.equal(summarizeToolArgs("bash", { command: "echo hi" }), "echo hi");
});

test("summarizeToolArgs: bash truncates long commands at 50 chars with ellipsis", () => {
  const long = "a".repeat(80);
  const out = summarizeToolArgs("bash", { command: long });
  assert.equal(out.length, 50);
  assert.ok(out.endsWith("…"));
  assert.equal(out, "a".repeat(49) + "…");
});

test("summarizeToolArgs: bash with missing command returns empty string", () => {
  assert.equal(summarizeToolArgs("bash", {}), "");
});

test("summarizeToolArgs: read returns the file_path", () => {
  assert.equal(summarizeToolArgs("read", { file_path: "x.ts" }), "x.ts");
});

test("summarizeToolArgs: read falls back to args.path", () => {
  assert.equal(summarizeToolArgs("read", { path: "y.ts" }), "y.ts");
});

test("summarizeToolArgs: write returns the file_path", () => {
  assert.equal(summarizeToolArgs("write", { file_path: "out.txt" }), "out.txt");
});

test("summarizeToolArgs: edit returns the file_path", () => {
  assert.equal(summarizeToolArgs("edit", { file_path: "src/foo.ts" }), "src/foo.ts");
});

test("summarizeToolArgs: grep returns the pattern", () => {
  assert.equal(summarizeToolArgs("grep", { pattern: "TODO" }), "TODO");
});

test("summarizeToolArgs: unknown tools render compact key=value pairs", () => {
  const out = summarizeToolArgs("custom_tool", { foo: "bar", n: 7 });
  assert.equal(out, "foo=bar n=7");
});

test("summarizeToolArgs: unknown tools shorten each value at 30 chars", () => {
  // Each value is shortened to 30 chars (with ellipsis) before pair-joining.
  const out = summarizeToolArgs("custom_tool", { x: "a".repeat(80) });
  assert.equal(out, "x=" + "a".repeat(29) + "…");
});

test("summarizeToolArgs: unknown tools truncate the joined pair list at 50 chars", () => {
  // Many short values whose joined form exceeds 50 chars get a final outer trim.
  const args: Record<string, any> = {};
  for (let i = 0; i < 20; i++) args[`k${i}`] = `v${i}`;
  const out = summarizeToolArgs("custom_tool", args);
  assert.equal(out.length, 50);
  assert.ok(out.endsWith("…"));
});

test("summarizeToolArgs: empty args render as empty string", () => {
  assert.equal(summarizeToolArgs("custom_tool", {}), "");
});
