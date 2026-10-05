/**
 * Enforced persona tool policy: `tools` (allowlist → `pi --tools`) and
 * `exclude_tools` (denylist → `pi --exclude-tools`, always unioned with
 * the conductor's own LLM tool names).
 *
 * Pi 0.87 filters both builtin and extension tools through Set-based
 * allow/exclude lists (`dist/core/sdk.js`, `dist/core/agent-session.js`
 * `_refreshToolRegistry`), so unknown names are harmless no-ops.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONDUCTOR_LLM_TOOL_NAMES,
  FOREIGN_SPAWN_TOOLS,
  LEGACY_CHILD_SCOPE,
  SUPERVISION_TOOL_NAMES,
  toRunRecord,
  type ChildToolScope,
  type Persona,
  type PersonaOverride,
  type Run,
} from "../src/types.ts";
import {
  builtinPersonasDir,
  effectiveAllowTools,
  effectiveExcludeTools,
  parseFrontmatter,
  resolvePersonas,
} from "../src/personas.ts";
import { buildPiArgs, buildResumePiArgs, planSpawnPiArgs, RunRegistry } from "../src/runs.ts";
import { formatPersonaListForLLM, registerTools } from "../src/tools.ts";
import { formatPersonaDetail } from "../src/commands.ts";
import { reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { loadConfig } from "../src/config.ts";
import { SpawnQueue } from "../src/queue.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";

const READ_ONLY_EXCLUSIONS = ["edit", "write", "insert_before", "insert_after"];
/** What every depth-1 child excludes after the persona's own list (a delegator keeps only `delegate`). */
const ALWAYS_EXCLUDED = [...CONDUCTOR_LLM_TOOL_NAMES, ...FOREIGN_SPAWN_TOOLS, "chief", "peer", "staff", "delegate"];

/** Value following `flag`, asserting the flag appears at most once. */
function flagValue(args: string[], flag: string): string | undefined {
  const hits = args.filter((a) => a === flag).length;
  assert.ok(hits <= 1, `${flag} must appear at most once; got ${hits}`);
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

function withSandbox<T>(fn: (dirs: { home: string; proj: string; personaDir: string }) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "conductor-tool-policy-"));
  const home = join(root, "home");
  const proj = join(root, "proj");
  const personaDir = join(proj, ".pi", "conductor", "personas");
  mkdirSync(join(home, ".pi", "agent", "conductor", "personas"), { recursive: true });
  mkdirSync(personaDir, { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = home;
  return fn({ home, proj, personaDir }).finally(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    rmSync(root, { recursive: true, force: true });
  });
}

function personaFile(name: string, extraFrontmatter: string): string {
  return `---\nname: ${name}\ndescription: probe persona\n${extraFrontmatter}---\n\nYou are ${name}.\n`;
}

async function resolveOne(
  frontmatter: string,
  overrides?: Record<string, PersonaOverride>,
): Promise<{ persona: Persona | undefined; errors: string[] }> {
  return withSandbox(async ({ proj, personaDir }) => {
    writeFileSync(join(personaDir, "probe.md"), personaFile("probe", frontmatter));
    const r = await resolvePersonas({ cwd: proj, personaOverrides: overrides });
    return {
      persona: r.personas.get("probe"),
      errors: r.errors.map((e) => `${e.path}: ${e.reason}`),
    };
  });
}

/** Tool names `registerTools` registers under an injected env (the lead's by default). */
function captureRegisteredToolNames(env: NodeJS.ProcessEnv = {}, supervision?: unknown, chief?: unknown): string[] {
  const names: string[] = [];
  const reg = new RunRegistry();
  const queue = new SpawnQueue(reg, 4);
  const model = new FocusedStreamModel(reg);
  const activation = supervision ? { getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [] } : {};
  registerTools({ registerTool: (t: { name: string }) => names.push(t.name), ...activation } as any, {
    ...(supervision ? { supervision: supervision as never } : {}),
    ...(chief ? { chief: chief as never } : {}),
    getCwd: () => tmpdir(),
    getRegistry: () => reg,
    getQueue: () => queue,
    getModel: () => model,
    getParentMessages: () => [],
    openFocusedOverlay: () => {},
    registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister: () => {} }),
    pushCompletionNotification: () => {},
  }, env);
  return names;
}

