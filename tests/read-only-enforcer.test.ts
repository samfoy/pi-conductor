/**
 * Read-only persona enforcer tests (item 13 fix candidate #1).
 *
 * Pins the auto-prepended scope-enforcer block that ships at the top of
 * a read-only persona's `--append-system-prompt` content. Closes the
 * silent-scope-drift class documented in `docs/backlog.md` item 13
 * (critic-z8v9 witness, 2026-05-28).
 *
 * W1 mutation witness (parallel-formula rule per `docs/wdd.md`):
 *   The killing test imports `assemblePersonaSystemPrompt` from
 *   `src/runs.ts` and asserts the prepend-or-passthrough formula
 *   directly. Mutating the production helper to drop the prepend
 *   reds `assemblePersonaSystemPrompt: read-only persona prompt
 *   begins with the enforcer block`.
 *
 * W3 string-pin (character-precise pin):
 *   The enforcer text is character-pinned. Mutating one character of
 *   the production constant `READ_ONLY_PERSONA_ENFORCER` reds
 *   `READ_ONLY_PERSONA_ENFORCER: enforcer text is character-pinned`.
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assemblePersonaSystemPrompt,
  READ_ONLY_PERSONA_ENFORCER,
} from "../src/runs.ts";
import type { Persona } from "../src/types.ts";

function makePersona(overrides: Partial<Persona> & { name: string }): Persona {
  return {
    description: "test",
    inheritContext: "filtered",
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 30,
    systemPrompt: "PERSONA_BODY_SENTINEL",
    source: "builtin",
    sourcePath: "/tmp/test.md",
    readOnly: false,
    ...overrides,
  };
}

// ── W3 string-pin ─────────────────────────────────────────────────────

test("READ_ONLY_PERSONA_ENFORCER: enforcer text is character-pinned (W3 string witness)", () => {
  // Character-precise pin. Mutating one character of the production
  // constant in src/runs.ts reds this assertion. This is what catches
  // accidental drift in the user-visible enforcer wording across
  // future slices.
  assert.equal(
    READ_ONLY_PERSONA_ENFORCER,
    [
      "[READ-ONLY PERSONA ENFORCER]",
      "You are a read-only persona. You MAY: read files, run tests",
      "(orientation), git inspection, run mutations IN-PLACE for",
      "verification (followed by IMMEDIATE restoration via git checkout).",
      "You MUST NOT: edit, write, or otherwise mutate any tracked file",
      "beyond mutation-test-and-restore cycles. You MUST NOT: run",
      "git commit, git add, git push, git merge, git rebase, git tag, or",
      "any operation that changes the repository's tracked state. If your",
      "review concludes you have advice for the parent conductor, RETURN",
      "that advice in your output — do not act on it. Acting beyond your",
      "review scope is the failure mode documented in docs/backlog.md",
      "item 13.",
      "[END READ-ONLY PERSONA ENFORCER]",
    ].join("\n"),
  );
});

// ── Prepend behavior + W1 mutation witness ────────────────────────────

test("assemblePersonaSystemPrompt: read-only persona prompt begins with the enforcer block (W1 witness)", () => {
  // W1 — pins the production formula directly:
  //   readOnly === true  → enforcer + "\n\n" + persona.systemPrompt
  //   readOnly === false → persona.systemPrompt
  // Mutating the helper to drop the prepend (e.g. always return
  // `persona.systemPrompt`) reds this assertion for the read-only
  // branch; mutating to always-prepend reds the write-capable test
  // below.
  const persona = makePersona({ name: "critic", readOnly: true });
  const out = assemblePersonaSystemPrompt(persona);
  assert.ok(
    out.startsWith(READ_ONLY_PERSONA_ENFORCER),
    "read-only persona system prompt must start with READ_ONLY_PERSONA_ENFORCER",
  );
  assert.equal(out, `${READ_ONLY_PERSONA_ENFORCER}\n\n${persona.systemPrompt}`);
});

test("assemblePersonaSystemPrompt: write-capable persona prompt does NOT contain the enforcer block", () => {
  const persona = makePersona({ name: "builder", readOnly: false });
  const out = assemblePersonaSystemPrompt(persona);
  assert.ok(
    !out.includes("[READ-ONLY PERSONA ENFORCER]"),
    "write-capable persona prompt must not contain the enforcer header",
  );
  assert.equal(out, persona.systemPrompt);
});

test("assemblePersonaSystemPrompt: undefined readOnly is treated as false (defensive default)", () => {
  // Defensive — if a Persona object reaches this helper without a
  // readOnly field set (e.g. legacy fixture), it must NOT silently
  // be treated as read-only.
  const persona = {
    ...makePersona({ name: "legacy" }),
    readOnly: undefined as unknown as boolean,
  };
  const out = assemblePersonaSystemPrompt(persona);
  assert.equal(out, persona.systemPrompt);
});

// ── Audit-style coverage across all 16 shipped personas ───────────────

test("assemblePersonaSystemPrompt: all 10 read-only personas get the enforcer prepended; all 6 write-capable do not", () => {
  // Couples to the read_only audit table in tests/personas.test.ts.
  // If the audit table ever drifts from the actual persona files,
  // tests/personas.test.ts catches it; this test couples the prompt-
  // assembly behaviour to the audited shape via a lightweight
  // synthetic persona per row.
  const audit: Record<string, boolean> = {
    analyst: true,
    clarifier: true,
    critic: true,
    finalizer: true,
    inspector: true,
    investigator: true,
    oracle: true,
    profiler: true,
    redteam: true,
    verifier: true,
    builder: false,
    cartographer: false,
    designer: false,
    planner: false,
    scribe: false,
    simplifier: false,
  };
  for (const [name, readOnly] of Object.entries(audit)) {
    const persona = makePersona({ name, readOnly });
    const out = assemblePersonaSystemPrompt(persona);
    if (readOnly) {
      assert.ok(
        out.startsWith(READ_ONLY_PERSONA_ENFORCER),
        `read-only persona '${name}' must begin with the enforcer block`,
      );
    } else {
      assert.ok(
        !out.includes("[READ-ONLY PERSONA ENFORCER]"),
        `write-capable persona '${name}' must NOT contain the enforcer block`,
      );
    }
  }
});
