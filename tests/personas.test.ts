/**
 * Tests for the frontmatter parser and persona validator.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter, resolvePersonas } from "../src/personas.ts";

test("parseFrontmatter: empty body without frontmatter", () => {
  const r = parseFrontmatter("hello world");
  assert.deepEqual(r.frontmatter, {});
  assert.equal(r.body, "hello world");
});

test("parseFrontmatter: scalar fields", () => {
  const r = parseFrontmatter(
    `---
name: oracle
description: second opinion
worktree: false
timeout_minutes: 30
---
body content`,
  );
  assert.equal(r.frontmatter.name, "oracle");
  assert.equal(r.frontmatter.description, "second opinion");
  assert.equal(r.frontmatter.worktree, false);
  assert.equal(r.frontmatter.timeout_minutes, 30);
  assert.equal(r.body, "body content");
});

test("parseFrontmatter: list fields", () => {
  const r = parseFrontmatter(
    `---
name: oracle
description: x
default_reads:
  - plan.md
  - progress.md
---
body`,
  );
  assert.deepEqual(r.frontmatter.default_reads, ["plan.md", "progress.md"]);
});

test("parseFrontmatter: quoted strings preserved", () => {
  const r = parseFrontmatter(
    `---
name: oracle
description: "second opinion: with colons"
---
body`,
  );
  assert.equal(r.frontmatter.description, "second opinion: with colons");
});

test("parseFrontmatter: throws on unclosed frontmatter", () => {
  assert.throws(() =>
    parseFrontmatter(
      `---
name: oracle
body without closing fence`,
    ),
  );
});

test("resolvePersonas: project overrides user", async () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-test-"));
  const homeDir = join(root, "home");
  const projectDir = join(root, "proj");
  const userPersonaDir = join(homeDir, ".pi", "agent", "conductor", "personas");
  const projectPersonaDir = join(projectDir, ".pi", "conductor", "personas");
  mkdirSync(userPersonaDir, { recursive: true });
  mkdirSync(projectPersonaDir, { recursive: true });

  // Override HOME so the loader looks at our tmp dir.
  const realHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    writeFileSync(
      join(userPersonaDir, "shared.md"),
      `---
name: shared
description: USER VERSION
---
user prompt body`,
    );
    writeFileSync(
      join(projectPersonaDir, "shared.md"),
      `---
name: shared
description: PROJECT VERSION
---
project prompt body`,
    );

    const r = await resolvePersonas({ cwd: projectDir });
    const shared = r.personas.get("shared");
    assert.ok(shared);
    assert.equal(shared.description, "PROJECT VERSION");
    assert.equal(shared.source, "project");
    assert.equal(r.shadowed.get("shared")?.length, 2);
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});

test("resolvePersonas: persona override applies model + thinking", async () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-test-"));
  const homeDir = join(root, "home");
  const userPersonaDir = join(homeDir, ".pi", "agent", "conductor", "personas");
  mkdirSync(userPersonaDir, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    writeFileSync(
      join(userPersonaDir, "oracle.md"),
      `---
name: oracle
description: second opinion
---
prompt body`,
    );

    const r = await resolvePersonas({
      cwd: root,
      personaOverrides: {
        oracle: { model: "anthropic/claude-opus-4-1", thinking: "high" },
      },
    });
    const oracle = r.personas.get("oracle");
    assert.ok(oracle);
    assert.equal(oracle.model, "anthropic/claude-opus-4-1");
    assert.equal(oracle.thinking, "high");
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});

test("resolvePersonas: disabled override removes persona", async () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-test-"));
  const homeDir = join(root, "home");
  const userPersonaDir = join(homeDir, ".pi", "agent", "conductor", "personas");
  mkdirSync(userPersonaDir, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    writeFileSync(
      join(userPersonaDir, "redteam.md"),
      `---
name: redteam
description: adversarial review
---
prompt body`,
    );

    const r = await resolvePersonas({
      cwd: root,
      personaOverrides: { redteam: { disabled: true } },
    });
    assert.equal(r.personas.has("redteam"), false);
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});

test("resolvePersonas: malformed file recorded as error, not crash", async () => {
  const root = mkdtempSync(join(tmpdir(), "conductor-test-"));
  const homeDir = join(root, "home");
  const userPersonaDir = join(homeDir, ".pi", "agent", "conductor", "personas");
  mkdirSync(userPersonaDir, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = homeDir;

  try {
    writeFileSync(
      join(userPersonaDir, "broken.md"),
      `---
name: broken
# missing description
---
body`,
    );
    writeFileSync(
      join(userPersonaDir, "ok.md"),
      `---
name: ok
description: fine
---
prompt`,
    );

    const r = await resolvePersonas({ cwd: root });
    assert.equal(r.personas.has("ok"), true);
    assert.equal(r.personas.has("broken"), false);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]?.path ?? "", /broken\.md$/);
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});
