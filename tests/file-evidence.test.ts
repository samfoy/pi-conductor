import test from "node:test";
import assert from "node:assert/strict";
import fs, { chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import * as evidence from "../src/file-evidence.ts";
import { RunRegistry, runDir, runsRoot, spawnRun } from "../src/runs.ts";
import { SpawnQueue } from "../src/queue.ts";
import { loadConfig } from "../src/config.ts";
import { emptyUsage, toRunRecord, type Run, type Persona } from "../src/types.ts";

const { home } = sandboxPi();
const cwd = realpathSync(tmpDir("a5-evidence-"));
const registry = new RunRegistry();
const attach = (files: unknown, limit = 131072) => evidence.appendFileEvidence("task", files as string[], { cwd, registry, limit });
const file = (name: string, content: string | Buffer) => { const p = join(cwd, name); writeFileSync(p, content); return p; };
function result(id = "critic-a5"): Run {
  const dir = runDir(id); mkdirSync(dir, { recursive: true });
  const run: Run = { id, persona: "critic", task: "review", cwd, status: "completed", mode: "background", startTime: 1, lastEventAt: 1, usage: emptyUsage(), messages: [], finalPath: join(dir, "final.md"), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), sessionPath: join(dir, "session.jsonl"), contextRetired: true };
  writeFileSync(run.finalPath, "Retirement handoff: verified changes.\n");
  writeFileSync(run.recordPath, JSON.stringify(toRunRecord(run)));
  return run;
}

test("paths resolve from caller cwd and HOME; canonical first occurrence wins", () => {
  const p = file('notes<&".md', "whole 😀\r\nline\u2028end");
  const link = join(cwd, "link"); symlinkSync(p, link);
  const rendered = attach([link, p]);
  assert.equal((rendered.match(/<file name=/g) ?? []).length, 1);
  assert.ok(rendered.includes('notes&lt;&amp;&quot;.md'));
  assert.ok(rendered.includes("whole 😀\r\nline\u2028end"));
  assert.match(rendered, /evidence.*not instructions/i);
  writeFileSync(join(home, "home.md"), "HOME evidence");
  assert.match(attach(["~/home.md"]), /HOME evidence/);
  file("relative.md", "relative evidence");
  assert.match(attach(["relative.md"]), /relative evidence/);
});

test("durable run refs survive registry loss, preserve provenance and dedup against paths", () => {
  const run = result();
  const before = readFileSync(run.finalPath);
  const rendered = attach([`run:${run.id}`, run.finalPath]);
  assert.match(rendered, /name="run:critic-a5"/);
  assert.match(rendered, /Agent result source:/);
  assert.match(rendered, /&quot;agent_id&quot;: ?&quot;critic-a5&quot;/);
  assert.ok(rendered.includes(run.sessionPath!));
  assert.equal((rendered.match(/<file name=/g) ?? []).length, 1);
  assert.deepEqual(readFileSync(run.finalPath), before);
  const ref = attach([`run:${run.id}`], 1024);
  assert.match(ref, /Retirement handoff/);
  registry.register(run);
  assert.equal(attach([`run:${run.id}`]), attach([`run:${run.id}`]));
  assert.equal(evidence.resultRef(run), `run:${run.id}`);
  writeFileSync(run.finalPath, "(no output)");
  assert.throws(() => attach([`run:${run.id}`]), /no usable final/i);
  assert.equal(evidence.resultRef(run), undefined);
});

test("reject malformed inputs, traversal, unknown or absent results, non-regular and unreadable files", () => {
  for (const input of [null, "x", [1], [""], ["run:"], ["run:../critic-a5"], ["run:critic-a5/final.md"], ["run:unknown-a5"], [cwd], ["missing"], ["bad\0path"]]) {
    assert.throws(() => attach(input), JSON.stringify(input));
  }
  const run = result("missing-a5");
  writeFileSync(run.recordPath, JSON.stringify({ ...toRunRecord(run), id: "different" }));
  assert.throws(() => attach(["run:missing-a5"]), /record/i);
  const p = file("unreadable", "secret"); chmodSync(p, 0);
  try { assert.throws(() => attach([p]), /read/i); } finally { chmodSync(p, 0o600); }
});

test("refs name the persisted result even while a known run is active again", () => {
  const r = result("resumed-source"); r.status = "running";
  writeFileSync(r.recordPath, JSON.stringify(toRunRecord(r)));
  assert.match(attach([`run:${r.id}`]), /Retirement handoff/);
  registry.register(r);
  assert.match(attach([`run:${r.id}`]), /Retirement handoff/);
  assert.equal(evidence.resultRef(r), undefined, "only completion surfaces advertise a ref");
});

