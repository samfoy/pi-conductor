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
import { emptyUsage, type RunRecord, type RunStatus } from "../src/types.ts";

/**
 * Build a minimal run dir layout under <runsRoot>/<id>/ with a record.json,
 * an optional transcript.jsonl of given byte size, and optional .pinned
 * sidecar. Used by Slice 7 doctor tests to exercise the GC surface.
 */
function makeRun(
  runsRoot: string,
  id: string,
  partial: {
    persona?: string;
    status?: RunStatus;
    finishedAt?: number | null;
    transcriptBytes?: number;
    pinned?: boolean;
  } = {},
): void {
  const runDir = join(runsRoot, id);
  mkdirSync(runDir, { recursive: true });
  const rec: RunRecord = {
    id,
    persona: partial.persona ?? "inspector",
    task: "noop",
    mode: "foreground",
    status: partial.status ?? "completed",
    startTime: 1_700_000_000_000,
    finishedAt: partial.finishedAt ?? 1_700_000_010_000,
    usage: emptyUsage(),
    cwd: "/tmp",
    recordPath: join(runDir, "record.json"),
    transcriptPath: join(runDir, "transcript.jsonl"),
    finalPath: join(runDir, "final.md"),
  };
  writeFileSync(rec.recordPath, JSON.stringify(rec));
  const bytes = partial.transcriptBytes ?? 0;
  if (bytes > 0) {
    writeFileSync(rec.transcriptPath, "a".repeat(bytes));
  }
  if (partial.pinned) {
    writeFileSync(join(runDir, ".pinned"), "");
  }
}

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

// v0.10 Slice 3: watchdog defaults surface in /conductor doctor.
test("buildDoctorReport: surfaces watchdog defaults under Resolved config", async () => {
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
    // Threshold + grace numbers come from DEFAULT_CONFIG.watchdog.
    assert.match(out, /watchdog:\s+enabled/);
    assert.match(out, /soft=120s/);
    assert.match(out, /hard=600s/);
    assert.match(out, /grace=30s/);
    // kill_on_stall default-off must be visible so operators know what
    // they're getting without overriding.
    assert.match(out, /watchdog kill_on_stall:\s+off/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: warns on legacy ~/.pi/agent/extensions/conductor/index.js", async () => {
  const fx = setup();
  try {
    // Simulate the v0.8 failure mode: a legacy install symlink (or file)
    // at ~/.pi/agent/extensions/conductor/index.js. The dir already exists
    // (it houses config.json); the smell is the index.{js,ts} entry.
    const legacyEntry = join(
      fx.homeDir,
      ".pi",
      "agent",
      "extensions",
      "conductor",
      "index.js",
    );
    writeFileSync(legacyEntry, "// pretend symlink target\n");

    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
    });
    assert.match(out, /## Legacy install path detected/);
    assert.match(out, /index\.js/);
    assert.match(out, /Recommended fix:/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: also warns on legacy index.ts entry", async () => {
  const fx = setup();
  try {
    const legacyEntry = join(
      fx.homeDir,
      ".pi",
      "agent",
      "extensions",
      "conductor",
      "index.ts",
    );
    writeFileSync(legacyEntry, "// pretend src symlink target\n");

    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
    });
    assert.match(out, /## Legacy install path detected/);
    assert.match(out, /index\.ts/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: omits legacy-install warning when no index entry exists", async () => {
  const fx = setup();
  try {
    // setup() already creates ~/.pi/agent/extensions/conductor/ (for
    // config.json). With NO index.{js,ts} inside, the warning must NOT fire.
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
    });
    assert.doesNotMatch(out, /## Legacy install path detected/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: surfaces maxConcurrentWriteCapable in Resolved config", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
    });
    assert.match(out, /## Resolved config/);
    // Default value is 1, surfaced verbatim.
    assert.match(out, /maxConcurrentWriteCapable:\s*1/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: surfaces gc auto trigger state and last-run timestamp (Slice 5)", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const runsRoot = join(fx.homeDir, ".pi", "agent", "conductor", "runs");
    mkdirSync(runsRoot, { recursive: true });
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
      runsRoot,
    });
    assert.match(out, /gc:\s+enabled/);
    assert.match(out, /gc auto:\s+ON\s+\(debounce=6h\)/);
    assert.match(out, /gc last run:\s+never/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: gc last run shows ISO-ish timestamp once marker exists", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const runsRoot = join(fx.homeDir, ".pi", "agent", "conductor", "runs");
    mkdirSync(runsRoot, { recursive: true });
    const { writeLastGcMtime } = await import("../src/gc/last-gc.ts");
    writeLastGcMtime(runsRoot, 1_750_000_000_000);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
      runsRoot,
    });
    assert.match(out, /gc last run:\s+\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
  } finally {
    teardown(fx);
  }
});

