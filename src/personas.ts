/**
 * pi-conductor — Persona file loader.
 *
 * Layered resolution: builtin (shipped) < user (~/.pi/agent/conductor/personas/)
 *                       < project (<project>/.pi/conductor/personas/).
 *
 * No other discovery paths. Persona files are markdown with YAML-ish frontmatter
 * delimited by `---`. The schema is small and we hand-roll the parser to avoid
 * adding a runtime dependency.
 */

import { parseRuntimeChoice } from "./runtime.ts";
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONDUCTOR_LLM_TOOL_NAMES,
  CONTEXT_INHERITANCE,
  FOREIGN_SPAWN_TOOLS,
  LEGACY_CHILD_SCOPE,
  isDelegating,
  THINKING_LEVELS,
  type ChildToolScope,
  type ContextInheritance,
  type Persona,
  type PersonaLoadError,
  type PersonaOverride,
  type PersonaResolution,
  type PersonaSource,
} from "./types.ts";

// ── Discovery paths ────────────────────────────────────────────────────

/**
 * Personas that may mutate the working tree / git history.
 *
 * v0.9 Item 2(c) cap: a separate `maxConcurrentWriteCapable` (default 1)
 * limits how many of these may run at once, so two builders can't race
 * `git commit --amend` on the same shared working tree. Read-only
 * personas (oracle/redteam/inspector/etc.) are not affected and continue
 * to be governed only by the general `maxConcurrent` cap.
 *
 * Match is by Persona.name (string). The harness owns this set; persona
 * frontmatter does NOT declare write-capability — we don't trust the
 * frontmatter to opt out of a serialization invariant.
 */
export const WRITE_CAPABLE_PERSONAS: ReadonlySet<string> = new Set([
  "builder",
  "simplifier",
]);

export function isWriteCapable(personaName: string): boolean {
  return WRITE_CAPABLE_PERSONAS.has(personaName);
}

/**
 * Resolve the path to the bundled `personas/` directory given a module URL.
 *
 * Exposed as a separate helper so it can be unit-tested with a fake
 * symlinked layout. Production code calls {@link builtinPersonasDir}.
 *
 * Critical: the `realpathSync` call canonicalizes symlinks. Without it,
 * loading the bundle through a legacy `~/.pi/agent/extensions/conductor/`
 * symlink would walk `..` from the symlink path (e.g. `~/.pi/agent/extensions/`)
 * instead of the real package root, and the `personas/` dir would not
 * be found. See `docs/v0.9-symlink-investigation.md` for the failure mode.
 */
export function resolveBuiltinPersonasDir(metaUrl: string): string {
  const here = realpathSync(fileURLToPath(metaUrl));
  return resolve(dirname(here), "..", "personas");
}

/**
 * Resolve the path to the bundled `personas/` directory next to this source file.
 * Works whether the extension is loaded from src/ (dev), after a publish, or via
 * a legacy `~/.pi/agent/extensions/conductor/` symlink (canonicalized).
 */
export function builtinPersonasDir(): string {
  // Walk up from this file's real path to find the `personas/` dir at package root.
  // This file: <pkg>/src/personas.ts → <pkg>/personas/
  return resolveBuiltinPersonasDir(import.meta.url);
}

export function userPersonasDir(): string {
  return join(homedir(), ".pi", "agent", "conductor", "personas");
}

export function projectPersonasDir(cwd: string): string {
  return join(cwd, ".pi", "conductor", "personas");
}

// ── Frontmatter parser ────────────────────────────────────────────────

interface RawPersonaFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_FENCE = "---";

/**
 * Split a markdown file into frontmatter (object) + body (string).
 *
 * Supported value forms:
 *   key: value                # scalar (string)
 *   key: true | false         # boolean
 *   key: 42                   # number
 *   key: "quoted with spaces" # string with spaces (use quotes)
 *   key:                      # list (continuation lines)
 *     - item1
 *     - item2
 *
 * Anything more complex should not be in a persona file — keep it simple.
 */
