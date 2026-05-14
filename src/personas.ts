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

import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CONTEXT_INHERITANCE,
  THINKING_LEVELS,
  type ContextInheritance,
  type Persona,
  type PersonaLoadError,
  type PersonaOverride,
  type PersonaResolution,
  type PersonaSource,
} from "./types.ts";

// ── Discovery paths ────────────────────────────────────────────────────

/**
 * Resolve the path to the bundled `personas/` directory next to this source file.
 * Works whether the extension is loaded from src/ (dev) or after a publish.
 */
export function builtinPersonasDir(): string {
  // Walk up from this file's location to find the `personas/` dir at package root.
  // This file: <pkg>/src/personas.ts → <pkg>/personas/
  const here = fileURLToPath(import.meta.url);
  return resolve(dirname(here), "..", "personas");
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
  const timeoutMinutes = optionalNumber(frontmatter, "timeout_minutes") ?? 30;

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
  };
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

// ── Loader ────────────────────────────────────────────────────────────

async function loadPersonasFromDir(
  dir: string,
  source: PersonaSource,
): Promise<{ personas: Persona[]; errors: PersonaLoadError[] }> {
  const personas: Persona[] = [];
  const errors: PersonaLoadError[] = [];

  if (!existsSync(dir)) return { personas, errors };

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (e) {
    errors.push({ path: dir, reason: `cannot read directory: ${(e as Error).message}` });
    return { personas, errors };
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      const text = await readFile(filePath, "utf-8");
      const raw = parseFrontmatter(text);
      const persona = validateAndBuild(raw, source, filePath);
      personas.push(persona);
    } catch (e) {
      errors.push({ path: filePath, reason: (e as Error).message });
    }
  }
  return { personas, errors };
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

  const ordered: Persona[] = [...builtin.personas, ...user.personas, ...project.personas];
  for (const p of ordered) {
    const list = shadowed.get(p.name) ?? [];
    list.push(p);
    shadowed.set(p.name, list);
    personas.set(p.name, p);
  }

  // Apply overrides (model/thinking/timeout/disabled).
  for (const [name, ov] of Object.entries(overrides)) {
    if (ov.disabled) {
      personas.delete(name);
      continue;
    }
    const base = personas.get(name);
    if (!base) continue; // override of nonexistent persona is a no-op (doctor will warn)
    personas.set(name, {
      ...base,
      model: ov.model ?? base.model,
      thinking: ov.thinking ?? base.thinking,
      timeoutMinutes: ov.timeoutMinutes ?? base.timeoutMinutes,
      inheritContext: ov.inheritContext ?? base.inheritContext,
      inheritSkills: ov.inheritSkills ?? base.inheritSkills,
    });
  }

  return { personas, shadowed, errors };
}
