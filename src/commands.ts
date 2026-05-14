/**
 * pi-conductor — Slash commands.
 *
 * v0.1 ships read-only commands:
 *   /conductor list                  — list resolved personas
 *   /conductor show <persona>        — display a persona's full file
 *   /conductor doctor                — health check
 *
 * Spawning, sending, pausing, focus, history land in v0.2+.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import type { PersonaResolution } from "./types.ts";
import { resolvePersonas } from "./personas.ts";
import { loadConfig, projectConfigPath, userConfigPath } from "./config.ts";

interface RegisterCommandsOpts {
  getCwd: () => string;
}

export function registerCommands(pi: ExtensionAPI, opts: RegisterCommandsOpts): void {
  pi.registerCommand("conductor", {
    description: "pi-conductor: list, show, or check sub-agent personas",
    getArgumentCompletions: (prefix: string) => {
      const subs = ["list", "show", "doctor"];
      const items = subs.map((s) => ({ value: s, label: s }));
      const filtered = items.filter((i) => i.value.startsWith(prefix.split(/\s+/)[0] ?? ""));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (rawArgs, ctx) => {
      const args = (rawArgs ?? "").trim();
      const [sub, ...rest] = args.split(/\s+/);
      const subRest = rest.join(" ").trim();

      switch (sub) {
        case "":
        case "list":
          await runList(opts, ctx);
          return;
        case "show":
          await runShow(opts, ctx, subRest);
          return;
        case "doctor":
          await runDoctor(opts, ctx);
          return;
        default:
          ctx.ui.notify(
            `unknown subcommand: ${sub}. Try /conductor list | show <name> | doctor`,
            "warning",
          );
      }
    },
  });
}

async function runList(opts: RegisterCommandsOpts, ctx: ExtensionCommandContext): Promise<void> {
  const cwd = opts.getCwd();
  const cfg = loadConfig(cwd);
  const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
  const personas = [...resolved.personas.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (personas.length === 0) {
    ctx.ui.notify(
      "no personas resolved. Add files under ~/.pi/agent/conductor/personas/ or <cwd>/.pi/conductor/personas/",
      "warning",
    );
    return;
  }

  const lines: string[] = [`${personas.length} personas resolved:`, ""];
  for (const p of personas) {
    const cfgBits: string[] = [];
    cfgBits.push(`source=${p.source}`);
    if (p.model) cfgBits.push(`model=${p.model}`);
    if (p.thinking) cfgBits.push(`thinking=${p.thinking}`);
    cfgBits.push(`context=${p.inheritContext}`);
    lines.push(`  ${p.name.padEnd(14)} — ${p.description}`);
    lines.push(`  ${" ".repeat(14)}   [${cfgBits.join(", ")}]`);
  }
  if (resolved.errors.length > 0) {
    lines.push("", `${resolved.errors.length} parse errors:`);
    for (const e of resolved.errors) {
      lines.push(`  ✗ ${e.path}: ${e.reason}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function runShow(
  opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
  name: string,
): Promise<void> {
  if (!name) {
    ctx.ui.notify("usage: /conductor show <persona-name>", "warning");
    return;
  }
  const cwd = opts.getCwd();
  const cfg = loadConfig(cwd);
  const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
  const p = resolved.personas.get(name);
  if (!p) {
    ctx.ui.notify(
      `persona "${name}" not found. Run /conductor list to see what's available.`,
      "warning",
    );
    return;
  }

  const lines: string[] = [];
  lines.push(`# ${p.name}`);
  lines.push(`source: ${p.source} (${p.sourcePath})`);
  lines.push(`description: ${p.description}`);
  lines.push(`model: ${p.model ?? "<inherited>"}`);
  lines.push(`thinking: ${p.thinking ?? "<inherited>"}`);
  lines.push(`inherit_context: ${p.inheritContext}`);
  lines.push(`inherit_skills: ${p.inheritSkills}`);
  lines.push(`default_reads: ${p.defaultReads.length === 0 ? "(none)" : p.defaultReads.join(", ")}`);
  lines.push(`worktree: ${p.worktree}`);
  lines.push(`timeout_minutes: ${p.timeoutMinutes}`);
  lines.push("");
  lines.push("## System prompt");
  lines.push("");
  lines.push(p.systemPrompt);

  ctx.ui.notify(lines.join("\n"), "info");
}

async function runDoctor(
  opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const cwd = opts.getCwd();
  const cfg = loadConfig(cwd);
  const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });

  const lines: string[] = ["pi-conductor doctor", ""];

  // Personas summary.
  lines.push(`## Personas (${resolved.personas.size} resolved)`);
  if (resolved.personas.size === 0) {
    lines.push("  ✗ no personas resolved");
  } else {
    const counts = countBySource(resolved);
    lines.push(
      `  ✓ builtin=${counts.builtin}, user=${counts.user}, project=${counts.project}`,
    );
  }

  // Shadowed (overridden) personas.
  const shadowed = [...resolved.shadowed.entries()].filter(([, list]) => list.length > 1);
  if (shadowed.length > 0) {
    lines.push("");
    lines.push("## Shadowed (overridden) personas");
    for (const [name, list] of shadowed) {
      const winning = list[list.length - 1];
      lines.push(`  ${name}: ${list.length} sources, winning = ${winning.source}`);
      for (const p of list) {
        const marker = p === winning ? "  ✓" : "   ";
        lines.push(`    ${marker} ${p.source.padEnd(8)} ${p.sourcePath}`);
      }
    }
  }

  // Parse errors.
  if (resolved.errors.length > 0) {
    lines.push("");
    lines.push(`## Parse errors (${resolved.errors.length})`);
    for (const e of resolved.errors) {
      lines.push(`  ✗ ${e.path}`);
      lines.push(`    ${e.reason}`);
    }
  }

  // Unknown overrides.
  const unknownOverrides = Object.keys(cfg.personaOverrides).filter(
    (n) => !resolved.shadowed.has(n),
  );
  if (unknownOverrides.length > 0) {
    lines.push("");
    lines.push("## Unknown persona overrides");
    for (const n of unknownOverrides) {
      lines.push(`  ⚠ override "${n}" does not match any persona`);
    }
  }

  // Config file resolution.
  lines.push("");
  lines.push("## Config files");
  const userPath = userConfigPath();
  const projectPath = projectConfigPath(cwd);
  lines.push(`  user:    ${existsSync(userPath) ? "✓" : "·"} ${userPath}`);
  lines.push(`  project: ${existsSync(projectPath) ? "✓" : "·"} ${projectPath}`);

  // Resolved settings.
  lines.push("");
  lines.push("## Resolved config");
  lines.push(`  defaultTimeoutMinutes: ${cfg.defaultTimeoutMinutes}`);
  lines.push(`  maxConcurrent:         ${cfg.maxConcurrent}`);
  lines.push(`  queueOnConcurrencyCap: ${cfg.queueOnConcurrencyCap}`);
  lines.push(`  defaultSpawnMode:      ${cfg.defaultSpawnMode}`);
  lines.push(`  autoOpenFocusOnSpawn:  ${cfg.autoOpenFocusOnSpawn}`);
  lines.push(`  personaOverrides:      ${Object.keys(cfg.personaOverrides).length} entries`);

  ctx.ui.notify(lines.join("\n"), "info");
}

function countBySource(resolved: PersonaResolution): Record<string, number> {
  const counts: Record<string, number> = { builtin: 0, user: 0, project: 0 };
  for (const p of resolved.personas.values()) {
    counts[p.source] = (counts[p.source] ?? 0) + 1;
  }
  return counts;
}

// (no Persona type alias needed)