export function parseFrontmatter(text: string): RawPersonaFile {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return { frontmatter: {}, body: text };
  }
  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FRONTMATTER_FENCE) {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error("frontmatter opened with `---` but never closed");
  }

  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join("\n");
  const frontmatter: Record<string, unknown> = {};

  let i = 0;
  while (i < fmLines.length) {
    const raw = fmLines[i] ?? "";
    const line = raw.trim();
    i++;
    if (!line || line.startsWith("#")) continue;

    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`frontmatter line missing colon: "${line}"`);
    }
    const key = line.slice(0, colon).trim();
    const valuePart = line.slice(colon + 1).trim();

    if (valuePart === "") {
      // List form: collect continuation lines that start with "-"
      const items: string[] = [];
      while (i < fmLines.length) {
        const next = fmLines[i] ?? "";
        const trimmed = next.trim();
        if (trimmed.startsWith("- ")) {
          items.push(unquote(trimmed.slice(2).trim()));
          i++;
        } else if (trimmed === "" || trimmed.startsWith("#")) {
          i++;
        } else {
          break;
        }
      }
      frontmatter[key] = items;
    } else {
      frontmatter[key] = parseScalar(valuePart);
    }
  }
  return { frontmatter, body };
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(s: string): string | boolean | number {
  const u = unquote(s);
  if (u === "true") return true;
  if (u === "false") return false;
  if (/^-?\d+$/.test(u)) return Number.parseInt(u, 10);
  if (/^-?\d+\.\d+$/.test(u)) return Number.parseFloat(u);
  return u;
}

// ── Persona validation ───────────────────────────────────────────────

function validateAndBuild(
  raw: RawPersonaFile,
  source: PersonaSource,
  sourcePath: string,
): Persona {
  const { frontmatter, body } = raw;

  const name = requireString(frontmatter, "name");
  const description = requireString(frontmatter, "description");
  const model = optionalString(frontmatter, "model");
  const thinking = optionalEnum(frontmatter, "thinking", THINKING_LEVELS);
  const inheritContext =
    (optionalEnum(frontmatter, "inherit_context", CONTEXT_INHERITANCE) as ContextInheritance) ??
    "filtered";
  const inheritSkills = optionalBoolean(frontmatter, "inherit_skills") ?? false;
  const defaultReads = optionalStringList(frontmatter, "default_reads") ?? [];
  const worktree = optionalBoolean(frontmatter, "worktree") ?? false;
  const timeoutMinutes = optionalNumber(frontmatter, "timeout_minutes") ?? 60;
  // Item 13: optional read_only (default false). When true, the
  // spawn-time prompt assembly prepends READ_ONLY_PERSONA_ENFORCER
  // (see src/runs.ts: assemblePersonaSystemPrompt).
  const readOnly = optionalBoolean(frontmatter, "read_only") ?? false;
  const runtime = frontmatter.runtime === undefined ? undefined : parseRuntimeChoice(frontmatter.runtime);
  // v0.11 slice 4 — on_complete_hook frontmatter parsing. The Persona
  // type field shipped in slice 1a; this slice populates it from
  // YAML. Empty string is preserved (cascade resolver treats it as
  // the explicit-disable sentinel — see hook-cascade.ts).
  const onCompleteHook = optionalStringAllowEmpty(frontmatter, "on_complete_hook");
  const onCompleteHookTimeoutSeconds = optionalPositiveInteger(
    frontmatter,
    "on_complete_hook_timeout_seconds",
  );
  // v0.17-S3: max_turns and grace_turns frontmatter fields.
  const maxTurns = optionalPositiveInteger(frontmatter, "max_turns");
  const graceTurns = optionalNonNegativeInteger(frontmatter, "grace_turns");
  // v0.18: retry_max_attempts frontmatter field.
  const retryMaxAttempts = optionalPositiveInteger(frontmatter, "retry_max_attempts");
  const tools =
    frontmatter.tools === undefined ? undefined : parseToolList(frontmatter.tools, "tools");
  const excludeTools =
    frontmatter.exclude_tools === undefined
      ? undefined
      : parseToolList(frontmatter.exclude_tools, "exclude_tools");
  const agents = frontmatter.agents === undefined ? undefined : parseAgentList(frontmatter.agents);

  if (timeoutMinutes <= 0 || timeoutMinutes > 24 * 60) {
    throw new Error(`timeout_minutes must be in (0, 1440]; got ${timeoutMinutes}`);
  }

  const systemPrompt = body.trim();
  if (!systemPrompt) {
    throw new Error("system prompt body is empty");
  }

  return {
    name,
    description,
    model,
    thinking,
    inheritContext,
    inheritSkills,
    defaultReads,
    worktree,
    timeoutMinutes,
    systemPrompt,
    source,
    sourcePath,
    readOnly,
    runtime,
    onCompleteHook,
    onCompleteHookTimeoutSeconds,
    maxTurns,
    graceTurns,
    retryMaxAttempts,
    tools,
    excludeTools,
    agents,
  };
}

