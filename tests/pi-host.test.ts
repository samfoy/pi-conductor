import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { hostPiVersion, PI_LIBRARY_VERSION } from "../src/pi-host.ts";
import { piVersionWarning } from "../src/herdr/runtime.ts";
import { tmpDir } from "./helpers/tmp.ts";

function fakePi(name = "@earendil-works/pi-coding-agent", version = "9.9.9") {
  const root = tmpDir("pi-host-"), cli = join(root, "dist", "bundle", "cli.js");
  mkdirSync(join(root, "dist", "bundle"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version, bin: { pi: "dist/bundle/cli.js" } }));
  writeFileSync(cli, ""); writeFileSync(join(root, "dist", "cli.js"), "");
  symlinkSync(cli, join(root, "pi"));
  return root;
}

test("host Pi version comes from the executing package's declared CLI entry, through symlinks", () => {
  const root = fakePi();
  assert.equal(hostPiVersion({}, join(root, "pi")), "9.9.9");
  assert.equal(hostPiVersion({}, join(root, "dist", "bundle", "cli.js")), "9.9.9");
});

test("undeclared entries, other packages and missing paths are unknown, not the imported copy", () => {
  assert.equal(hostPiVersion({}, join(fakePi(), "dist", "cli.js")), "unknown", "only a declared bin is the executing CLI");
  assert.equal(hostPiVersion({}, join(fakePi("some-other-cli"), "pi")), "unknown");
  assert.equal(hostPiVersion({}, "/nonexistent/pi"), "unknown");
  assert.equal(hostPiVersion({}, undefined), "unknown");
  assert.equal(hostPiVersion({ sessionManager: { getSessionId: () => "look-alike" } }, "/nonexistent/pi"), "unknown", "a structural look-alike is not host evidence");
});

test("the host's own session object proves the imported module is the host's", () => {
  const session = SessionManager.inMemory();
  assert.equal(hostPiVersion({ sessionManager: session }, "/nonexistent/pi"), VERSION);
  assert.equal(PI_LIBRARY_VERSION, VERSION);
});

for (const [name, root] of [["native minimum", process.env.CONDUCTOR_NATIVE_PI_ROOT], ...(process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean).map(r => ["H11 matrix", r])] as const) {
  test(`real ${name} Pi root reports its own version from its bin entry`, { skip: root ? false : "no explicit Pi root configured" }, () => {
    const pkg = JSON.parse(readFileSync(join(root!, "package.json"), "utf8"));
    assert.equal(hostPiVersion({}, join(root!, pkg.bin.pi)), pkg.version);
  });
}

test("version warning truth table", () => {
  assert.equal(piVersionWarning("0.99.1", "0.99.1"), undefined);
  assert.equal(piVersionWarning("0.99.1", "0.87.1"), "Pi version mismatch: lead 0.99.1, child 0.87.1");
  assert.equal(piVersionWarning("unknown", "0.87.1"), "Pi version unverified: lead unknown, child 0.87.1");
  assert.equal(piVersionWarning("0.87.1", "unknown"), "Pi version unverified: lead 0.87.1, child unknown");
});