function makePersona(overrides: Partial<Persona> = {}): Persona {
  return {
    name: "probe",
    description: "probe persona",
    inheritContext: "none",
    inheritSkills: false,
    defaultReads: [],
    worktree: false,
    timeoutMinutes: 10,
    systemPrompt: "You are probe.",
    source: "builtin",
    sourcePath: "/fake/probe.md",
    readOnly: false,
    ...overrides,
  };
}

// ── The always-excluded conductor tool names ─────────────────────────

test("CONDUCTOR_LLM_TOOL_NAMES is exactly the set of tools registerTools registers", () => {
  const registered = captureRegisteredToolNames();
  assert.equal(registered.length, CONDUCTOR_LLM_TOOL_NAMES.length, "sanity: registerTools registers the ensemble_* surface");
  assert.deepEqual([...CONDUCTOR_LLM_TOOL_NAMES].sort(), [...registered].sort());
});

// N1/N2: set equality per injected env; no child ever gets an ensemble_* tool, and
// only a validated depth-1 delegator env (with its run dir and id) gets `delegate`.
for (const [label, env, expected] of [
  ["lead", {}, [...CONDUCTOR_LLM_TOOL_NAMES]],
  ["lead with a non-exact child flag", { CONDUCTOR_SUBAGENT: "true" }, [...CONDUCTOR_LLM_TOOL_NAMES]],
  ["legacy child without depth", { CONDUCTOR_SUBAGENT: "1" }, ["ask_owner"]],
  ["depth-1 child", { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "1" }, ["ask_owner"]],
  ["depth-1 delegator without its run identity", { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "1", CONDUCTOR_DELEGATE_ALLOW: "inspector" }, ["ask_owner"]],
  ["depth-1 delegator", { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "1", CONDUCTOR_DELEGATE_ALLOW: "inspector", CONDUCTOR_RUN_ID: "lead-a", CONDUCTOR_RUN_DIR: "/runs/lead-a" }, ["ask_owner", "delegate"]],
  ["depth-2 leaf with a leaked allowlist and identity", { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "2", CONDUCTOR_DELEGATE_ALLOW: "inspector", CONDUCTOR_RUN_ID: "x", CONDUCTOR_RUN_DIR: "/runs/x" }, []],
  ["depth-2 leaf", { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "2" }, []],
  ["depth-2 leaf with a leaked allowlist", { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "2", CONDUCTOR_DELEGATE_ALLOW: "inspector" }, []],
  ...["", "0", "3", "01", " 1", "1 ", "one"].map((d) => [`unknown depth ${JSON.stringify(d)}`, { CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: d }, []] as const),
] as const) {
  test(`registerTools under ${label} registers exactly ${expected.length ? expected.length > 2 ? "the lead tools" : expected.join(",") : "nothing"}`, () => {
    assert.deepEqual(captureRegisteredToolNames(env).sort(), [...expected].sort());
  });
}

