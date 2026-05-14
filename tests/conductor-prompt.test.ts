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
