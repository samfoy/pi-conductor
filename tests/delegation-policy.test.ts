/**
 * N1: validated `agents:` allowlists, frozen depth scope, and the child
 * tool policy built from it. No `delegate` tool or broker exists yet, so
 * every child, a delegator included, excludes `delegate` until N2.
 */
import test from "node:test";
import assert from "node:assert/strict";
import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sandboxPi, tmpDir } from "./helpers/tmp.ts";
import {
  MAX_DELEGATE_TARGETS, builtinPersonasDir, childToolScope, effectiveAllowTools, effectiveExcludeTools,
  parseFrontmatter, projectPersonasDir, resolvePersonas, runScopeError, userPersonasDir,
} from "../src/personas.ts";
import {
  availableActions, buildPiArgs, buildResumePiArgs, buildSubAgentPrompt, buildSubagentEnv, planSpawnPiArgs,
  RunRegistry, sendToRun, spawnRun, type SpawnOptions,
} from "../src/runs.ts";
import { buildHerdrEnv, tabCreateArgs } from "../src/herdr/placement.ts";
import { herdrLaunchArgv } from "./helpers/herdr-launch-argv.ts";
import { buildOrphanRun, classifyRecord, reconcileOrphansAtStartup } from "../src/reconcile-startup.ts";
import { SpawnQueue } from "../src/queue.ts";
import { buildOnRetryCallback, formatPersonaListForLLM, registerTools } from "../src/tools.ts";
import { buildDoctorReport } from "../src/doctor.ts";
import { FocusedStreamModel } from "../src/focused-stream-model.ts";
import {
  CONDUCTOR_LLM_TOOL_NAMES, DEFAULT_CONFIG, LEGACY_CHILD_SCOPE, emptyUsage, toRunRecord,
  type ChildToolScope, type Persona, type Run,
} from "../src/types.ts";

sandboxPi();

// ── Fixtures ─────────────────────────────────────────────────────────

const LEAD: ChildToolScope = { depth: 1, delegateAllow: [] };
const DELEGATOR: ChildToolScope = { depth: 1, delegateAllow: ["inspector", "oracle"] };
const LEAF: ChildToolScope = { depth: 2, delegateAllow: [] };
/** What every child excludes after its own list, in every N1 scope: no child keeps `delegate` before N2 registers it. */
const ALWAYS = [...CONDUCTOR_LLM_TOOL_NAMES, "subagent", "agent", "delegate"];
const LEAF_ONLY = ["ask_owner", "edit", "write", "insert_before", "insert_after"];
const NINE_READERS = ["analyst", "clarifier", "critic", "finalizer", "inspector", "investigator", "oracle", "profiler", "redteam"];

const doc = (name: string, fm: string, body = `You are ${name}.`) => `---\nname: ${name}\ndescription: probe\n${fm}---\n${body}\n`;
const flag = (args: readonly string[], name: string) => {
  assert.ok(args.filter((a) => a === name).length <= 1, `${name} at most once`);
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const toolFlags = (args: readonly string[]) => ({ tools: flag(args, "--tools"), exclude: flag(args, "--exclude-tools") });

function persona(over: Partial<Persona> = {}): Persona {
  return { name: "lead", description: "probe", inheritContext: "none", inheritSkills: false, defaultReads: [], worktree: false,
    timeoutMinutes: 1, systemPrompt: "You are lead.", source: "project", sourcePath: "/fake/lead.md", readOnly: false, ...over };
}
function run(over: Partial<Run> = {}): Run {
  const dir = tmpDir("n1-run-");
  return { id: "lead-saved", persona: "lead", task: "probe", cwd: dir, mode: "background", status: "completed", startTime: 1, lastEventAt: 1,
    messages: [], usage: emptyUsage(), recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md"), ...over };
}
function options(over: Partial<SpawnOptions> = {}): SpawnOptions {
  return { registry: new RunRegistry(), persona: persona(), task: "probe", cwd: tmpDir("n1-cwd-"), mode: "background", timeoutMs: 4000, runtimeEnv: {}, ...over };
}

/** Every child launch through the real subprocess runtime, with its argv and env. */
function fakeSpawn(t: test.TestContext) {
  const launches: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
  const procs: EventEmitter[] = [];
  t.mock.method(cp, "spawn", (_cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), kill: () => true, unref() {} });
    launches.push({ args: args.slice(1), env: opts.env }); procs.push(proc); return proc;
  });
  syncBuiltinESMExports();
  t.after(() => { for (const p of procs) p.emit("close", 1); t.mock.restoreAll(); syncBuiltinESMExports(); });
  return launches;
}

