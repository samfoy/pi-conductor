import { matchesGlob } from "node:path";

export interface EffortPolicy {
  verify: string;
  verifyTimeoutSeconds: number;
  verifyRetries: number;
  generated?: { paths: string[]; command: string };
  maxParallel: number;
  merger: "auto" | "ask" | "off";
  mergerMaxAttempts: number;
  land: "branch" | "base";
  history: "squash";
}

export const EFFORT_NOTICE = "M3: new hook-passed writers integrate serially after optional generated artifact regeneration, baseline/candidate verification and repository hooks. Legacy work remains UNINTEGRATED. Interrupted work pauses for inspection; recovery, parallel admission, merger, landing, readers, auto plans, chains and retries are unavailable.";

export function effortSummary(run: import("../types.ts").Run): string {
  if (!run.effort) return "";
  const state = run.landedCommit ? `integrated ${run.landedCommit.slice(0, 12)}` : run.mergeResult?.nothingToCommit ? "tree-equal no-op" : run.status === "integrating" ? `integrating (${run.integration?.state ?? "paused"})` : "UNINTEGRATED";
  return `${run.effort.name}: ${state}${run.mergeResult?.verifyDisabled ? " (effort verify disabled; repository hooks still required)" : ""}${run.integration?.reason ? `: ${run.integration.reason}` : ""}`;
}

export function validateEffortName(name: string): void {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
    throw new Error("effort name must match /^[a-z][a-z0-9-]{0,39}$/");
  }
}

/** Only the documented literal, * and ** path syntax is supported. */
export function validateTouches(paths: unknown): asserts paths is string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some(p =>
    typeof p !== "string" || !p || p.startsWith("/") ||
    !/^[\p{L}\p{N}_.* /-]+$/u.test(p) || p.trim() !== p ||
    p.split("/").some(s => !s || s === "." || s === ".."))) {
    throw new Error("effort paths must be nonempty repo-relative globs using literals, * or **; no traversal or absolute paths");
  }
}

/** Classify concrete repo paths only; broad declarations are trusted policy, not source recognition. */
export function isGeneratedPath(path: string, generated: EffortPolicy["generated"]): boolean {
  return !path.startsWith("/") && !path.includes("\0") && !path.split("/").some(p => !p || p === "." || p === "..") &&
    !!generated?.paths.some(glob => matchesGlob(path, glob));
}

export function resolveEffortPolicy(config: Partial<EffortPolicy> = {}, overrides: Partial<EffortPolicy> = {}): EffortPolicy {
  const p = { verifyTimeoutSeconds: 1200, verifyRetries: 1, maxParallel: 2, merger: "auto", mergerMaxAttempts: 1, land: "branch", history: "squash", ...config, ...overrides };
  if (typeof p.verify !== "string") throw new Error('no verify command: set efforts.verify or explicitly pass verify:"" (verification disabled)');
  if (!Number.isInteger(p.verifyTimeoutSeconds) || p.verifyTimeoutSeconds < 1) throw new Error("efforts.verifyTimeoutSeconds must be a positive integer");
  if (!Number.isInteger(p.verifyRetries) || p.verifyRetries < 0 || p.verifyRetries > 1) throw new Error("efforts.verifyRetries must be 0 or 1");
  if (p.verify.includes("\0")) throw new Error("efforts.verify must not contain NUL");
  if (!Number.isInteger(p.maxParallel) || p.maxParallel < 1) throw new Error("efforts.maxParallel must be a positive integer");
  if (!["auto", "ask", "off"].includes(p.merger)) throw new Error("efforts.merger must be auto, ask or off");
  if (p.mergerMaxAttempts !== 1) throw new Error("efforts.mergerMaxAttempts must be 1");
  if (!["branch", "base"].includes(p.land)) throw new Error("efforts.land must be branch or base");
  if (p.history !== "squash") throw new Error("efforts.history must be squash");
  if (p.generated !== undefined) {
    validateTouches(p.generated?.paths);
    if (typeof p.generated.command !== "string" || !p.generated.command.trim() || p.generated.command.includes("\0")) throw new Error("efforts.generated.command must be nonempty");
  }
  return { verify: p.verify, verifyTimeoutSeconds: p.verifyTimeoutSeconds, verifyRetries: p.verifyRetries, maxParallel: p.maxParallel, merger: p.merger as EffortPolicy["merger"], mergerMaxAttempts: 1,
    land: p.land as EffortPolicy["land"], history: "squash",
    ...(p.generated ? { generated: { paths: [...p.generated.paths], command: p.generated.command } } : {}) };
}
