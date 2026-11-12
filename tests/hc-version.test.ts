import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { sandboxPi } from "./helpers/tmp.ts";
import { launchFixture, realProbe } from "./helpers/hc-launch.ts";
import { loadConductor, stubCtx } from "./helpers/stub-pi.ts";
import { leadPi } from "../src/pi-host.ts";
import { formatCompletionNotification } from "../src/notifications.ts";

sandboxPi();

test("the lead proves its loaded Pi from its own session at session_start", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-lead-pi-"));
  const saved = { HOME: process.env.HOME, CONDUCTOR_SUBAGENT: process.env.CONDUCTOR_SUBAGENT };
  process.env.HOME = join(root, "home");
  delete process.env.CONDUCTOR_SUBAGENT;
  try {
    const conf = join(root, "home", ".pi", "agent", "extensions", "conductor");
    mkdirSync(conf, { recursive: true });
    writeFileSync(join(conf, "config.json"), JSON.stringify({ gc: { enabled: false } }));
    assert.equal(leadPi.version(), "unknown", "a test runner's argv[1] is not Pi's declared bin");
    const fire = loadConductor();
    const ctx = { ...stubCtx(root), sessionManager: SessionManager.inMemory() };
    await fire("session_start", {}, ctx);
    try { assert.equal(leadPi.version(), VERSION); } finally { await fire("session_shutdown", { reason: "quit" }, ctx); }
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("hc launch compares the child's hello with the lead's loaded Pi: a mismatch is persisted on the binding and shown", { timeout: 60000 }, async t => {
  leadPi.prove(SessionManager.inMemory());
  const h = await launchFixture(t, "hold", () => realProbe, cli => cli, undefined, null);
  const transport = h.launch();
  try {
    await transport.ready;
    const expected = `Pi version mismatch: lead ${VERSION}, child fake-child`;
    assert.equal(h.run.herdr?.versionWarning, expected);
    assert.equal(JSON.parse(readFileSync(h.run.recordPath, "utf8")).herdr.versionWarning, expected);
    assert.match(transport.stderr, new RegExp(expected.replace(/[.]/g, "\\.")));
    assert.match(formatCompletionNotification({ ...h.run, status: "completed" }), new RegExp(`<warning reason="pi-version">${expected.replace(/[.]/g, "\\.")}</warning>`));
  } finally {
    await transport.stop();
    await transport.closed;
  }
});
