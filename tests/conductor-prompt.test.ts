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
    readOnly: false,
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

// ── §11: canonical workflows (v0.8 Slice 2) ───────────────────────

test("buildConductorSystemPrompt: §11 — heading 'Default workflows' is present", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /Default workflows/i);
});

test("buildConductorSystemPrompt: §11 — loop semantics names ensemble_send as the iteration tool", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // ensemble_send already appears in §3 — pin its presence in the loop
  // semantics paragraph specifically (anywhere after the §11 heading).
  const idx11 = out.indexOf("## 11.");
  assert.ok(idx11 >= 0, "§11 heading should exist");
  assert.match(out.slice(idx11), /ensemble_send/);
});

test("buildConductorSystemPrompt: §11 — loop bound (≤3 iterations) is published", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /loop ≤3|max 3 iterations|cap.*3 iterations|3 iterations/i);
});

test("buildConductorSystemPrompt: §11 — finalizer appears in the canonical chain shapes", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // 'finalizer' was added to §10 in Slice 1 (closer trigger row). §11
  // adds it to the chain blocks. Scope the assertion to §11 so it
  // gates the new content, not Slice 1's row.
  const idx11 = out.indexOf("## 11.");
  assert.ok(idx11 >= 0, "§11 heading should exist");
  assert.match(out.slice(idx11), /finalizer/);
});

test("buildConductorSystemPrompt: §11 — plan-loop pairs planner with oracle/critic", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  const idx11 = out.indexOf("## 11.");
  assert.ok(idx11 >= 0, "§11 heading should exist");
  assert.match(
    out.slice(idx11),
    /oracle.*planner|planner.*oracle|planner ⇄ oracle|planner ⇄ critic_or_oracle/i,
  );
});

test("buildConductorSystemPrompt: §11 — build-loop pairs builder with critic", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  const idx11 = out.indexOf("## 11.");
  assert.ok(idx11 >= 0, "§11 heading should exist");
  assert.match(out.slice(idx11), /builder.*critic|critic.*builder|builder ⇄ critic/i);
});

test("buildConductorSystemPrompt: §11 — reviewer-veto rule is published", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /Reviewer veto|reviewer.*veto|reviewer.*trumps/i);
});

test("buildConductorSystemPrompt: §11 — the overseer-doesn't-review rule is published", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(
    out,
    /You do not review|overseer (does not|doesn't) review|does not review/i,
  );
});

test("buildConductorSystemPrompt: §11 — 'Breaking the chain' exceptions block exists", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /Breaking the chain|break the chain/i);
});

test("buildConductorSystemPrompt: §11 — 'No parallel write-capable spawns' rule is present", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // NEW-1 from design §7.5.4: parallel write-capable builders share git
  // history and tree state, so the conductor must not parallelize them.
  assert.match(out, /No parallel write-capable spawns/i);
});

// ── §9 cross-reference to §11 (v0.8 Slice 2) ──────────────────────

test("buildConductorSystemPrompt: §9 — cross-reference to §11 lands at the end of the section", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // Slice 1 already added "see §11" to §10's closer-trigger rows. The
  // §9 cross-ref must land in §9 specifically — scope between the §9
  // heading and the §10 heading so we gate the new content, not Slice 1.
  const idx9 = out.indexOf("## 9.");
  const idx10 = out.indexOf("## 10.");
  assert.ok(idx9 >= 0 && idx10 > idx9, "§9 and §10 should both exist in order");
  assert.match(out.slice(idx9, idx10), /see §11/i);
});

// ── §6 disambiguation: new spawns vs loop revisions (v0.8 Slice 2) ─

test("buildConductorSystemPrompt: §6 — disambiguation sentence distinguishes new spawns from loop revisions", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // F5 disambiguation: §6's "synthesize their findings yourself" is for
  // *new* persona spawns; §11's loop semantics use ensemble_send for
  // revisions to the *same* producer. The disambiguation sentence in §6
  // names both halves so the apparent contradiction is explicitly
  // resolved. Pin both halves' substrings near each other inside §6.
  const idx6 = out.indexOf("## 6.");
  const idx7 = out.indexOf("## 7.");
  assert.ok(idx6 >= 0 && idx7 > idx6, "§6 and §7 should both exist in order");
  const section6 = out.slice(idx6, idx7);
  assert.match(section6, /spawning a new persona/i);
  assert.match(section6, /ensemble_send/);
  assert.match(section6, /see §11/i);
});

