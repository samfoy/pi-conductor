/**
 * Slice 4 — 4-layer cascade collapse for `steerable`.
 *
 * SLICE 4 STATUS: WIRED. The 8 cases below assert against the real
 * production helper `collapseSteerableCascade` from `src/steerable.ts`.
 * Slice 1 shipped this file as a SCAFFOLD (skipped) so this slice's
 * upgrade is purely (a) replace the stub import with the production
 * import and (b) drop the `{ skip: true }` flag from each case.
 *
 * The cascade is consumed at `ensemble_spawn` time (`src/tools.ts`):
 * per-call > project > user > built-in default `false`. The collapsed
 * boolean is stamped onto `Run.steerable` before the spawn pipeline
 * runs.
 *
 * No persona-frontmatter layer. Mirrors v0.10 `kill_on_stall`'s
 * deferred shape exactly (oracle fix #1; PRD.md:517).
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { collapseSteerableCascade } from "../src/steerable.ts";

test("steerable cascade: per-call true wins over all lower layers", () => {
  assert.equal(
    collapseSteerableCascade({ perCall: true, project: false, user: false, defaultValue: false }),
    true,
  );
});

test("steerable cascade: per-call false wins over all lower layers", () => {
  assert.equal(
    collapseSteerableCascade({ perCall: false, project: true, user: true, defaultValue: true }),
    false,
  );
});

test("steerable cascade: project shadows user when per-call unset", () => {
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: true, user: false, defaultValue: false }),
    true,
  );
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: false, user: true, defaultValue: true }),
    false,
  );
});

test("steerable cascade: user wins when per-call + project unset", () => {
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: undefined, user: true, defaultValue: false }),
    true,
  );
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: undefined, user: false, defaultValue: true }),
    false,
  );
});

test("steerable cascade: built-in default fires only when all layers unset", () => {
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: undefined, user: undefined, defaultValue: false }),
    false,
  );
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: undefined, user: undefined, defaultValue: true }),
    true,
  );
});

test("steerable cascade: explicit false at any layer short-circuits below it", () => {
  // per-call false short-circuits even when lower layers are true.
  assert.equal(
    collapseSteerableCascade({ perCall: false, project: undefined, user: undefined, defaultValue: true }),
    false,
  );
  // project false short-circuits user/default when per-call is unset.
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: false, user: true, defaultValue: true }),
    false,
  );
});

test("steerable cascade: built-in default is false (mirrors v0.10 kill_on_stall default-OFF)", () => {
  // Default-OFF posture per PRD.md:517 — no autonomous-chain field
  // data justifies flipping the built-in default. This is the same
  // posture as `defaultKillOnStall: false`.
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: undefined, user: undefined, defaultValue: false }),
    false,
  );
});

test("steerable cascade: result is a boolean (no undefined leak)", () => {
  // The helper MUST collapse to a definite boolean; downstream
  // `Run.steerable` accepts `boolean | undefined` only because the
  // pre-spawn surface area (record.json round-trip, etc.) hasn't been
  // populated yet. Post-collapse it's always a boolean.
  const result = collapseSteerableCascade({
    perCall: undefined,
    project: undefined,
    user: undefined,
    defaultValue: false,
  });
  assert.equal(typeof result, "boolean");
});