// ── Tool policy ────────────────────────────────────────────────────────────────

const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/;

/**
 * Validate a `tools` / `exclude_tools` value (frontmatter or config
 * override) into a trimmed, deduped name list. Throws on anything else;
 * an empty `tools` allowlist is rejected because it would disable every
 * tool, which is almost certainly a typo rather than intent.
 */
function parseToolList(value: unknown, field: "tools" | "exclude_tools"): string[] {
  const names = parseNameList(value, field, "tool");
  if (field === "tools" && names.length === 0) {
    throw new Error(`field "tools" must list at least one tool name; omit it to keep pi's default set`);
  }
  return [...new Set(names)];
}

function parseNameList(value: unknown, field: string, kind: "tool" | "persona"): string[] {
  if (typeof value === "string" && /^\[.*\]$/.test(value.trim())) {
    throw new Error(
      `field "${field}" must be a block list (one \`- name\` per line); flow syntax [a, b] is not supported`,
    );
  }
  if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) {
    throw new Error(`field "${field}" must be a list of ${kind} names`);
  }
  const names = value.map((s) => s.trim());
  if (names.includes("")) throw new Error(`field "${field}" has an empty entry`);
  const bad = names.find((n) => !TOOL_NAME_PATTERN.test(n));
  if (bad !== undefined) {
    throw new Error(
      `field "${field}" entry "${bad}" is not a valid ${kind} name (allowed: letters, digits, _ . : -)`,
    );
  }
  return names;
}

export const MAX_DELEGATE_TARGETS = 8;

/** A delegation allowlist is rejected whole: duplicates are errors, not deduped. */
function parseAgentList(value: unknown, field = "agents"): string[] {
  const names = parseNameList(value, field, "persona");
  const duplicate = names.find((n, i) => names.indexOf(n) !== i);
  if (duplicate !== undefined) throw new Error(`field "${field}" lists "${duplicate}" more than once`);
  if (names.length > MAX_DELEGATE_TARGETS) {
    throw new Error(`field "${field}" has ${names.length} entries; at most ${MAX_DELEGATE_TARGETS} are allowed`);
  }
  return names;
}

/** Why a run's persisted scope is unusable. Both fields absent is a legacy depth-1 leaf. */
export function runScopeError(run: { depth?: unknown; delegateAllow?: unknown }): string | undefined {
  if (run.depth === undefined && run.delegateAllow === undefined) return undefined;
  if (run.depth !== 1 && run.depth !== 2) {
    return `run depth ${JSON.stringify(run.depth) ?? "missing"} is not 1 or 2; refusing to launch with a guessed tool scope`;
  }
  try {
    if (parseAgentList(run.delegateAllow, "delegateAllow").length > 0 && run.depth === 2) return "run scope is malformed: a depth-2 run cannot delegate";
  } catch (e) {
    return `run scope is malformed: ${(e as Error).message}`;
  }
  return undefined;
}

/** The frozen scope a launch uses; throws rather than widening a malformed record. */
export function childToolScope(run: { depth?: unknown; delegateAllow?: unknown }): ChildToolScope {
  const error = runScopeError(run);
  if (error) throw new Error(error);
  if (run.depth === undefined) return LEGACY_CHILD_SCOPE;
  return { depth: run.depth as ChildToolScope["depth"], delegateAllow: [...(run.delegateAllow as string[])] };
}

/** Write tools a depth-2 leaf never keeps (the read-only builtins exclude the same four). */
const LEAF_MUTATION_TOOLS = ["edit", "write", "insert_before", "insert_after"];

/**
 * The `--exclude-tools` list a sub-agent actually gets: the persona's own
 * exclusions (first, in order), every conductor LLM tool, the foreign spawn
 * tools, `delegate`, and at depth 2 the owner tool and write tools too.
 * Deduped; idempotent for the same scope.
 */
export function effectiveExcludeTools(
  excludeTools?: readonly string[],
  scope: ChildToolScope = LEGACY_CHILD_SCOPE,
): string[] {
  return [...new Set([
    ...(excludeTools ?? []),
    ...CONDUCTOR_LLM_TOOL_NAMES,
    ...FOREIGN_SPAWN_TOOLS,
    // Only an eligible delegator keeps the name, filled by the conductor's own tool;
    // another extension's same-named tool then fails pi's startup as a conflict.
    ...(isDelegating(scope) ? [] : ["delegate"]),
    ...(scope.depth === 2 ? ["ask_owner", ...LEAF_MUTATION_TOOLS] : []),
  ])];
}