// ── §11 — load-bearing prose pins (Slice 2 critic revise) ─────────

test("buildConductorSystemPrompt: §11 — top-of-section cross-references the §1.5 principle by name", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  const idx11 = out.indexOf("## 11.");
  const idx12 = out.length; // §11 is last section
  // NEW-2: §11 must explicitly reference §1.5 so the cross-ref binding
  // doesn't silently disappear in a future "tighten the prose" rewrite.
  assert.match(out.slice(idx11, idx12), /§1\.5/);
});

test("buildConductorSystemPrompt: §11 — publishes 'oracle is the opener' and 'finalizer is the closer'", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  const idx11 = out.indexOf("## 11.");
  // These two structural sentences are load-bearing — they make
  // oracle's primacy and finalizer's terminality prescriptive, not
  // optional. Pin both so a future rewrite that collapses §11 to
  // chain-shape-only is caught.
  assert.match(out.slice(idx11), /Oracle is the opener|oracle.*opener/i);
  assert.match(out.slice(idx11), /finalizer.*closer|closer.*finalizer/i);
});

test("buildConductorSystemPrompt: §11 — 'Breaking the chain' covers F6's skill-driven and user-fan-out exceptions", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  const idx11 = out.indexOf("## 11.");
  // F6 from the oracle-revision round added these two exceptions.
  // They are distinctive content and should be regression-protected
  // so a future "trim the list" rewrite doesn't silently drop them.
  assert.match(out.slice(idx11), /[Ss]kill-driven workflow/);
  assert.match(out.slice(idx11), /User explicitly directs|user-directed.*fan-?out|parallel fan-?out/i);
  // Closure prose is load-bearing per design §7.5.3 — pin it too.
  assert.match(out.slice(idx11), /not a valid reason/i);
});

test("buildConductorSystemPrompt: §11 — verifier briefs must be self-contained (Q#16 inherit_context: none follow-up)", () => {
  // v0.8.1 Q#16 audit flipped `verifier` from inherit_context: filtered to
  // inherit_context: none. Post-flip, a verifier brief like "verify the
  // previous slice" is unrunnable — verifier boots with no parent
  // transcript, so the conductor must spell out the claim, the files
  // changed, the existing check, and acceptance criteria explicitly.
  // §11 is where verifier shows up in the canonical chains, so the rule
  // lives there. See docs/backlog.md "§11 verifier-brief sub-rule".
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  const idx11 = out.indexOf("## 11.");
  assert.ok(idx11 >= 0, "§11 heading must exist");
  const section = out.slice(idx11);

  // Anchor: the rule must mention verifier and inherit_context together.
  assert.match(section, /verifier/i);
  assert.match(section, /inherit_context/);

  // Anchor: the rule must use "self-contained" or "claim" (or both)
  // — these are the load-bearing concepts. Leave editorial wording free.
  assert.match(section, /self-contained|claim/i);

  // Locality: the verifier-brief rule should be co-located with
  // inherit_context — i.e. they should appear within the same paragraph-ish
  // window, not separated by hundreds of lines. 600 chars is generous
  // (a paragraph or two) and rules out accidental matches across sections.
  const verifierIdx = section.search(/verifier briefs?/i);
  const inheritIdx = section.indexOf("inherit_context");
  assert.ok(verifierIdx >= 0, "§11 must reference 'verifier brief(s)' explicitly");
  assert.ok(inheritIdx >= 0, "§11 must reference inherit_context");
  assert.ok(
    Math.abs(verifierIdx - inheritIdx) < 600,
    `verifier-brief rule must be co-located with inherit_context (got ${Math.abs(verifierIdx - inheritIdx)} chars apart)`,
  );
});

