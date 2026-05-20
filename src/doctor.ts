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
import { lastGcMarkerPath, readLastGcMtime } from "./gc/last-gc.ts";
import { walkInventory } from "./gc/inventory.ts";
import { planReclaim } from "./gc/policy.ts";

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
  /**
   * Override the conductor runs root (parent of the runs/ dir). Used by
   * the v0.9 Slice 5 "Last GC" surface so tests can stub the marker
   * path without touching the real `~/.pi/agent/conductor/runs`.
   */
  runsRoot?: string;
  /**
   * Override `Date.now()` for the v0.9 Slice 7 next-eviction preview.
   * Lets tests inject a deterministic clock when classifying orphans /
   * eviction candidates without touching the real wall-clock.
   */
  now?: number;
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
  lines.push(`  maxConcurrentWriteCapable: ${cfg.maxConcurrentWriteCapable}`);
  lines.push(`  queueOnConcurrencyCap: ${cfg.queueOnConcurrencyCap}`);
  lines.push(`  defaultSpawnMode:      ${cfg.defaultSpawnMode}`);
  lines.push(`  autoOpenFocusOnSpawn:  ${cfg.autoOpenFocusOnSpawn}`);
  lines.push(`  personaOverrides:      ${Object.keys(cfg.personaOverrides).length} entries`);
  lines.push(`  conductorMode:         ${opts.conductorMode ? "ON" : "off"}`);
  // v0.9 Slice 5: minimal GC autotrigger + last-run surface. Slice 7
  // polishes with usage, next-eviction preview, and orphan count.
  lines.push(
    `  gc:                    ${cfg.gc.enabled ? "enabled" : "DISABLED"} ` +
      `(completed=${cfg.gc.completedTtlDays}d, failed=${cfg.gc.failedTtlDays}d, ` +
      `budget=${Math.round(cfg.gc.totalSizeBudgetBytes / (1024 * 1024 * 1024))}GB)`,
  );
  lines.push(
    `  gc auto:               ${cfg.gc.autoOnSessionStart ? "ON" : "off"} ` +
      `(debounce=${cfg.gc.autoDebounceHours}h)`,
  );
  // v0.10 Slice 3: surface watchdog defaults so operators see what
  // thresholds apply to spawns that don't override them.
  lines.push(
    `  watchdog:              ${cfg.watchdog.enabled ? "enabled" : "DISABLED"} ` +
      `(soft=${cfg.watchdog.defaultSoftSeconds}s, hard=${cfg.watchdog.defaultHardSeconds}s, ` +
      `grace=${cfg.watchdog.graceSeconds}s)`,
  );
  lines.push(
    `  watchdog kill_on_stall: ${cfg.watchdog.defaultKillOnStall ? "ON (default)" : "off (default)"} ` +
      `— per-spawn override via ensemble_spawn kill_on_stall arg`,
  );
  // v0.10 Slice 4: live stall counter. Counts runs whose enforcer has
  // marked stalledSince — i.e. runs that crossed soft or hard at last
  // tick. Pure read off the registry; no clock arithmetic here
  // (`/conductor watchdog status` does the live silent-seconds math).
  {
    const all = opts.registry.list();
    const activeCount = all.filter(
      (r) =>
        r.status === "running" || r.status === "queued" || r.status === "paused",
    ).length;
    const stalledCount = all.filter((r) => r.stalledSince !== undefined).length;
    lines.push(
      `  watchdog runtime:      active=${activeCount}  stalled=${stalledCount}`,
    );
  }
  {
    const root = opts.runsRoot ?? join(opts.homeDir ?? homedir(), ".pi", "agent", "conductor", "runs");
    const lastMs = readLastGcMtime(root);
    const lastStr =
      lastMs === null
        ? "never"
        : new Date(lastMs).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    lines.push(`  gc last run:           ${lastStr} (${lastGcMarkerPath(root)})`);
  }

  // v0.9 Slice 7: Run-record disk usage + next-eviction preview.
  // Reads the runs/ directory once via walkInventory, then runs a
  // dry-run plan via planReclaim. No I/O beyond stat()s. Slice 5
  // already surfaces gc enabled / last-gc-mtime above; this section
  // adds the operational story (how many records, how big, how many
  // pinned, how many orphaned, what the next gc pass would do).
  {
    const runsRoot = opts.runsRoot ?? join(opts.homeDir ?? homedir(), ".pi", "agent", "conductor", "runs");
    lines.push("");
    lines.push(`## Run records (under ${runsRoot})`);
    if (!existsSync(runsRoot)) {
      lines.push("  (no run records)");
    } else {
      let inventory: Awaited<ReturnType<typeof walkInventory>>;
      try {
        inventory = await walkInventory(runsRoot, opts.registry);
      } catch {
        inventory = [];
      }
      if (inventory.length === 0) {
        lines.push("  (no run records)");
      } else {
        const totalBytes = inventory.reduce((s, e) => s + e.totalSizeBytes, 0);
        const pinned = inventory.filter((e) => e.pinned);
        const pinnedBytes = pinned.reduce((s, e) => s + e.totalSizeBytes, 0);
        lines.push(
          `  total:                 ${inventory.length} runs, ${formatBytes(totalBytes)} on disk`,
        );
        lines.push(
          `  pinned:                ${pinned.length} runs (${formatBytes(pinnedBytes)} protected)`,
        );

        if (cfg.gc.enabled) {
          const now = opts.now ?? Date.now();
          const plan = planReclaim(inventory, cfg.gc, now);
          let orphans = 0;
          let archives = 0;
          let archiveBytes = 0;
          let deletes = 0;
          let deleteBytes = 0;
          for (const a of plan.actions) {
            if (a.kind === "reconcile-orphan") orphans++;
            else if (a.kind === "cold-archive") {
              archives++;
              archiveBytes += a.bytesReclaimed;
            } else if (a.kind === "delete") {
              deletes++;
              deleteBytes += a.bytesReclaimed;
            }
          }
          lines.push(
            `  orphaned:              ${orphans} records (status=running but stale, not in registry)`,
          );
          lines.push(
            `  next eviction (dry):   ${archives} archive (~${formatBytes(archiveBytes)}), ${deletes} delete (~${formatBytes(deleteBytes)})`,
          );
        } else {
          // Still surface the orphan count even when gc is disabled,
          // because operators care whether the records are stale
          // regardless of whether reclaim is on.
          let orphans = 0;
          for (const e of inventory) {
            if (e.status === "running" && e.inMemory === undefined) orphans++;
          }
          lines.push(
            `  orphaned:              ${orphans} records (status=running but stale, not in registry)`,
          );
          lines.push(`  (GC disabled)`);
        }
      }
    }
  }

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

/** Compact human-readable byte size: 12 B / 4.2 KB / 1.7 GB. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}
