/**
 * Spawn integration test — exercises the real subprocess machinery without
 * involving a parent LLM. We spawn the `inspector` persona on a trivial task
 * and assert the run reaches a terminal status with a transcript on disk.
 *
 * Long-running (uses an actual pi subprocess); skipped in CI by default.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolvePersonas } from "../src/personas.ts";
import { RunRegistry, runDir, sendToRun } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import {
  awaitOrDetach,
  createUpdateThrottle,
  renderForegroundStream,
  renderForegroundSummary,
} from "../src/foreground-stream.ts";
import type { Run } from "../src/types.ts";

const HAS_PI = (() => {
  try {
    execSync("pi --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const RUN_LIVE = process.env.CONDUCTOR_LIVE_TESTS === "1" && HAS_PI;

test(
  "spawn integration: inspector persona spawns and reaches a terminal status",
  { skip: !RUN_LIVE ? "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)" : false, timeout: 180_000 },
  async () => {
    // Keep the real HOME so AWS credentials work; use a tmp cwd.
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-live-cwd-"));

    try {
      const resolved = await resolvePersonas({ cwd: tmpCwd });
      const inspector = resolved.personas.get("inspector");
      assert.ok(inspector, "inspector persona must be resolvable");

      const registry = new RunRegistry();
      const queue = new SpawnQueue(registry, 4);

      const result = queue.enqueueOrSpawn({
        persona: inspector,
        task:
          "Use bash to run `echo HELLO_FROM_INSPECTOR` and report what you saw. Do not call any other tools.",
        mode: "background",
        cwd: tmpCwd,
        timeoutMs: 120_000,
      });

      assert.equal(result.kind, "spawned", "should spawn immediately (slot available)");
      if (result.kind !== "spawned") return;

      const finished = await result.done;

      assert.equal(finished.id, result.run.id);
      assert.ok(
        finished.status === "completed" || finished.status === "failed",
        `unexpected terminal status: ${finished.status}`,
      );

      // Record should be on disk regardless of whether pi emitted any events
      // before exit.
      assert.ok(existsSync(finished.recordPath), "record.json should be written");

      // Final.md should exist (may contain '(no output)' if pi exited early).
      assert.ok(existsSync(finished.finalPath), "final.md should be written");

      // runDir should resolve under the real $HOME's conductor runs root.
      assert.equal(
        runDir(finished.id),
        join(homedir(), ".pi", "agent", "conductor", "runs", finished.id),
      );
    } finally {
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);

test(
  "spawn integration: ensemble_send resumes a finished sub-agent's session",
  { skip: !RUN_LIVE ? "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)" : false, timeout: 240_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-live-cwd-"));
    try {
      const resolved = await resolvePersonas({ cwd: tmpCwd });
      const inspector = resolved.personas.get("inspector");
      assert.ok(inspector, "inspector persona must be resolvable");

      const registry = new RunRegistry();
      const queue = new SpawnQueue(registry, 4);

      const result = queue.enqueueOrSpawn({
        persona: inspector,
        task:
          "Reply only with the literal string FIRST_REPLY and stop. Do not call any tools.",
        mode: "background",
        cwd: tmpCwd,
        timeoutMs: 120_000,
      });
      assert.equal(result.kind, "spawned");
      if (result.kind !== "spawned") return;

      const after1 = await result.done;
      assert.ok(
        after1.status === "completed" || after1.status === "failed",
        `unexpected terminal status after spawn: ${after1.status}`,
      );
      const turnsAfter1 = after1.usage.turns;
      const messagesAfter1 = after1.messages.length;
      assert.ok(after1.sessionPath, "sessionPath must be discovered after spawn");
      if (!after1.sessionPath) return;
      assert.ok(existsSync(after1.sessionPath), "sessionPath must exist on disk");
      // The persona system prompt must be captured on Run so the resume
      // path of buildResumePiArgs can re-pass it (pi sessions don't
      // persist system prompts to disk).
      assert.ok(
        after1.systemPrompt && after1.systemPrompt.length > 0,
        "Run.systemPrompt must be captured at spawn time so ensemble_send can re-inject it",
      );

      // Send a follow-up. The sub-agent should resume from the same session
      // and produce a second assistant turn.
      const sendResult = sendToRun(
        after1,
        "Reply only with the literal string SECOND_REPLY and stop. Do not call any tools.",
        { registry, timeoutMs: 120_000 },
      );
      assert.equal(sendResult.kind, "started");
      if (sendResult.kind !== "started") return;

      const after2 = await sendResult.done;
      assert.ok(
        after2.status === "completed" || after2.status === "failed",
        `unexpected terminal status after send: ${after2.status}`,
      );
      assert.equal(after2.id, after1.id, "send reuses the same Run");
      assert.ok(
        after2.usage.turns > turnsAfter1,
        `expected at least one new assistant turn after send (was ${turnsAfter1}, now ${after2.usage.turns})`,
      );
      // D4 guard: pin pi's resume semantics. If `pi --session <path>` ever
      // starts replaying old events to stdout (instead of just emitting
      // the new turn), `applyEvent` would append duplicates and the message
      // delta would jump well above the expected 1–2 new entries. Tightening
      // this assertion makes a future pi behavior change loud, not silent.
      const newMessages = after2.messages.length - messagesAfter1;
      assert.ok(
        newMessages >= 1 && newMessages <= 4,
        `expected 1–4 new messages after a single resume turn (got ${newMessages}). ` +
          `If this fails high, pi may have started replaying old events on resume.`,
      );

      // Transcript on disk should contain both turns' assistant text.
      const transcript = readFileSync(after2.transcriptPath, "utf8");
      assert.match(transcript, /FIRST_REPLY|SECOND_REPLY/, "transcript should contain at least one of the two reply markers");
    } finally {
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);

test(
  "spawn integration: inherit_context=filtered seeds parent prose into the sub-agent's session",
  { skip: !RUN_LIVE ? "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)" : false, timeout: 180_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-live-cwd-"));
    try {
      const resolved = await resolvePersonas({ cwd: tmpCwd });
      const baseInspector = resolved.personas.get("inspector");
      assert.ok(baseInspector, "inspector persona must be resolvable");
      // Override inheritContext for this spawn so we exercise the seeded
      // resume path without having to ship a new persona.
      const inspector = { ...baseInspector, inheritContext: "filtered" as const };

      const registry = new RunRegistry();
      const queue = new SpawnQueue(registry, 4);

      // Construct a faked parent transcript. The MARKER below is the load
      // bearing token: it appears nowhere in the persona body or task
      // prompt, so if the sub-agent reproduces it, the seeded parent
      // history is what taught it.
      const MARKER = "PURPLE_OCTOPUS_4419";
      const parentMessages: any[] = [
        {
          role: "user",
          content:
            `Earlier I told you my secret codeword is ${MARKER}. Please remember it for later.`,
          timestamp: 0,
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Got it — your codeword is ${MARKER}. I'll remember it.`,
            },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      ];

      const result = queue.enqueueOrSpawn({
        persona: inspector,
        task:
          `What was the codeword the user told you earlier? Reply with just the codeword and nothing else. Do not call any tools.`,
        mode: "background",
        cwd: tmpCwd,
        timeoutMs: 120_000,
        parentMessages,
      });
      assert.equal(result.kind, "spawned");
      if (result.kind !== "spawned") return;

      const finished = await result.done;
      assert.ok(
        finished.status === "completed" || finished.status === "failed",
        `unexpected terminal status: ${finished.status}`,
      );
      // The seeded session file should be the one pi actually used.
      assert.ok(finished.sessionPath, "sessionPath should be set");
      if (!finished.sessionPath) return;
      assert.ok(
        finished.sessionPath.endsWith("seeded.jsonl"),
        `expected seeded.jsonl session path, got: ${finished.sessionPath}`,
      );
      // Pi resumes from the seeded file, so the seeded file is also where
      // the new turn lands. The parent prose and the new assistant text
      // both live there.
      const sessionRaw = readFileSync(finished.sessionPath, "utf8");
      assert.match(
        sessionRaw,
        new RegExp(MARKER),
        "seeded session file should contain the parent's marker",
      );

      // The sub-agent's reply should reproduce the marker — the only way
      // it can know it is from the seeded parent transcript.
      const finalText = readFileSync(finished.finalPath, "utf8");
      assert.match(
        finalText,
        new RegExp(MARKER),
        `sub-agent must reproduce the parent's seeded marker in its reply (got: ${finalText.slice(0, 200)})`,
      );
    } finally {
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);

test(
  "spawn integration: inherit_context=full seeds the entire parent transcript verbatim",
  { skip: !RUN_LIVE ? "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)" : false, timeout: 180_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-live-cwd-"));
    try {
      const resolved = await resolvePersonas({ cwd: tmpCwd });
      const baseInspector = resolved.personas.get("inspector");
      assert.ok(baseInspector, "inspector persona must be resolvable");
      const inspector = { ...baseInspector, inheritContext: "full" as const };

      const registry = new RunRegistry();
      const queue = new SpawnQueue(registry, 4);

      const MARKER = "GREEN_PENGUIN_8821";
      const parentMessages: any[] = [
        {
          role: "user",
          content: `Earlier I told you my secret codeword is ${MARKER}.`,
          timestamp: 0,
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: `Got it — your codeword is ${MARKER}.` },
          ],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-4-5",
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 0,
        },
      ];

      const result = queue.enqueueOrSpawn({
        persona: inspector,
        task:
          "What was the codeword? Reply with just the codeword and nothing else. Do not call any tools.",
        mode: "background",
        cwd: tmpCwd,
        timeoutMs: 120_000,
        parentMessages,
      });
      assert.equal(result.kind, "spawned");
      if (result.kind !== "spawned") return;

      const finished = await result.done;
      assert.ok(
        finished.status === "completed" || finished.status === "failed",
        `unexpected terminal status: ${finished.status}`,
      );
      assert.ok(finished.sessionPath?.endsWith("seeded.jsonl"));
      // full mode does NOT prepend the <filtered-history> sentinel.
      const sessionRaw = readFileSync(finished.sessionPath!, "utf8");
      assert.ok(
        !/<filtered-history>/.test(sessionRaw),
        "inherit_context=full must NOT prepend the filtered-history sentinel",
      );
      assert.match(sessionRaw, new RegExp(MARKER));
      const finalText = readFileSync(finished.finalPath, "utf8");
      assert.match(
        finalText,
        new RegExp(MARKER),
        `sub-agent must reproduce the parent's seeded marker in its reply (got: ${finalText.slice(0, 200)})`,
      );
    } finally {
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);

test(
  "spawn integration: foreground stream onUpdate fires multiple times and last frame matches final state",
  { skip: !RUN_LIVE ? "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)" : false, timeout: 180_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-live-cwd-"));
    try {
      const resolved = await resolvePersonas({ cwd: tmpCwd });
      const inspector = resolved.personas.get("inspector");
      assert.ok(inspector, "inspector persona must be resolvable");

      const registry = new RunRegistry();
      const queue = new SpawnQueue(registry, 4);

      // Capture sequence of rendered foreground-stream frames. Mirrors what
      // ensemble_spawn (foreground) wires up: throttled onUpdate fed by
      // registry.onChange, then a final flush before the summary.
      const frames: { runId: string; status: Run["status"]; text: string }[] = [];
      const throttle = createUpdateThrottle<Run>((r: Run) => {
        frames.push({
          runId: r.id,
          status: r.status,
          text: renderForegroundStream(r, 100),
        });
      }, { intervalMs: 50 });

      const result = queue.enqueueOrSpawn({
        persona: inspector,
        task:
          "Use bash to run `echo HELLO_FROM_INSPECTOR_FOREGROUND` then describe what you saw in one sentence.",
        mode: "foreground",
        cwd: tmpCwd,
        timeoutMs: 150_000,
      });
      assert.equal(result.kind, "spawned");
      if (result.kind !== "spawned") return;

      // Initial render so the card isn't blank, mirroring tools.ts wiring.
      throttle.push(result.run);
      const unsub = registry.onChange((r) => {
        if (r.id !== result.run.id) return;
        throttle.push(r);
      });

      let finished: Run;
      try {
        finished = await result.done;
        // Mirror tools.ts wiring: the registry's terminal notify already
        // pushed the final state into the throttle. flush() forces any
        // pending payload through so the last frame matches reality.
        throttle.flush();
      } finally {
        throttle.dispose();
        unsub();
      }

      assert.ok(
        finished.status === "completed" || finished.status === "failed",
        `unexpected terminal status: ${finished.status}`,
      );

      // 1. At least 2 frames fired (initial + at least one progress / terminal).
      assert.ok(
        frames.length >= 2,
        `expected ≥2 streamed frames, got ${frames.length}`,
      );

      // 2. The LAST frame matches the run's terminal status.
      const last = frames[frames.length - 1];
      assert.equal(last.runId, finished.id);
      assert.equal(
        last.status,
        finished.status,
        `terminal flush should carry the final status; got ${last.status}, expected ${finished.status}`,
      );

      // 3. No frame fires after dispose. Snapshot count, give the loop
      //    a tick, assert no growth.
      const lenAtDispose = frames.length;
      await new Promise((res) => setImmediate(res));
      assert.equal(
        frames.length,
        lenAtDispose,
        "no frames should fire after the throttle is disposed",
      );

      // 4. The terminal frame's rendered text reflects the final state.
      assert.match(last.text, new RegExp(finished.id));
      assert.match(last.text, new RegExp(finished.status));

      // 5. The completion summary the tool returns should be compact and
      //    distinct from the streamed transcript dump (no XML envelope).
      const summary = renderForegroundSummary(finished);
      assert.ok(
        summary.length < 2_000,
        `summary should be compact (<2KB), got ${summary.length} bytes`,
      );
      assert.doesNotMatch(summary, /<sub-agent-completed>/);
    } finally {
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);

test(
  "spawn integration: Esc-to-detach converts a foreground spawn to background",
  { skip: !RUN_LIVE ? "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)" : false, timeout: 180_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-live-cwd-"));
    try {
      const resolved = await resolvePersonas({ cwd: tmpCwd });
      const inspector = resolved.personas.get("inspector");
      assert.ok(inspector, "inspector persona must be resolvable");

      const registry = new RunRegistry();
      const queue = new SpawnQueue(registry, 4);

      // Spawn a foreground run that takes long enough to detach mid-stream.
      const result = queue.enqueueOrSpawn({
        persona: inspector,
        task:
          "Use bash to run `sleep 3 && echo HELLO_FROM_DETACHED` and then summarize what happened in one sentence.",
        mode: "foreground",
        cwd: tmpCwd,
        timeoutMs: 150_000,
      });
      assert.equal(result.kind, "spawned");
      if (result.kind !== "spawned") return;

      // Trigger detach after a short delay so the run has time to start
      // emitting events but cannot have completed yet.
      let resolveDetach: () => void = () => {};
      const detachSignal = new Promise<void>((res) => {
        resolveDetach = res;
      });
      setTimeout(() => resolveDetach(), 800);

      const outcome = await awaitOrDetach(result.done, detachSignal);

      // Must come back as detached — the run hasn't completed in <1s.
      assert.equal(
        outcome.kind,
        "detached",
        `expected detach to win the race, got ${outcome.kind}`,
      );

      // The run should still be alive after detach.
      const liveRun = registry.get(result.run.id);
      assert.ok(liveRun, "run must remain in registry after detach");
      assert.ok(
        liveRun!.status === "running" ||
          liveRun!.status === "paused" ||
          liveRun!.status === "completed",
        `unexpected post-detach status: ${liveRun!.status}`,
      );

      // Wait for the run to actually complete in the background and
      // verify the registry state ends up terminal.
      const finished = await result.done;
      assert.ok(
        finished.status === "completed" || finished.status === "failed",
        `unexpected eventual status: ${finished.status}`,
      );
      assert.equal(finished.id, result.run.id);
    } finally {
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);
