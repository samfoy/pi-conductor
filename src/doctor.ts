/**
 * pi-conductor — pure report builder for /conductor doctor.
 *
 * Extracted from commands.ts so it can be tested without faking the
 * ExtensionCommandContext.notify pipe.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolvePersonas } from "./personas.ts";
import {
  loadConfigWithErrors,
  projectConfigPath,
  userConfigPath,
} from "./config.ts";
import type { RunRegistry } from "./runs.ts";
import type { SpawnQueue } from "./queue.ts";
import type { PersonaResolution } from "./types.ts";

export interface DoctorReportOptions {
  cwd: string;
  registry: RunRegistry;
  queue: SpawnQueue;
  conductorMode: boolean;
  /**
   * Override $HOME for the legacy-install audit. Defaults to {@link homedir}.
   * Lets tests stub the home dir without touching `process.env.HOME`.
   */
  homeDir?: string;
}

export async function buildDoctorReport(opts: DoctorReportOptions): Promise<string> {
  const { config: cfg, errors: configErrors } = loadConfigWithErrors(opts.cwd);
  const resolved = await resolvePersonas({
    cwd: opts.cwd,
    personaOverrides: cfg.personaOverrides,
  });

  const lines: string[] = ["pi-conductor doctor", ""];

  // Personas summary.
  lines.push(`## Personas (${resolved.personas.size} resolved)`);
  if (resolved.personas.size === 0) {
    lines.push("  ✗ no personas resolved");
  } else {
    const counts = countBySource(resolved);
    lines.push(`  ✓ builtin=${counts.builtin}, user=${counts.user}, project=${counts.project}`);
  }

  // Shadowed (overridden) personas.
  const shadowed = [...resolved.shadowed.entries()].filter(([, list]) => list.length > 1);
  if (shadowed.length > 0) {
    lines.push("");
    lines.push("## Shadowed (overridden) personas");
    for (const [name, list] of shadowed) {
      const winning = list[list.length - 1]!;
      lines.push(`  ${name}: ${list.length} sources, winning = ${winning.source}`);
      for (const p of list) {
        const marker = p === winning ? "  ✓" : "   ";
        lines.push(`    ${marker} ${p.source.padEnd(8)} ${p.sourcePath}`);
      }
    }
  }

  // Persona file parse errors.
  if (resolved.errors.length > 0) {
    lines.push("");
    lines.push(`## Persona parse errors (${resolved.errors.length})`);
    for (const e of resolved.errors) {
      lines.push(`  ✗ ${e.path}`);
      lines.push(`    ${e.reason}`);
    }
  }

  // Config file load errors.
  if (configErrors.length > 0) {
    lines.push("");
    lines.push(`## Config errors (${configErrors.length})`);
    for (const e of configErrors) {
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
  const projectPath = projectConfigPath(opts.cwd);
  lines.push(`  user:    ${existsSync(userPath) ? "✓" : "·"} ${userPath}`);
  lines.push(`  project: ${existsSync(projectPath) ? "✓" : "·"} ${projectPath}`);

  // Legacy-install audit. The dir at ~/.pi/agent/extensions/conductor/ is
  // expected (it houses config.json), but an `index.{js,ts}` inside it means
  // pi-conductor is being auto-discovered as a standalone extension in
  // addition to whatever load path settings.packages[] (or `pi -e`) set up.
  // The dual-load can resolve `import.meta.url` to the symlink path and
  // break persona discovery silently. See docs/v0.9-symlink-investigation.md.
  const home = opts.homeDir ?? homedir();
  const legacyDir = join(home, ".pi", "agent", "extensions", "conductor");
  const legacyJs = join(legacyDir, "index.js");
  const legacyTs = join(legacyDir, "index.ts");
  const legacyEntry = existsSync(legacyJs)
    ? legacyJs
    : existsSync(legacyTs)
      ? legacyTs
      : null;
  if (legacyEntry !== null) {
    lines.push("");
    lines.push("## Legacy install path detected");
    lines.push(`  ⚠ ${legacyEntry}`);
    lines.push(
      "    pi-conductor is being auto-loaded from ~/.pi/agent/extensions/.",
    );
    lines.push(
      "    If it is also installed via settings.packages[] or `pi -e`, the",
    );
    lines.push(
      "    dual-load can break persona discovery (0 personas resolved).",
    );
    lines.push(
      `    Recommended fix: rm ${legacyEntry}  (the dir + config.json may stay).`,
    );
  }

  // Resolved settings.
  lines.push("");
  lines.push("## Resolved config");
  lines.push(`  defaultTimeoutMinutes: ${cfg.defaultTimeoutMinutes}`);
  lines.push(`  maxConcurrent:         ${cfg.maxConcurrent}`);
  lines.push(`  queueOnConcurrencyCap: ${cfg.queueOnConcurrencyCap}`);
  lines.push(`  defaultSpawnMode:      ${cfg.defaultSpawnMode}`);
  lines.push(`  autoOpenFocusOnSpawn:  ${cfg.autoOpenFocusOnSpawn}`);
  lines.push(`  personaOverrides:      ${Object.keys(cfg.personaOverrides).length} entries`);
  lines.push(`  conductorMode:         ${opts.conductorMode ? "ON" : "off"}`);

  lines.push("");
  lines.push("## Runtime");
  lines.push(`  active:        ${opts.registry.countActive()}`);
  lines.push(`  queued:        ${opts.queue.size()}`);
  lines.push(`  total tracked: ${opts.registry.list().length}`);

  return lines.join("\n");
}

function countBySource(resolved: PersonaResolution): Record<string, number> {
  const counts: Record<string, number> = { builtin: 0, user: 0, project: 0 };
  for (const p of resolved.personas.values()) {
    counts[p.source] = (counts[p.source] ?? 0) + 1;
  }
  return counts;
}
