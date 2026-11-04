import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  scripts?: Record<string, string>;
  pi?: { extensions?: string[] };
};
const tracked = new Set(execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n"));

test("a git install runs no lifecycle script, because pi installs with --omit=dev and the build tools are dev dependencies", () => {
  const lifecycle = ["preinstall", "install", "postinstall", "prepare"].filter((name) => manifest.scripts?.[name] !== undefined);
  assert.deepEqual(lifecycle, []);
});

test("every pi extension entry point is a tracked file, so a git install loads without building", () => {
  const entries = manifest.pi?.extensions ?? [];
  assert.ok(entries.length > 0);
  for (const entry of entries) assert.ok(tracked.has(entry.replace(/^\.\//, "")), `${entry} is not tracked`);
});
