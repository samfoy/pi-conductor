import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi } from "./helpers/tmp.ts";
import { herdrFixture } from "./helpers/herdr-pipeline.ts";
import { toRunRecord } from "../src/types.ts";
import { executeReclaim } from "../src/gc/executor.ts";
sandboxPi();
for (const race of ["none", "nonce", "status", "memory"] as const) test(`H9 GC fake CLI effect-time proof and sibling preservation: ${race}`, { timeout: 10000 }, async () => {
  const h = herdrFixture("healthy");
  h.run.transport = h.runtime.launch(h.run, [], h.run.cwd, { line() {}, close() {}, error() {}, initialDeliveryFailed() {} }, "probe", h.opts.core);
  await h.run.transport.ready; h.run.status = "completed";
  const statePath = join(h.run.cwd, "fake.json");
  h.run.herdr!.socketPath = `${statePath}.socket`; h.run.herdr!.childPid = 2147483647;
  const helloPath = join(dirname(h.run.recordPath), "launch", `${h.run.herdr!.launchNonce}.json`);
  const hello = JSON.parse(readFileSync(helloPath, "utf8")); hello.pid = h.run.herdr!.childPid;
  writeFileSync(helloPath, JSON.stringify(hello));
  const record = toRunRecord(h.run);
  writeFileSync(h.run.recordPath, JSON.stringify(record));
  const replacement = { ...record, herdr: { ...record.herdr!, launchNonce: race === "nonce" ? "fresh-resume" : record.herdr!.launchNonce }, status: race === "status" ? "running" : record.status };
  writeFileSync(statePath, JSON.stringify({ calls: [], pane: h.pane, siblingPane: { pane_id: "foreign", agent: "manual" },
    ...(race === "nonce" || race === "status" ? { rewriteRecord: { path: h.run.recordPath, value: replacement } } : {}) }));
  let observations = 0;
  const result = await executeReclaim([{ kind: "cold-archive", id: h.run.id, reason: "cap", bytesReclaimed: 1, herdr: { ...record.herdr! } }], h.run.cwd, new Set(), Date.now(), {
    env: { HOME: h.run.cwd, TMPDIR: h.run.cwd, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, FAKE_HERDR_STATE: statePath, CONDUCTOR_HERDR_BIN: new URL("fixtures/fake-herdr.mjs", import.meta.url).pathname },
    currentRun: () => { if (race === "memory" && ++observations === 3) h.run.status = "running"; return h.run; },
  });
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  assert.deepEqual(state.siblingPane, { pane_id: "foreign", agent: "manual" });
  assert.equal(state.calls.filter((c: any) => c.args[0] === "tab" && c.args[1] === "close").length, 0);
  assert.equal(result.archived.length, race === "none" ? 1 : 0);
  assert.equal(existsSync(h.run.transcriptPath), race !== "none", "fresh resume evidence must not be reclaimed");
  assert.equal(state.calls.filter((c: any) => c.args[1] === "close").length, race === "none" ? 1 : 0, "fresh resumed pane must not be closed");
});
