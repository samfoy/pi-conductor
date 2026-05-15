/**
 * Tests for resolveInitialConductorMode — the pure helper that decides
 * whether conductor mode is on at extension load.
 *
 * Default behavior: ON. Conductor is the whole point of this extension;
 * users who load it almost always want it active. The PI_CONDUCTOR_MODE
 * env var is preserved as an explicit override for both directions —
 * "0" / "false" / "off" disables the addendum without unloading the
 * extension; "1" / "true" / "on" is redundant under the new default but
 * still honored. Per-session toggling stays via /conductor on | off.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveInitialConductorMode } from "../src/conductor-mode.ts";

test("resolveInitialConductorMode: ON by default when the env var is unset", () => {
  assert.equal(resolveInitialConductorMode({}), true);
});

test("resolveInitialConductorMode: ON by default when the env var is empty", () => {
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "" }), true);
});

test("resolveInitialConductorMode: explicit 1 / true / on / yes keep it ON", () => {
  for (const v of ["1", "true", "TRUE", "on", "ON", "yes", "YES"]) {
    assert.equal(
      resolveInitialConductorMode({ PI_CONDUCTOR_MODE: v }),
      true,
      `value "${v}" should keep conductor mode ON`,
    );
  }
});

test("resolveInitialConductorMode: explicit 0 / false / off / no turns it OFF", () => {
  for (const v of ["0", "false", "FALSE", "off", "OFF", "no", "NO"]) {
    assert.equal(
      resolveInitialConductorMode({ PI_CONDUCTOR_MODE: v }),
      false,
      `value "${v}" should turn conductor mode OFF`,
    );
  }
});

test("resolveInitialConductorMode: unrecognized values fall back to the default (ON)", () => {
  // Garbage in env var shouldn't silently disable a feature that's on by
  // default. Only the explicit OFF tokens flip the bit.
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "maybe" }), true);
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "2" }), true);
});

test("resolveInitialConductorMode: surrounding whitespace is tolerated", () => {
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: "  off  " }), false);
  assert.equal(resolveInitialConductorMode({ PI_CONDUCTOR_MODE: " 1 " }), true);
});