// ── §1.5 / §11: tiny-direct-action exception (v0.10.x) ─────────────

test("buildConductorSystemPrompt: §1.5 — tiny direct actions sub-block landed", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /Tiny direct actions \(explicit-opt-in only\)/);
  assert.match(out, /Tiny direct action:/);
  assert.match(out, /Commit-message-only amends/);
  assert.match(out, /At most one tiny direct action per turn/);
  assert.match(
    out,
    /without requiring you to read additional files to compute the change/,
  );
});

test("buildConductorSystemPrompt: §1.5 — tiny-action anti-list present", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /[Nn]ot tiny, even if they feel tiny/);
});

test("buildConductorSystemPrompt: §1.5 — forensic git plumbing demoted to orientation", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /git reflog/);
  const idx = out.search(/git reflog/);
  const window = out.slice(Math.max(0, idx - 200), idx + 200);
  assert.match(window, /orientation/i);
});

test("buildConductorSystemPrompt: §11 — Tiny dictated fix bullet still names the categorized exception", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  assert.match(out, /Tiny dictated fix/);
  const idx11 = out.indexOf("## 11.");
  assert.match(out.slice(idx11), /§1\.5/);
});

test("buildConductorSystemPrompt: §1 — forward references the §1.5 tiny-action exception", () => {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  // §1 must signal the exception's existence so a future reader doesn't treat
  // 'You are not the implementer' as flatly absolute.
  const beforeS15 = out.slice(0, out.indexOf("## 1.5"));
  assert.match(beforeS15, /§1\.5/);
  assert.match(beforeS15, /tiny.action/i);
});

// ── v0.12 closure: §10 steering addendum pins ──────────────────────────────
//
// Slice 7 of v0.12 wires `streaming_behavior` (on `ensemble_send`) and
// per-spawn `steerable: true` (on `ensemble_spawn`) into the conductor
// system prompt's §10 delegation playbook. Without this addendum the
// LLM defaults to print-mode usage and never opts into steering.

function section10(): string {
  const out = buildConductorSystemPrompt({ personas: [], maxConcurrent: 4 });
  const idx10 = out.indexOf("## 10.");
  assert.ok(idx10 >= 0, "§10 heading must exist");
  const idx11 = out.indexOf("## 11.", idx10);
  assert.ok(idx11 > idx10, "§11 heading must follow §10");
  return out.slice(idx10, idx11);
}

test("buildConductorSystemPrompt: §10 — names streaming_behavior verbatim (v0.12 steering addendum)", () => {
  // The arg name is the LLM's only way to discover the steering surface.
  // Pinning the verbatim spelling guards against well-meaning prose
  // refactors that paraphrase "streaming behavior" or "steering mode".
  assert.match(section10(), /streaming_behavior/);
});

test("buildConductorSystemPrompt: §10 — names the steer / follow_up / resume verbs verbatim", () => {
  // The plan locks these as the four behaviors (auto + 3 explicit). The
  // LLM must see the explicit verbs to invoke them; "auto" is the
  // default and need not be pinned.
  const s = section10();
  assert.match(s, /\bsteer\b/);
  assert.match(s, /follow_up/);
  assert.match(s, /\bresume\b/);
});

test("buildConductorSystemPrompt: §10 — names steerable: true per-spawn opt-in verbatim", () => {
  // The default is OFF (mirrors v0.10 kill_on_stall Q1). The LLM must
  // see the per-spawn arg name to opt in. Pinning the verbatim spelling
  // guards against "steerable=true" or "steerable mode" drift.
  assert.match(section10(), /steerable: true/);
});

test("buildConductorSystemPrompt: §10 — ensemble_spawn and ensemble_send still named in the addendum (no regression)", () => {
  // The two tools that gain new v0.12 args. The addendum must reference
  // them by name so the LLM connects steerable: true to ensemble_spawn
  // and streaming_behavior to ensemble_send.
  const s = section10();
  assert.match(s, /ensemble_spawn/);
  assert.match(s, /ensemble_send/);
});
