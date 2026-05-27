/**
 * Tests for `resolveSteerable` — the v0.12 cascade resolver that mirrors
 * `src/watchdog.ts:287` `resolveKillOnStall` shape exactly (oracle gate
 * 2 ADJUST: signature isomorphism so a future PRD entry can upgrade
 * both cascades together).
 *
 * The 4-layer cascade (per-call > project > user > built-in default
 * false) is collapsed UPSTREAM at spawn time onto `run.steerable`
 * before this resolver ever sees the inputs. The resolver itself is a
 * one-line `run.steerable ?? defaultSteerable`. Slice 4 wires the
 * upstream collapse; this slice (1) only ships the resolver.
 *
 * W1 mutation witness: parallel-formula rule per `docs/wdd.md`. The
 * killing test imports `resolveSteerable` from `src/steerable.ts` and
 * pins the truth-table directly; mutating the production formula to
 * `run.steerable ?? !defaultSteerable` reds the killing test.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveSteerable } from "../src/steerable.ts";
import { emptyUsage, type Run } from "../src/types.ts";

function runFx(overrides: Partial<Run> = {}): Run {
  return {
    id: "tester-aaaa",
    persona: "tester",
    task: "test",
    mode: "background",
    status: "running",
    startTime: 0,
    lastEventAt: 0,
    messages: [],
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: "/tmp/r.json",
    transcriptPath: "/tmp/t.jsonl",
    finalPath: "/tmp/f.md",
    ...overrides,
  };
}

test("resolveSteerable: returns true when run.steerable=true (any default)", () => {
  // Explicit true on the run wins regardless of the default.
  assert.equal(resolveSteerable(runFx({ steerable: true }), false), true);
  assert.equal(resolveSteerable(runFx({ steerable: true }), true), true);
});

test("resolveSteerable: returns false when run.steerable=false (any default)", () => {
  // Explicit false on the run wins regardless of the default.
  assert.equal(resolveSteerable(runFx({ steerable: false }), false), false);
  assert.equal(resolveSteerable(runFx({ steerable: false }), true), false);
});

test("resolveSteerable: falls back to defaultSteerable when run.steerable=undefined", () => {
  // `undefined` (the "no upstream cascade input set this value" sentinel)
  // is the only case where the default takes over.
  assert.equal(resolveSteerable(runFx({ steerable: undefined }), false), false);
  assert.equal(resolveSteerable(runFx({ steerable: undefined }), true), true);
});

test(
  'resolveSteerable: W1 — mutating the resolver to "run.steerable ?? !defaultSteerable" fails an assertion that pins the truth-table',
  () => {
    // LOAD-BEARING — parallel-formula witness pin per `docs/wdd.md`.
    //
    // Importing the production helper directly (not re-deriving the
    // cascade inline) is what gives this test teeth. If the resolver
    // body is mutated from `return run.steerable ?? defaultSteerable`
    // to `return run.steerable ?? !defaultSteerable`, the two
    // `undefined`-fallthrough rows below flip and at least one
    // assertion fails. The two explicit-value rows stay pinned to
    // ensure the mutation can't sneak through by inverting the entire
    // truth-table.
    //
    // Sister witness: src/watchdog.ts:287 `resolveKillOnStall` is
    // pinned by tests/watchdog-enforcer.test.ts:474 with the same
    // shape; the two cascades MUST stay isomorphic.
    assert.equal(
      resolveSteerable(runFx({ steerable: true }), false),
      true,
      "explicit true wins over default false",
    );
    assert.equal(
      resolveSteerable(runFx({ steerable: undefined }), false),
      false,
      "undefined falls through to default false",
    );
    assert.equal(
      resolveSteerable(runFx({ steerable: undefined }), true),
      true,
      "undefined falls through to default true",
    );
    assert.equal(
      resolveSteerable(runFx({ steerable: false }), true),
      false,
      "explicit false wins over default true",
    );
  },
);
