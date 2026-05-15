#!/usr/bin/env node
/**
 * One-shot migration: rewrite all `@mariozechner/pi-*` imports to
 * `@earendil-works/pi-*`. The pi-coding-agent project moved namespaces
 * upstream; this is the conductor-side rename.
 *
 * Run from the repo root: node tools/rename-pi-namespace.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOTS = ["src", "tests"];
const FROM = "@mariozechner/pi-";
const TO = "@earendil-works/pi-";

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      yield* walk(p);
    } else if (s.isFile() && /\.(ts|tsx|js|mjs|cjs|md|json)$/.test(name)) {
      yield p;
    }
  }
}

let touched = 0;
for (const root of ROOTS) {
  for (const path of walk(root)) {
    const before = readFileSync(path, "utf8");
    if (!before.includes(FROM)) continue;
    const after = before.replaceAll(FROM, TO);
    writeFileSync(path, after);
    touched++;
    console.log(`updated: ${path}`);
  }
}
console.log(`\n${touched} file(s) updated`);
