/**
 * Tests for `buildPiArgs`'s v0.12 RPC argv branch.
 *
 * Print-mode regression cases (the existing `--mode json -p`
 * argv) live in `tests/runs-helpers.test.ts`. This file pins
 * the new `steerable: true / false` discriminator and the
 * regression-on-print-mode invariant.
 *
 * Design ref: `docs/v0.12-steering-design.md` §4.2 (lines ~414–429).
 * Slice ref: `docs/v0.12-steering-plan.md` §"Slice 2".
 *
 * Two named acceptance cases:
 *   1. steerable=true → ["--mode", "rpc", ...] (no -p, no prompt
 *      positional)
 *   2. steerable=false → today's argv EXACTLY (regression pin)
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildPiArgs } from "../src/runs.ts";

test('buildPiArgs(fresh, steerable=true): emits ["--mode", "rpc", ...] without "-p" and without trailing prompt positional', () => {
  const args = buildPiArgs({
    kind: "fresh",
    sessionDir: "/tmp/sess",
    systemPrompt: "SYS",
    prompt: "PROMPT",
    steerable: true,
  });

  // Mode flips to rpc; -p is dropped (rpc mode does not auto-prompt;
  // slice 3 will inject the prompt via stdin).
  assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
  assert.equal(args.includes("-p"), false, "-p must NOT appear in steerable=true argv");
  assert.equal(args.includes("--print"), false);

  // The remaining flags survive: --session-dir, --append-system-prompt.
  const sd = args.indexOf("--session-dir");
  assert.ok(sd > 0, "--session-dir must be present");
  assert.equal(args[sd + 1], "/tmp/sess");
  const sp = args.indexOf("--append-system-prompt");
  assert.ok(sp > 0, "--append-system-prompt must be present");
  assert.equal(args[sp + 1], "SYS");

  // CRITICAL: the trailing prompt positional must NOT be emitted
  // in RPC mode. Slice 3 sends the initial prompt as a JSON line
  // on stdin via RpcStdinQueue.
  assert.equal(
    args.includes("PROMPT"),
    false,
    "PROMPT positional must NOT be in steerable=true argv (slice 3 injects via stdin)",
  );
  // Stronger: the final argument is NOT the prompt text. (Last arg
  // should be the value of the last --flag pair, not a positional.)
  assert.notEqual(args[args.length - 1], "PROMPT");
});

test("buildPiArgs(fresh, steerable=false): emits today's argv EXACTLY (regression pin)", () => {
  // This pins the print-mode invariant: every flag, every position,
  // byte-for-byte the same as v0.11. If a future slice subtly
  // changes the argv shape this test must fail loudly.
  const args = buildPiArgs({
    kind: "fresh",
    sessionDir: "/tmp/sess",
    systemPrompt: "SYS",
    prompt: "PROMPT",
    steerable: false,
  });
  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--session-dir",
    "/tmp/sess",
    "--append-system-prompt",
    "SYS",
    "PROMPT",
  ]);
});

test('buildPiArgs(resume, steerable=true): emits ["--mode", "rpc", ...] without "-p" and without trailing prompt positional', () => {
  const args = buildPiArgs({
    kind: "resume",
    sessionPath: "/tmp/sess/abc.jsonl",
    prompt: "another question",
    steerable: true,
  });
  assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
  assert.equal(args.includes("-p"), false);
  const s = args.indexOf("--session");
  assert.ok(s > 0);
  assert.equal(args[s + 1], "/tmp/sess/abc.jsonl");
  // Prompt is NOT a positional in RPC mode (slice 3 sends via stdin).
  assert.equal(args.includes("another question"), false);
});

test("buildPiArgs(resume, steerable=false): emits today's resume argv EXACTLY (regression pin)", () => {
  const args = buildPiArgs({
    kind: "resume",
    sessionPath: "/tmp/sess/abc.jsonl",
    prompt: "another question",
    steerable: false,
  });
  assert.deepEqual(args, [
    "--mode",
    "json",
    "-p",
    "--session",
    "/tmp/sess/abc.jsonl",
    "another question",
  ]);
});
