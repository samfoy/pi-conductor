/**
 * Slice 4 scaffold — 4-layer cascade collapse for `steerable`.
 *
 * SLICE 1 STATUS: SCAFFOLD ONLY. The 8 cases below are skipped via
 * `node:test` `{ skip: true }`. Slice 4 is where `ensemble_spawn`'s
 * per-call `steerable` arg lands and stamps `run.steerable` from the
 * merged cascade (per-call > project > user > built-in default false).
 * Once the cascade-feeding helper is in place, slice 4 removes the
 * `skip: true` flags and these cases verify real behaviour.
 *
 * Counted in slice 4's test-count delta (+8), NOT slice 1's. The plan
 * (`docs/v0.12-steering-plan.md` slice 1 trajectory) flags this
 * explicitly so cumulative trajectory math doesn't double-count.
 *
 * Why the scaffold lives in slice 1 instead of being deferred to
 * slice 4: pinning the helper signature + cascade-collapse semantics
 * here gives slice 4 a green target — the tests fail compilation /
 * fail-fast until the production helper matches the contract this
 * file declares.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

// ── Stub helper (slice 4 will replace this with the real import) ─────
//
// Slice 4 will export `collapseSteerableCascade(...)` from a
// production module (current candidate: `src/steerable.ts` alongside
// the resolver, or `src/runs.ts`'s spawn-pipeline section). The shape
// pinned here matches design §4.1 lines 342–346: cascade per-call >
// project > user > default, with the result stamped onto
// `run.steerable` at spawn time. Returning `boolean | undefined`
// mirrors the spawn-pipeline plumbing — `undefined` survives only when
// every layer is unset and the resolver-time default would later fill
// it.
type SteerableCascadeInputs = {
  perCall: boolean | undefined;
  project: boolean | undefined;
  user: boolean | undefined;
  defaultValue: boolean;
};

function collapseSteerableCascade(_inputs: SteerableCascadeInputs): boolean {
  // STUB. Slice 4 replaces with the real production helper.
  throw new Error("collapseSteerableCascade: not yet wired — slice 4");
}

// All cases skipped until slice 4 wires the real helper.
const PENDING = { skip: "pending slice 4 wiring (steerable spawn-time cascade)" } as const;

test("steerable cascade: per-call true wins over all lower layers", PENDING, () => {
  assert.equal(
    collapseSteerableCascade({ perCall: true, project: false, user: false, defaultValue: false }),
    true,
  );
});

test("steerable cascade: per-call false wins over all lower layers", PENDING, () => {
  assert.equal(
    collapseSteerableCascade({ perCall: false, project: true, user: true, defaultValue: true }),
    false,
  );
});

test("steerable cascade: project shadows user when per-call unset", PENDING, () => {
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: true, user: false, defaultValue: false }),
    true,
  );
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: false, user: true, defaultValue: true }),
    false,
  );
});

test("steerable cascade: user wins when per-call + project unset", PENDING, () => {
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: undefined, user: true, defaultValue: false }),
    true,
  );
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: undefined, user: false, defaultValue: true }),
    false,
  );
});

test("steerable cascade: built-in default fires only when all layers unset", PENDING, () => {
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: undefined, user: undefined, defaultValue: false }),
    false,
  );
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: undefined, user: undefined, defaultValue: true }),
    true,
  );
});

test("steerable cascade: explicit false at any layer short-circuits below it", PENDING, () => {
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

test("steerable cascade: built-in default is false (mirrors v0.10 kill_on_stall default-OFF)", PENDING, () => {
  // Default-OFF posture per PRD.md:517 — no autonomous-chain field
  // data justifies flipping the built-in default. This is the same
  // posture as `defaultKillOnStall: false`.
  assert.equal(
    collapseSteerableCascade({ perCall: undefined, project: undefined, user: undefined, defaultValue: false }),
    false,
  );
});

test("steerable cascade: result is a boolean (no undefined leak)", PENDING, () => {
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
