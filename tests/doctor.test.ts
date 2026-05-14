/**
 * Tests for buildDoctorReport — the pure report-building function used by
 * /conductor doctor. Tests behavior, not the notify pipe.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDoctorReport } from "../src/doctor.ts";
import { RunRegistry } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { userConfigPath } from "../src/config.ts";

interface Fx {
  root: string;
  homeDir: string;
  projectDir: string;
  realHome: string | undefined;
}

function setup(): Fx {
  const root = mkdtempSync(join(tmpdir(), "conductor-doctor-test-"));
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

test("buildDoctorReport: includes the personas section with builtin count", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
    });
    assert.match(out, /## Personas/);
    assert.match(out, /builtin=16/); // we ship 16 personas
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: shows malformed user config under 'Config errors'", async () => {
  const fx = setup();
  try {
    writeFileSync(userConfigPath(), "{ this is not, json }");
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
    });
    assert.match(out, /## Config errors/);
    assert.match(out, /config\.json/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: hides the 'Config errors' section when there are none", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
    });
    assert.doesNotMatch(out, /## Config errors/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: shows conductorMode status", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const off = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
    });
    assert.match(off, /conductorMode:\s+off/);
    const on = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: true,
    });
    assert.match(on, /conductorMode:\s+ON/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: shows runtime active/queued counts", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
    });
    assert.match(out, /## Runtime/);
    assert.match(out, /active:\s+0/);
    assert.match(out, /queued:\s+0/);
  } finally {
    teardown(fx);
  }
});