// ── Slice 7: run-record disk usage + GC eviction preview ───────────

test("buildDoctorReport: shows '(no run records)' when runs root is empty (Slice 7)", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const runsRoot = join(fx.homeDir, ".pi", "agent", "conductor", "runs");
    mkdirSync(runsRoot, { recursive: true });
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
      runsRoot,
    });
    assert.match(out, /## Run records/);
    assert.match(out, /\(no run records\)/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: surfaces total runs + bytes when records exist (Slice 7)", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const runsRoot = join(fx.homeDir, ".pi", "agent", "conductor", "runs");
    mkdirSync(runsRoot, { recursive: true });
    makeRun(runsRoot, "inspector-aaaa", { transcriptBytes: 1024 });
    makeRun(runsRoot, "designer-bbbb", { persona: "designer", transcriptBytes: 2048 });
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
      runsRoot,
    });
    assert.match(out, /## Run records/);
    assert.match(out, /total:\s+2 runs/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: surfaces pinned count and bytes (Slice 7)", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const runsRoot = join(fx.homeDir, ".pi", "agent", "conductor", "runs");
    mkdirSync(runsRoot, { recursive: true });
    makeRun(runsRoot, "inspector-aaaa", { transcriptBytes: 1024 });
    makeRun(runsRoot, "designer-bbbb", { transcriptBytes: 2048, pinned: true });
    makeRun(runsRoot, "planner-cccc", { pinned: true });
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
      runsRoot,
    });
    assert.match(out, /pinned:\s+2 runs/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: surfaces orphan count when status=running but not in registry (Slice 7)", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const runsRoot = join(fx.homeDir, ".pi", "agent", "conductor", "runs");
    mkdirSync(runsRoot, { recursive: true });
    makeRun(runsRoot, "inspector-aaaa", {
      status: "running",
      finishedAt: null,
      transcriptBytes: 100,
    });
    makeRun(runsRoot, "designer-bbbb", {
      status: "running",
      finishedAt: null,
      transcriptBytes: 100,
    });
    makeRun(runsRoot, "planner-cccc", { transcriptBytes: 100 });
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
      runsRoot,
      now: 1_800_000_000_000,
    });
    assert.match(out, /orphaned:\s+2 records/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: shows next-eviction preview as archive/delete counts + bytes (Slice 7)", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const runsRoot = join(fx.homeDir, ".pi", "agent", "conductor", "runs");
    mkdirSync(runsRoot, { recursive: true });
    const projConfig = join(fx.projectDir, ".pi", "conductor.json");
    writeFileSync(
      projConfig,
      JSON.stringify({
        gc: {
          enabled: true,
          transcriptSizeCapBytes: 1024,
          completedTtlDays: 30,
          failedTtlDays: 60,
          totalSizeBudgetBytes: 5 * 1024 * 1024 * 1024,
          orphanTtlHours: 24,
          autoOnSessionStart: true,
          autoDebounceHours: 6,
          perPersonaTtlDays: {},
        },
      }),
    );
    makeRun(runsRoot, "inspector-aaaa", { transcriptBytes: 4096 });
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
      runsRoot,
    });
    assert.match(out, /next eviction/);
    assert.match(out, /\d+ archive/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: omits next-eviction line when GC is disabled (Slice 7)", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const runsRoot = join(fx.homeDir, ".pi", "agent", "conductor", "runs");
    mkdirSync(runsRoot, { recursive: true });
    const projConfig = join(fx.projectDir, ".pi", "conductor.json");
    writeFileSync(
      projConfig,
      JSON.stringify({
        gc: {
          enabled: false,
          completedTtlDays: 30,
          failedTtlDays: 60,
          totalSizeBudgetBytes: 5 * 1024 * 1024 * 1024,
          transcriptSizeCapBytes: 100 * 1024 * 1024,
          orphanTtlHours: 24,
          autoOnSessionStart: true,
          autoDebounceHours: 6,
          perPersonaTtlDays: {},
        },
      }),
    );
    makeRun(runsRoot, "inspector-aaaa", { transcriptBytes: 1024 });
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
      runsRoot,
    });
    assert.match(out, /## Run records/);
    assert.doesNotMatch(out, /next eviction/);
    assert.match(out, /\(GC disabled\)/);
  } finally {
    teardown(fx);
  }
});

// ── v0.10 Slice 4: watchdog runtime counters ──

