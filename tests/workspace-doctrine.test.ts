import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { assemblePersonaSystemPrompt } from "../src/runs.ts";
import type { Persona } from "../src/types.ts";
import {
  DOCTRINE_HEADING,
  MAX_DOCTRINE_CHARS,
  MAX_WALK_DEPTH,
  loadWorkspaceDoctrine,
} from "../src/workspace-doctrine.ts";

function tree(doctrine = "RULE: redirect every build to a log file.\n") {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-conductor-doctrine-"));
  const root = join(sandbox, "Workspace");
  const pkg = join(root, "src", "Package");
  mkdirSync(join(pkg, ".git"), { recursive: true });
  writeFileSync(join(root, "AGENTS.md"), doctrine);
  return { root, pkg };
}

function persona(): Persona {
  return {
    name: "builder",
    description: "test",
    inheritContext: "filtered",
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 30,
    systemPrompt: "PERSONA_BODY",
    source: "builtin",
    sourcePath: "/tmp/builder.md",
    readOnly: false,
  };
}

test("loads an AGENTS.md above a nested package git root", () => {
  const { root, pkg } = tree();
  const block = loadWorkspaceDoctrine(pkg);
  assert.ok(block.startsWith(DOCTRINE_HEADING));
  assert.ok(block.includes(join(root, "AGENTS.md")));
  assert.ok(block.includes("redirect every build"));
});

test("skips AGENTS.md that the child loads natively", () => {
  const { root } = tree();
  assert.equal(loadWorkspaceDoctrine(root), "");
});

test("stops at the bounded ancestor depth", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-conductor-depth-"));
  writeFileSync(join(sandbox, "AGENTS.md"), "TOO FAR");
  let deep = sandbox;
  for (let i = 0; i < MAX_WALK_DEPTH + 2; i++) deep = join(deep, `d${i}`);
  mkdirSync(deep, { recursive: true });
  assert.equal(loadWorkspaceDoctrine(deep), "");
});

test("truncates oversized doctrine with a visible marker", () => {
  const { pkg } = tree(`${"x".repeat(79)}\n`.repeat(400));
  const block = loadWorkspaceDoctrine(pkg);
  assert.ok(block.includes(`truncated at ${MAX_DOCTRINE_CHARS / 1000} KB`));
  assert.ok(block.includes("AGENTS.md for the remainder]"));
});

test("prompt order is persona, standing doctrine, workspace doctrine", () => {
  const { pkg } = tree();
  const prompt = assemblePersonaSystemPrompt(persona(), pkg);
  assert.ok(prompt.indexOf("PERSONA_BODY") < prompt.indexOf("## Standing doctrine"));
  assert.ok(prompt.indexOf("## Standing doctrine") < prompt.indexOf(DOCTRINE_HEADING));
});