/** Inherited copies a lead might carry; a child must never keep them. */
const POLLUTION = { CONDUCTOR_DEPTH: "2", CONDUCTOR_RUN_DIR: "/evil/run", CONDUCTOR_DELEGATE_ALLOW: "builder,simplifier" };
function polluteProcessEnv(t: test.TestContext) {
  const prior = Object.fromEntries(Object.keys(POLLUTION).map((k) => [k, process.env[k]]));
  Object.assign(process.env, POLLUTION);
  t.after(() => { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
}

async function roster(t: test.TestContext, files: { project?: Record<string, string>; user?: Record<string, string> }, overrides?: Record<string, unknown>) {
  const cwd = tmpDir("n1-roster-");
  mkdirSync(projectPersonasDir(cwd), { recursive: true });
  mkdirSync(userPersonasDir(), { recursive: true });
  for (const [f, text] of Object.entries(files.project ?? {})) writeFileSync(join(projectPersonasDir(cwd), f), text);
  for (const [f, text] of Object.entries(files.user ?? {})) {
    writeFileSync(join(userPersonasDir(), f), text);
    t.after(() => rmSync(join(userPersonasDir(), f), { force: true }));
  }
  const r = await resolvePersonas({ cwd, personaOverrides: overrides as never });
  return { ...r, cwd, errorText: r.errors.map((e) => `${e.path}: ${e.reason}`).join("\n") };
}

function tools(cwd: string, queue: SpawnQueue, registry: RunRegistry) {
  const registered = new Map<string, any>();
  registerTools({ registerTool: (t: any) => registered.set(t.name, t) } as any, {
    getCwd: () => cwd, getRegistry: () => registry, getQueue: () => queue, getModel: () => new FocusedStreamModel(registry), getParentMessages: () => [],
    openFocusedOverlay() {}, registerForegroundDetach: () => ({ detachSignal: new Promise<void>(() => {}), unregister() {} }), pushCompletionNotification() {},
  }, {});
  return registered;
}

// ── Allowlist validation: one red case per reason ────────────────────

const REJECTIONS: [string, { lead: string; user?: Record<string, string>; project?: Record<string, string>; overrides?: Record<string, unknown> }, RegExp][] = [
  ["an unknown target", { lead: "agents:\n  - nobody\n" }, /entry "nobody" is not an available persona/],
  ["a disabled target", { lead: "agents:\n  - inspector\n", overrides: { inspector: { disabled: true } } }, /entry "inspector" is disabled/],
  ["the persona itself", { lead: "read_only: true\nagents:\n  - lead\n" }, /entry "lead" names the persona itself/],
  ["a duplicate entry", { lead: "agents:\n  - inspector\n  - oracle\n  - inspector\n" }, /lists "inspector" more than once/],
  ["a non-string entry", { lead: "", overrides: { lead: { agents: ["inspector", 7] } } }, /personaOverrides\.lead: field "agents" must be a list of persona names/],
  ["flow syntax", { lead: "agents: [inspector, oracle]\n" }, /field "agents" must be a block list/],
  ["a scalar", { lead: "agents: inspector\n" }, /field "agents" must be a list of persona names/],
  ["an invalid name", { lead: "agents:\n  - \"inspector,oracle\"\n" }, /entry "inspector,oracle" is not a valid persona name/],
  [`more than ${MAX_DELEGATE_TARGETS} entries`, { lead: `agents:\n${NINE_READERS.map((n) => `  - ${n}\n`).join("")}` }, /has 9 entries; at most 8/],
  ["a target that is not read_only", { lead: "agents:\n  - planner\n" }, /entry "planner" is not read_only: true/],
  ["a known write-capable target", { lead: "agents:\n  - builder\n", user: { "builder.md": doc("builder", "read_only: true\n") } }, /entry "builder" is write-capable/],
  ["a masked target", { lead: "agents:\n  - inspector\n", project: { "inspector.md": "---\nname: inspector\n" } }, /entry "inspector" is not an available persona/],
  // An override-supplied list gets the same roster check; a valid file list never survives a bad override.
  ["an override-supplied non-read_only target", { lead: "agents:\n  - inspector\n", overrides: { lead: { agents: ["planner"] } } },
    /personaOverrides\.lead: field "agents" entry "planner" is not read_only: true/],
  ["an override-supplied write-capable target", { lead: "agents:\n  - inspector\n", user: { "builder.md": doc("builder", "read_only: true\n") }, overrides: { lead: { agents: ["builder"] } } },
    /personaOverrides\.lead: field "agents" entry "builder" is write-capable/],
  ["an override-supplied unknown target", { lead: "", overrides: { lead: { agents: ["ghost"] } } }, /personaOverrides\.lead: field "agents" entry "ghost" is not an available persona/],
  ["an override-supplied self entry", { lead: "read_only: true\n", overrides: { lead: { agents: ["lead"] } } }, /personaOverrides\.lead: field "agents" entry "lead" names the persona itself/],
  ["an override-supplied disabled target", { lead: "", overrides: { lead: { agents: ["inspector"] }, inspector: { disabled: true } } },
    /personaOverrides\.lead: field "agents" entry "inspector" is disabled/],
];
for (const [label, c, reason] of REJECTIONS) {
  test(`N1 allowlist naming ${label} makes the delegator unavailable, not partial`, async (t) => {
    const r = await roster(t, { project: { "lead.md": doc("lead", c.lead), ...c.project }, user: c.user }, c.overrides);
    assert.equal(r.personas.has("lead"), false, "invalid allowlist must not load a shortened list");
    assert.match(r.errorText, reason);
    assert.ok(r.errors.some((e) => /lead(\.md)?$/.test(e.path) && reason.test(`${e.path}: ${e.reason}`)), r.errorText);
    assert.equal(r.personas.has("oracle"), true, "unrelated personas still resolve");
  });
}

test("N1 a read-only target whose own allowlist is invalid takes its delegator with it", async (t) => {
  const r = await roster(t, { project: { "lead.md": doc("lead", "agents:\n  - mid\n"), "mid.md": doc("mid", "read_only: true\nagents:\n  - nobody\n") } });
  assert.equal(r.personas.has("mid"), false);
  assert.equal(r.personas.has("lead"), false, "a target that became unavailable fails its delegator closed");
  assert.match(r.errorText, /lead\.md: field "agents" entry "mid" is not an available persona/);
});

test("N1 valid allowlists resolve; overrides replace the whole list and [] disables", async (t) => {
  const eight = NINE_READERS.slice(0, 8);
  const r = await roster(t, { project: { "lead.md": doc("lead", "agents:\n  - inspector\n  - oracle\n"), "wide.md": doc("wide", `agents:\n${eight.map((n) => `  - ${n}\n`).join("")}`), "off.md": doc("off", "agents:\n  - oracle\n") } },
    { off: { agents: [] } });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.personas.get("lead")?.agents, ["inspector", "oracle"]);
  assert.deepEqual(r.personas.get("wide")?.agents, eight, "exactly eight is the accepted bound");
  assert.deepEqual(r.personas.get("off")?.agents, [], "[] disables delegation without dropping the persona");
  const replaced = await roster(t, { project: { "lead.md": doc("lead", "agents:\n  - inspector\n  - oracle\n") } }, { lead: { agents: ["critic"] } });
  assert.deepEqual(replaced.personas.get("lead")?.agents, ["critic"]);
});

test("N1 a raw null agents override is not normalized: the persona is unavailable", async (t) => {
  const r = await roster(t, { project: { "lead.md": doc("lead", "agents:\n  - inspector\n") } }, { lead: { agents: null } });
  assert.equal(r.personas.has("lead"), false);
  assert.match(r.errorText, /personaOverrides\.lead: field "agents" must be a list of persona names/);
});

test("N1 D4: no builtin persona declares agents; delegation is opt-in only", async (t) => {
  for (const f of readdirSync(builtinPersonasDir()).filter((f) => f.endsWith(".md") && !f.startsWith("_"))) {
    assert.equal(parseFrontmatter(readFileSync(join(builtinPersonasDir(), f), "utf8")).frontmatter.agents, undefined, f);
  }
  const r = await roster(t, {});
  assert.ok(r.personas.size >= 17);
  for (const p of r.personas.values()) assert.equal(p.agents, undefined, `${p.name} is a leaf by default`);
});

// ── H2 shadowing, extended to every privilege field ──────────────────

for (const [key, line] of [["runtime", "runtime: rpc\n"], ["read_only", "read_only: yes\n"], ["tools", "tools: [read]\n"],
  ["exclude_tools", "exclude_tools: edit\n"], ["agents", "agents: [oracle]\n"]] as const) {
  test(`N1 a broken higher-layer file declaring ${key} masks its lower persona instead of falling back`, async (t) => {
    const r = await roster(t, { project: { "inspector.md": `---\nname: inspector\ndescription: broken\n${line}---\nBroken.\n` } });
    assert.equal(r.personas.has("inspector"), false, `${key}: the wider builtin must not substitute`);
    assert.ok(r.errors.some((e) => e.path.endsWith("inspector.md")), r.errorText);
    assert.equal(r.personas.has("oracle"), true);
  });
}

test("N1 an unparseable higher-layer file masks its lower persona", async (t) => {
  const r = await roster(t, { project: { "inspector.md": "---\nname: inspector\ndescription: never closed\nread_only: true\n" } });
  assert.equal(r.personas.has("inspector"), false);
  assert.match(r.errorText, /inspector\.md: frontmatter opened/);
  assert.equal(r.personas.has("oracle"), true);
});

test("N1 a broken non-privilege field keeps the existing fallback", async (t) => {
  const r = await roster(t, { project: { "inspector.md": "---\nname: inspector\ndescription: broken\nthinking: bogus\n---\nBroken.\n" } });
  assert.equal(r.personas.get("inspector")?.source, "builtin");
});

for (const broken of ["---\nname: oracle\ndescription: invalid\nread_only: maybe\n---\nX\n", "---\nname: oracle\n"]) {
  test(`N1 masking uses the source filename, never a malformed declared name (${broken.includes("maybe") ? "privilege" : "unparseable"})`, async (t) => {
    const r = await roster(t, { user: { "custom-reader.md": doc("team-reader", "read_only: true\n") }, project: { "custom-reader.md": broken } });
    assert.equal(r.personas.has("team-reader"), false, "the validated lower persona from the same filename is masked");
    assert.equal(r.personas.has("oracle"), true, "the malformed declared name cannot hide an unrelated persona");
    const fixed = await roster(t, { user: { "custom-reader.md": doc("team-reader", "read_only: true\n") },
      project: { "custom-reader.md": broken, "replacement.md": doc("team-reader", "read_only: true\n", "Validated project reader.") } });
    assert.equal(fixed.personas.get("team-reader")?.sourcePath, join(projectPersonasDir(fixed.cwd), "replacement.md"), "a valid higher override still wins");
  });
}

// ── Scope-aware argv ─────────────────────────────────────────────────

for (const kind of ["fresh", "resume"] as const) {
  const base = kind === "fresh"
    ? ({ kind, sessionDir: "/tmp/s", systemPrompt: "SYS", prompt: "P", steerable: false } as const)
    : ({ kind, sessionPath: "/tmp/s/a.jsonl", prompt: "P", steerable: false } as const);
  const cases: [string, ChildToolScope | undefined, string[] | undefined, string[], string | undefined, string[]][] = [
    ["legacy default", undefined, ["read", "bash"], [], "read,bash,ask_owner", ALWAYS],
    ["depth-1 lead child", LEAD, ["read", "bash"], [], "read,bash,ask_owner", ALWAYS],
    ["depth-1 delegator", DELEGATOR, ["read", "bash"], [], "read,bash,ask_owner", ALWAYS],
    ["depth-1 delegator whose allowlist names delegate", DELEGATOR, ["read", "delegate"], [], "read,delegate,ask_owner", ALWAYS],
    ["depth-1 delegator, explicit exclusion wins", DELEGATOR, ["read", "bash"], ["delegate", "ask_owner"], "read,bash", [...new Set(["delegate", "ask_owner", ...ALWAYS])]],
    ["depth-1 lead child, explicit ask exclusion wins", LEAD, ["read"], ["ask_owner"], "read", ["ask_owner", ...ALWAYS]],
    ["depth-2 leaf", LEAF, ["read", "bash"], [], "read,bash", [...ALWAYS, ...LEAF_ONLY]],
    ["depth-2 leaf, default tool set", LEAF, undefined, ["grep"], undefined, ["grep", ...ALWAYS, ...LEAF_ONLY]],
    ["depth-1 delegator, default tool set", DELEGATOR, undefined, [], undefined, ALWAYS],
  ];
  for (const [label, scope, allow, exclude, tools, excluded] of cases) {
    test(`N1 ${kind} argv for ${label}`, () => {
      const args = buildPiArgs({ ...base, tools: allow, excludeTools: exclude, scope });
      assert.deepEqual(toolFlags(args), { tools, exclude: excluded.join(",") });
      assert.deepEqual(effectiveExcludeTools(effectiveExcludeTools(exclude, scope), scope), excluded, "re-applying on resume is idempotent");
    });
  }
}

test("N1 depth-2 argv excludes ask_owner and every write tool even when the persona allowlists them", () => {
  const args = buildPiArgs({ kind: "fresh", sessionDir: "/tmp/s", systemPrompt: "S", prompt: "P", steerable: false, scope: LEAF,
    tools: ["read", "ask_owner", "delegate", "edit", "write", "subagent"] });
  const excluded = flag(args, "--exclude-tools")!.split(",");
  for (const name of ["ask_owner", "delegate", "edit", "write", "insert_before", "insert_after", "subagent", "agent", ...CONDUCTOR_LLM_TOOL_NAMES]) {
    assert.ok(excluded.includes(name), `depth 2 must exclude ${name}`);
  }
  assert.deepEqual(effectiveAllowTools(["read"], LEAF, excluded), ["read"], "no owner tool is added at depth 2");
});

// ── Registration-independent prompt guard ────────────────────────────

test("N1 prompt guard: only an eligible delegator differs from no-nesting; leaves get read-only + QUESTION", () => {
  const p = persona();
  const legacy = buildSubAgentPrompt(p, "T");
  assert.equal(buildSubAgentPrompt(p, "T", undefined, LEAD), legacy);
  assert.equal(buildSubAgentPrompt(p, "T", undefined, { depth: 1, delegateAllow: [] }), legacy);
  assert.match(legacy.split("\n")[0]!, /^IMPORTANT: You are running as a pi-conductor sub-agent\. Do NOT attempt to spawn further sub-agents/);
  const delegating = buildSubAgentPrompt(p, "T", undefined, DELEGATOR);
  assert.notEqual(delegating.split("\n")[0], legacy.split("\n")[0]);
  assert.match(delegating, /inspector, oracle/);
  assert.match(delegating, /no delegation tool is available yet\. Do NOT attempt to spawn/);
  assert.doesNotMatch(delegating, /use `delegate`|you may delegate/i, "N1 must not advertise executable delegation");
  const leaf = buildSubAgentPrompt(p, "T", undefined, LEAF);
  assert.ok(leaf.startsWith(legacy.split("\n")[0]!), "leaves keep the no-nesting guard");
  assert.match(leaf, /read-only leaf: do not edit, write, or commit files/);
  assert.match(leaf, /end your final answer with `QUESTION: …`; your owner decides\. You cannot ask anyone\./);
});

// ── Env: both runtimes, polluted parents ─────────────────────────────

test("N1 subprocess env: owned depth/run dir always set; allowlist only for a delegator; inherited copies dropped", () => {
  const base = { ...POLLUTION, PATH: "/usr/bin", KEEP: "yes" };
  const before = structuredClone(base);
  const leaf = buildSubagentEnv(base, { CONDUCTOR_DEPTH: "1", CONDUCTOR_RUN_DIR: "/runs/a" });
  assert.equal(leaf.CONDUCTOR_DELEGATE_ALLOW, undefined);
  assert.deepEqual({ d: leaf.CONDUCTOR_DEPTH, r: leaf.CONDUCTOR_RUN_DIR, s: leaf.CONDUCTOR_SUBAGENT, p: leaf.PATH, k: leaf.KEEP }, { d: "1", r: "/runs/a", s: "1", p: "/usr/bin", k: "yes" });
  assert.equal(buildSubagentEnv(base).CONDUCTOR_DEPTH, undefined, "no helper default inherits a parent's depth");
  assert.deepEqual(base, before, "the parent env is never mutated");
});

for (const [label, p, allow] of [["leaf", persona(), undefined], ["delegator", persona({ agents: ["inspector", "oracle"] }), "inspector,oracle"]] as const) {
  test(`N1 real subprocess launch from a polluted lead env (${label})`, async (t) => {
    polluteProcessEnv(t);
    const launches = fakeSpawn(t);
    const spawned = spawnRun(options({ persona: p }));
    t.after(() => clearTimeout(spawned.run.timeoutTimer));
    const [{ args, env }] = launches;
    assert.equal(env.CONDUCTOR_DEPTH, "1");
    assert.equal(env.CONDUCTOR_RUN_DIR, dirname(spawned.run.recordPath));
    assert.equal(env.CONDUCTOR_DELEGATE_ALLOW, allow);
    assert.equal(env.CONDUCTOR_SUBAGENT, "1");
    assert.equal(spawned.run.depth, 1);
    assert.deepEqual(spawned.run.delegateAllow, p.agents ?? []);
    assert.deepEqual(toolFlags(args).exclude, effectiveExcludeTools(undefined, childToolScope(spawned.run)).join(","));
  });
}

test("N1 herdr pane env forwards no secrets or mode overrides and owns every scope name", () => {
  const source = { ...POLLUTION, AWS_PROFILE: "p", AWS_SECRET_ACCESS_KEY: "SECRET", PI_CONDUCTOR_MODE: "on", HERDR_SOCKET_PATH: "/sock", CONDUCTOR_SUBAGENT: "0" };
  const owned = { runId: "lead-a", runDir: "/runs/lead-a", configCwd: "/cwd" };
  assert.deepEqual(buildHerdrEnv(source, { ...owned, scope: LEAD }), { AWS_PROFILE: "p", CONDUCTOR_SUBAGENT: "1", CONDUCTOR_RUNTIME: "herdr",
    CONDUCTOR_RUN_ID: "lead-a", CONDUCTOR_CONFIG_CWD: "/cwd", CONDUCTOR_DEPTH: "1", CONDUCTOR_RUN_DIR: "/runs/lead-a" });
  assert.equal(buildHerdrEnv(source, { ...owned, scope: DELEGATOR }).CONDUCTOR_DELEGATE_ALLOW, "inspector,oracle");
  assert.equal(buildHerdrEnv(source, { ...owned, scope: LEAF }).CONDUCTOR_DEPTH, "2");
  assert.equal(buildHerdrEnv(source, { ...owned, scope: LEAF }).CONDUCTOR_DELEGATE_ALLOW, undefined);
  const env = buildHerdrEnv(source, { ...owned, scope: DELEGATOR });
  assert.doesNotThrow(() => tabCreateArgs({ workspaceId: "ws", cwd: "/cwd", runId: "lead-a", env }), "every owned name is an allowed pane name");
  assert.throws(() => tabCreateArgs({ workspaceId: "ws", cwd: "/cwd", runId: "lead-a", env: { ...env, CONDUCTOR_DELEGATES: "x" } }), /environment/);
});

test("N1 herdr launch takes pane env and argv from the run's frozen scope, not the caller or lead env", async () => {
  const root = tmpDir("n1-herdr-"), dir = join(root, "lead-herd"); mkdirSync(dir);
  const r = run({ id: "lead-herd", runtime: "herdr", status: "running", cwd: root, recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"),
    finalPath: join(dir, "final.md"), depth: 1, delegateAllow: ["inspector", "oracle"] });
  const { paneEnv, argv } = await herdrLaunchArgv(r, { kind: "fresh", sessionDir: join(dir, "session"), systemPrompt: "SYS", tools: ["read"], excludeTools: ["write"], scope: LEAF },
    { ...POLLUTION, AWS_SECRET_ACCESS_KEY: "SECRET", PI_CONDUCTOR_MODE: "on" });
  assert.deepEqual({ d: paneEnv.CONDUCTOR_DEPTH, r: paneEnv.CONDUCTOR_RUN_DIR, a: paneEnv.CONDUCTOR_DELEGATE_ALLOW }, { d: "1", r: dir, a: "inspector,oracle" });
  assert.equal(paneEnv.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(paneEnv.PI_CONDUCTOR_MODE, undefined);
  assert.deepEqual(toolFlags(argv), { tools: "read,ask_owner", exclude: ["write", ...ALWAYS].join(",") }, "the caller's core scope never wins over the run");
});

// ── Durable scope: record, orphan restore and resume ─────────────────

test("N1 spawn → record → orphan rebuild → byte-identical resume argv and scoped env", async (t) => {
  const launches = fakeSpawn(t);
  const spawned = spawnRun(options({ persona: persona({ agents: ["inspector", "oracle"], tools: ["read", "bash"], excludeTools: ["edit"] }) }));
  t.after(() => clearTimeout(spawned.run.timeoutTimer));
  const live = spawned.run;
  const sessionPath = join(dirname(live.recordPath), "session", "saved.jsonl");
  writeFileSync(sessionPath, JSON.stringify({ type: "session", id: "saved", cwd: live.cwd }) + "\n");
  live.sessionPath = sessionPath;
  const record = JSON.parse(JSON.stringify(toRunRecord(live)));
  assert.deepEqual({ depth: record.depth, delegateAllow: record.delegateAllow }, { depth: 1, delegateAllow: ["inspector", "oracle"] });
  const restored = buildOrphanRun(record, "completed");
  assert.deepEqual(buildResumePiArgs(restored, "continue"), buildResumePiArgs(live, "continue"));
  assert.deepEqual(toolFlags(buildResumePiArgs(restored, "continue")), toolFlags(launches[0]!.args), "resume keeps the fresh spawn's tool flags");

  const runsRoot = tmpDir("n1-reconcile-"); mkdirSync(join(runsRoot, live.id));
  writeFileSync(join(runsRoot, live.id, "record.json"), JSON.stringify({ ...record, status: "running", pid: 999_999 }));
  const registered = new Map<string, Run>();
  await reconcileOrphansAtStartup({ runsRoot, registry: { has: (k) => registered.has(k), get: (k) => registered.get(k), register: (x) => void registered.set(x.id, x) }, isAlive: () => false, now: 2 });
  assert.deepEqual(buildResumePiArgs(registered.get(live.id)!, "continue"), buildResumePiArgs(live, "continue"));

  // The persisted allowlist is the authority: later config cannot change a saved run's scope.
  mkdirSync(join(restored.cwd, ".pi"), { recursive: true });
  writeFileSync(join(restored.cwd, ".pi", "conductor.json"), JSON.stringify({ personaOverrides: { lead: { agents: [] } } }));
  const registry = new RunRegistry(); registry.register(restored);
  const sent = sendToRun(restored, "continue", { registry, timeoutMs: 4000 });
  t.after(() => clearTimeout(restored.timeoutTimer));
  assert.equal(sent.kind, "started");
  const resumed = launches.at(-1)!;
  assert.deepEqual(toolFlags(resumed.args), toolFlags(launches[0]!.args));
  assert.equal(resumed.env.CONDUCTOR_DELEGATE_ALLOW, "inspector,oracle");
  assert.equal(resumed.env.CONDUCTOR_DEPTH, "1");
});

test("N1 a record with no scope fields is a legacy depth-1 leaf", () => {
  const raw = JSON.parse(JSON.stringify(toRunRecord(run({ sessionPath: "/tmp/s.jsonl", tools: ["read"] }))));
  assert.equal("depth" in raw || "delegateAllow" in raw, false);
  assert.equal(runScopeError(raw), undefined);
  assert.deepEqual(childToolScope(buildOrphanRun(raw, "completed")), LEGACY_CHILD_SCOPE);
  assert.deepEqual(toolFlags(buildResumePiArgs(buildOrphanRun(raw, "completed"), "x")), { tools: "read,ask_owner", exclude: ALWAYS.join(",") });
});

const MALFORMED: [string, Record<string, unknown>][] = [
  ["null depth", { depth: null, delegateAllow: [] }],
  ["string depth", { depth: "1", delegateAllow: [] }],
  ["depth 3", { depth: 3, delegateAllow: [] }],
  ["depth 0", { depth: 0, delegateAllow: [] }],
  ["depth without allowlist", { depth: 1 }],
  ["allowlist without depth", { delegateAllow: [] }],
  ["null allowlist", { depth: 1, delegateAllow: null }],
  ["duplicate allowlist", { depth: 1, delegateAllow: ["inspector", "inspector"] }],
  ["oversized allowlist", { depth: 1, delegateAllow: NINE_READERS }],
  ["non-string allowlist", { depth: 1, delegateAllow: [1] }],
  ["delegating leaf", { depth: 2, delegateAllow: ["inspector"] }],
];
for (const [label, fields] of MALFORMED) {
  test(`N1 malformed saved scope (${label}) fails closed after roundtrip, not as legacy`, async (t) => {
    const launches = fakeSpawn(t);
    const original = run({ status: "completed" });
    original.sessionPath = join(original.cwd, "session.jsonl");
    writeFileSync(original.sessionPath, '{"type":"session","id":"saved"}\n');
    const raw = JSON.parse(JSON.stringify({ ...toRunRecord(original), ...fields }));
    assert.equal(classifyRecord(raw, () => assert.fail("no PID probes"), 1), "skip-malformed-scope");
    const restored = buildOrphanRun(raw, "completed");
    const roundtrip = JSON.parse(JSON.stringify(toRunRecord(restored)));
    for (const key of ["depth", "delegateAllow"]) assert.deepEqual(roundtrip[key], raw[key], `${key} persisted verbatim`);
    const target = buildOrphanRun(roundtrip, "completed");
    const before = structuredClone(target);
    assert.throws(() => buildResumePiArgs(target, "x"), /depth|scope/);
    assert.equal(availableActions(target).includes("send"), false);
    const registry = new RunRegistry(); registry.register(target);
    const sent = sendToRun(target, "continue", { registry, timeoutMs: 4000 });
    assert.equal(sent.kind, "rejected"); if (sent.kind === "rejected") assert.match(sent.reason, /depth|scope/);
    assert.equal(launches.length, 0, "no child launches with a guessed scope");
    assert.deepEqual(target, before, "refusal leaves the run untouched");
    assert.equal(existsSync(target.recordPath), false, "refusal writes no record");
  });
}

test("N1 reconcile preserves a malformed herdr record without probing, attaching or rewriting", async () => {
  const root = tmpDir("n1-reconcile-bad-"); const r = run({ id: "lead-bad", runtime: "herdr", status: "running", pid: 1 });
  mkdirSync(join(root, r.id)); const path = join(root, r.id, "record.json");
  const saved = JSON.stringify({ ...toRunRecord(r), depth: "2", delegateAllow: [] }); writeFileSync(path, saved);
  const registry = new RunRegistry();
  const forbidden = (): never => assert.fail("malformed scope must not be probed, attached or signalled");
  const result = await reconcileOrphansAtStartup({ runsRoot: root, registry, now: 1, isAlive: forbidden, isParentAlive: forbidden, signal: forbidden, herdrProbe: forbidden, attachHerdr: forbidden });
  assert.ok(result.errors.some((e) => e.id === r.id && /depth/.test(e.message)), JSON.stringify(result.errors));
  assert.equal(readFileSync(path, "utf8"), saved);
  assert.deepEqual(registry.list(), []);
});

// ── Flags survive every spawn path; callers cannot widen scope ───────

test("N1 queue, retry and seeded parent context keep the same scoped tool flags", async (t) => {
  const launches = fakeSpawn(t);
  const delegator = persona({ agents: ["inspector"], tools: ["read"] });
  const direct = spawnRun(options({ persona: delegator })); t.after(() => clearTimeout(direct.run.timeoutTimer));
  const expected = toolFlags(launches[0]!.args);
  assert.deepEqual(expected, { tools: "read,ask_owner", exclude: ALWAYS.join(",") });

  const registry = new RunRegistry(); const busy = run({ id: "busy-a", status: "running" }); registry.register(busy);
  const queue = new SpawnQueue(registry, 1);
  const queued = queue.enqueueOrSpawn({ ...options({ persona: delegator }), registry });
  assert.equal(queued.kind, "queued"); if (queued.kind !== "queued") return;
  busy.status = "completed"; registry.notify(busy);
  const promoted = registry.get(queued.placeholderRun.id)!; t.after(() => clearTimeout(promoted.timeoutTimer));
  assert.equal(promoted.status, "running");
  assert.deepEqual(toolFlags(launches.at(-1)!.args), expected, "queued drain");
  assert.deepEqual(promoted.delegateAllow, ["inspector"]);

  const retryRegistry = new RunRegistry();
  const retry = buildOnRetryCallback({ originalTask: "probe", persona: delegator, cfg: DEFAULT_CONFIG, queue: new SpawnQueue(retryRegistry, 4), cwd: tmpDir("n1-retry-"), pushNotification() {}, getParentMessages: () => [] });
  retry(run({ status: "failed", runtime: "subprocess", depth: 1, delegateAllow: ["inspector"] }));
  const retried = retryRegistry.list()[0]!; t.after(() => clearTimeout(retried.timeoutTimer));
  assert.deepEqual(toolFlags(launches.at(-1)!.args), expected, "retry");
  assert.deepEqual({ d: retried.depth, a: retried.delegateAllow }, { d: 1, a: ["inspector"] });

  const sessionDir = tmpDir("n1-seed-");
  const parentMessages = [{ role: "user", content: "spawn things", timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "ensemble_spawn", arguments: { persona: "builder" } }], timestamp: 2 }] as never;
  for (const scope of [LEAD, DELEGATOR, LEAF]) {
    const plan = (inheritContext: "none" | "full") => planSpawnPiArgs({ persona: persona({ inheritContext, tools: ["read"] }), parentMessages, sessionDir, systemPrompt: "S", prompt: "P", cwd: sessionDir, scope });
    assert.equal(plan("full").mode, "resume");
    assert.deepEqual(toolFlags(plan("full").piArgs), toolFlags(plan("none").piArgs), "inherited parent context never grants tools");
  }
});

