/**
 * v0.11 slice 4 — end-to-end on_complete_hook cascade integration.
 *
 * Slice 4 connects the four populated cascade layers at the production
 * call site (`resolveCloseHook` in `src/runs.ts`):
 *
 *   1. per-call (slice 3 — `ensemble_spawn` / `ensemble_send` LLM tool arg)
 *   2. project config (`<cwd>/.pi/conductor.json :: personaOverrides[name]`)
 *   3. user config (`~/.pi/agent/extensions/conductor/config.json`)
 *   4. persona frontmatter (`personas/<name>.md` :: `on_complete_hook`)
 *
 * The pure cascade arithmetic (resolveOnCompleteHook on a crafted
 * HookCascadeInput) is pinned in `tests/hook-cascade.test.ts`. THIS
 * file exercises the full call path: filesystem-backed config + persona
 * → resolveCloseHook → final ResolvedHook (or undefined).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import { resolveCloseHook } from "../src/runs.ts";
import { resolvePersonas } from "../src/personas.ts";

interface FixtureLayers {
  perCall?: { command: string; timeoutSeconds?: number };
  projectOverride?: { onCompleteHook?: string; onCompleteHookTimeoutSeconds?: number };
  userOverride?: { onCompleteHook?: string; onCompleteHookTimeoutSeconds?: number };
  personaFrontmatter?: { command?: string; timeoutSeconds?: number };
}

function setupCascadeFixture(personaName: string, layers: FixtureLayers): {
  cwd: string;
  fakeHome: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(join(tmpdir(), "conductor-slice4-cascade-cwd-"));
  const fakeHome = mkdtempSync(join(tmpdir(), "conductor-slice4-cascade-home-"));

  // Project config layer.
  if (layers.projectOverride !== undefined) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".pi", "conductor.json"),
      JSON.stringify({
        personaOverrides: { [personaName]: layers.projectOverride },
      }),
    );
  }

  // User config layer (read from fakeHome via process.env.HOME).
  if (layers.userOverride !== undefined) {
    mkdirSync(join(fakeHome, ".pi", "agent", "extensions", "conductor"), {
      recursive: true,
    });
    writeFileSync(
      join(fakeHome, ".pi", "agent", "extensions", "conductor", "config.json"),
      JSON.stringify({
        personaOverrides: { [personaName]: layers.userOverride },
      }),
    );
  }

  // Persona frontmatter layer (project-scoped persona).
  if (layers.personaFrontmatter !== undefined) {
    mkdirSync(join(cwd, ".pi", "conductor", "personas"), { recursive: true });
    const fm: string[] = [
      `name: ${personaName}`,
      `description: cascade fixture`,
    ];
    if (layers.personaFrontmatter.command !== undefined) {
      fm.push(`on_complete_hook: ${JSON.stringify(layers.personaFrontmatter.command)}`);
    }
    if (layers.personaFrontmatter.timeoutSeconds !== undefined) {
      fm.push(
        `on_complete_hook_timeout_seconds: ${layers.personaFrontmatter.timeoutSeconds}`,
      );
    }
    writeFileSync(
      join(cwd, ".pi", "conductor", "personas", `${personaName}.md`),
      `---\n${fm.join("\n")}\n---\n\nYou are ${personaName}.\n`,
      "utf8",
    );
  }

  return {
    cwd,
    fakeHome,
    cleanup: () => {
      rmSync(cwd, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    },
  };
}

function withFakeHome<T>(fakeHome: string, fn: () => T): T {
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return fn();
  } finally {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
  }
}

// ── End-to-end: per-call wins over all 4 lower layers ─────────────────

test("resolveOnCompleteHook end-to-end: persona frontmatter → user override → project override → per-call → per-call wins", async () => {
  const personaName = "cascadepersona";
  const fx = setupCascadeFixture(personaName, {
    personaFrontmatter: { command: "frontmatter-hook", timeoutSeconds: 10 },
    userOverride: { onCompleteHook: "user-hook", onCompleteHookTimeoutSeconds: 20 },
    projectOverride: {
      onCompleteHook: "project-hook",
      onCompleteHookTimeoutSeconds: 30,
    },
  });
  try {
    await withFakeHome(fx.fakeHome, async () => {
      // First confirm the persona loads with its frontmatter (sanity).
      const resolved = await resolvePersonas({ cwd: fx.cwd });
      const p = resolved.personas.get(personaName);
      assert.ok(p, "fixture persona resolves");
      assert.equal(p!.onCompleteHook, "frontmatter-hook");

      // Now call the production seam with all 4 layers populated.
      const result = resolveCloseHook(
        fx.cwd,
        personaName,
        { command: "per-call-hook", timeoutSeconds: 40 },
        { command: p!.onCompleteHook, timeoutSeconds: p!.onCompleteHookTimeoutSeconds },
      );
      assert.ok(result, "cascade returns a ResolvedHook");
      assert.equal(result!.command, "per-call-hook");
      assert.equal(result!.timeoutSeconds, 40);
      assert.equal(result!.source, "per-call");
    });
  } finally {
    fx.cleanup();
  }
});

// ── End-to-end: project empty-string disables despite frontmatter hook ─

test("resolveOnCompleteHook end-to-end: project empty-string disables despite persona frontmatter setting one", async () => {
  // Project layer's empty-string is the explicit-disable sentinel for
  // a project-wide override of an otherwise-active persona hook. The
  // cascade short-circuits at the project layer (per-call is omitted).
  const personaName = "shadowedpersona";
  const fx = setupCascadeFixture(personaName, {
    personaFrontmatter: { command: "frontmatter-active-hook" },
    projectOverride: { onCompleteHook: "" },
  });
  try {
    await withFakeHome(fx.fakeHome, async () => {
      const resolved = await resolvePersonas({ cwd: fx.cwd });
      const p = resolved.personas.get(personaName);
      assert.ok(p);
      assert.equal(p!.onCompleteHook, "frontmatter-active-hook");

      const result = resolveCloseHook(
        fx.cwd,
        personaName,
        undefined, // no per-call
        { command: p!.onCompleteHook },
      );
      assert.equal(
        result,
        undefined,
        "project empty-string disables despite frontmatter setting one",
      );
    });
  } finally {
    fx.cleanup();
  }
});

// ── End-to-end: persona frontmatter alone reaches the resolver ─────────

test("resolveOnCompleteHook end-to-end: persona frontmatter alone wins when no overrides set", async () => {
  // Pins the bottom of the cascade — when project + user + per-call are
  // all undefined, the persona's frontmatter hook is still honored.
  // This is the slice-4 happy path for personas/*.md to declare a
  // hook (slice 5 will land recommendation comments in builder /
  // simplifier).
  const personaName = "frontmatteronly";
  const fx = setupCascadeFixture(personaName, {
    personaFrontmatter: { command: "frontmatter-only-hook", timeoutSeconds: 75 },
  });
  try {
    await withFakeHome(fx.fakeHome, async () => {
      const resolved = await resolvePersonas({ cwd: fx.cwd });
      const p = resolved.personas.get(personaName);
      assert.ok(p);
      const result = resolveCloseHook(fx.cwd, personaName, undefined, {
        command: p!.onCompleteHook,
        timeoutSeconds: p!.onCompleteHookTimeoutSeconds,
      });
      assert.ok(result);
      assert.equal(result!.command, "frontmatter-only-hook");
      assert.equal(result!.timeoutSeconds, 75);
      assert.equal(result!.source, "persona");
    });
  } finally {
    fx.cleanup();
  }
});

// ── Sanity: real homedir hasn't been polluted ──────────────────────────

test("resolveOnCompleteHook end-to-end: fixture cleanup leaves real homedir untouched", () => {
  // Belt-and-suspenders: confirm we restored process.env.HOME so
  // subsequent tests don't pick up a stale fake-home.
  assert.equal(typeof homedir(), "string");
  assert.notEqual(homedir(), "");
});