/**
 * An explicit allowlist keeps the scope's own child tools: `ask_owner` at
 * depth 1 and `delegate` for a delegator. An excluded name is never added.
 */
export function effectiveAllowTools(
  tools: readonly string[] | undefined,
  scope: ChildToolScope,
  excluded: readonly string[],
): string[] | undefined {
  if (tools === undefined) return undefined;
  const own = [...(scope.depth === 1 ? ["ask_owner"] : []), ...(isDelegating(scope) ? ["delegate"] : [])];
  return [...new Set([...tools, ...own.filter((n) => !excluded.includes(n))])];
}

function requireString(fm: Record<string, unknown>, key: string): string {
  const v = fm[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`required field "${key}" is missing or empty`);
  }
  return v.trim();
}

function optionalString(fm: Record<string, unknown>, key: string): string | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new Error(`field "${key}" must be a string; got ${typeof v}`);
  }
  return v.trim() === "" ? undefined : v.trim();
}

function optionalEnum<T extends string>(
  fm: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw new Error(`field "${key}" must be one of ${allowed.join("|")}; got ${String(v)}`);
  }
  return v as T;
}

function optionalBoolean(fm: Record<string, unknown>, key: string): boolean | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw new Error(`field "${key}" must be a boolean; got ${typeof v}`);
  }
  return v;
}

function optionalNumber(fm: Record<string, unknown>, key: string): number | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number") {
    throw new Error(`field "${key}" must be a number; got ${typeof v}`);
  }
  return v;
}

function optionalStringList(fm: Record<string, unknown>, key: string): string[] | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`field "${key}" must be a list of strings`);
  }
  return v.map((s) => s.trim()).filter(Boolean);
}

/**
 * v0.11 slice 4 — like {@link optionalString} but preserves the empty
 * string. Required because the on_complete_hook cascade treats `""`
 * as the explicit-disable sentinel; coercing it to `undefined` would
 * silently fall through to lower cascade layers.
 */
function optionalStringAllowEmpty(
  fm: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new Error(`field "${key}" must be a string; got ${typeof v}`);
  }
  return v;
}

/**
 * v0.11 slice 4 — number field that must be a positive integer when
 * present. Mirrors `validateHookTimeoutSeconds` in `tools.ts` (per-call
 * boundary); applies the same rule at the persona-frontmatter boundary
 * so a degenerate value fails fast at load time, not at hook fire time.
 */
function optionalPositiveInteger(
  fm: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`field "${key}" must be a positive integer; got ${String(v)}`);
  }
  return v;
}

/**
 * Like `optionalPositiveInteger` but allows 0 as a valid value.
 * Used for `grace_turns` where 0 means "no grace period".
 */
function optionalNonNegativeInteger(
  fm: Record<string, unknown>,
  key: string,
): number | undefined {
  const v = fm[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new Error(`field "${key}" must be a non-negative integer; got ${String(v)}`);
  }
  return v;
}

// ── Loader ────────────────────────────────────────────────────────────

/** Fields that change what a child may do; a broken file declaring one must not fall back. */
const PRIVILEGE_KEYS = ["runtime", "read_only", "tools", "exclude_tools", "agents"];

async function loadPersonasFromDir(
  dir: string,
  source: PersonaSource,
): Promise<{ personas: Persona[]; errors: PersonaLoadError[]; blockedNames: string[] }> {
  const personas: Persona[] = [];
  const errors: PersonaLoadError[] = [];
  const blockedNames: string[] = [];

  if (!existsSync(dir)) return { personas, errors, blockedNames };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    errors.push({ path: dir, reason: `cannot read directory: ${(e as Error).message}` });
    return { personas, errors, blockedNames };
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md") || entry.startsWith("_")) continue;
    const filePath = join(dir, entry);
    let raw: RawPersonaFile | undefined;
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      const text = await readFile(filePath, "utf-8");
      raw = parseFrontmatter(text);
      const persona = validateAndBuild(raw, source, filePath);
      personas.push(persona);
    } catch (e) {
      errors.push({ path: filePath, reason: (e as Error).message });
      // An unparseable or privilege-bearing broken override must not expose a wider lower-priority
      // persona. Its filename, not malformed frontmatter.name, identifies the blocked candidate.
      if (!raw || PRIVILEGE_KEYS.some((k) => raw!.frontmatter[k] !== undefined)) blockedNames.push(entry.slice(0, -3));
    }
  }
  return { personas, errors, blockedNames };
}