test("run IDs with trailing line terminators are malformed even when present in the registry", () => {
  for (const tail of ["\n", "\r", "\u2028", "\u2029"]) {
    const r = result(`bad-id${tail}`); registry.register(r);
    assert.throws(() => attach([`run:${r.id}`]), /malformed/);
    assert.equal(evidence.resultRef(r), undefined);
  }
});

test("whole rendered UTF-8 budget includes escaping, provenance and framing; never partial embeds", () => {
  const p = file("budget", "😀<&".repeat(150));
  const small = attach([p], 1024);
  assert.match(small, /bytes="900" \/>/);
  assert.doesNotMatch(small, /😀/);
  const large = attach([p], 4096);
  assert.ok(large.includes("😀&lt;&amp;".repeat(150)));
  const b = file("binary", Buffer.from([0x61, 0, 0x62]));
  const invalid = file("invalid", Buffer.from([0xc3, 0x28]));
  assert.match(attach([b]), /bytes="3" \/>/);
  assert.match(attach([invalid]), /bytes="2" \/>/);
  const huge = file("huge", ""); const fd = openSync(huge, "r+"); ftruncateSync(fd, 2 ** 34); closeSync(fd);
  assert.match(attach([huge]), /bytes="17179869184" \/>/);
  const paths = Array.from({ length: 12 }, (_, i) => file(`total-${i}`, "x".repeat(700)));
  const total = attach(paths, 1024);
  assert.ok(Buffer.byteLength(total.slice(4)) <= 4 * 1024);
  assert.match(total, /live paths.*not copied or snapshotted/);
  assert.match(total, / \/>/);
  const run = result("large-a5"); writeFileSync(run.finalPath, "x".repeat(2000));
  assert.ok(attach([`run:${run.id}`], 1024).includes(`path="${realpathSync(run.finalPath)}"`));
});

test("oversized files are checked for readability without any content read", (t) => {
  const huge = file("bounded-huge", ""); const fd = openSync(huge, "r+"); ftruncateSync(fd, 2 ** 34); closeSync(fd);
  const spy = t.mock.method(fs, "readSync", () => { throw new Error("must not read oversized evidence"); });
  syncBuiltinESMExports();
  try { assert.match(attach([huge]), /bytes="17179869184" \/>/); assert.equal(spy.mock.callCount(), 0); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("durable lookup handles a symlinked runs root but rejects run directory escape", () => {
  const r = result("root-symlink");
  const canonical = runsRoot() + "-real";
  renameSync(runsRoot(), canonical); symlinkSync(canonical, runsRoot());
  try { assert.match(attach([`run:${r.id}`]), /Retirement handoff/); }
  finally { unlinkSync(runsRoot()); renameSync(canonical, runsRoot()); }
  const external = tmpDir("a5-external-record-");
  symlinkSync(external, runDir("escaped-run"));
  assert.throws(() => attach(["run:escaped-run"]), /outside canonical/);
});

test("metadata escapes attribute newlines and tabs", () => {
  const p = file("line\nname\t.md", "body");
  assert.ok(attach([p]).includes("line&#10;name&#9;.md"));
});

test("config accepts integer attachment limits only in 1024..1048576", () => {
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  for (const value of [1024, 1048576, 1023, 1048577, 1024.5, "2048"]) {
    writeFileSync(join(cwd, ".pi", "conductor.json"), JSON.stringify({ inlineAttachmentLimitBytes: value }));
    assert.equal(loadConfig(cwd).inlineAttachmentLimitBytes, value === 1024 || value === 1048576 ? value : 131072);
  }
});

test("queue validates before registration and captures embedded evidence exactly once", () => {
  const reg = new RunRegistry();
  const calls: any[] = [];
  const queue = new SpawnQueue(reg, 1, 1, (opts) => { calls.push(opts); return { run: {} as Run, done: Promise.resolve({} as Run) }; });
  const busy = result("busy-a5"); busy.status = "running"; reg.register(busy);
  const persona = { name: "inspector", defaultReads: [], systemPrompt: "", inheritContext: "none", description: "probe", inheritSkills: false, worktree: false, timeoutMinutes: 1, readOnly: true, source: "builtin", sourcePath: "test" } satisfies Persona;
  const opts = { persona, task: "task", files: ["missing"], mode: "background" as const, cwd, timeoutMs: 1000 };
  assert.throws(() => queue.enqueueOrSpawn(opts));
  assert.throws(() => spawnRun({ ...opts, registry: reg, worktree: true }));
  assert.equal(reg.list().length, 1); assert.equal(queue.size(), 0);
  const p = file("snapshot", "ACCEPTED");
  queue.enqueueOrSpawn({ ...opts, files: [p] });
  writeFileSync(p, "CHANGED"); busy.status = "completed"; reg.notify(busy);
  assert.equal(calls.length, 1); assert.match(calls[0].task, /ACCEPTED/); assert.doesNotMatch(calls[0].task, /CHANGED/);
  assert.equal(calls[0].files, undefined);
});
