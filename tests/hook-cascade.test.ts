/**
 * Tests for the v0.11 on_complete_hook cascade resolver — pure
 * `resolveOnCompleteHook`. Slice 1b: resolver lands cold, no callers.
 * Slice 2 wires it.
 *
 * Cascade precedence (highest wins, first non-undefined non-empty stops):
 *   1. per-call               (ensemble_spawn arg)
 *   2. project config         (project personaOverrides)
 *   3. user config            (user personaOverrides)
 *   4. persona frontmatter    (persona.onCompleteHook)
 *   5. built-in default       (none — returns `undefined`)
 *
 * Empty string at any layer is the explicit-disable sentinel: it
 * short-circuits the cascade and returns `undefined`. Undefined means
 * "fall through to next layer".
 *
 * Tests are WDD parallel-formula compliant: every assertion calls
 * `resolveOnCompleteHook` directly with crafted fixtures. No test
 * re-derives the precedence inline.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveOnCompleteHook,
  DEFAULT_HOOK_TIMEOUT_SECONDS,
  type HookCascadeInput,
} from "../src/hook-cascade.ts";

// ── Layer fixtures ────────────────────────────────────────────────────
// Each layer carries a distinct command + timeout so the resolved
// `source` can be verified unambiguously by inspecting the command.

const PER_CALL = { command: "per-call-cmd", timeoutSeconds: 11 } as const;
const PROJECT = { command: "project-cmd", timeoutSeconds: 22 } as const;
const USER = { command: "user-cmd", timeoutSeconds: 33 } as const;
const PERSONA = { command: "persona-cmd", timeoutSeconds: 44 } as const;

// ── Witness 1: per-call wins over all ─────────────────────────────────

test("resolveOnCompleteHook: per-call wins over project, user, persona", () => {
  const input: HookCascadeInput = {
    perCall: PER_CALL,
    project: PROJECT,
    user: USER,
    persona: PERSONA,
  };
  const resolved = resolveOnCompleteHook(input);
  assert.ok(resolved, "expected a resolved hook");
  assert.equal(resolved.command, "per-call-cmd");
  assert.equal(resolved.timeoutSeconds, 11);
  assert.equal(resolved.source, "per-call");
});

// ── Witness 2: project wins over user / persona / default ─────────────

test("resolveOnCompleteHook: project wins over user and persona", () => {
  const input: HookCascadeInput = {
    project: PROJECT,
    user: USER,
    persona: PERSONA,
  };
  const resolved = resolveOnCompleteHook(input);
  assert.ok(resolved);
  assert.equal(resolved.command, "project-cmd");
  assert.equal(resolved.timeoutSeconds, 22);
  assert.equal(resolved.source, "project");
});

// ── Witness 3: user wins over persona / default ───────────────────────

test("resolveOnCompleteHook: user wins over persona", () => {
  const input: HookCascadeInput = { user: USER, persona: PERSONA };
  const resolved = resolveOnCompleteHook(input);
  assert.ok(resolved);
  assert.equal(resolved.command, "user-cmd");
  assert.equal(resolved.timeoutSeconds, 33);
  assert.equal(resolved.source, "user");
});

// ── Witness 4: persona-frontmatter wins over default ──────────────────

test("resolveOnCompleteHook: persona frontmatter when no override", () => {
  const input: HookCascadeInput = { persona: PERSONA };
  const resolved = resolveOnCompleteHook(input);
  assert.ok(resolved);
  assert.equal(resolved.command, "persona-cmd");
  assert.equal(resolved.timeoutSeconds, 44);
  assert.equal(resolved.source, "persona");
});

// ── Witness 5: no layers set → undefined (NOT a default ResolvedHook) ─

test("resolveOnCompleteHook: returns undefined when all layers absent", () => {
  const input: HookCascadeInput = {};
  const resolved = resolveOnCompleteHook(input);
  assert.equal(resolved, undefined);
});

// ── Witness 6: empty-string-as-explicit-disable ───────────────────────

test("resolveOnCompleteHook: empty string at per-call layer disables (returns undefined)", () => {
  const input: HookCascadeInput = {
    perCall: { command: "" },
    project: PROJECT,
    user: USER,
    persona: PERSONA,
  };
  const resolved = resolveOnCompleteHook(input);
  assert.equal(
    resolved,
    undefined,
    "empty-string per-call must short-circuit the cascade",
  );
});

// ── Empty-string-disable at every other layer (R7 regression) ─────────

test("resolveOnCompleteHook: empty string at project layer disables", () => {
  const input: HookCascadeInput = {
    project: { command: "" },
    user: USER,
    persona: PERSONA,
  };
  assert.equal(resolveOnCompleteHook(input), undefined);
});

test("resolveOnCompleteHook: empty string at user layer disables", () => {
  const input: HookCascadeInput = {
    user: { command: "" },
    persona: PERSONA,
  };
  assert.equal(resolveOnCompleteHook(input), undefined);
});

test("resolveOnCompleteHook: empty string at persona-frontmatter layer disables", () => {
  const input: HookCascadeInput = { persona: { command: "" } };
  assert.equal(resolveOnCompleteHook(input), undefined);
});

// ── Timeout resolution ────────────────────────────────────────────────

test("resolveOnCompleteHook: timeout resolved from same layer as command", () => {
  // Project provides command WITHOUT timeout; user provides timeout.
  // Resolved timeout must NOT pull from user — falls back to default.
  const input: HookCascadeInput = {
    project: { command: "project-cmd" },
    user: { command: "user-cmd", timeoutSeconds: 999 },
    persona: PERSONA,
  };
  const resolved = resolveOnCompleteHook(input);
  assert.ok(resolved);
  assert.equal(resolved.command, "project-cmd");
  assert.equal(resolved.source, "project");
  assert.equal(
    resolved.timeoutSeconds,
    DEFAULT_HOOK_TIMEOUT_SECONDS,
    "timeout must fall back to default, not pull from user layer",
  );
});

test("resolveOnCompleteHook: timeout falls back to default 300 when unset", () => {
  const input: HookCascadeInput = { perCall: { command: "cmd-only" } };
  const resolved = resolveOnCompleteHook(input);
  assert.ok(resolved);
  assert.equal(resolved.timeoutSeconds, DEFAULT_HOOK_TIMEOUT_SECONDS);
  assert.equal(DEFAULT_HOOK_TIMEOUT_SECONDS, 300);
});
