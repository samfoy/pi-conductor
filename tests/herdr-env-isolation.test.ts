/**
 * The suite must never see herdr's pane env. herdr sets these in every
 * pane it runs, and a `runtime: auto` resolver keyed on them would drive
 * the user's live herdr session from `npm test`. The package.json test
 * scripts strip them with `env -u`.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Names herdr 0.9.1 sets (observed with `env | grep ^HERDR_`).
const HERDR_VARS = [
  "HERDR_ENV",
  "HERDR_SOCKET_PATH",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_SESSION",
  "HERDR_BIN_PATH",
];

test("no HERDR_* variable reaches the test process", () => {
  assert.deepEqual(
    Object.keys(process.env).filter((k) => k.startsWith("HERDR_")),
    [],
    "run the suite through `npm test` / `npm run test:summary`",
  );
});

test("both test scripts unset every herdr variable", () => {
  const scripts = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).scripts;
  for (const name of ["test", "test:summary"]) {
    for (const v of HERDR_VARS) {
      assert.ok(scripts[name].includes(`-u ${v} `), `${name} script unsets ${v}`);
    }
  }
});
