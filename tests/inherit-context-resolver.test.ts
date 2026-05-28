/**
 * Item 12 candidate #3 — `resolveInheritContext` cascade resolver.
 *
 * Mirrors the v0.10 `resolveKillOnStall` (`src/watchdog.ts:287`) +
 * v0.12 `resolveSteerable` (`src/steerable.ts`) shape exactly. The
 * resolver itself is a one-liner — `perCall ?? persona.inheritContext`
 * — but because the persona layer is already merged upstream by
 * `resolvePersonas` (collapsing project + user `personaOverrides[name]
 * .inheritContext` onto persona frontmatter at `src/personas.ts:369`),
 * this cascade has effectively two layers at the resolver's seam:
 *   1. perCall                   — `ensemble_spawn` LLM tool arg
 *   2. persona.inheritContext    — frontmatter ∪ project/user override
 *
 * Cascade-shape isomorphism with the v0.10 / v0.12 cascades is
 * intentional (oracle gate 2 ADJUST, PRD.md:517) so a future PRD entry
 * can upgrade all three resolvers together.
 *
 * W1 mutation witness: parallel-formula rule per `docs/wdd.md`. The
 * killing test imports `resolveInheritContext` from
 * `src/inherit-context.ts` and pins the truth-table directly; mutating
 * the production formula reds the killing test.
 *
 * See `docs/backlog.md` item 12 for the witnessed builder-4gsl
 * parent-identity-bleed failure mode this candidate defends against.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveInheritContext } from "../src/inherit-context.ts";
import type { ContextInheritance, Persona } from "../src/types.ts";

function persona(inheritContext: ContextInheritance): Persona {
  return {
    name: "tester",
    description: "test persona",
    inheritContext,
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 30,
    systemPrompt: "you are a tester",
    source: "builtin",
    sourcePath: "/tmp/tester.md",
    readOnly: false,
  };
}

// ── Truth table ───────────────────────────────────────────────────────

test("resolveInheritContext: per-call wins over persona frontmatter (none over filtered)", () => {
  // The high-value case for item 12 candidate #3: spawn a sub-agent
  // whose persona normally inherits filtered, but a per-call `none`
  // arg breaks the filtered-context bleed for this one spawn.
  assert.equal(resolveInheritContext("none", persona("filtered")), "none");
});

test("resolveInheritContext: per-call wins over persona frontmatter (filtered_compact over filtered)", () => {
  // The other expected use: a persona normally on filtered gets
  // filtered_compact for one spawn to strip prose blocks.
  assert.equal(
    resolveInheritContext("filtered_compact", persona("filtered")),
    "filtered_compact",
  );
});

test("resolveInheritContext: per-call wins over persona frontmatter (full over none)", () => {
  // Symmetric coverage — going UP the inheritance ladder must also
  // work, not just down. A user can pass `full` to override an
  // intentionally-restrictive persona.
  assert.equal(resolveInheritContext("full", persona("none")), "full");
});

test("resolveInheritContext: undefined per-call falls back to persona frontmatter (filtered)", () => {
  assert.equal(resolveInheritContext(undefined, persona("filtered")), "filtered");
});

test("resolveInheritContext: undefined per-call falls back to persona frontmatter (none)", () => {
  assert.equal(resolveInheritContext(undefined, persona("none")), "none");
});

test("resolveInheritContext: undefined per-call falls back to persona frontmatter (filtered_compact)", () => {
  assert.equal(
    resolveInheritContext(undefined, persona("filtered_compact")),
    "filtered_compact",
  );
});

test("resolveInheritContext: undefined per-call falls back to persona frontmatter (full)", () => {
  assert.equal(resolveInheritContext(undefined, persona("full")), "full");
});

// ── W1 mutation witness ───────────────────────────────────────────────

test(
  'resolveInheritContext: W1 — parallel-formula witness pins "perCall ?? persona.inheritContext"',
  () => {
    // LOAD-BEARING — parallel-formula witness pin per `docs/wdd.md`.
    //
    // Importing the production helper directly (not re-deriving the
    // cascade inline) is what gives this test teeth. If the resolver
    // body is mutated:
    //   - "perCall ?? persona.inheritContext" → "persona.inheritContext"
    //     (drop the override) → row 1 fails (per-call should win).
    //   - "perCall ?? persona.inheritContext" → "perCall"
    //     (always-perCall, no fallback) → row 2 fails (undefined
    //     should fall through to persona, not become undefined).
    //   - "perCall ?? persona.inheritContext" → "perCall ?? 'none'"
    //     (default-to-none instead of persona) → row 3 fails (the
    //     persona's `filtered` value is what should fill the
    //     undefined slot, not a hard-coded `none`).
    //
    // Sister witnesses: `tests/steerable.test.ts:resolveSteerable W1`
    // and `tests/watchdog-enforcer.test.ts: resolveKillOnStall W1`.
    // The three cascades MUST stay isomorphic — this witness keeps
    // the `??`-fallback shape pinned across the family.
    assert.equal(
      resolveInheritContext("none", persona("filtered")),
      "none",
      "row 1: per-call must win over persona (mutating to drop override reds this)",
    );
    assert.equal(
      resolveInheritContext(undefined, persona("filtered")),
      "filtered",
      "row 2: undefined must fall back to persona (mutating to always-perCall reds this)",
    );
    assert.equal(
      resolveInheritContext(undefined, persona("full")),
      "full",
      "row 3: undefined must fall back to PERSONA's value, not a hard-coded fallback (mutating to default-to-X reds this)",
    );
    assert.equal(
      resolveInheritContext("filtered", persona("none")),
      "filtered",
      "row 4: explicit per-call over persona, in the opposite direction from row 1",
    );
  },
);
