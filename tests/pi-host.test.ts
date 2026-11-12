import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";
import { captureLeadPiVersion, hostPiCommand, hostPiVersion, PI_LIBRARY_VERSION } from "../src/pi-host.ts";
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

test("the hc pi command is node plus the realpath of the declared bin, and nothing when that is unprovable", () => {
  const root = fakePi();
  assert.deepEqual(hostPiCommand(join(root, "pi"), "/opt/node/bin/node"), ["/opt/node/bin/node", realpathSync(join(root, "dist", "bundle", "cli.js"))]);
  assert.deepEqual(hostPiCommand(join(root, "pi")), [process.execPath, realpathSync(join(root, "dist", "bundle", "cli.js"))]);
  for (const entry of [join(fakePi(), "dist", "cli.js"), join(fakePi("some-other-cli"), "pi"), "/nonexistent/pi", undefined, "pi"]) {
    assert.equal(hostPiCommand(entry, "/opt/node/bin/node"), undefined, `${entry}: never a bare pi`);
  }
  assert.equal(hostPiCommand(join(root, "pi"), "node"), undefined, "a relative node is unprovable too");
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

test("the lead's Pi version is captured at load: an in-place update on disk after load is a mismatch with the updated child", () => {
  const root = fakePi("@earendil-works/pi-coding-agent", "1.5.2");
  const lead = captureLeadPiVersion(join(root, "pi"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "1.6.0", bin: { pi: "dist/bundle/cli.js" } }));
  assert.equal(hostPiVersion({}, join(root, "pi")), "1.6.0", "disk now shows the update");
  assert.equal(lead.version(), "1.5.2", "the lead still runs what it loaded");
  assert.equal(piVersionWarning(lead.version(), "1.6.0"), "Pi version mismatch: lead 1.5.2, child 1.6.0");
});

test("the lead's own session object, once seen, makes the in-memory VERSION the lead's version; a look-alike changes nothing", () => {
  const lead = captureLeadPiVersion("/nonexistent/pi");
  assert.equal(lead.version(), "unknown");
  lead.prove({ getSessionId: () => "look-alike" });
  assert.equal(lead.version(), "unknown", "a structural look-alike is not host evidence");
  lead.prove(SessionManager.inMemory());
  assert.equal(lead.version(), VERSION);
  lead.prove(undefined);
  assert.equal(lead.version(), VERSION, "the proof is about module identity, which a later session cannot undo");
});
