/**
 * Smoke test: confirm every shipped persona file parses cleanly.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolvePersonas, builtinPersonasDir } from "../src/personas.ts";
import { readdirSync } from "node:fs";

test("all 16 shipped personas load without errors", async () => {
  // Use a tmp HOME so user/project directories don't pollute results.
  const realHome = process.env.HOME;
  process.env.HOME = "/tmp/__nonexistent_home_for_conductor_test__";

  try {
    const r = await resolvePersonas({ cwd: "/tmp/__nonexistent_cwd_for_conductor_test__" });

    // Every shipped persona must resolve.
    const expected = readdirSync(builtinPersonasDir())
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();

    assert.equal(expected.length, 16, `expected 16 personas, found ${expected.length}`);

    const got = [...r.personas.keys()].sort();
    assert.deepEqual(got, expected);

    // No parse errors.
    assert.deepEqual(r.errors, []);

    // Every persona has a non-empty system prompt and a description.
    for (const p of r.personas.values()) {
      assert.ok(p.description.length > 0, `${p.name}: empty description`);
      assert.ok(p.systemPrompt.length > 200, `${p.name}: system prompt too short`);
      assert.equal(p.source, "builtin");
    }
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});

test("starter roster matches the v0.4 PRD list", async () => {
  const realHome = process.env.HOME;
  process.env.HOME = "/tmp/__nonexistent_home_for_conductor_test__";

  try {
    const r = await resolvePersonas({ cwd: "/tmp/__nonexistent_cwd_for_conductor_test__" });
    const names = [...r.personas.keys()].sort();

    const expected = [
      "analyst",
      "builder",
      "cartographer",
      "clarifier",
      "critic",
      "designer",
      "finalizer",
      "inspector",
      "investigator",
      "oracle",
      "planner",
      "profiler",
      "redteam",
      "scribe",
      "simplifier",
      "verifier",
    ];
    assert.deepEqual(names, expected);
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});

test("personas with default_reads parse the list correctly", async () => {
  const realHome = process.env.HOME;
  process.env.HOME = "/tmp/__nonexistent_home_for_conductor_test__";

  try {
    const r = await resolvePersonas({ cwd: "/tmp/__nonexistent_cwd_for_conductor_test__" });
    const oracle = r.personas.get("oracle");
    assert.ok(oracle);
    assert.deepEqual(oracle.defaultReads, ["context.md", "design.md", "plan.md"]);

    const builder = r.personas.get("builder");
    assert.ok(builder);
    assert.deepEqual(builder.defaultReads, ["context.md", "plan.md"]);

    const inspector = r.personas.get("inspector");
    assert.ok(inspector);
    assert.deepEqual(inspector.defaultReads, []);
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});

test("review/research/writing personas inherit parent skills for project overlays", async () => {
  const realHome = process.env.HOME;
  process.env.HOME = "/tmp/__nonexistent_home_for_conductor_test__";

  // Personas whose job overlaps the user's skill catalog (code-review,
  // doc-review, diagnose, evergreen-vault, cr-workflow, etc.) and where
  // pulling project overlays from <cwd>/.pi/skills/ is clearly useful.
  // The orchestrator-driven workers (builder, simplifier, planner) and
  // pure-dialog clarifier deliberately stay opt-out.
  const shouldInherit = [
    "analyst",
    "cartographer",
    "critic",
    "designer",
    "finalizer",
    "inspector",
    "investigator",
    "oracle",
    "profiler",
    "redteam",
    "scribe",
    "verifier",
  ];
  const shouldNotInherit = ["builder", "clarifier", "planner", "simplifier"];

  try {
    const r = await resolvePersonas({ cwd: "/tmp/__nonexistent_cwd_for_conductor_test__" });
    for (const name of shouldInherit) {
      const p = r.personas.get(name);
      assert.ok(p, `${name} persona missing`);
      assert.equal(
        p.inheritSkills,
        true,
        `${name} should set inherit_skills: true so it picks up the user's review/workflow skills`,
      );
    }
    for (const name of shouldNotInherit) {
      const p = r.personas.get(name);
      assert.ok(p, `${name} persona missing`);
      assert.equal(
        p.inheritSkills,
        false,
        `${name} should NOT inherit skills — orchestrator drives workflow skills, not the sub-agent`,
      );
    }
  } finally {
    if (realHome !== undefined) process.env.HOME = realHome;
    else delete process.env.HOME;
  }
});