// S1: set equality per injected env with a presence; only a herdr lead (never a child) adds `peer`,
// and `chief`/`staff` are never registered before their behaviour lands (S3 `staff` needs a chief role, below).
const HERDR = { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", HERDR_PANE_ID: "pane-1" };
const LEAD_TOOLS = [...CONDUCTOR_LLM_TOOL_NAMES];
for (const [label, env, expected] of [
  ["plain lead", {}, LEAD_TOOLS],
  ["herdr lead", HERDR, [...LEAD_TOOLS, "peer"]],
  ["herdr lead with a non-exact child flag", { ...HERDR, CONDUCTOR_SUBAGENT: "true" }, [...LEAD_TOOLS, "peer"]],
  ["lead whose HERDR_ENV is not exactly 1", { ...HERDR, HERDR_ENV: "true" }, LEAD_TOOLS],
  ["lead with an empty socket", { ...HERDR, HERDR_SOCKET_PATH: "" }, LEAD_TOOLS],
  ["lead without a pane id", { HERDR_ENV: "1", HERDR_SOCKET_PATH: "/tmp/herdr.sock" }, LEAD_TOOLS],
  ["depth-1 child in a herdr pane", { ...HERDR, CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "1" }, ["ask_owner"]],
  ["depth-1 delegator in a herdr pane", { ...HERDR, CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "1", CONDUCTOR_DELEGATE_ALLOW: "inspector", CONDUCTOR_RUN_ID: "lead-a", CONDUCTOR_RUN_DIR: "/runs/lead-a" }, ["ask_owner", "delegate"]],
  ["depth-2 leaf in a herdr pane", { ...HERDR, CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "2" }, []],
] as const) {
  test(`S1 registerTools with a presence under ${label} registers exactly ${expected.includes("peer" as never) ? "the lead tools plus peer" : expected.length > 2 ? "the lead tools" : expected.join(",") || "nothing"}`, () => {
    const names = captureRegisteredToolNames(env, { ownTool() {} });
    assert.deepEqual([...names].sort(), [...expected].sort());
    for (const name of ["chief", "staff"]) assert.ok(!names.includes(name), `${name} is not registered in S1`);
  });
}

// S3: with a chief role too, only a herdr lead also registers `staff` (kept inactive unless chief); `chief` waits for S4.
for (const [label, env, expected] of [
  ["plain lead", {}, LEAD_TOOLS],
  ["herdr lead", HERDR, [...LEAD_TOOLS, "peer", "staff"]],
  ["depth-1 child in a herdr pane", { ...HERDR, CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "1" }, ["ask_owner"]],
  ["depth-1 delegator in a herdr pane", { ...HERDR, CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "1", CONDUCTOR_DELEGATE_ALLOW: "inspector", CONDUCTOR_RUN_ID: "lead-a", CONDUCTOR_RUN_DIR: "/runs/lead-a" }, ["ask_owner", "delegate"]],
  ["depth-2 leaf in a herdr pane", { ...HERDR, CONDUCTOR_SUBAGENT: "1", CONDUCTOR_DEPTH: "2" }, []],
] as const) {
  test(`S3 registerTools with a presence and a chief role under ${label} registers exactly ${expected.includes("staff" as never) ? "the lead tools plus peer and staff" : expected.length > 2 ? "the lead tools" : expected.join(",") || "nothing"}`, () => {
    const names = captureRegisteredToolNames(env, { ownTool() {} }, {});
    assert.deepEqual([...names].sort(), [...expected].sort());
    assert.ok(!names.includes("chief"), "the chief tool is not registered in S3");
  });
}

test("S1 registerTools: a herdr lead without a presence or tool activation registers no peer", () => {
  assert.deepEqual(captureRegisteredToolNames(HERDR).sort(), [...LEAD_TOOLS].sort());
});

test("SUPERVISION_TOOL_NAMES is chief, peer and staff", () => {
  assert.deepEqual([...SUPERVISION_TOOL_NAMES], ["chief", "peer", "staff"]);
});

test("effectiveExcludeTools: persona exclusions first, then every conductor tool, then the foreign spawn tools, deduped", () => {
  assert.deepEqual(effectiveExcludeTools(undefined), ALWAYS_EXCLUDED);
  assert.deepEqual(effectiveExcludeTools(["edit", "ensemble_spawn", "agent", "edit"]), [
    "edit",
    "ensemble_spawn",
    "agent",
    ...ALWAYS_EXCLUDED.filter((n) => n !== "ensemble_spawn" && n !== "agent"),
  ]);
});

// N2 registers the conductor's own delegate and relaxes the exclusion together, only for an
// eligible depth-1 delegator; every other scope still excludes it so no other tool fills the name.
test("effectiveExcludeTools/effectiveAllowTools: only an eligible delegator keeps and gains delegate; explicit exclusion wins", () => {
  const delegator: ChildToolScope = { depth: 1, delegateAllow: ["inspector"] };
  for (const scope of [LEGACY_CHILD_SCOPE, { depth: 1, delegateAllow: [] }, { depth: 2, delegateAllow: [] }] as ChildToolScope[]) {
    assert.ok(effectiveExcludeTools(undefined, scope).includes("delegate"), `${JSON.stringify(scope)} must exclude delegate`);
    assert.ok(!effectiveAllowTools(["read"], scope, [])!.includes("delegate"), `${JSON.stringify(scope)} must not add delegate`);
  }
  assert.ok(!effectiveExcludeTools(undefined, delegator).includes("delegate"));
  assert.deepEqual(effectiveAllowTools(["read"], delegator, effectiveExcludeTools(undefined, delegator)), ["read", "ask_owner", "delegate"]);
  const excluded = effectiveExcludeTools(["delegate"], delegator);
  assert.ok(excluded.includes("delegate"));
  assert.deepEqual(effectiveAllowTools(["read"], delegator, excluded), ["read", "ask_owner"], "an explicit persona exclusion wins");
});

test("FOREIGN_SPAWN_TOOLS names pi's subagent example and pi-herdsman's agent tool", () => {
  assert.deepEqual([...FOREIGN_SPAWN_TOOLS], ["subagent", "agent"]);
});

// ── buildPiArgs ──────────────────────────────────────────────────────

for (const kind of ["fresh", "resume"] as const) {
  const base =
    kind === "fresh"
      ? ({ kind, sessionDir: "/tmp/sess", systemPrompt: "SYS", prompt: "PROMPT", steerable: false } as const)
      : ({ kind, sessionPath: "/tmp/sess/a.jsonl", prompt: "PROMPT", steerable: false } as const);

  test(`buildPiArgs(${kind}): no allowlist → no --tools; --exclude-tools carries every registered conductor tool`, () => {
    const args = buildPiArgs(base);
    assert.equal(args.includes("--tools"), false);
    const excluded = (flagValue(args, "--exclude-tools") ?? "").split(",");
    for (const name of captureRegisteredToolNames()) {
      assert.ok(excluded.includes(name), `--exclude-tools must contain ${name}; got ${excluded.join(",")}`);
    }
    assert.equal(args[args.length - 1], "PROMPT", "prompt stays the trailing positional");
  });

  test(`buildPiArgs(${kind}): allowlist → --tools csv; persona exclusions prepended to the conductor tools`, () => {
    const args = buildPiArgs({ ...base, tools: ["read", "grep"], excludeTools: ["edit", "write"] });
    assert.equal(flagValue(args, "--tools"), "read,grep,ask_owner");
    assert.equal(
      flagValue(args, "--exclude-tools"),
      ["edit", "write", ...ALWAYS_EXCLUDED].join(","),
    );
    assert.equal(args[args.length - 1], "PROMPT");
  });

  test(`buildPiArgs(${kind}): --exclude-tools always carries the foreign spawn tools, even over an allowlist`, () => {
    for (const policy of [{}, { tools: ["read", "subagent", "agent"], excludeTools: ["edit"] }]) {
      const excluded = (flagValue(buildPiArgs({ ...base, ...policy }), "--exclude-tools") ?? "").split(",");
      assert.ok(excluded.includes("subagent"), `subagent excluded; got ${excluded.join(",")}`);
      assert.ok(excluded.includes("agent"), `agent excluded; got ${excluded.join(",")}`);
    }
  });
}

test("buildPiArgs(steerable): tool flags are emitted in RPC mode too", () => {
  const args = buildPiArgs({
    kind: "fresh",
    sessionDir: "/tmp/sess",
    systemPrompt: "SYS",
    prompt: "PROMPT",
    steerable: true,
    tools: ["read"],
  });
  assert.equal(flagValue(args, "--tools"), "read,ask_owner");
  assert.ok(flagValue(args, "--exclude-tools"));
});

// ── Resume + persistence ─────────────────────────────────────────────

function makeRun(over: Partial<Run> = {}): Run {
  return {
    id: "critic-abcd",
    persona: "critic",
    task: "t",
    mode: "background",
    status: "completed",
    startTime: 0,
    lastEventAt: 0,
    messages: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    cwd: "/tmp",
    recordPath: "/tmp/r/record.json",
    transcriptPath: "/tmp/r/transcript.jsonl",
    finalPath: "/tmp/r/final.md",
    sessionPath: "/tmp/r/session/s.jsonl",
    ...over,
  } as Run;
}

test("buildResumePiArgs: re-applies the run's persisted tool policy", () => {
  const args = buildResumePiArgs(
    makeRun({ tools: ["read", "bash"], excludeTools: effectiveExcludeTools(["edit"]) }),
    "follow up",
  );
  assert.equal(flagValue(args, "--tools"), "read,bash,ask_owner");
  assert.equal(flagValue(args, "--exclude-tools"), ["edit", ...ALWAYS_EXCLUDED].join(","));
});

test("buildResumePiArgs: a run persisted before the foreign spawn tools were excluded gets them on resume", () => {
  const args = buildResumePiArgs(makeRun({ excludeTools: ["edit", ...CONDUCTOR_LLM_TOOL_NAMES] }), "follow up");
  const excluded = (flagValue(args, "--exclude-tools") ?? "").split(",");
  assert.ok(excluded.includes("subagent") && excluded.includes("agent"), excluded.join(","));
});

test("buildResumePiArgs: a legacy run without tool fields still excludes the conductor tools", () => {
  const args = buildResumePiArgs(makeRun(), "follow up");
  assert.equal(args.includes("--tools"), false);
  assert.equal(flagValue(args, "--exclude-tools"), ALWAYS_EXCLUDED.join(","));
});

// Critic REJECT on A1: `buildOrphanRun` copied systemPrompt but not the
// tool policy, so a resume after crash or /reload dropped the persona's
// allowlist and exclusions. Covers every branch that registers an orphan.
for (const [label, onDisk, alive, status] of [
  ["killed", "running", false, "killed"],
  ["readopt", "running", true, "running"],
  ["failed-queued", "queued", false, "failed"],
] as const) {
  test(`reconcile (${label}): the re-adopted run keeps the persisted tool policy on resume`, async () => {
    const runsRoot = mkdtempSync(join(tmpdir(), "conductor-tool-policy-reconcile-"));
    try {
      const id = "critic-orph";
      const dir = join(runsRoot, id);
      mkdirSync(join(dir, "session"), { recursive: true });
      const sessionPath = join(dir, "session", "s.jsonl");
      writeFileSync(sessionPath, '{"type":"session"}\n');
      const record = toRunRecord(
        makeRun({
          id,
          status: onDisk,
          pid: 999_999,
          recordPath: join(dir, "record.json"),
          sessionPath,
          tools: ["read", "bash"],
          // Stamped before the foreign spawn tools were always excluded.
          excludeTools: [...READ_ONLY_EXCLUSIONS, ...CONDUCTOR_LLM_TOOL_NAMES],
        }),
      );
      writeFileSync(record.recordPath, JSON.stringify(record, null, 2));

      const runs = new Map<string, Run>();
      await reconcileOrphansAtStartup({
        runsRoot,
        registry: { has: (k) => runs.has(k), get: (k) => runs.get(k), register: (r) => void runs.set(r.id, r) },
        isAlive: () => alive,
        now: 2_000,
      });

      const registered = runs.get(id);
      assert.equal(registered?.status, status);
      const args = buildResumePiArgs(registered!, "x");
      assert.equal(flagValue(args, "--tools"), "read,bash,ask_owner");
      const excluded = (flagValue(args, "--exclude-tools") ?? "").split(",");
      for (const name of [...READ_ONLY_EXCLUSIONS, ...CONDUCTOR_LLM_TOOL_NAMES, "subagent", "agent"]) {
        assert.ok(excluded.includes(name), `--exclude-tools must contain ${name}; got ${excluded.join(",")}`);
      }
    } finally {
      rmSync(runsRoot, { recursive: true, force: true });
    }
  });
}

test("toRunRecord persists the effective tool policy", () => {
  const rec = toRunRecord(makeRun({ tools: ["read"], excludeTools: ["edit", "ensemble_list"] }));
  assert.deepEqual(rec.tools, ["read"]);
  assert.deepEqual(rec.excludeTools, ["edit", "ensemble_list"]);
});

test("planSpawnPiArgs: threads the persona's tool policy into fresh AND seeded-resume argv", () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "conductor-tool-policy-plan-"));
  try {
    for (const inheritContext of ["none", "full"] as const) {
      const plan = planSpawnPiArgs({
        persona: makePersona({ inheritContext, tools: ["read"], excludeTools: ["edit"] }),
        parentMessages:
          inheritContext === "full"
            ? [{ role: "user", content: "hi", timestamp: 1 } as any]
            : [],
        sessionDir,
        systemPrompt: "SYS",
        prompt: "PROMPT",
        cwd: sessionDir,
      });
      assert.equal(plan.mode, inheritContext === "full" ? "resume" : "fresh");
      assert.equal(flagValue(plan.piArgs, "--tools"), "read,ask_owner");
      assert.equal(
        flagValue(plan.piArgs, "--exclude-tools"),
        ["edit", ...ALWAYS_EXCLUDED].join(","),
      );
    }
  } finally {
    rmSync(sessionDir, { recursive: true, force: true });
  }
});

