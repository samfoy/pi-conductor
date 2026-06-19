/**
 * Tests for v0.17-S2 — `resolveMaxTurns` and `resolveGraceTurns` pure
 * cascade resolvers. WDD parallel-formula compliant: every assertion calls
 * the resolver directly with crafted fixtures. No test re-derives the
 * precedence inline.
 *
 * Cascade precedence (highest wins, first defined layer stops):
 *   1. per-call   (ensemble_spawn arg)
 *   2. project    (project personaOverrides)
 *   3. user       (user personaOverrides)
 *   4. persona    (persona frontmatter)
 *   5. built-in   (undefined / 5 for grace)
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveMaxTurns,
  resolveGraceTurns,
  DEFAULT_GRACE_TURNS,
  type TurnLimitCascadeInput,
} from "../src/turn-limit.ts";

// ── Layer fixtures ────────────────────────────────────────────────────
// Each layer carries distinct values so the winning layer is unambiguous.

const PER_CALL = { maxTurns: 10, graceTurns: 1 } as const;
const PROJECT = { maxTurns: 20, graceTurns: 2 } as const;
const USER = { maxTurns: 30, graceTurns: 3 } as const;
const PERSONA = { maxTurns: 40, graceTurns: 4 } as const;

// ── W1: per-call wins over all ────────────────────────────────────────

test("resolveMaxTurns: per-call wins over project, user, persona", () => {
  const input: TurnLimitCascadeInput = {
    perCall: PER_CALL,
    project: PROJECT,
    user: USER,
    persona: PERSONA,
  };
  assert.equal(resolveMaxTurns(input), 10);
});

test("resolveGraceTurns: per-call wins over project, user, persona", () => {
  const input: TurnLimitCascadeInput = {
    perCall: PER_CALL,
    project: PROJECT,
    user: USER,
    persona: PERSONA,
  };
  assert.equal(resolveGraceTurns(input), 1);
});

// ── W2: config (project) wins when per-call absent ────────────────────

test("resolveMaxTurns: project wins over user and persona when no per-call", () => {
  const input: TurnLimitCascadeInput = {
    project: PROJECT,
    user: USER,
    persona: PERSONA,
  };
  assert.equal(resolveMaxTurns(input), 20);
});

test("resolveGraceTurns: project wins over user and persona when no per-call", () => {
  const input: TurnLimitCascadeInput = {
    project: PROJECT,
    user: USER,
    persona: PERSONA,
  };
  assert.equal(resolveGraceTurns(input), 2);
});

test("resolveMaxTurns: user wins over persona when no per-call or project", () => {
  const input: TurnLimitCascadeInput = {
    user: USER,
    persona: PERSONA,
  };
  assert.equal(resolveMaxTurns(input), 30);
});

test("resolveGraceTurns: user wins over persona when no per-call or project", () => {
  const input: TurnLimitCascadeInput = {
    user: USER,
    persona: PERSONA,
  };
  assert.equal(resolveGraceTurns(input), 3);
});

// ── W3: persona frontmatter wins when config absent ───────────────────

test("resolveMaxTurns: persona wins when no per-call, project, or user", () => {
  const input: TurnLimitCascadeInput = {
    persona: PERSONA,
  };
  assert.equal(resolveMaxTurns(input), 40);
});

test("resolveGraceTurns: persona wins when no per-call, project, or user", () => {
  const input: TurnLimitCascadeInput = {
    persona: PERSONA,
  };
  assert.equal(resolveGraceTurns(input), 4);
});

// ── W4: undefined returned when no layer defines maxTurns ────────────

test("resolveMaxTurns: returns undefined when no layer defines maxTurns", () => {
  const input: TurnLimitCascadeInput = {};
  assert.equal(resolveMaxTurns(input), undefined);
});

test("resolveMaxTurns: returns undefined when all layers define only graceTurns", () => {
  const input: TurnLimitCascadeInput = {
    perCall: { graceTurns: 2 },
    project: { graceTurns: 3 },
  };
  assert.equal(resolveMaxTurns(input), undefined);
});

// ── W5: resolveGraceTurns defaults to 5 ──────────────────────────────

test("resolveGraceTurns: defaults to 5 when no layer defines graceTurns", () => {
  const input: TurnLimitCascadeInput = {};
  assert.equal(resolveGraceTurns(input), DEFAULT_GRACE_TURNS);
  assert.equal(resolveGraceTurns(input), 5);
});

test("resolveGraceTurns: defaults to 5 when layers only define maxTurns", () => {
  const input: TurnLimitCascadeInput = {
    perCall: { maxTurns: 10 },
    persona: { maxTurns: 20 },
  };
  assert.equal(resolveGraceTurns(input), 5);
});

// ── Extra: graceTurns: 0 is a valid explicit value ────────────────────

test("resolveGraceTurns: 0 from per-call is valid (immediate hard abort)", () => {
  const input: TurnLimitCascadeInput = {
    perCall: { graceTurns: 0 },
    persona: { graceTurns: 5 },
  };
  assert.equal(resolveGraceTurns(input), 0);
});

// ── Extra: partial layer (only maxTurns defined in layer) ─────────────

test("resolveMaxTurns: skips layers that define only graceTurns, finds deeper maxTurns", () => {
  const input: TurnLimitCascadeInput = {
    perCall: { graceTurns: 1 },   // no maxTurns — falls through
    project: { maxTurns: 20 },
  };
  assert.equal(resolveMaxTurns(input), 20);
});

test("resolveGraceTurns: skips layers that define only maxTurns, finds deeper graceTurns", () => {
  const input: TurnLimitCascadeInput = {
    perCall: { maxTurns: 5 },     // no graceTurns — falls through
    project: { graceTurns: 2 },
  };
  assert.equal(resolveGraceTurns(input), 2);
});
