/**
 * N5 native witness: a real Pi 0.87.1 delegating parent in a fake herdr pane calls the
 * real `delegate`; its real start/update/end events reach the lead only through the H4
 * tee, the lead's broker spawns real Pi leaves that split the parent's pane, and the
 * parent's next turn reads their envelopes. Pane sessions are built from the exact pane
 * env and argv the lead gave herdr. Offline faux model. The 0.87.1 minimum root is required (missing
 * fails, never skips); each CONDUCTOR_H11_PI_ROOTS root also runs, expecting its own declared version.
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { delegationHarness } from "./helpers/herdr-delegation.ts";
import { getFinalText } from "../src/runs.ts";
import { delegatePaths } from "../src/delegation.ts";
import type { Run } from "../src/types.ts";

sandboxPi();
process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
const root = tmpDir("n5-native-");
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); mkdirSync(join(root, "agent"), { recursive: true });
after(() => stop());

async function bundle(t: test.TestContext, piRoot: string): Promise<{ path: string; version: string }> {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? piRoot : join(piRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(metadata.version, version, `${specifier} matches the explicit root`);
    const path = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main);
    t.diagnostic(`${specifier}@${metadata.version}: ${path}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const path = join(root, `n5-child-${version}.mjs`);
  await build({ entryPoints: [fileURLToPath(new URL("./helpers/herdr-delegation-native-child.ts", import.meta.url))], outfile: path, bundle: true, platform: "node", format: "esm",
    packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  return { path, version };
}

/** One installed Pi root, at the version its own package.json declares. */
async function witness(t: test.TestContext, piRoot: string, expected: string) {
  const child = await bundle(t, piRoot);
  assert.equal(child.version, expected, `the bundled child runs Pi ${expected}, read from the root itself`);
  process.env.N5_NATIVE_VERSION = child.version;
  const h = await delegationHarness(t, { child: manifest => [child.path, manifest] });
  const { run: parent, done } = await h.spawnParent("N5-NATIVE parent fan-out", 90000);
  await done;
  assert.equal(parent.status, "completed", parent.errorMessage);
  const final = getFinalText(parent.messages);
  t.diagnostic(`Pi ${child.version} parent final:\n${final.replace(/```xml[\s\S]*?```/g, "<envelope>")}`);
  assert.match(final, /^N5 native parent saw 4 results/);
  assert.match(final, /n_scout: ## ✓ `scout` completed[\s\S]*?N5 native leaf scout done; saw=Tool delegate not found/);
  assert.match(final, /n_auditor: ## ✓ `auditor` completed[\s\S]*?N5 native leaf auditor done/);
  assert.match(final, /n_denied: ERROR delegate rejected: persona writer is not in this run's delegation allowlist \(scout, auditor\)/);
  assert.match(final, /n_schema: ERROR Validation failed for tool "delegate"/);
  assert.deepEqual(readdirSync(join(dirname(parent.recordPath), "delegate")).sort(),
    ["n_auditor.claim.json", "n_auditor.json", "n_denied.claim.json", "n_denied.json", "n_scout.claim.json", "n_scout.json"], "a schema-rejected start claims nothing");

  // The parent's real event order, as the lead received it through the tee.
  const nonce = parent.herdr!.launchNonce;
  const events = readFileSync(parent.transcriptPath, "utf8").trim().split("\n").map(l => JSON.parse(l)).filter(e => e._c?.n === nonce);
  const kinds = (id: string) => events.filter(e => e.toolCallId === id && /^tool_execution_/.test(e.type)).map(e => e.type.slice(15));
  for (const id of ["n_scout", "n_auditor", "n_denied"]) assert.deepEqual(kinds(id), ["start", "update", "end"], id);
  assert.deepEqual(kinds("n_schema"), ["start", "end"], "start precedes validation; no update, no claim");

  const leaves = h.leaves(parent);
  assert.deepEqual(leaves.map(l => [l.persona, l.runtime, l.status, l.herdr?.createdTab]).sort(), [["auditor", "herdr", "completed", false], ["scout", "herdr", "completed", false]]);
  const splits = h.splits();
  assert.deepEqual(splits.map(a => [a[a.indexOf("--pane") + 1], a[a.indexOf("--direction") + 1]]), [[parent.herdr!.paneId, "right"], [leaves[0]!.herdr!.paneId, "down"]]);
  assert.equal(h.cards(), 1, "no leaf card");

  // Tool surfaces of the real sessions, built from the lead's pane env and argv.
  const surface = (run: Run) => JSON.parse(readFileSync(`${h.manifestOf(run)}.tools.json`, "utf8")) as { version: string; depth: string; active: string[] };
  const p = surface(parent);
  t.diagnostic(`Pi ${child.version} parent tools: ${p.active.join(",")}`);
  assert.equal(p.version, child.version); assert.equal(p.depth, "1");
  for (const name of ["delegate", "ask_owner", "read", "bash", "edit", "write"]) assert.ok(p.active.includes(name), `delegating parent keeps ${name}`);
  for (const leafRun of leaves) {
    const s = surface(leafRun);
    t.diagnostic(`Pi ${child.version} ${leafRun.persona} tools: ${s.active.join(",")}`);
    assert.equal(s.version, child.version); assert.equal(s.depth, "2");
    assert.ok(s.active.includes("read") && s.active.includes("bash"), "a leaf keeps its default read-only tools");
    for (const name of ["delegate", "ask_owner", "edit", "write", "insert_before", "insert_after", "subagent", "ensemble_spawn", "ensemble_send"]) {
      assert.ok(!s.active.includes(name), `${leafRun.persona} has no ${name}`);
    }
    const r = JSON.parse(readFileSync(delegatePaths(dirname(parent.recordPath), leafRun.delegateToolCallId!).response, "utf8"));
    assert.deepEqual([r.ok, r.agentId, r.status], [true, leafRun.id, "completed"]);
  }
  // Each pane child wrote a tool-surface sidecar beside its request; none was taken for a request.
  const sidecars = readdirSync(h.manifests).filter(f => f.endsWith(".json.tools.json"));
  assert.equal(sidecars.length, 3);
  assert.deepEqual(h.launched(), sidecars.map(f => f.slice(0, -".tools.json".length)).sort(), "exactly the three agent-start requests were launched");
}

test("N5 native Pi 0.87.1 (minimum): real delegate start/update/end through the H4 tee to the broker; split leaves; depth-2 tool surface", { timeout: 120000 }, async t => {
  const piRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT;
  assert.ok(piRoot && existsSync(join(piRoot, "package.json")), "CONDUCTOR_NATIVE_PI_ROOT must name the approved Pi 0.87.1 root; a missing minimum is a failure, not a skip");
  await witness(t, piRoot, "0.87.1");
});

for (const piRoot of (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean)) {
  const version = JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version as string;
  test(`N5 native Pi ${version} (H11 matrix): real delegate through the H4 tee to the broker; split leaves; depth-2 tool surface`, { timeout: 120000 }, async t => {
    await witness(t, piRoot, version);
  });
}