// ── Frontmatter parsing ──────────────────────────────────────────────

test("persona: tools / exclude_tools parse as trimmed, deduped block lists", async () => {
  const { persona, errors } = await resolveOne(
    "tools:\n  - read\n  - grep\n  - read\nexclude_tools:\n  - edit\n  - \" write \"\n  - mcp:server.tool-x\n",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(persona?.tools, ["read", "grep"]);
  assert.deepEqual(persona?.excludeTools, ["edit", "write", "mcp:server.tool-x"]);
});

test("persona: tool fields are optional and absent by default", async () => {
  const { persona, errors } = await resolveOne("");
  assert.deepEqual(errors, []);
  assert.ok(persona);
  assert.equal(persona.tools, undefined);
  assert.equal(persona.excludeTools, undefined);
});

for (const [label, frontmatter, pattern] of [
  ["a name with a space", "tools:\n  - bad name\n", /tools.*"bad name"/],
  ["a shell metacharacter", "exclude_tools:\n  - edit;rm\n", /exclude_tools.*"edit;rm"/],
  ["an empty entry", "exclude_tools:\n  - edit\n  - \"\"\n", /exclude_tools.*empty/],
  ["an empty allowlist", "tools:\n", /tools.*at least one/],
  ["flow-list syntax", "tools: [read, grep]\n", /tools.*block list/],
  ["a scalar", "exclude_tools: edit\n", /exclude_tools.*list/],
] as const) {
  test(`persona: rejects ${label} in a tool list (persona does not load)`, async () => {
    const { persona, errors } = await resolveOne(frontmatter);
    assert.equal(persona, undefined, "invalid tool policy must not load");
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, pattern);
  });
}

