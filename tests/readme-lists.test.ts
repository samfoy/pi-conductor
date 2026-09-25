/**
 * README's tool and slash-command lists name everything the extension
 * registers. They fell behind once (send, worktree), so pin them to the
 * sources of truth: CONDUCTOR_LLM_TOOL_NAMES and SUBCOMMANDS.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SUBCOMMANDS } from "../src/commands.ts";
import { CONDUCTOR_LLM_TOOL_NAMES } from "../src/types.ts";

const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8").split("\n");
const line = (label: string): string => {
  const found = readme.find((l) => l.startsWith(`- **${label}:**`));
  assert.ok(found, `README has a "${label}" line`);
  return found;
};

test("README's LLM tools line names every registered ensemble_* tool", () => {
  const tools = line("LLM tools");
  const missing = CONDUCTOR_LLM_TOOL_NAMES.filter((t) => !tools.includes(`\`${t}\``));
  assert.deepEqual(missing, []);
});

test("README's slash commands line names every /conductor subcommand", () => {
  const listed = line("Slash commands").match(/`\/conductor ([^`]*)`/)?.[1]?.split("|").map((s) => s.trim()) ?? [];
  assert.deepEqual(SUBCOMMANDS.filter((s) => !listed.includes(s)), []);
});
