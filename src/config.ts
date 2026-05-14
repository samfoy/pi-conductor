/**
 * pi-conductor — Config loader.
 *
 * Loads from ~/.pi/agent/extensions/conductor/config.json (user) and
 * <project>/.pi/conductor.json (project, overrides user).
 *
 * Unknown fields are ignored. Malformed JSON falls back to defaults with a logged warning.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, type ConductorConfig } from "./types.ts";

export function userConfigPath(): string {
  return join(homedir(), ".pi", "agent", "extensions", "conductor", "config.json");
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, ".pi", "conductor.json");
}

function safeReadJson(path: string): unknown {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function mergeConfig(base: ConductorConfig, raw: unknown): ConductorConfig {
  if (!raw || typeof raw !== "object") return base;
  const r = raw as Record<string, unknown>;
  const out: ConductorConfig = { ...base };

  if (typeof r.defaultTimeoutMinutes === "number" && r.defaultTimeoutMinutes > 0) {
    out.defaultTimeoutMinutes = r.defaultTimeoutMinutes;
  }
  if (typeof r.maxConcurrent === "number" && r.maxConcurrent >= 1) {
    out.maxConcurrent = Math.floor(r.maxConcurrent);
  }
  if (typeof r.queueOnConcurrencyCap === "boolean") {
    out.queueOnConcurrencyCap = r.queueOnConcurrencyCap;
  }
  if (typeof r.autoOpenFocusOnSpawn === "boolean") {
    out.autoOpenFocusOnSpawn = r.autoOpenFocusOnSpawn;
  }
  if (r.defaultSpawnMode === "foreground" || r.defaultSpawnMode === "background") {
    out.defaultSpawnMode = r.defaultSpawnMode;
  }
  if (r.personaOverrides && typeof r.personaOverrides === "object") {
    // Field-level merge per persona name. A project entry that touches
    // `thinking` does not blow away a user entry's `model`.
    const incoming = r.personaOverrides as Record<string, Record<string, unknown>>;
    const merged = { ...out.personaOverrides } as Record<string, Record<string, unknown>>;
    for (const [name, fields] of Object.entries(incoming)) {
      if (!fields || typeof fields !== "object") continue;
      merged[name] = { ...(merged[name] ?? {}), ...fields };
    }
    out.personaOverrides = merged as unknown as ConductorConfig["personaOverrides"];
  }
  if (typeof r.conductorPromptPath === "string") {
    out.conductorPromptPath = r.conductorPromptPath;
  }

  return out;
}

export function loadConfig(cwd: string): ConductorConfig {
  let cfg = { ...DEFAULT_CONFIG };
  cfg = mergeConfig(cfg, safeReadJson(userConfigPath()));
  cfg = mergeConfig(cfg, safeReadJson(projectConfigPath(cwd)));
  return cfg;
}
