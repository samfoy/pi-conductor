// Bundles tests/helpers/native-merger-child.ts against the explicit installed Pi root, never the
// repository devDependency; asserts every aliased package is the 0.87.1 minimum.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const NATIVE_PI_ROOT = process.env.CONDUCTOR_NATIVE_PI_ROOT ?? resolve(dirname(process.execPath), "../lib/node_modules/@earendil-works/pi-coding-agent");

export async function bundleNativeMerger(outDir: string, diagnostic: (line: string) => void = () => {}): Promise<string> {
  const version = JSON.parse(readFileSync(join(NATIVE_PI_ROOT, "package.json"), "utf8")).version;
  assert.equal(version, "0.87.1", `CONDUCTOR_NATIVE_PI_ROOT must be the installed 0.87.1 minimum, got ${version} at ${NATIVE_PI_ROOT}`);
  const alias = Object.fromEntries(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui"].map(name => {
    const specifier = `@earendil-works/${name}`, packageRoot = name === "pi-coding-agent" ? NATIVE_PI_ROOT : join(NATIVE_PI_ROOT, "node_modules", specifier);
    const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    assert.equal(metadata.version, "0.87.1", specifier);
    const path = resolve(packageRoot, metadata.exports?.["."]?.import ?? metadata.main);
    diagnostic(`${specifier}@${metadata.version}: ${path}`); return [specifier, path];
  }));
  alias["@sinclair/typebox"] = fileURLToPath(import.meta.resolve("@sinclair/typebox"));
  const path = join(outDir, "merger-child-0.87.1.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("./native-merger-child.ts", import.meta.url))], outfile: path, bundle: true, platform: "node", format: "esm",
    packages: "external", alias, external: Object.values(alias), logLevel: "silent" });
  return path;
}
