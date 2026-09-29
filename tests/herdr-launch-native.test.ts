import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
sandboxPi();
process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1"; process.env.PI_TELEMETRY = "0";
const root = tmpDir("h6-native-"); process.env.TMPDIR = root; process.env.PI_CODING_AGENT_DIR = join(root, "agent");

test("H6 native 0.87.1 exported trust truth table and correlated agent_start", { timeout: 60000 }, async t => {
  t.after(() => stop()); t.mock.timers.enable({ apis: ["setInterval"] });
  const nativeRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT ?? resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? nativeRoot : join(nativeRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")); assert.equal(metadata.version, "0.87.1");
    const path = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main); t.diagnostic(`${specifier}: ${path}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const output = join(root, "harness.mjs");
  await build({ stdin: { contents: 'export { nativeWitness } from "./tests/helpers/child-inbox-native.ts"; export { projectTrustArgs } from "./src/herdr/runtime.ts"; export * as pi from "@earendil-works/pi-coding-agent";', resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts" }, outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  const { nativeWitness, projectTrustArgs, pi } = await import(pathToFileURL(output).href);
  for (const name of ["getAgentDir", "hasTrustRequiringProjectResources", "ProjectTrustStore", "SettingsManager"]) assert.equal(typeof pi[name], "function");
  for (const resources of [false, true]) for (const decision of [null, false, true]) for (const defaultTrust of [undefined, "ask", "always", "never"]) {
    const base = join(root, `trust-${resources}-${decision}-${defaultTrust}`), cwd = join(base, "cwd"), agent = join(base, "agent");
    mkdirSync(cwd, { recursive: true }); mkdirSync(agent);
    if (resources) { mkdirSync(join(cwd, ".pi")); writeFileSync(join(cwd, ".pi", "settings.json"), "{}"); }
    writeFileSync(join(agent, "settings.json"), JSON.stringify({ defaultProjectTrust: defaultTrust }));
    const trust = JSON.stringify({ [cwd]: decision }); writeFileSync(join(agent, "trust.json"), trust);
    assert.equal(new pi.ProjectTrustStore(agent).get(cwd), decision);
    assert.deepEqual(projectTrustArgs(cwd, agent), resources && decision === null && (defaultTrust === undefined || defaultTrust === "ask") ? ["--no-approve"] : []);
    assert.equal(readFileSync(join(agent, "trust.json"), "utf8"), trust, "reading flags never changes saved rejection/trust");
  }
  await nativeWitness(root, "healthy", t);
  const dir = join(root, "oracle-healthy");
  const events = readFileSync(join(dir, "transcript.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events.find(e => e.type === "agent_start").initialRequestId, "request-1", "native start must carry this input's correlation, not an earlier human turn");
  await nativeWitness(root, "intercept", t);
  const intercepted = readFileSync(join(root, "oracle-intercept", "transcript.jsonl"), "utf8");
  assert.ok(!intercepted.includes('"initialRequestId"'), "an input ack handled by a later extension is not execution");
  await nativeWitness(root, "intercept-human", t);
  const human = readFileSync(join(root, "oracle-intercept-human", "transcript.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  assert.equal(human.filter(e => e.type === "agent_start").length, 1);
  assert.equal(human.find(e => e.type === "agent_start").initialRequestId, undefined, "later human start must not execute an intercepted request");
});
