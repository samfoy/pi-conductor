/**
 * Tests for the frontmatter parser and persona validator.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  builtinPersonasDir,
  parseFrontmatter,
  resolveBuiltinPersonasDir,
  resolvePersonas,
} from "../src/personas.ts";
import { readdir } from "node:fs/promises";

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

// ── read_only audit (item 13 fix candidate #1) ────────────────────────
//
// Mirrors the v0.8.1 inherit_context audit shape. Pins which personas
// are read-only versus write-capable. The 10 read-only personas get an
// auto-prepended scope-enforcer block in their system prompt at spawn
// time (see `tests/read-only-enforcer.test.ts`). The 6 write-capable
// personas do not. Closes the silent-scope-drift class documented in
// `docs/backlog.md` item 13 (critic-z8v9 witness, 2026-05-28).

test("personas: read_only audit (docs/backlog.md item 13 fix candidate #1)", () => {
  // 10 read-only personas — bodies declare "No edits" / "No fixes" /
  // "Read-only" / "no optimization, no edits" / gate-only behavior.
  // 6 write-capable personas — bodies implement code (builder),
  // simplifications (simplifier), or write specific artifacts
  // (cartographer/designer/planner/scribe).
  const expected: Record<string, boolean> = {
    // 10 read-only.
    analyst: true,
    clarifier: true,
    critic: true,
    finalizer: true,
    inspector: true,
    investigator: true,
    oracle: true,
    profiler: true,
    redteam: true,
    verifier: true,
    // 6 write-capable.
    builder: false,
    cartographer: false,
    designer: false,
    planner: false,
    scribe: false,
    simplifier: false,
  };

  const dir = builtinPersonasDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  assert.equal(files.length, 16, `expected 16 personas, found ${files.length}`);

  for (const file of files) {
    const text = readFileSync(join(dir, file), "utf8");
    const { frontmatter } = parseFrontmatter(text);
    const name = String(frontmatter.name);
    const expectedReadOnly = expected[name];
    assert.ok(
      expectedReadOnly !== undefined,
      `persona '${name}' (${file}) is not in the read_only audit table; update tests/personas.test.ts and docs/backlog.md item 13`,
    );
    // Frontmatter parser default: undefined → false. Both representations
    // are equivalent at the Persona-type level (Persona.readOnly is
    // strictly boolean post-parse). The audit pins the YAML shape:
    //   read_only: true   for the 10 read-only personas
    //   <field absent>    for the 6 write-capable personas
    if (expectedReadOnly === true) {
      assert.equal(
        frontmatter.read_only,
        true,
        `persona '${name}' read_only drifted (expected true, got ${String(frontmatter.read_only)})`,
      );
    } else {
      assert.ok(
        frontmatter.read_only === undefined || frontmatter.read_only === false,
        `persona '${name}' is write-capable but has read_only=${String(frontmatter.read_only)} (expected undefined or false)`,
      );
    }
  }
});

test("personas: parser populates Persona.readOnly with default false (write-capable)", () => {
  // Pins the parser default so a regression that strips the readOnly
  // field from validateAndBuild() is caught even if no persona file
  // changes.
  const text = `---
name: tester
description: test
inherit_context: filtered
---

body`;
  const { frontmatter, body } = parseFrontmatter(text);
  assert.equal(frontmatter.read_only, undefined);
  assert.ok(body.includes("body"));
});

test("resolveBuiltinPersonasDir: canonicalizes through legacy symlink layout", () => {
  // Reproduces the v0.8 failure mode: pi-conductor loaded via a legacy
  // ~/.pi/agent/extensions/conductor/index.js symlink whose target lives
  // at <pkg>/dist/index.js. Without realpathSync, walking `..` from the
  // symlink path lands on ~/.pi/agent/extensions/, which has no
  // personas/ dir, so 0 personas resolve.
  // Use realpathSync on root so macOS /var→/private/var symlink doesn't cause mismatches.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conductor-symlink-test-")));
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
  // Use realpathSync on root so macOS /var→/private/var symlink doesn't cause mismatches.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "conductor-realpath-test-")));
  const distDir = join(root, "dist");
  const personasDir = join(root, "personas");
  mkdirSync(distDir, { recursive: true });
  mkdirSync(personasDir, { recursive: true });
  const realFile = join(distDir, "index.js");
  writeFileSync(realFile, "// real bundle\n");

  const resolved = resolveBuiltinPersonasDir(pathToFileURL(realFile).href);
  assert.equal(resolved, personasDir);
});

// ── v0.12 Slice 1 — negative test for `steerable` frontmatter parsing ──
//
// Per oracle fix #1 (`docs/v0.12-steering-design.md` revision log
// 2026-05-27): the v0.12 `steerable` cascade has NO persona-frontmatter
// layer. Mirrors v0.10 `kill_on_stall`'s deferred shape exactly
// (`PRD.md:517`). The two cascades MUST stay isomorphic; a future PRD
// entry that adds a frontmatter layer to one upgrades both.
//
// This test pins the absence: the parser MUST NOT extract `steerable`
// from frontmatter into the resolved `Persona`, even when present.
// Critic gate 2 (out-of-scope check) for slice 1 also greps `src/`
// and should NOT find `steerable` in `src/personas.ts`.

test("personas: v0.12 schema accepts no `steerable` field (parser does not extend Persona for steerable in v0.12)", async () => {
  // Round-trip a persona file with `steerable: true` in frontmatter
  // through the public parse → build pipeline. The resulting object
  // MUST NOT carry a `steerable` property; if a future slice silently
  // adds frontmatter parsing, this test catches it.
  const tempDir = mkdtempSync(join(tmpdir(), "persona-steerable-neg-"));
  const file = join(tempDir, "with-steerable.md");
  writeFileSync(
    file,
    `---\nname: with-steerable\ndescription: probe\nsteerable: true\n---\n\nbody`,
    "utf8",
  );
  const text = readFileSync(file, "utf8");
  const { frontmatter } = parseFrontmatter(text);
  // Frontmatter parsing keeps unknown keys around (raw map); the
  // validate-and-build step is what's responsible for filtering them
  // out of the typed Persona. Verify the raw frontmatter sees the key
  // (so we know the test fixture is valid).
  assert.equal(frontmatter.steerable, true, "raw frontmatter parser must surface the key");

  // Drop a real persona file into a temp builtin dir and resolve via
  // the production `resolvePersonas`. The resolved Persona object
  // MUST NOT have a `steerable` property.
  const userPersonaDir = join(tempDir, ".pi", "agent", "conductor", "personas");
  mkdirSync(userPersonaDir, { recursive: true });
  writeFileSync(
    join(userPersonaDir, "steertest.md"),
    `---\nname: steertest\ndescription: probe\nsteerable: true\n---\n\nYou are steertest.\n`,
    "utf8",
  );
  const homeDir = tempDir;
  const origHome = process.env.HOME;
  process.env.HOME = homeDir;
  try {
    const resolved = await resolvePersonas({ cwd: tempDir });
    const p = resolved.personas.get("steertest");
    if (p) {
      // Persona type does not declare `steerable`; the parser MUST
      // not have set it. Use Object.hasOwn so we catch undefined-via-
      // declared and undefined-via-absent equivalently.
      assert.equal(
        Object.hasOwn(p, "steerable"),
        false,
        "resolved Persona must NOT carry a `steerable` property; v0.12 explicitly defers frontmatter parsing",
      );
      // Belt-and-suspenders: assert via dynamic property access too.
      assert.equal(
        (p as unknown as Record<string, unknown>).steerable,
        undefined,
        "resolved Persona must NOT have a truthy `steerable` value",
      );
    }
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  }
});

// ── v0.11 slice 4: on_complete_hook frontmatter parsing ─────────────────
//
// Slice 1a extended `Persona` with `onCompleteHook` /
// `onCompleteHookTimeoutSeconds` (typed-only). Slice 4 wires the
// frontmatter parser to populate them. Empty string is preserved
// (cascade resolver treats it as the explicit-disable sentinel).

test("parseFrontmatter: on_complete_hook string scalar parses", () => {
  const r = parseFrontmatter(
    `---
name: gated
description: gated persona
on_complete_hook: "npm test"
---
body`,
  );
  assert.equal(r.frontmatter.on_complete_hook, "npm test");
});

test("parseFrontmatter: on_complete_hook_timeout_seconds number parses", () => {
  const r = parseFrontmatter(
    `---
name: gated
description: gated persona
on_complete_hook: "npm test"
on_complete_hook_timeout_seconds: 600
---
body`,
  );
  assert.equal(r.frontmatter.on_complete_hook_timeout_seconds, 600);
});

test("Persona: on_complete_hook surfaces from frontmatter via validateAndBuild", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "conductor-slice4-frontmatter-"));
  mkdirSync(join(tempDir, ".pi", "conductor", "personas"), { recursive: true });
  writeFileSync(
    join(tempDir, ".pi", "conductor", "personas", "gated.md"),
    `---
name: gated
description: gated persona
on_complete_hook: "npm test"
on_complete_hook_timeout_seconds: 600
---

You are gated.
`,
    "utf8",
  );
  const origHome = process.env.HOME;
  process.env.HOME = tempDir;
  try {
    const resolved = await resolvePersonas({ cwd: tempDir });
    const p = resolved.personas.get("gated");
    assert.ok(p, "persona resolves");
    assert.equal(p!.onCompleteHook, "npm test");
    assert.equal(p!.onCompleteHookTimeoutSeconds, 600);
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  }
});

test("Persona: on_complete_hook=\"\" preserves empty string (disable sentinel)", async () => {
  // The cascade resolver short-circuits on empty `command`. The
  // frontmatter parser must not coerce `""` to undefined — doing so
  // would silently fall through to lower cascade layers.
  const tempDir = mkdtempSync(join(tmpdir(), "conductor-slice4-empty-"));
  mkdirSync(join(tempDir, ".pi", "conductor", "personas"), { recursive: true });
  writeFileSync(
    join(tempDir, ".pi", "conductor", "personas", "disabled.md"),
    `---
name: disabled
description: hook explicitly off
on_complete_hook: ""
---

You are disabled.
`,
    "utf8",
  );
  const origHome = process.env.HOME;
  process.env.HOME = tempDir;
  try {
    const resolved = await resolvePersonas({ cwd: tempDir });
    const p = resolved.personas.get("disabled");
    assert.ok(p);
    assert.equal(p!.onCompleteHook, "");
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  }
});

test("Persona: on_complete_hook_timeout_seconds rejects zero", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "conductor-slice4-zero-"));
  mkdirSync(join(tempDir, ".pi", "conductor", "personas"), { recursive: true });
  writeFileSync(
    join(tempDir, ".pi", "conductor", "personas", "bad.md"),
    `---
name: bad
description: bad persona
on_complete_hook_timeout_seconds: 0
---

body
`,
    "utf8",
  );
  const origHome = process.env.HOME;
  process.env.HOME = tempDir;
  try {
    const resolved = await resolvePersonas({ cwd: tempDir });
    // Validation failure surfaces as a load error, not a thrown call.
    assert.equal(
      resolved.personas.get("bad"),
      undefined,
      "degenerate persona must not load",
    );
    assert.ok(
      resolved.errors.some((e) =>
        /on_complete_hook_timeout_seconds/.test(e.reason ?? ""),
      ),
      "error mentions the offending field",
    );
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  }
});

test("personas: no shipped persona declares an active on_complete_hook frontmatter field", async () => {
  // Slice 4 ships type plumbing; slice 5 lands recommendation
  // comments inside personas/*.md. No shipped persona declares a
  // hook in v0.11. This regression catches accidental drift.
  const dir = builtinPersonasDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const body = readFileSync(join(dir, f), "utf8");
    // Match an UNCOMMENTED YAML key. A leading `# ` (recommendation
    // comment) is allowed; bare `on_complete_hook:` at the start of
    // a frontmatter line is the regression.
    const offending = body
      .split("\n")
      .filter((line) => /^\s*on_complete_hook(_timeout_seconds)?\s*:/.test(line));
    assert.equal(
      offending.length,
      0,
      `${f} declares on_complete_hook frontmatter (forbidden in slice 4): ${offending.join(" | ")}`,
    );
  }
});
