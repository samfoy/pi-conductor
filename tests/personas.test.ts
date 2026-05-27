/**
 * Tests for the frontmatter parser and persona validator.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  builtinPersonasDir,
  parseFrontmatter,
  resolveBuiltinPersonasDir,
  resolvePersonas,
} from "../src/personas.ts";

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

// ── v0.8.1 Item 1 — PRD Open Q #16 inherit_context audit ──
//
// Pins the per-persona table from docs/v0.8.1-item1-design.md §5. Future
// drift on any of the 16 shipped personas fails this test loudly. Frontmatter-
// only assertion (no body checks) — the audit is about routing decisions, not
// behavior.

test("personas: v0.8.1 inherit_context audit (PRD Open Q #16 fold-in)", () => {
  const expected: Record<string, "none" | "filtered" | "filtered_compact" | "full"> = {
    // 7 read-only specialists / gates flipped to none in v0.8.1.
    oracle: "none",
    redteam: "none",
    inspector: "none",
    analyst: "none",
    profiler: "none",
    scribe: "none",
    verifier: "none",
    // 9 personas keep filtered (trajectory-needers, gates with parent context
    // value, and write-capable producers).
    investigator: "filtered",
    clarifier: "filtered",
    cartographer: "filtered",
    critic: "filtered",
    finalizer: "filtered",
    designer: "filtered",
    planner: "filtered",
    simplifier: "filtered_compact",
    builder: "filtered_compact",
  };

  const dir = builtinPersonasDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  // Sanity: 16 shipped personas. If this fails, either a persona was added
  // or removed without updating the audit — update the table above first.
  assert.equal(files.length, 16, `expected 16 personas, found ${files.length}`);

  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const { frontmatter } = parseFrontmatter(text);
    const name = String(frontmatter.name);
    const expectedInherit = expected[name];
    assert.ok(
      expectedInherit !== undefined,
      `persona '${name}' (${file}) is not in the v0.8.1 audit table; update docs/v0.8.1-item1-design.md §5 and this test`,
    );
    assert.equal(
      frontmatter.inherit_context,
      expectedInherit,
      `persona '${name}' inherit_context drifted from v0.8.1 audit (expected '${expectedInherit}', got '${frontmatter.inherit_context}')`,
    );
  }
});

test("resolveBuiltinPersonasDir: canonicalizes through legacy symlink layout", () => {
  // Reproduces the v0.8 failure mode: pi-conductor loaded via a legacy
  // ~/.pi/agent/extensions/conductor/index.js symlink whose target lives
  // at <pkg>/dist/index.js. Without realpathSync, walking `..` from the
  // symlink path lands on ~/.pi/agent/extensions/, which has no
  // personas/ dir, so 0 personas resolve.
  const root = mkdtempSync(join(tmpdir(), "conductor-symlink-test-"));
  // Real package layout: <root>/pkg/{dist/index.js, personas/<name>.md}
  const pkgDir = join(root, "pkg");
  const distDir = join(pkgDir, "dist");
  const personasDir = join(pkgDir, "personas");
  mkdirSync(distDir, { recursive: true });
  mkdirSync(personasDir, { recursive: true });
  const realDistFile = join(distDir, "index.js");
  writeFileSync(realDistFile, "// fake bundle\n");
  writeFileSync(
    join(personasDir, "tester.md"),
    "---\nname: tester\ndescription: t\n---\nbody",
  );

  // Legacy install: <root>/legacy/conductor/index.js -> <root>/pkg/dist/index.js
  const legacyConductorDir = join(root, "legacy", "conductor");
  mkdirSync(legacyConductorDir, { recursive: true });
  const legacySymlink = join(legacyConductorDir, "index.js");
  symlinkSync(realDistFile, legacySymlink);

  // Caller-perspective: import.meta.url would resolve to the symlink path.
  const symlinkUrl = pathToFileURL(legacySymlink).href;
  const resolved = resolveBuiltinPersonasDir(symlinkUrl);

  // Must resolve to the REAL package's personas/, not <root>/legacy/personas/.
  assert.equal(resolved, personasDir);
  assert.notEqual(resolved, join(root, "legacy", "personas"));
});

test("resolveBuiltinPersonasDir: passes through non-symlink paths unchanged", () => {
  // Sanity: realpathSync on a real file is a no-op (modulo absolute-path
  // canonicalization). The walk still lands on <pkg>/personas/.
  const root = mkdtempSync(join(tmpdir(), "conductor-realpath-test-"));
  const distDir = join(root, "dist");
  const personasDir = join(root, "personas");
  mkdirSync(distDir, { recursive: true });
  mkdirSync(personasDir, { recursive: true });
  const realFile = join(distDir, "index.js");
  writeFileSync(realFile, "// real bundle\n");

  const resolved = resolveBuiltinPersonasDir(pathToFileURL(realFile).href);
  assert.equal(resolved, personasDir);
});