test("buildDoctorReport: watchdog runtime line shows active=0 stalled=0 on empty registry (Slice 4)", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
    });
    assert.match(out, /watchdog runtime:\s+active=0\s+stalled=0/);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: watchdog runtime line counts running + stalled runs (Slice 4)", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    // Two running runs; one of them flagged as stalled by the enforcer.
    const baseRun = {
      id: "builder-aaaa",
      persona: "builder",
      task: "test",
      mode: "background" as const,
      status: "running" as const,
      startTime: 1_700_000_000_000,
      lastEventAt: 1_700_000_000_000,
      messages: [],
      usage: emptyUsage(),
      cwd: "/tmp",
      recordPath: "/dev/null/record.json",
      transcriptPath: "/dev/null/transcript.jsonl",
      finalPath: "/dev/null/final.md",
    };
    reg.register({ ...baseRun, id: "builder-aaaa" });
    reg.register({
      ...baseRun,
      id: "builder-bbbb",
      stalledSince: 1_700_000_180_000,
    });
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
    });
    assert.match(out, /watchdog runtime:\s+active=2\s+stalled=1/);
  } finally {
    teardown(fx);
  }
});

// ── v0.9.x slice 4 — Post-startup reconcile section ───────────────

test("buildDoctorReport: post-startup reconcile section says 'never' when lastReconcile is undefined", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
    });
    assert.match(out, /## Post-startup reconcile/);
    assert.match(out, /never/i);
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: post-startup reconcile shows scanned/readopted/reclassified/unresumable counts on success", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
      lastReconcile: {
        scanned: 5,
        readopted: ["a"],
        reclassified: ["b", "c"],
        preSchema: [],
        unresumable: ["c"],
        skippedForeign: [],
        errors: [],
      },
    });
    assert.match(out, /## Post-startup reconcile/);
    assert.match(out, /scanned\s*[:=]?\s*5/);
    assert.match(out, /readopted\s*[:=]?\s*1/);
    assert.match(out, /reclassified\s*[:=]?\s*2/);
    assert.match(out, /unresumable\s*[:=]?\s*1/);
    // No errors → no errors line listing them.
    assert.ok(!/errors:\s*[1-9]/.test(out));
  } finally {
    teardown(fx);
  }
});

test("buildDoctorReport: post-startup reconcile lists per-record errors and unresumable ids", async () => {
  const fx = setup();
  try {
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
      homeDir: fx.homeDir,
      lastReconcile: {
        scanned: 3,
        readopted: [],
        reclassified: ["builder-aa11"],
        preSchema: [],
        unresumable: ["oracle-bb22"],
        skippedForeign: [],
        errors: [
          { id: "critic-cc33", message: "JSON parse error: Unexpected token" },
        ],
      },
    });
    assert.match(out, /## Post-startup reconcile/);
    assert.match(out, /errors\s*[:=]?\s*1/);
    assert.match(out, /critic-cc33/);
    assert.match(out, /JSON parse error/);
    // unresumable id is surfaced (so user knows resume will fail).
    assert.match(out, /oracle-bb22/);
  } finally {
    teardown(fx);
  }
});

// ── v0.11 slice 5: Hooks section in doctor ───────────────────────────────

test("doctor: lists resolved hooks per persona with cascade source", async () => {
  const fx = setup();
  try {
    // Write a project config that declares a hook for the "oracle" persona.
    writeFileSync(
      join(fx.projectDir, ".pi", "conductor.json"),
      JSON.stringify({
        personaOverrides: {
          oracle: { onCompleteHook: "echo gate-passed", onCompleteHookTimeoutSeconds: 30 },
        },
      }),
    );
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
    });
    assert.match(out, /## Hooks/);
    // oracle should show the hook with source tag
    assert.match(out, /oracle.*echo gate-passed/);
    assert.match(out, /\[project\]/);
    // Some other persona (e.g. inspector) has no hook — shows (none)
    assert.match(out, /inspector.*\(none\)/);
  } finally {
    teardown(fx);
  }
});

test("doctor: warns when hook binary not on PATH", async () => {
  const fx = setup();
  try {
    writeFileSync(
      join(fx.projectDir, ".pi", "conductor.json"),
      JSON.stringify({
        personaOverrides: {
          oracle: { onCompleteHook: "definitely-not-a-real-binary-xyz --flag" },
        },
      }),
    );
    const reg = new RunRegistry();
    const q = new SpawnQueue(reg, 4);
    const out = await buildDoctorReport({
      cwd: fx.projectDir,
      registry: reg,
      queue: q,
      conductorMode: false,
    });
    // PATH warning present for the unknown binary
    assert.match(out, /binary not found on PATH|not found on PATH/i);
  } finally {
    teardown(fx);
  }
});