test("N1 an ordinary LLM caller cannot supply depth or an allowlist to widen a spawn", async (t) => {
  const launches = fakeSpawn(t);
  const cwd = tmpDir("n1-llm-"); mkdirSync(projectPersonasDir(cwd), { recursive: true });
  writeFileSync(join(projectPersonasDir(cwd), "lead.md"), doc("lead", "agents:\n  - inspector\n"));
  const registry = new RunRegistry(); const registered = tools(cwd, new SpawnQueue(registry, 4), registry);
  const extra = { depth: 2, delegateAllow: ["builder"], agents: ["builder"], scope: { depth: 1, delegateAllow: ["builder"] } };
  for (const name of ["oracle", "lead"]) {
    await registered.get("ensemble_spawn").execute(`s-${name}`, { persona: name, task: "probe", foreground: false, ...extra });
  }
  const [oracle, lead] = registry.list();
  for (const r of registry.list()) t.after(() => clearTimeout(r.timeoutTimer));
  assert.deepEqual({ d: oracle!.depth, a: oracle!.delegateAllow, env: launches[0]!.env.CONDUCTOR_DELEGATE_ALLOW }, { d: 1, a: [], env: undefined });
  assert.deepEqual({ d: lead!.depth, a: lead!.delegateAllow, env: launches[1]!.env.CONDUCTOR_DELEGATE_ALLOW }, { d: 1, a: ["inspector"], env: "inspector" });
  for (const { args } of launches) assert.ok(flag(args, "--exclude-tools")!.split(",").includes("delegate"), "no child, delegator included, keeps delegate in N1");
});

