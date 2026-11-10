import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import { HC_UNSET_HERDR_ENV, hcTab } from "../src/hc/host.ts";

sandboxPi();
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";
const root = tmpDir("hc-native-");
process.env.TMPDIR = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");

test("hc native 0.87.1: a Pi child launched through HcHost takes the bridge's hc branch, names its terminal and completes its task", { timeout: 60000 }, async t => {
  t.after(() => stop());
  const nativeRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT ?? resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
  assert.equal(JSON.parse(readFileSync(join(nativeRoot, "package.json"), "utf8")).version, "0.87.1", "native witness requires Pi 0.87.1");
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`;
    const packageRoot = name === "pi-coding-agent" ? nativeRoot : join(nativeRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(metadata.version, "0.87.1");
    return [specifier, resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main)];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const output = join(root, "hc-native-harness.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("./helpers/hc-native.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm",
    packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  const { nativeHcPipeline } = await import(pathToFileURL(output).href);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const result = await nativeHcPipeline(root, t);
  t.diagnostic(JSON.stringify({ status: result.status, shutdowns: result.shutdowns, turns: result.turns, hello: result.hello }));
  assert.equal(result.status, "completed", result.error);
  assert.deepEqual([result.shutdowns, result.completions, result.turns], [1, 1, 1]);
  assert.match(result.final, /Native hc final evidence/);
  assert.deepEqual(result.hello, { paneId: "t5", terminalId: "t5", piVersion: "0.87.1" }, "the hello names HC_TERMINAL_ID, not the leaked herdr pane");
  assert.deepEqual(result.binding, { host: "hc", address: "t5", coreId: "native-core", tab: hcTab("oracle-native-hc"), space: "sp-native" });
  assert.equal(result.runs.length, 1, "one hc run per launch");
  const [spec] = result.runs;
  assert.equal(spec.parent, "t1");
  assert.deepEqual(spec.labels, { "conductor.run": "oracle-native-hc", "conductor.nonce": spec.labels["conductor.nonce"], "herdr.tab": hcTab("oracle-native-hc"), "herdr.space": "sp-native" });
  assert.deepEqual(spec.argv.slice(0, 1 + 2 * HC_UNSET_HERDR_ENV.length), ["env", ...HC_UNSET_HERDR_ENV.flatMap((name: string) => ["-u", name])]);
  assert.ok(spec.argv.includes(process.execPath) && spec.argv.includes("/opt/pi/dist/cli.js"));
  assert.equal(spec.argv[spec.argv.indexOf("--conductor-launch") + 1], spec.labels["conductor.nonce"]);
});
