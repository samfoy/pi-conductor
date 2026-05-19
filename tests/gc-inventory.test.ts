/**
 * pi-conductor — GC inventory tests.
 *
 * Spec: docs/v0.9-gc-design.md §3, docs/v0.9-gc-plan.md "Slice 1".
 *
 * Pure async function tests with mkdtempSync fixtures per design §6
 * (Test strategy → Integration). Builds fake run-dir layouts and asserts
 * the entry shape; never touches the real ~/.pi tree.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  utimesSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkInventory, type InventoryEntry } from "../src/gc/inventory.ts";
import { RunRegistry } from "../src/runs.ts";
import { emptyUsage, type Run, type RunRecord } from "../src/types.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "pi-conductor-gc-inv-"));
}

function writeRecord(runDir: string, partial: Partial<RunRecord>): void {
  const rec: RunRecord = {
    id: partial.id ?? "test-1234",
    persona: partial.persona ?? "inspector",
    task: partial.task ?? "noop",
    mode: partial.mode ?? "foreground",
    status: partial.status ?? "completed",
    startTime: partial.startTime ?? 1_700_000_000_000,
    finishedAt: partial.finishedAt ?? 1_700_000_010_000,
    usage: partial.usage ?? emptyUsage(),
    cwd: partial.cwd ?? "/tmp",
    recordPath: partial.recordPath ?? join(runDir, "record.json"),
    transcriptPath: partial.transcriptPath ?? join(runDir, "transcript.jsonl"),
    finalPath: partial.finalPath ?? join(runDir, "final.md"),
    ...partial,
  };
  writeFileSync(join(runDir, "record.json"), JSON.stringify(rec));
}

function makeRunDir(
  root: string,
  id: string,
  partial: Partial<RunRecord> & {
    transcript?: string;
    final?: string;
    pinned?: boolean;
    archived?: boolean;
    archivedAt?: number;
    transcriptMtime?: number;
    sessionFiles?: string[];
    skipRecord?: boolean;
    badRecordJson?: string;
  } = {},
): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });

  if (partial.skipRecord) {
    // Intentionally no record.json
  } else if (partial.badRecordJson !== undefined) {
    writeFileSync(join(dir, "record.json"), partial.badRecordJson);
  } else {
    writeRecord(dir, { ...partial, id });
  }

  if (partial.transcript !== undefined) {
    const path = join(dir, "transcript.jsonl");
    writeFileSync(path, partial.transcript);
    if (partial.transcriptMtime !== undefined) {
      const t = partial.transcriptMtime / 1000;
      utimesSync(path, t, t);
    }
  }
  if (partial.final !== undefined) {
    writeFileSync(join(dir, "final.md"), partial.final);
  }
  if (partial.pinned) {
    writeFileSync(join(dir, ".pinned"), "");
  }
  if (partial.archived) {
    const path = join(dir, ".archived");
    writeFileSync(path, "");
    if (partial.archivedAt !== undefined) {
      const t = partial.archivedAt / 1000;
      utimesSync(path, t, t);
    }
  }
  if (partial.sessionFiles && partial.sessionFiles.length > 0) {
    const sd = join(dir, "session");
    mkdirSync(sd);
    for (const f of partial.sessionFiles) {
      writeFileSync(join(sd, f), "");
    }
  }

  return dir;
}

test("walkInventory: nonexistent root returns empty list, no throw", async () => {
  const reg = new RunRegistry();
  const out = await walkInventory("/this/path/definitely/does/not/exist/pi-conductor-gc", reg);
  assert.deepEqual(out, []);
});

test("walkInventory: empty dir returns empty list", async () => {
  const root = tempRoot();
  try {
    const reg = new RunRegistry();
    const out = await walkInventory(root, reg);
    assert.deepEqual(out, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkInventory: well-formed run yields a fully-populated entry", async () => {
  const root = tempRoot();
  try {
    makeRunDir(root, "inspector-aaaa", {
      persona: "inspector",
      status: "completed",
      startTime: 1_700_000_000_000,
      finishedAt: 1_700_000_010_000,
      transcript: "x".repeat(2000),
      final: "summary text",
    });
    const reg = new RunRegistry();
    const out = await walkInventory(root, reg);
    assert.equal(out.length, 1);
    const e = out[0]!;
    assert.equal(e.id, "inspector-aaaa");
    assert.equal(e.persona, "inspector");
    assert.equal(e.status, "completed");
    assert.equal(e.startTime, 1_700_000_000_000);
    assert.equal(e.finishedAt, 1_700_000_010_000);
    assert.equal(e.transcriptSizeBytes, 2000);
    assert.ok(e.recordSizeBytes > 0, "record.json size should be > 0");
    assert.equal(e.finalSizeBytes, "summary text".length);
    assert.equal(e.totalSizeBytes, e.transcriptSizeBytes + e.recordSizeBytes + e.finalSizeBytes);
    assert.equal(e.pinned, false);
    assert.equal(e.archived, false);
    assert.equal(e.archivedAt, null);
    assert.equal(e.sessionPathPresent, false);
    assert.equal(e.inMemory, undefined);
    assert.equal(e.malformed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkInventory: malformed record.json marks entry malformed and does not throw", async () => {
  const root = tempRoot();
  try {
    makeRunDir(root, "broken-bbbb", { badRecordJson: "{ not valid json " });
    const reg = new RunRegistry();
    const out = await walkInventory(root, reg);
    assert.equal(out.length, 1);
    const e = out[0]!;
    assert.equal(e.id, "broken-bbbb");
    assert.equal(e.malformed, true);
    assert.equal(e.persona, "<unknown>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkInventory: missing record.json marks entry malformed (not crash)", async () => {
  const root = tempRoot();
  try {
    makeRunDir(root, "headless-cccc", { skipRecord: true, transcript: "abc" });
    const reg = new RunRegistry();
    const out = await walkInventory(root, reg);
    assert.equal(out.length, 1);
    const e = out[0]!;
    assert.equal(e.malformed, true);
    assert.equal(e.transcriptSizeBytes, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkInventory: pinned and archived sidecars detected; archivedAt mtime read", async () => {
  const root = tempRoot();
  try {
    const archivedAtMs = 1_700_000_500_000;
    makeRunDir(root, "old-dddd", {
      status: "completed",
      transcript: "z",
      pinned: true,
      archived: true,
      archivedAt: archivedAtMs,
    });
    const reg = new RunRegistry();
    const out = await walkInventory(root, reg);
    const e = out[0]!;
    assert.equal(e.pinned, true);
    assert.equal(e.archived, true);
    assert.ok(e.archivedAt !== null);
    // utimesSync resolution is whole seconds on most filesystems.
    assert.ok(Math.abs(e.archivedAt! - archivedAtMs) < 1500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkInventory: sessionPathPresent true when session/ has a .jsonl", async () => {
  const root = tempRoot();
  try {
    makeRunDir(root, "live-eeee", {
      transcript: "x",
      sessionFiles: ["2026-05-19_abc.jsonl"],
    });
    makeRunDir(root, "live-ffff", { transcript: "x", sessionFiles: ["other.txt"] });
    const reg = new RunRegistry();
    const out = await walkInventory(root, reg);
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    assert.equal(byId["live-eeee"]!.sessionPathPresent, true);
    assert.equal(byId["live-ffff"]!.sessionPathPresent, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkInventory: hooks live Run from RunRegistry by id", async () => {
  const root = tempRoot();
  try {
    makeRunDir(root, "matched-gggg", { transcript: "y" });
    const reg = new RunRegistry();
    const liveRun: Run = {
      id: "matched-gggg",
      persona: "inspector",
      task: "noop",
      mode: "background",
      status: "running",
      startTime: 1_700_000_000_000,
      lastEventAt: 1_700_000_000_000,
      messages: [],
      usage: emptyUsage(),
      cwd: "/tmp",
      recordPath: "/tmp/matched-gggg/record.json",
      transcriptPath: "/tmp/matched-gggg/transcript.jsonl",
      finalPath: "/tmp/matched-gggg/final.md",
    };
    reg.register(liveRun);
    const out = await walkInventory(root, reg);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.inMemory?.id, "matched-gggg");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkInventory: skips files at the top level (only walks directories)", async () => {
  const root = tempRoot();
  try {
    makeRunDir(root, "real-hhhh", { transcript: "x" });
    writeFileSync(join(root, ".DS_Store"), "fake");
    writeFileSync(join(root, "stray-file.json"), "{}");
    const reg = new RunRegistry();
    const out = await walkInventory(root, reg);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.id, "real-hhhh");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("walkInventory: transcriptMtime is populated when transcript exists", async () => {
  const root = tempRoot();
  try {
    const mtimeMs = 1_700_000_900_000;
    makeRunDir(root, "mtime-iiii", {
      transcript: "abc",
      transcriptMtime: mtimeMs,
    });
    const reg = new RunRegistry();
    const out = await walkInventory(root, reg);
    const e = out[0]!;
    assert.ok(e.transcriptMtime !== null);
    assert.ok(Math.abs(e.transcriptMtime! - mtimeMs) < 1500);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
// silence unused import warning for symlinkSync (kept for potential follow-up tests)
void symlinkSync;
void (null as unknown as InventoryEntry);
