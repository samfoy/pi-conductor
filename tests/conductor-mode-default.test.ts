/**
 * Tests for resolveInitialConductorMode — the pure helper that decides
 * whether conductor mode is on at extension load.
 *
 * v0.8: default flipped to OFF. Conductor mode is now opt-in.
 * Precedence (highest → lowest):
 *   1. config.defaultMode ("on" | "off")  — pinned in
 *      ~/.pi/agent/extensions/conductor/config.json or project config
 *   2. PI_CONDUCTOR_MODE env var          — "1/true/on/yes" → ON,
 *                                            "0/false/off/no" → OFF
 *   3. Built-in default                   — OFF
 *
 * Per-session toggling stays via /conductor on | off (set on the running
 * session, no env-var change required).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveInitialConductorMode } from "../src/conductor-mode.ts";

// ── Built-in default + env-var path (no config) ───────────────────

test("resolveInitialConductorMode: OFF by default when the env var is unset", () => {
  assert.equal(resolveInitialConductorMode({}), false);
});

test("resolveInitialConductorMode: OFF by default when the env var is empty", () => {
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "" }), false);
});

test("resolveInitialConductorMode: explicit 1 / true / on / yes turn it ON via env", () => {
  for (const v of ["1", "true", "TRUE", "on", "ON", "yes", "YES"]) {
    assert.equal(
      resolveInitialConductorMode({ PI_CONDUCTOR_MODE: v }),
      true,
      `value "${v}" should turn conductor mode ON`,
    );
  }
});

test("resolveInitialConductorMode: explicit 0 / false / off / no keep it OFF via env", () => {
  for (const v of ["0", "false", "FALSE", "off", "OFF", "no", "NO"]) {
    assert.equal(
      resolveInitialConductorMode({ PI_CONDUCTOR_MODE: v }),
      false,
      `value "${v}" should keep conductor mode OFF`,
    );
  }
});

test("resolveInitialConductorMode: unrecognized env values fall back to the default (OFF)", () => {
  // Garbage in env shouldn't silently enable a feature that's now opt-in.
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "maybe" }), false);
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "2" }), false);
});

test("resolveInitialConductorMode: surrounding whitespace is tolerated on env values", () => {
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "  on  " }), true);
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: " 1 " }), true);
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "  off  " }), false);
});

// ── Config-override path (v0.8 NEW) ───────────────────────────────

test("resolveInitialConductorMode: config defaultMode 'on' wins over no env var", () => {
  assert.equal(resolveInitialConductorMode({}, { defaultMode: "on" }), true);
});

test("resolveInitialConductorMode: config defaultMode 'off' wins over no env var", () => {
  // Same as built-in default, but the path is exercised explicitly.
  assert.equal(resolveInitialConductorMode({}, { defaultMode: "off" }), false);
});

test("resolveInitialConductorMode: config defaultMode 'on' beats env-var '0' (config > env)", () => {
  assert.equal(
    resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "0" }, { defaultMode: "on" }),
    true,
    "config-pinned 'on' must override an env-var 'off'",
  );
});

test("resolveInitialConductorMode: config defaultMode 'off' beats env-var '1' (config > env)", () => {
  assert.equal(
    resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "1" }, { defaultMode: "off" }),
    false,
    "config-pinned 'off' must override an env-var 'on'",
  );
});

test("resolveInitialConductorMode: malformed config defaultMode falls through to env-var path", () => {
  // An unrecognized config value must not silently flip the bit; it
  // should defer to env-var resolution (which here says ON).
  assert.equal(
    resolveInitialConductorMode(
      { PI_CONDUCTOR_MODE: "1" },
      { defaultMode: "maybe" as unknown as "on" | "off" },
    ),
    true,
  );
});

test("resolveInitialConductorMode: malformed config + no env var defaults to OFF", () => {
  assert.equal(
    resolveInitialConductorMode(
      {},
      { defaultMode: "yes" as unknown as "on" | "off" },
    ),
    false,
  );
});

test("resolveInitialConductorMode: undefined config arg behaves as no-config (env or default)", () => {
  assert.equal(resolveInitialConductorMode({}, undefined), false);
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "1" }, undefined), true);
});

test("resolveInitialConductorMode: empty config object behaves as no-config", () => {
  assert.equal(resolveInitialConductorMode({}, {}), false);
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "on" }, {}), true);
});
