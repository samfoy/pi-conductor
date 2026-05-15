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
  // v0.7 used "When to reach for conductor"; v0.8 uses "Delegation playbook".
  // Either heading satisfies the LLM contract — the section exists.
  assert.match(out, /When to reach for conductor|Delegation playbook/i);
});

test("buildConductorSystemPrompt: §10 — names the high-leverage delegation cases", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // Triggers we want the LLM to internalize:
  //   - parallel reviews / multiple perspectives ("fan out")
  //   - reviews / pre-mortems / sanity checks
  //   - oracle as a synchronous review gate
  //   - phased / chained work
  assert.match(out, /parallel|fan(-| )?out|multiple (independent )?perspectives/i);
  assert.match(out, /review|pre-mortem|second opinion|sanity check/i);
  assert.match(out, /oracle/i);
  assert.match(out, /chain|phase(s)?/i);
});

test("buildConductorSystemPrompt: §10 — also names when NOT to delegate (or the slip antipattern)", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // v0.7 phrased this as "Don't delegate when:". v0.8 reframes it as
  // "the slip antipattern". Either headline counts — the warning that
  // a "quick read" turns into a long one is the durable signal.
  assert.match(out, /Don't delegate|do not delegate|skip delegation|slip antipattern/i);
});

test("buildConductorSystemPrompt: §10 — includes the per-turn 'ask yourself' nudge", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // Per-turn-start prompt that forces the LLM to consider conductor
  // before going solo. v0.8 phrasing: "What persona owns this verb?".
  assert.match(
    out,
    /(ask yourself|at (the )?start of (every|each) (non-trivial )?(user )?turn|before any non-trivial|persona owns this verb)/i,
  );
});

// ── §1 / §1.5: strict-overseer language (v0.8) ────────────────────

test("buildConductorSystemPrompt: §1 — declares the conductor a strict overseer / manager", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /strict overseer|manager/i);
});

test("buildConductorSystemPrompt: §1 — explicitly says the conductor is not the implementer", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /You are not the implementer/i);
});

test("buildConductorSystemPrompt: §1.5 — bans `edit` via MUST NOT", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // The banned-tools list is the load-bearing piece; the test asserts
  // the strongest words appear together (MUST NOT + edit) so a softening
  // edit ("prefer not to use edit") would be caught.
  assert.match(out, /MUST NOT[\s\S]{0,200}\bedit\b/);
});

test("buildConductorSystemPrompt: §1.5 — bans `write` via MUST NOT", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /MUST NOT[\s\S]{0,200}\bwrite\b/);
});

test("buildConductorSystemPrompt: §1.5 — bans `lsp_code_actions` (LSP-quick-fix slip)", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // The LSP-quick-fix path is a frequent slip-in-disguise: it edits
  // code while pretending to be a 'view'. Explicit ban required.
  assert.match(out, /lsp_code_actions/);
});

test("buildConductorSystemPrompt: §1.5 — publishes a slip-detection check", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /slip/i);
});

test("buildConductorSystemPrompt: §1.5 — enumerates orientation as the narrow exception", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // The 'You MAY' block names orientation reads (meta-docs, ls/git
  // status, ~3 file reads). Either the word 'orientation' or the
  // file-count cap is the durable signal.
  assert.match(out, /orientation|3 (source )?file/i);
});

test("buildConductorSystemPrompt: §1.5 — names code-mutating tools as the principle for the ban", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // The principle paragraph distinguishes producing-code from
  // producing-facts. Either side of the dichotomy must appear.
  assert.match(out, /(produce|mutate)[\s\S]{0,80}(code|facts)/i);
});

// ── §10: delegation playbook (v0.8) ────────────────────────────────

test("buildConductorSystemPrompt: §10 — reframed as 'Delegation playbook'", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /Delegation playbook/i);
});

test("buildConductorSystemPrompt: §10 — pattern→persona trigger table covers the canonical verbs", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // §10's trigger table maps user-prose verbs to personas. We assert
  // every canonical verb's owner shows up in a backtick-wrapped name
  // (the table's stable form).
  for (const persona of [
    "investigator",
    "inspector",
    "designer",
    "planner",
    "builder",
    "oracle",
    "profiler",
    "clarifier",
  ]) {
    assert.match(out, new RegExp(`\`${persona}\``));
  }
});

test("buildConductorSystemPrompt: §10 — names the slip antipattern explicitly", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /slip antipattern/i);
});

test("buildConductorSystemPrompt: §10 — closer triggers (finalizer/verifier) are in the trigger table (F1)", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // F1 added rows 9 (finalizer) and 10 (verifier) to the §10 trigger
  // table during the oracle-revision pass. Row 9 frames finalizer as
  // the mandatory closer for greenfield/refactor/perf chains; row 10
  // frames verifier as the closer for bug-fix chains. The 8-persona
  // backtick-presence test above doesn't catch a regression where the
  // row prose is dropped — finalizer appears ONLY in §10, and verifier
  // appears in §1's reviewer list independently. Pin the row prose so
  // a future rewrite that silently regresses the closer rows fails here.
  assert.match(out, /finalizer[\s\S]{0,80}Mandatory closer/i);
  assert.match(out, /verifier[\s\S]{0,80}Closer for bug-fix/i);
});

// ── §9: chain shapes (v0.8 additions) ──────────────────────────────

test("buildConductorSystemPrompt: §9 — lists clarifier as the disambiguation chain", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /Ambiguous request[\s\S]{0,80}clarifier/i);
});

test("buildConductorSystemPrompt: §9 — lists inspector as the fact-finding chain", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /Fact-finding[\s\S]{0,80}inspector/i);
});
