/**
 * Tests for loadConfig.
 *
 * Coverage gaps closed by this file:
 *   - Defaults applied when no user/project config exists
 *   - Partial user config merges over defaults (only specified fields change)
 *   - Project config overrides user config field-by-field
 *   - Malformed JSON falls back silently to defaults (no throw)
 *   - personaOverrides are merged shallowly across layers
 *   - Unknown top-level fields are ignored
 *   - Bad-typed values in user config are rejected (defaults retained)
 *   - Out-of-range values in user config are rejected (defaults retained)
 *
 * Each test uses an isolated tmp HOME + tmp project dir and cleans up in finally.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, userConfigPath, projectConfigPath } from "../src/config.ts";
import { DEFAULT_CONFIG } from "../src/types.ts";

interface Fx {
  root: string;
  homeDir: string;
  projectDir: string;
  realHome: string | undefined;
}

function setup(): Fx {
  const root = mkdtempSync(join(tmpdir(), "conductor-cfg-"));
  const homeDir = join(root, "home");
  const projectDir = join(root, "proj");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = homeDir;
  return { root, homeDir, projectDir, realHome };
}

function teardown(fx: Fx): void {
  if (fx.realHome !== undefined) process.env.HOME = fx.realHome;
  else delete process.env.HOME;
  rmSync(fx.root, { recursive: true, force: true });
}

function writeUserConfig(_fx: Fx, body: string): void {
  const p = userConfigPath();
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

function writeProjectConfig(fx: Fx, body: string): void {
  const p = projectConfigPath(fx.projectDir);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
}

test("loadConfig: returns defaults when no user or project config exists", () => {
  const fx = setup();
  try {
    const cfg = loadConfig(fx.projectDir);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: partial user config merges over defaults", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ maxConcurrent: 8 }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrent, 8);
    // Other fields keep defaults
    assert.equal(cfg.defaultTimeoutMinutes, DEFAULT_CONFIG.defaultTimeoutMinutes);
    assert.equal(cfg.queueOnConcurrencyCap, DEFAULT_CONFIG.queueOnConcurrencyCap);
    assert.equal(cfg.defaultSpawnMode, DEFAULT_CONFIG.defaultSpawnMode);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: project config overrides user config field-by-field", () => {
  const fx = setup();
  try {
    writeUserConfig(
      fx,
      JSON.stringify({ maxConcurrent: 8, defaultSpawnMode: "background" }),
    );
    writeProjectConfig(fx, JSON.stringify({ maxConcurrent: 2 }));
    const cfg = loadConfig(fx.projectDir);
    // Project overrides this one
    assert.equal(cfg.maxConcurrent, 2);
    // User-only field still applies
    assert.equal(cfg.defaultSpawnMode, "background");
  } finally {
    teardown(fx);
  }
});

test("loadConfig: malformed user config JSON falls back to defaults silently", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, "{not valid json");
    const cfg = loadConfig(fx.projectDir);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: malformed project JSON falls back, user config still applies", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ maxConcurrent: 6 }));
    writeProjectConfig(fx, "<<< broken");
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrent, 6);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: personaOverrides merge across user and project layers (field-level)", () => {
  const fx = setup();
  try {
    writeUserConfig(
      fx,
      JSON.stringify({
        personaOverrides: {
          oracle: { model: "anthropic/claude-opus-4-1", thinking: "high" },
          redteam: { disabled: true },
        },
      }),
    );
    writeProjectConfig(
      fx,
      JSON.stringify({
        personaOverrides: {
          oracle: { thinking: "medium" }, // project overrides one field on the user's oracle entry
          builder: { timeoutMinutes: 60 }, // new entry
        },
      }),
    );
    const cfg = loadConfig(fx.projectDir);
    // Field-level merge: project's `thinking: medium` overrides user's `thinking: high`,
    // but user's `model` survives because project didn't touch it.
    assert.deepEqual(cfg.personaOverrides.oracle, {
      model: "anthropic/claude-opus-4-1",
      thinking: "medium",
    });
    // User-only entry survives unchanged.
    assert.deepEqual(cfg.personaOverrides.redteam, { disabled: true });
    // Project-only entry present.
    assert.deepEqual(cfg.personaOverrides.builder, { timeoutMinutes: 60 });
  } finally {
    teardown(fx);
  }
});

test("loadConfig: project can clear a user-set field by setting it to undefined-equivalent", () => {
  // Sanity: setting a field to a falsy value at the project layer overrides
  // the user's value. (We don't introduce a special 'clear' sentinel.)
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ personaOverrides: { oracle: { disabled: true } } }));
    writeProjectConfig(fx, JSON.stringify({ personaOverrides: { oracle: { disabled: false } } }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.personaOverrides.oracle.disabled, false);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: unknown top-level fields are ignored", () => {
  const fx = setup();
  try {
    writeUserConfig(
      fx,
      JSON.stringify({ maxConcurrent: 5, hypothetical: "ignored", another: 42 }),
    );
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrent, 5);
    assert.equal((cfg as unknown as Record<string, unknown>).hypothetical, undefined);
    assert.equal((cfg as unknown as Record<string, unknown>).another, undefined);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: rejects wrong-typed values and keeps defaults", () => {
  const fx = setup();
  try {
    writeUserConfig(
      fx,
      JSON.stringify({
        maxConcurrent: "five", // wrong type
        queueOnConcurrencyCap: "yes", // wrong type
        defaultSpawnMode: "asynchronous", // not in enum
      }),
    );
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrent, DEFAULT_CONFIG.maxConcurrent);
    assert.equal(cfg.queueOnConcurrencyCap, DEFAULT_CONFIG.queueOnConcurrencyCap);
    assert.equal(cfg.defaultSpawnMode, DEFAULT_CONFIG.defaultSpawnMode);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: rejects out-of-range values (zero/negative)", () => {
  const fx = setup();
  try {
    writeUserConfig(
      fx,
      JSON.stringify({
        maxConcurrent: 0,
        defaultTimeoutMinutes: -5,
      }),
    );
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrent, DEFAULT_CONFIG.maxConcurrent);
    assert.equal(cfg.defaultTimeoutMinutes, DEFAULT_CONFIG.defaultTimeoutMinutes);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: floors fractional maxConcurrent to integer", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ maxConcurrent: 4.9 }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrent, 4);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: empty JSON object yields defaults unchanged", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, "{}");
    writeProjectConfig(fx, "{}");
    const cfg = loadConfig(fx.projectDir);
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: accepts conductorPromptPath string override", () => {
  const fx = setup();
  try {
    writeProjectConfig(
      fx,
      JSON.stringify({ conductorPromptPath: "/custom/prompt.md" }),
    );
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.conductorPromptPath, "/custom/prompt.md");
  } finally {
    teardown(fx);
  }
});

// ── defaultMode (v0.8) ────────────────────────────────────────────

test("loadConfig: DEFAULT_CONFIG includes defaultMode 'off'", () => {
  // The new field has a deterministic default (OFF) so consumers can rely
  // on it without optional-chaining the resolved config.
  assert.equal(DEFAULT_CONFIG.defaultMode, "off");
});

test("loadConfig: defaults include defaultMode 'off' when no config files exist", () => {
  const fx = setup();
  try {
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.defaultMode, "off");
  } finally {
    teardown(fx);
  }
});

test("loadConfig: user config defaultMode 'on' is preserved", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ defaultMode: "on" }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.defaultMode, "on");
  } finally {
    teardown(fx);
  }
});

test("loadConfig: user config defaultMode 'off' is preserved", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ defaultMode: "off" }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.defaultMode, "off");
  } finally {
    teardown(fx);
  }
});

test("loadConfig: project config defaultMode beats user config defaultMode", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ defaultMode: "on" }));
    writeProjectConfig(fx, JSON.stringify({ defaultMode: "off" }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.defaultMode, "off");
  } finally {
    teardown(fx);
  }
});

test("loadConfig: malformed defaultMode (unknown string) silently falls back to default", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ defaultMode: "maybe" }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.defaultMode, "off");
  } finally {
    teardown(fx);
  }
});

test("loadConfig: malformed defaultMode (wrong type) silently falls back to default", () => {
  const fx = setup();
  try {
    writeUserConfig(
      fx,
      JSON.stringify({ defaultMode: 1, otherTouched: 2 }), // number, not string
    );
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.defaultMode, "off");
  } finally {
    teardown(fx);
  }
});

test("loadConfig: malformed defaultMode (array) silently falls back to default", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ defaultMode: ["on"] }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.defaultMode, "off");
  } finally {
    teardown(fx);
  }
});

// ── v0.9 Item 2(c): maxConcurrentWriteCapable ───────────────────

test("loadConfig: maxConcurrentWriteCapable defaults to 1 when unset", () => {
  const fx = setup();
  try {
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrentWriteCapable, 1);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: maxConcurrentWriteCapable user override is respected", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ maxConcurrentWriteCapable: 3 }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrentWriteCapable, 3);
    // Doesn't disturb the general cap.
    assert.equal(cfg.maxConcurrent, DEFAULT_CONFIG.maxConcurrent);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: maxConcurrentWriteCapable < 1 silently falls back to default", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ maxConcurrentWriteCapable: 0 }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrentWriteCapable, 1);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: maxConcurrentWriteCapable wrong type falls back to default", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ maxConcurrentWriteCapable: "two" }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrentWriteCapable, 1);
  } finally {
    teardown(fx);
  }
});

// ────────────────────────────────────────────────────────────────────
// v0.9 — gc config block (Slice 1)
// ────────────────────────────────────────────────────────────────────

test("loadConfig: defaults populate gc block with conservative thresholds", () => {
  const fx = setup();
  try {
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.gc.enabled, true);
    assert.equal(cfg.gc.completedTtlDays, 30);
    assert.equal(cfg.gc.failedTtlDays, 60);
    assert.equal(cfg.gc.totalSizeBudgetBytes, 5 * 1024 * 1024 * 1024);
    assert.equal(cfg.gc.transcriptSizeCapBytes, 100 * 1024 * 1024);
    assert.equal(cfg.gc.orphanReconcileAfterHours, 24);
    assert.equal(cfg.gc.autoOnSessionStart, true);
    assert.equal(cfg.gc.autoDebounceHours, 6);
    assert.deepEqual(cfg.gc.perPersonaTtlDays, {});
  } finally {
    teardown(fx);
  }
});

test("loadConfig: partial gc overrides merge field-level over defaults", () => {
  const fx = setup();
  try {
    writeUserConfig(
      fx,
      JSON.stringify({ gc: { completedTtlDays: 7, transcriptSizeCapBytes: 1024 } }),
    );
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.gc.completedTtlDays, 7);
    assert.equal(cfg.gc.transcriptSizeCapBytes, 1024);
    assert.equal(cfg.gc.failedTtlDays, 60);
    assert.equal(cfg.gc.enabled, true);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: gc rejects negative / wrong-typed values, keeps defaults", () => {
  const fx = setup();
  try {
    writeUserConfig(
      fx,
      JSON.stringify({
        gc: {
          completedTtlDays: -5,
          totalSizeBudgetBytes: "wrong",
          autoOnSessionStart: "yes",
          enabled: 1,
          orphanReconcileAfterHours: 0,
        },
      }),
    );
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.gc.completedTtlDays, 30);
    assert.equal(cfg.gc.totalSizeBudgetBytes, 5 * 1024 * 1024 * 1024);
    assert.equal(cfg.gc.autoOnSessionStart, true);
    assert.equal(cfg.gc.enabled, true);
    assert.equal(cfg.gc.orphanReconcileAfterHours, 24);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: project gc block layers over user gc block", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ gc: { completedTtlDays: 7 } }));
    writeProjectConfig(fx, JSON.stringify({ gc: { completedTtlDays: 14, failedTtlDays: 90 } }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.gc.completedTtlDays, 14);
    assert.equal(cfg.gc.failedTtlDays, 90);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: gc.perPersonaTtlDays accepts positive numbers per persona", () => {
  const fx = setup();
  try {
    writeUserConfig(
      fx,
      JSON.stringify({
        gc: { perPersonaTtlDays: { designer: 14, planner: 21, bogus: -3, alsoBogus: "x" } },
      }),
    );
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.gc.perPersonaTtlDays["designer"], 14);
    assert.equal(cfg.gc.perPersonaTtlDays["planner"], 21);
    assert.equal(cfg.gc.perPersonaTtlDays["bogus"], undefined);
    assert.equal(cfg.gc.perPersonaTtlDays["alsoBogus"], undefined);
  } finally {
    teardown(fx);
  }
});

test("loadConfig: gc.enabled=false is honored as an explicit opt-out", () => {
  const fx = setup();
  try {
    writeUserConfig(fx, JSON.stringify({ gc: { enabled: false, autoOnSessionStart: false } }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.gc.enabled, false);
    assert.equal(cfg.gc.autoOnSessionStart, false);
  } finally {
    teardown(fx);
  }
});
