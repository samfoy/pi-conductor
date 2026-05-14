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
