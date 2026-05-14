/**
 * Tests for loadConfig's malformed-file reporting.
 *
 * Replaces the prior silent-fallback behavior: loadConfig now returns the
 * resolved ConductorConfig PLUS a list of file-load errors, so callers
 * (specifically /conductor doctor) can surface "your config file didn't
 * parse" without crashing the session.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  loadConfigWithErrors,
  projectConfigPath,
  userConfigPath,
} from "../src/config.ts";

interface Fx {
  root: string;
  homeDir: string;
  projectDir: string;
  realHome: string | undefined;
}

function setup(): Fx {
  const root = mkdtempSync(join(tmpdir(), "conductor-cfg-errors-"));
  const homeDir = join(root, "home");
  const projectDir = join(root, "proj");
  mkdirSync(join(homeDir, ".pi", "agent", "extensions", "conductor"), { recursive: true });
  mkdirSync(join(projectDir, ".pi"), { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = homeDir;
  return { root, homeDir, projectDir, realHome };
}

function teardown(fx: Fx): void {
  if (fx.realHome !== undefined) process.env.HOME = fx.realHome;
  else delete process.env.HOME;
  try {
    rmSync(fx.root, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function writeUser(fx: Fx, content: string): void {
  writeFileSync(userConfigPath(), content);
}

function writeProject(fx: Fx, content: string): void {
  writeFileSync(projectConfigPath(fx.projectDir), content);
}

test("loadConfigWithErrors: returns empty errors when no config files exist", () => {
  const fx = setup();
  try {
    const r = loadConfigWithErrors(fx.projectDir);
    assert.deepEqual(r.errors, []);
    assert.equal(r.config.maxConcurrent, 4); // default
  } finally {
    teardown(fx);
  }
});

test("loadConfigWithErrors: returns empty errors when files are valid", () => {
  const fx = setup();
  try {
    writeUser(fx, JSON.stringify({ maxConcurrent: 6 }));
    writeProject(fx, JSON.stringify({ maxConcurrent: 8 }));
    const r = loadConfigWithErrors(fx.projectDir);
    assert.deepEqual(r.errors, []);
    assert.equal(r.config.maxConcurrent, 8);
  } finally {
    teardown(fx);
  }
});

test("loadConfigWithErrors: malformed user config file is reported, defaults still apply", () => {
  const fx = setup();
  try {
    writeUser(fx, "{ this is not, json::: }");
    const r = loadConfigWithErrors(fx.projectDir);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]!.path, userConfigPath());
    assert.match(r.errors[0]!.reason, /JSON|Unexpected|Expected/i);
    // Defaults still apply.
    assert.equal(r.config.maxConcurrent, 4);
  } finally {
    teardown(fx);
  }
});

test("loadConfigWithErrors: malformed project config is reported separately from user", () => {
  const fx = setup();
  try {
    writeUser(fx, JSON.stringify({ maxConcurrent: 6 }));
    writeProject(fx, "garbage }{");
    const r = loadConfigWithErrors(fx.projectDir);
    assert.equal(r.errors.length, 1);
    assert.equal(r.errors[0]!.path, projectConfigPath(fx.projectDir));
    // User config still applied.
    assert.equal(r.config.maxConcurrent, 6);
  } finally {
    teardown(fx);
  }
});

test("loadConfigWithErrors: both malformed reports both, defaults apply", () => {
  const fx = setup();
  try {
    writeUser(fx, "garbage 1");
    writeProject(fx, "garbage 2");
    const r = loadConfigWithErrors(fx.projectDir);
    assert.equal(r.errors.length, 2);
    const paths = r.errors.map((e: { path: string }) => e.path).sort();
    assert.deepEqual(paths, [projectConfigPath(fx.projectDir), userConfigPath()].sort());
    assert.equal(r.config.maxConcurrent, 4); // both fell back to defaults
  } finally {
    teardown(fx);
  }
});

test("loadConfig (legacy wrapper) preserves the silent-fallback contract", () => {
  // Existing call sites use loadConfig() with no errors-return. That should
  // still work — it just discards the errors[] array.
  const fx = setup();
  try {
    writeUser(fx, "garbage }{");
    writeProject(fx, JSON.stringify({ maxConcurrent: 3 }));
    const cfg = loadConfig(fx.projectDir);
    assert.equal(cfg.maxConcurrent, 3); // project still applied
    // No throw. Legacy contract preserved.
  } finally {
    teardown(fx);
  }
});
