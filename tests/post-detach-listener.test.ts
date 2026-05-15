/**
 * Tests for installPostDetachCompletionListener — the small helper that
 * wires the registry-onChange listener responsible for pushing the
 * standard <sub-agent-completed> notification card after Esc-to-detach.
 *
 * Exercises the four scenarios the antagonistic v0.7 review called out:
 *
 *   1. Detach wins, run is still active → listener installed, no premature
 *      push; later terminal flip fires the push exactly once.
 *   2. Detach wins, run is ALREADY terminal at install time → race-guard
 *      fires the push synchronously, listener unsubs, no double-fire.
 *   3. Listener is correctly torn down by its returned unsubscribe.
 *   4. Notification fires only for the matching agent_id (other runs in
 *      the registry don't trigger it).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { installPostDetachCompletionListener } from "../src/foreground-stream.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "oracle-7f3a",
    persona: "oracle",
    task: "test task",
    mode: "foreground",
    status: "running",
    startTime: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/x/record.json",
    transcriptPath: "/tmp/x/transcript.jsonl",
    finalPath: "/tmp/x/final.md",
    ...overrides,
  };
}

test("installPostDetachCompletionListener: still-running run → no premature push", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "running" });
  reg.register(run);
  const pushed: Run[] = [];
  installPostDetachCompletionListener(run, reg, (r: Run) => pushed.push(r));
  assert.deepEqual(pushed, [], "no notification should fire while run is alive");
});

test("installPostDetachCompletionListener: terminal flip later fires push exactly once", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "running" });
  reg.register(run);
  const pushed: Run[] = [];
  installPostDetachCompletionListener(run, reg, (r: Run) => pushed.push(r));
  // Simulate the run reaching terminal status.
  run.status = "completed";
  run.finishedAt = Date.now();
  reg.notify(run);
  assert.equal(pushed.length, 1, "push should fire on terminal flip");
  assert.equal(pushed[0]!.id, run.id);
  // Subsequent notifies must not re-fire (listener should have unsubbed).
  reg.notify(run);
  reg.notify(run);
  assert.equal(pushed.length, 1, "listener unsubs after firing — no double push");
});

test("installPostDetachCompletionListener: race-guard — already-terminal at install time fires push synchronously and unsubs", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "completed", finishedAt: Date.now() });
  reg.register(run);
  const pushed: Run[] = [];
  installPostDetachCompletionListener(run, reg, (r: Run) => pushed.push(r));
  assert.equal(pushed.length, 1, "race-guard should fire the push synchronously");
  // Spurious post-install notifies must not double-fire.
  reg.notify(run);
  reg.notify(run);
  assert.equal(pushed.length, 1);
});

test("installPostDetachCompletionListener: ignores notifies for other run ids", () => {
  const reg = new RunRegistry();
  const ours = makeRun({ id: "oracle-aa11", status: "running" });
  const other = makeRun({ id: "builder-bb22", status: "running" });
  reg.register(ours);
  reg.register(other);
  const pushed: Run[] = [];
  installPostDetachCompletionListener(ours, reg, (r: Run) => pushed.push(r));
  // Flip the OTHER run to terminal — must not trigger our listener.
  other.status = "completed";
  reg.notify(other);
  assert.equal(pushed.length, 0, "other-id terminal flip must not fire our notification");
  // Now flip ours.
  ours.status = "completed";
  reg.notify(ours);
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0]!.id, "oracle-aa11");
});

test("installPostDetachCompletionListener: returned unsubscribe stops further fires", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "running" });
  reg.register(run);
  const pushed: Run[] = [];
  const unsub = installPostDetachCompletionListener(run, reg, (r: Run) => pushed.push(r));
  // Caller-driven teardown before the run reaches terminal.
  unsub();
  run.status = "completed";
  reg.notify(run);
  assert.deepEqual(pushed, [], "unsub before terminal must suppress the push");
});

test("installPostDetachCompletionListener: non-terminal notifies are ignored", () => {
  const reg = new RunRegistry();
  const run = makeRun({ status: "running" });
  reg.register(run);
  const pushed: Run[] = [];
  installPostDetachCompletionListener(run, reg, (r: Run) => pushed.push(r));
  // A streaming-progress notify should not trigger the push.
  run.lastToolCall = "bash $ git status";
  reg.notify(run);
  assert.deepEqual(pushed, [], "non-terminal notifies must not fire the push");
  // 'paused' is also non-terminal.
  run.status = "paused";
  reg.notify(run);
  assert.deepEqual(pushed, [], "paused is non-terminal — no push");
});