test("persona: an empty exclude_tools list is accepted as no exclusions", async () => {
  const { persona, errors } = await resolveOne("exclude_tools:\n");
  assert.deepEqual(errors, []);
  assert.deepEqual(persona?.excludeTools, []);
});

// ── personaOverrides replacement ─────────────────────────────────────

const POLICY_FM = "tools:\n  - read\n  - grep\n  - bash\nexclude_tools:\n  - edit\n  - write\n";

test("personaOverrides.tools replaces the persona's whole allowlist", async () => {
  const { persona } = await resolveOne(POLICY_FM, { probe: { tools: ["read"] } });
  assert.deepEqual(persona?.tools, ["read"]);
  assert.deepEqual(persona?.excludeTools, ["edit", "write"], "untouched field keeps the persona value");
});

test("personaOverrides.exclude_tools replaces the persona's whole denylist", async () => {
  const { persona } = await resolveOne(POLICY_FM, { probe: { exclude_tools: ["bash"] } });
  assert.deepEqual(persona?.excludeTools, ["bash"]);
  assert.deepEqual(persona?.tools, ["read", "grep", "bash"]);
});

test("personaOverrides with an invalid tool list drops the persona and records the error", async () => {
  const { persona, errors } = await resolveOne(POLICY_FM, {
    probe: { tools: "read" as unknown as string[] },
  });
  assert.equal(persona, undefined);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /personaOverrides\.probe.*tools/);
});

