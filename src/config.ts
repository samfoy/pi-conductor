/**
 * pi-conductor — Config loader.
 *
 * Loads from ~/.pi/agent/extensions/conductor/config.json (user) and
 * <project>/.pi/conductor.json (project, overrides user).
 *
 * Two entry points:
 *   - loadConfig(cwd): ConductorConfig
 *       Silent-fallback for hot paths (every spawn re-reads config; we
 *       don't want chatty console.warn logs in the agent loop).
 *   - loadConfigWithErrors(cwd): { config, errors[] }
 *       Used by /conductor doctor to surface malformed config files to
 *       the user without crashing the session.
 *
 * Unknown fields are ignored (forward-compat). Bad-typed values silently
 * fall back to defaults — captured by the existing config tests.
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

export interface ConfigLoadError {
  path: string;
  reason: string;
}

export interface LoadConfigResult {
  config: ConductorConfig;
  errors: ConfigLoadError[];
}

interface ReadResult {
  value: unknown;
  error?: ConfigLoadError;
}

function safeReadJson(path: string): ReadResult {
  if (!existsSync(path)) return { value: null };
  try {
    return { value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (e) {
    return {
      value: null,
      error: { path, reason: (e as Error).message },
    };
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

/**
 * Load config and return both the resolved config and any file-load errors.
 * Use this when surfacing config health to the user (e.g. /conductor doctor).
 */
export function loadConfigWithErrors(cwd: string): LoadConfigResult {
  let cfg = { ...DEFAULT_CONFIG };
  const errors: ConfigLoadError[] = [];

  const u = safeReadJson(userConfigPath());
  if (u.error) errors.push(u.error);
  cfg = mergeConfig(cfg, u.value);

  const p = safeReadJson(projectConfigPath(cwd));
  if (p.error) errors.push(p.error);
  cfg = mergeConfig(cfg, p.value);

  return { config: cfg, errors };
}

/**
 * Silent-fallback wrapper around loadConfigWithErrors. Use this in hot
 * paths (every ensemble_spawn invocation re-reads config). Errors are
 * discarded — surfacing them is /conductor doctor's job.
 */
export function loadConfig(cwd: string): ConductorConfig {
  return loadConfigWithErrors(cwd).config;
}