/**
 * Resolve personas across all three sources. Project overrides user overrides builtin.
 * Disabled overrides remove a persona from the resolved set.
 */
export async function resolvePersonas(opts: {
  cwd: string;
  personaOverrides?: Record<string, PersonaOverride>;
}): Promise<PersonaResolution> {
  const overrides = opts.personaOverrides ?? {};

  const builtin = await loadPersonasFromDir(builtinPersonasDir(), "builtin");
  const user = await loadPersonasFromDir(userPersonasDir(), "user");
  const project = await loadPersonasFromDir(projectPersonasDir(opts.cwd), "project");

  const errors = [...builtin.errors, ...user.errors, ...project.errors];

  // Layer: later sources win.
  const personas = new Map<string, Persona>();
  const shadowed = new Map<string, Persona[]>();

  for (const layer of [builtin, user, project]) {
    // Only validated lower-layer sources can supply a differing declared name.
    // Mask before adding this layer's valid replacements, so higher priority still wins.
    for (const name of layer.blockedNames) {
      for (const p of personas.values()) {
        if (p.name === name || basename(p.sourcePath, ".md") === name) personas.delete(p.name);
      }
    }
    for (const p of layer.personas) {
      const list = shadowed.get(p.name) ?? [];
      list.push(p);
      shadowed.set(p.name, list);
      personas.set(p.name, p);
    }
  }

  // Apply overrides (model/thinking/timeout/disabled).
  for (const [name, ov] of Object.entries(overrides)) {
    if (ov.disabled) {
      personas.delete(name);
      continue;
    }
    const base = personas.get(name);
    if (!base) continue; // override of nonexistent persona is a no-op (doctor will warn)
    // Tool lists replace the persona's whole array. A malformed one drops
    // the persona (like a malformed file) rather than silently loosening it.
    let runtime = base.runtime;
    let tools = base.tools;
    let excludeTools = base.excludeTools;
    let agents = base.agents;
    try {
      if (ov.runtime !== undefined) runtime = parseRuntimeChoice(ov.runtime);
      if (ov.tools !== undefined) tools = parseToolList(ov.tools, "tools");
      if (ov.exclude_tools !== undefined) {
        excludeTools = parseToolList(ov.exclude_tools, "exclude_tools");
      }
      if (ov.agents !== undefined) agents = parseAgentList(ov.agents);
    } catch (e) {
      errors.push({ path: `personaOverrides.${name}`, reason: (e as Error).message });
      personas.delete(name);
      continue;
    }
    personas.set(name, {
      ...base,
      runtime,
      tools,
      excludeTools,
      agents,
      model: ov.model ?? base.model,
      thinking: ov.thinking ?? base.thinking,
      timeoutMinutes: ov.timeoutMinutes ?? base.timeoutMinutes,
      inheritContext: ov.inheritContext ?? base.inheritContext,
      inheritSkills: ov.inheritSkills ?? base.inheritSkills,
    });
  }

  // Allowlists are checked against the final roster, to a fixed point: a delegator
  // whose target became unavailable is itself unavailable, never a shorter list.
  for (let changed = true; changed; ) {
    changed = false;
    for (const p of personas.values()) {
      const reason = agentsRosterError(p, personas, overrides);
      if (reason === undefined) continue;
      errors.push({ path: overrides[p.name]?.agents !== undefined ? `personaOverrides.${p.name}` : p.sourcePath, reason });
      personas.delete(p.name);
      changed = true;
    }
  }

  return { personas, shadowed, errors };
}

function agentsRosterError(
  p: Persona,
  roster: ReadonlyMap<string, Persona>,
  overrides: Record<string, PersonaOverride>,
): string | undefined {
  for (const name of p.agents ?? []) {
    const entry = `field "agents" entry "${name}"`;
    if (name === p.name) return `${entry} names the persona itself`;
    if (overrides[name]?.disabled) return `${entry} is disabled`;
    const target = roster.get(name);
    if (!target) return `${entry} is not an available persona`;
    if (target.readOnly !== true) return `${entry} is not read_only: true`;
    if (isWriteCapable(name)) return `${entry} is write-capable`;
  }
  return undefined;
}
