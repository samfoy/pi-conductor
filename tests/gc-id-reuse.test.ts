/**
 * pi-conductor — GC R10 id-reuse log helper tests.
 *
 * Spec: docs/v0.9-gc-design.md §R10; docs/v0.9-gc-plan.md "Slice 5".
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  noteAllocatedId,
  noteDeletedId,
  _resetRecentlyDeletedIdsForTest,
  _peekRecentlyDeletedForTest,
} from "../src/gc/id-reuse.ts";

test("id-reuse: noteAllocatedId without prior delete -> no log", () => {
  _resetRecentlyDeletedIdsForTest();
  const logs: string[] = [];
  noteAllocatedId("inspector-fresh", (l) => logs.push(l));
  assert.equal(logs.length, 0);
});

test("id-reuse: noteAllocatedId after noteDeletedId on same id -> 'gc.id_reused' log", () => {
  _resetRecentlyDeletedIdsForTest();
  noteDeletedId("inspector-old1");
  const logs: string[] = [];
  noteAllocatedId("inspector-old1", (l) => logs.push(l));
  assert.deepEqual(logs, ["gc.id_reused: inspector-old1"]);
});

test("id-reuse: noteAllocatedId for a DIFFERENT id -> no log", () => {
  _resetRecentlyDeletedIdsForTest();
  noteDeletedId("inspector-old1");
  const logs: string[] = [];
  noteAllocatedId("inspector-old2", (l) => logs.push(l));
  assert.equal(logs.length, 0);
});

test("id-reuse: _peekRecentlyDeletedForTest reflects what was noted", () => {
  _resetRecentlyDeletedIdsForTest();
  noteDeletedId("a");
  noteDeletedId("b");
  const set = _peekRecentlyDeletedForTest();
  assert.ok(set.has("a"));
  assert.ok(set.has("b"));
  assert.equal(set.size, 2);
});

test("id-reuse: _resetRecentlyDeletedIdsForTest empties the set", () => {
  noteDeletedId("z");
  _resetRecentlyDeletedIdsForTest();
  assert.equal(_peekRecentlyDeletedForTest().size, 0);
});
