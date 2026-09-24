/**
 * pi-conductor — default cwd for spawns. pi can't change a session's cwd, so
 * the conductor keeps its own: the session cwd unless `/conductor cwd` or
 * `ensemble_cwd` set an override, persisted as a `conductor-cwd` entry.
 */

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const CWD_ENTRY_TYPE = "conductor-cwd";

export type CwdResolution = { ok: true; cwd: string } | { ok: false; error: string };

/** Expand `~`, resolve relative paths against `base`, and require an existing directory. */
export function resolveCwdArg(input: string, base: string): CwdResolution {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "cwd must be a non-empty path" };
  const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
  const cwd = resolve(base, expanded);
  let isDir: boolean;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    return { ok: false, error: `cwd ${cwd} does not exist` };
  }
  return isDir ? { ok: true, cwd } : { ok: false, error: `cwd ${cwd} is not a directory` };
}

export type CwdSource = "session start" | "override";

export interface CwdInfo {
  cwd: string;
  source: CwdSource;
}

export function formatCwdInfo(info: CwdInfo): string {
  return `cwd: ${info.cwd} (${info.source})`;
}

/** The override recorded by the last `conductor-cwd` entry; a reset entry (`cwd: null`) clears it. */
export function latestCwdOverride(entries: readonly unknown[]): string | undefined {
  let latest: string | undefined;
  for (const e of entries) {
    const entry = e as { type?: string; customType?: string; data?: { cwd?: unknown } };
    if (entry?.type !== "custom" || entry.customType !== CWD_ENTRY_TYPE) continue;
    latest = typeof entry.data?.cwd === "string" ? entry.data.cwd : undefined;
  }
  return latest;
}

export interface CwdRequest {
  path?: string;
  reset?: boolean;
}

export type CwdChangeResult = { ok: true; info: CwdInfo } | { ok: false; error: string };

export interface CwdController {
  /** Effective default cwd: the override when set, else the session cwd. */
  get(): string;
  override(): string | undefined;
  info(): CwdInfo;
  /** Track pi's `ctx.cwd`; never touches an active override. */
  setSessionCwd(cwd: string): void;
  /** Shared by `/conductor cwd` and `ensemble_cwd`: report, set, or reset. */
  change(req: CwdRequest): CwdChangeResult;
  /** Adopt the session's persisted override. Returns a warning when it no longer resolves. */
  restore(entries: readonly unknown[]): string | undefined;
}

export function createCwdController(deps: {
  sessionCwd: string;
  persist: (data: { cwd: string | null }) => void;
  onChange?: () => void;
}): CwdController {
  let sessionCwd = deps.sessionCwd;
  let override: string | undefined;
  const get = () => override ?? sessionCwd;
  const info = (): CwdInfo => ({ cwd: get(), source: override ? "override" : "session start" });

  return {
    get,
    override: () => override,
    info,
    setSessionCwd(cwd) {
      sessionCwd = cwd;
    },
    change(req) {
      if (req.reset && req.path !== undefined) {
        return { ok: false, error: "pass a path or reset, not both" };
      }
      if (req.reset) {
        override = undefined;
      } else if (req.path !== undefined) {
        const r = resolveCwdArg(req.path, get());
        if (!r.ok) return r;
        override = r.cwd;
      } else {
        return { ok: true, info: info() };
      }
      deps.persist({ cwd: override ?? null });
      deps.onChange?.();
      return { ok: true, info: info() };
    },
    restore(entries) {
      const saved = latestCwdOverride(entries);
      override = undefined;
      if (saved === undefined) return undefined;
      const r = resolveCwdArg(saved, sessionCwd);
      if (!r.ok) return `conductor cwd override dropped: ${r.error}`;
      override = r.cwd;
      return undefined;
    },
  };
}
