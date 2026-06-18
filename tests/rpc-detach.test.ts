/**
 * Tests for the RPC-mode detach mechanism: createRpcDetach.
 *
 * In RPC/headless mode, onTerminalInput is a no-op stub, so detach is
 * driven by a sentinel file at /tmp/pi-conductor-detach-<pid>.
 *
 * WDD witnesses:
 *   W1 (a): unregister clears the interval — no timer leak.
 *     Mutation: remove clearInterval(pollTimer) from unsubInput.
 *     Killing test: after unregister(), creating the file + advancing time
 *     must NOT resolve detachSignal.
 *
 *   W2 (b): signal file presence resolves detachSignal.
 *     Mutation: remove the existsSync(detachFilePath) branch.
 *     Killing test: creating the file + ticking time must resolve detachSignal.
 *
 *   W3 (c): unregister removes a stale signal file.
 *     Mutation: remove the cleanup block from unsubInput.
 *     Killing test: file exists after unregister() instead of being deleted.
 */

import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createRpcDetach } from "../src/rpc-detach.ts";

// ── W1: unregister clears the interval ───────────────────────────────────────

test("W1: unregister clears the poll interval — no signal after unregister", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const filePath = `/tmp/pi-conductor-test-detach-${process.pid}-w1`;
  try {
    const { detachSignal, unregister } = createRpcDetach(filePath, 200);

    let resolved = false;
    void detachSignal.then(() => { resolved = true; });

    // Tick twice without file — not resolved.
    mock.timers.tick(200);
    mock.timers.tick(200);
    assert.strictEqual(resolved, false, "pre-condition: no resolve without file");

    // Unregister clears the interval.
    unregister();

    // Now create the file and tick — must NOT resolve (interval was cleared).
    writeFileSync(filePath, "");
    mock.timers.tick(200);
    mock.timers.tick(200);

    assert.strictEqual(resolved, false, "must not resolve after unregister clears interval");
  } finally {
    mock.timers.reset();
    try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
  }
});

// ── W2: signal file resolves detachSignal ────────────────────────────────────

test("W2: detachSignal resolves when signal file appears on next tick", async () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const filePath = `/tmp/pi-conductor-test-detach-${process.pid}-w2`;
  try {
    const { detachSignal, unregister } = createRpcDetach(filePath, 200);

    let resolved = false;
    void detachSignal.then(() => { resolved = true; });

    // No file yet — tick, must not resolve.
    mock.timers.tick(200);
    await Promise.resolve(); // drain microtasks
    assert.strictEqual(resolved, false, "pre-condition: no file, no resolve");

    // Create the signal file.
    writeFileSync(filePath, "");

    // Next tick detects the file.
    mock.timers.tick(200);
    await Promise.resolve(); // drain microtasks

    assert.strictEqual(resolved, true, "must resolve after file appears and tick");

    // Implementation must delete the signal file.
    assert.strictEqual(existsSync(filePath), false, "implementation must delete signal file");

    unregister();
  } finally {
    mock.timers.reset();
    try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
  }
});

// ── W3: unregister removes stale signal file ─────────────────────────────────

test("W3: unregister removes a stale signal file if present", () => {
  mock.timers.enable({ apis: ["setInterval"] });
  const filePath = `/tmp/pi-conductor-test-detach-${process.pid}-w3`;
  try {
    writeFileSync(filePath, "");
    const { unregister } = createRpcDetach(filePath, 200);
    unregister();
    assert.strictEqual(existsSync(filePath), false, "unregister must remove stale signal file");
  } finally {
    mock.timers.reset();
    try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
  }
});