test("N1 a persona object bypassing resolution still cannot launch a malformed allowlist", (t) => {
  const launches = fakeSpawn(t);
  const opts = options({ persona: persona({ agents: ["inspector", "inspector"] }) });
  assert.throws(() => spawnRun(opts), /more than once/);
  assert.equal(launches.length, 0); assert.deepEqual(opts.registry.list(), []);
});

// ── Display surfaces ─────────────────────────────────────────────────

test("N1 ensemble_list and doctor show the effective allowlist without advertising a delegate tool", async (t) => {
  const text = formatPersonaListForLLM([persona({ agents: ["inspector", "oracle"] }), persona({ name: "plain" })]);
  const lines = text.split("\n");
  const cfgOf = (name: string) => lines[lines.findIndex((l) => l.trimStart().startsWith(`${name} `)) + 1]!;
  assert.match(cfgOf("lead"), /agents=inspector,oracle/);
  assert.doesNotMatch(cfgOf("plain"), /agents=/);
  const r = await roster(t, { project: { "lead.md": doc("lead", "agents:\n  - inspector\n  - oracle\n") } });
  const registry = new RunRegistry();
  const report = await buildDoctorReport({ cwd: r.cwd, registry, queue: new SpawnQueue(registry, 1), conductorMode: false, env: {} });
  assert.match(report, /## Delegation allowlists\n {2}lead: inspector, oracle\n.*no delegate tool is registered yet/);
  const empty = await buildDoctorReport({ cwd: tmpDir("n1-doctor-"), registry, queue: new SpawnQueue(registry, 1), conductorMode: false, env: {} });
  assert.match(empty, /## Delegation allowlists\n {2}· none/);
});

test("N1 doctor's always-excluded list holds for every scope, so it never silences a name a delegator keeps", async (t) => {
  const r = await roster(t, { project: { "lead.md": doc("lead", "agents:\n  - inspector\n") } });
  const registry = new RunRegistry();
  const report = await buildDoctorReport({ cwd: r.cwd, registry, queue: new SpawnQueue(registry, 1), conductorMode: false, env: {},
    loadedToolNames: ["read", "delegate", "run_agent"] });
  const listed = /always excluded: (.*)/.exec(report)![1]!.split(", ");
  assert.ok(listed.includes("delegate"), report);
  const lead = childToolScope({ depth: 1, delegateAllow: r.personas.get("lead")!.agents });
  for (const scope of [LEGACY_CHILD_SCOPE, LEAD, lead, LEAF]) {
    const excluded = effectiveExcludeTools(undefined, scope);
    for (const name of listed) assert.ok(excluded.includes(name), `doctor calls ${name} always excluded, but scope ${JSON.stringify(scope)} keeps it`);
  }
  assert.doesNotMatch(report, /⚠ delegate /, "silent only because every child really excludes it");
  assert.match(report, /⚠ run_agent looks spawn-capable/, "a spawn-looking name children keep still warns");
});
