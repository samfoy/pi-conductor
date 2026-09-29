import test from "node:test";
import assert from "node:assert/strict";
import { parseMergeTree } from "../src/effort/core.ts";
import { isGeneratedPath, resolveEffortPolicy } from "../src/effort/policy.ts";

const tree = "a".repeat(40);
test("merge-tree NUL protocol preserves exact paths and original tree", () => {
  const paths = [" leading space", "dist/über space.json", "line\nbreak", "trailing "];
  assert.deepEqual(parseMergeTree(`${tree}\0${paths.join("\0")}\0\0`, 1), { kind: "conflict", tree, conflicts: paths });
  assert.deepEqual(parseMergeTree(`${tree}\0`, 0), { kind: "clean", tree });
});
for (const output of [`${tree}\nfile\n`, `${tree}\0file`, `${tree}\0\0`, `bad\0file\0\0`]) test("malformed merge output fails closed " + JSON.stringify(output), () => {
  assert.equal(parseMergeTree(output, 1).kind, "error");
});
test("shared generated predicate matches concrete paths, not intersecting source globs", () => {
  const policy = resolveEffortPolicy({ verify: "", generated: { paths: ["dist/**", "a/über.json"], command: "build" } });
  assert.equal(isGeneratedPath("dist/über space.json", policy.generated), true);
  assert.equal(isGeneratedPath("a/über.json", policy.generated), true);
  assert.equal(isGeneratedPath("src/a.ts", policy.generated), false);
  assert.equal(isGeneratedPath("src/**", policy.generated), false);
  assert.equal(isGeneratedPath("dist/a", undefined), false);
  assert.equal(isGeneratedPath("../dist/a", policy.generated), false);
});
