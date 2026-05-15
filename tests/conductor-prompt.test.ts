/**
 * Tests for buildConductorSystemPrompt.
 *
 * Coverage gaps closed by this file:
 *   - Empty roster falls through to the "(no personas resolved …)" guidance line
 *   - Each persona name appears as a bullet with its description
 *   - maxConcurrent value is interpolated into the queueing rule
 *   - Foreground-auto-downgrade rule is present (it's the central conductor invariant)
 *   - Ensemble tool names (ensemble_spawn/list/status) are documented
 *   - Sub-agent completion XML envelope is described (<sub-agent-completed>)
 *
 * The prompt is a long markdown string; we assert on stable substrings rather
 * than on full equality so wording can evolve without breaking these tests.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { buildConductorSystemPrompt } from "../src/conductor-prompt.ts";
import type { Persona } from "../src/types.ts";

function makePersona(name: string, description: string): Persona {
  return {
    name,
    description,
    inheritContext: "filtered",
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 30,
    systemPrompt: `you are ${name}`,
    source: "builtin",
    sourcePath: `/tmp/${name}.md`,
  };
}

test("buildConductorSystemPrompt: empty roster shows doctor hint", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /no personas resolved.*\/conductor doctor/);
});

test("buildConductorSystemPrompt: empty roster does NOT include any persona bullet", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // The roster section uses lines like "- `oracle` —". With an empty roster
  // there should be zero such bullets.
  const bulletPattern = /^- `\w+` — /gm;
  const matches = out.match(bulletPattern) ?? [];
  assert.equal(matches.length, 0);
});

test("buildConductorSystemPrompt: lists each persona with its description", () => {
  const personas = [
    makePersona("oracle", "second opinion reviewer"),
    makePersona("redteam", "adversarial review"),
    makePersona("builder", "implementation specialist"),
  ];
  const out = buildConductorSystemPrompt({ personas, maxConcurrent: 4 });
  for (const p of personas) {
    assert.match(out, new RegExp(`- \`${p.name}\` — ${p.description}`));
  }
});

test("buildConductorSystemPrompt: persona descriptions appear in roster order", () => {
  const personas = [
    makePersona("alpha", "first"),
    makePersona("bravo", "second"),
    makePersona("charlie", "third"),
  ];
  const out = buildConductorSystemPrompt({ personas, maxConcurrent: 2 });
  const idxA = out.indexOf("`alpha`");
  const idxB = out.indexOf("`bravo`");
  const idxC = out.indexOf("`charlie`");
  assert.ok(idxA >= 0 && idxB > idxA && idxC > idxB, "personas listed in roster order");
});

test("buildConductorSystemPrompt: maxConcurrent value is interpolated", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 7 });
  assert.match(out, /at most 7 concurrent sub-agents/);
});

test("buildConductorSystemPrompt: maxConcurrent=1 still renders cleanly", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 1 });
  assert.match(out, /at most 1 concurrent sub-agents/);
});

test("buildConductorSystemPrompt: explains foreground auto-downgrade rule", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // Critical invariant: conductor should NOT retry when a foreground spawn is queued.
  assert.match(out, /Foreground spawns auto-downgrade to background/i);
  assert.match(out, /Do not spawn again/i);
});

test("buildConductorSystemPrompt: documents the three ensemble tools", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /`ensemble_spawn`/);
  assert.match(out, /`ensemble_list`/);
  assert.match(out, /`ensemble_status`/);
});

test("buildConductorSystemPrompt: documents ensemble_send / pause / resume", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /`ensemble_send`/);
  assert.match(out, /`ensemble_pause`/);
  assert.match(out, /`ensemble_resume`/);
});

test("buildConductorSystemPrompt: warns the LLM that ensemble_send bypasses the concurrency cap", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /bypass(es)? the (concurrency )?cap/i);
});

test("buildConductorSystemPrompt: describes sub-agent completion XML envelope", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /<sub-agent-completed>/);
  assert.match(out, /<status>completed\|failed\|killed\|timeout<\/status>/);
});

test("buildConductorSystemPrompt: tells the conductor not to address the persona directly", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /Never thank the sub-agent/i);
});

test("buildConductorSystemPrompt: explains inherit_context and the parent-snapshot semantics", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // The LLM needs to understand that personas with inherit_context: filtered
  // (the shipped default) carry a slice of the conductor's conversation —
  // so it doesn't redundantly restate context the sub-agent already has.
  assert.match(out, /inherit_context/i);
  assert.match(out, /filtered/i);
});

test("buildConductorSystemPrompt: warns about stale parent snapshots in batched spawns", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // When the LLM batches several ensemble_spawn calls in a single turn,
  // every queued sub-agent freezes its parent-context snapshot at enqueue
  // time — they all see identical parent context (the state before any
  // sibling sub-agent ran). The prompt should make this explicit so the
  // LLM doesn't expect later siblings to see earlier siblings' work.
  assert.match(out, /(snapshot|enqueue)/i);
});

// ── §10: delegation triggers ──────────────────────────────────────

test("buildConductorSystemPrompt: §10 — includes a 'when to reach for conductor' triggers section", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // Stable substring: the explicit §10 heading. Wording can evolve;
  // the heading shouldn't.
  assert.match(out, /When to reach for conductor/i);
});

test("buildConductorSystemPrompt: §10 — names the high-leverage delegation cases", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // The triggers we want the LLM to actually internalize:
  //   1. parallel review / multiple perspectives
  //   2. user-asked-for review or pre-mortem
  //   3. about-to-commit sanity check via oracle
  //   4. fresh mental model from many files
  //   5. multi-phase work (research → design → plan → build → verify)
  //   6. parent context heavy / noisy turn
  //   7. task-name-to-persona mapping
  assert.match(out, /parallel|multiple (independent )?perspectives/i);
  assert.match(out, /review|pre-mortem|second opinion|sanity check/i);
  assert.match(out, /commit|sanity check.*oracle|oracle.*before/i);
  assert.match(out, /fresh.*context|fresh.*mental model|specialist/i);
  assert.match(out, /phase(s)?|chain/i);
});

test("buildConductorSystemPrompt: §10 — also names when NOT to delegate", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // Don't-delegate triggers are equally important so the LLM doesn't
  // spawn-spam every turn. Look for the inverse heading or guidance.
  assert.match(out, /Don't delegate|do not delegate|skip delegation/i);
});

test("buildConductorSystemPrompt: §10 — includes the per-turn 'ask yourself' nudge", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // The biggest behavior changer in practice: a per-turn-start prompt
  // that forces the LLM to consider conductor before going solo.
  assert.match(out, /(ask yourself|at (the )?start of (every|each) (non-trivial )?(user )?turn|before any non-trivial)/i);
});
