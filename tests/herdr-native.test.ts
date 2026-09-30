import test from "node:test";
import assert from "node:assert/strict";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { build, stop } from "esbuild";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";

sandboxPi();
// node:test already gives this file a private process; no real Pi/herdr subprocess or TUI.
process.env.PI_OFFLINE = "1";
process.env.PI_SKIP_VERSION_CHECK = "1";
process.env.PI_TELEMETRY = "0";
const root = tmpDir("h7-native-");
process.env.TMPDIR = root;
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
process.env.CONDUCTOR_MEMORY_PATH = join(root, "memory.jsonl");

test("H7 installed Pi 0.87.1 bridge -> H6 readiness -> H7 tail -> shared settlement (injected exit)", { timeout: 60000 }, async t => {
  t.after(() => stop());
  const nativeRoot = process.env.CONDUCTOR_NATIVE_PI_ROOT ?? resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");
  const version = JSON.parse(readFileSync(join(nativeRoot, "package.json"), "utf8")).version;
  assert.equal(version, "0.87.1", "native witness requires installed Pi 0.87.1, not a skipped or older parity test");
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`;
    const packageRoot = name === "pi-coding-agent" ? nativeRoot : join(nativeRoot, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(metadata.version, "0.87.1");
    const resolved = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main);
    t.diagnostic(`${specifier}: ${pathToFileURL(resolved).href}`);
    return [specifier, resolved];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const output = join(root, "native-harness.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("./helpers/herdr-native.ts", import.meta.url))], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  const { nativePipeline } = await import(pathToFileURL(output).href);
  for (const ask of [false, true]) await t.test(`native pipeline ask=${ask}`, async child => {
    child.mock.timers.enable({ apis: ["setInterval"] });
    child.diagnostic(JSON.stringify(await nativePipeline(root, ask, child)));
  });
});