test("personaOverrides from <project>/.pi/conductor.json reach the resolved persona", async () => {
  await withSandbox(async ({ proj, personaDir }) => {
    writeFileSync(join(personaDir, "probe.md"), personaFile("probe", POLICY_FM));
    writeFileSync(
      join(proj, ".pi", "conductor.json"),
      JSON.stringify({ personaOverrides: { probe: { tools: ["read"], exclude_tools: ["bash"] } } }),
    );
    const cfg = loadConfig(proj);
    const r = await resolvePersonas({ cwd: proj, personaOverrides: cfg.personaOverrides });
    assert.deepEqual(r.personas.get("probe")?.tools, ["read"]);
    assert.deepEqual(r.personas.get("probe")?.excludeTools, ["bash"]);
  });
});

// ── Builtin personas ─────────────────────────────────────────────────

test("builtins: read-only reviewers exclude the edit/write tools; others declare no tool policy", () => {
  const readOnlyReviewers = new Set([
    "analyst",
    "critic",
    "finalizer",
    "inspector",
    "investigator",
    "oracle",
    "profiler",
    "redteam",
    "verifier",
  ]);
  const dir = builtinPersonasDir();
  const files = readdirSync(dir).filter((f) => f.endsWith(".md") && !f.startsWith("_"));
  assert.equal(files.length, 17);
  for (const file of files) {
    const { frontmatter } = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
    const name = String(frontmatter.name);
    assert.equal(frontmatter.tools, undefined, `${name}: no builtin sets an allowlist`);
    if (readOnlyReviewers.has(name)) {
      assert.equal(frontmatter.read_only, true, `${name} must stay read_only`);
      assert.deepEqual(frontmatter.exclude_tools, READ_ONLY_EXCLUSIONS, `${name} exclude_tools`);
    } else {
      assert.equal(frontmatter.exclude_tools, undefined, `${name} must not exclude tools`);
    }
  }
});

