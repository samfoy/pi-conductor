/**
 * Tests for the foreground onUpdate throttler.
 *
 * The sub-agent may emit dozens of stream events per turn (token deltas,
 * tool starts, tool result chunks). Pi re-renders the parent tool-call
 * card on every onUpdate, so we coalesce calls to at most one per N ms.
 * Terminal flushes are unconditional so the final transcript is the last
 * visible state before the result card collapses.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { createUpdateThrottle } from "../src/foreground-stream.ts";

test("throttle: first call fires synchronously (leading edge)", () => {
  const calls: string[] = [];
  const t = createUpdateThrottle((s: string) => calls.push(s), { intervalMs: 50 });
  t.push("first");
  assert.deepEqual(calls, ["first"]);
  t.dispose();
});

test("throttle: rapid calls within window are coalesced to the last value", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const calls: string[] = [];
    const t = createUpdateThrottle((s: string) => calls.push(s), { intervalMs: 50 });
    t.push("a"); // leading edge → fires
    t.push("b");
    t.push("c");
    t.push("d");
    assert.deepEqual(calls, ["a"], "only leading edge has fired so far");
    mock.timers.tick(50);
    assert.deepEqual(calls, ["a", "d"], "trailing flush carries the latest payload");
    t.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("throttle: a call after the window fires immediately", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const calls: string[] = [];
    const t = createUpdateThrottle((s: string) => calls.push(s), { intervalMs: 50 });
    t.push("a");
    mock.timers.tick(50);
    t.push("b");
    assert.deepEqual(calls, ["a", "b"]);
    t.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("throttle: flush() forces immediate delivery of pending payload", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const calls: string[] = [];
    const t = createUpdateThrottle((s: string) => calls.push(s), { intervalMs: 100 });
    t.push("a"); // leading
    t.push("b");
    t.push("c");
    assert.deepEqual(calls, ["a"]);
    t.flush();
    assert.deepEqual(calls, ["a", "c"]);
    t.dispose();
  } finally {
    mock.timers.reset();
  }
});

test("throttle: flush() with no pending payload is a no-op", () => {
  const calls: string[] = [];
  const t = createUpdateThrottle((s: string) => calls.push(s), { intervalMs: 50 });
  t.push("a");
  t.flush();
  assert.deepEqual(calls, ["a"]);
  t.dispose();
});

test("throttle: dispose cancels pending trailing flush", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const calls: string[] = [];
    const t = createUpdateThrottle((s: string) => calls.push(s), { intervalMs: 50 });
    t.push("a");
    t.push("b");
    t.dispose();
    mock.timers.tick(500);
    assert.deepEqual(calls, ["a"], "trailing fire is cancelled by dispose");
  } finally {
    mock.timers.reset();
  }
});

test("throttle: pushes after dispose are dropped silently", () => {
  const calls: string[] = [];
  const t = createUpdateThrottle((s: string) => calls.push(s), { intervalMs: 50 });
  t.dispose();
  t.push("a");
  t.push("b");
  assert.deepEqual(calls, []);
});

test("throttle: identical consecutive payloads still emit (caller controls dedup)", () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  try {
    const calls: string[] = [];
    const t = createUpdateThrottle((s: string) => calls.push(s), { intervalMs: 50 });
    t.push("same");
    t.push("same");
    mock.timers.tick(50);
    assert.deepEqual(calls, ["same", "same"]);
    t.dispose();
  } finally {
    mock.timers.reset();
  }
});