// ── Display surfaces ─────────────────────────────────────────────────

test("ensemble_list lines show each persona's tool policy and the always-excluded conductor tools", () => {
  const text = formatPersonaListForLLM([
    makePersona({ name: "critic", excludeTools: ["edit", "write"] }),
    makePersona({ name: "scout", tools: ["read", "grep"] }),
    makePersona({ name: "builder" }),
  ]);
  const block = (name: string) => {
    const lines = text.split("\n");
    const i = lines.findIndex((l: string) => l.trimStart().startsWith(name + " "));
    assert.ok(i >= 0, `${name} listed`);
    return lines[i + 1]!;
  };
  assert.match(block("critic"), /tools=default/);
  assert.match(block("critic"), /exclude_tools=edit,write/);
  assert.match(block("scout"), /tools=read,grep/);
  assert.doesNotMatch(block("scout"), /exclude_tools=/);
  assert.match(block("builder"), /tools=default/);
  assert.match(text, /ensemble_spawn/, "always-excluded conductor tools are named");
  assert.match(text, /subagent, agent/, "always-excluded foreign spawn tools are named");
  assert.match(text, /supervision tools: chief, peer, staff/, "always-excluded supervision tools are named");
});

test("/conductor show: renders tools, exclude_tools, and the always-excluded conductor tools", () => {
  const withPolicy = formatPersonaDetail(makePersona({ tools: ["read"], excludeTools: ["edit"] }));
  assert.match(withPolicy, /^tools: read$/m);
  assert.match(withPolicy, /^exclude_tools: edit$/m);
  assert.match(withPolicy, new RegExp(`^always excluded: ${CONDUCTOR_LLM_TOOL_NAMES.join(", ")}`, "m"));
  assert.match(withPolicy, /^always excluded: .*\bsubagent, agent \(foreign spawn tools\), chief, peer, staff \(supervision tools\)$/m);

  const bare = formatPersonaDetail(makePersona());
  assert.match(bare, /^tools: \(pi default set\)$/m);
  assert.match(bare, /^exclude_tools: \(none\)$/m);
  assert.match(bare, /## System prompt\n\nYou are probe\./);
});
