export interface EffortPolicy {
  verify: string;
  generated?: { paths: string[]; command: string };
  maxParallel: number;
  merger: "auto" | "ask" | "off";
  mergerMaxAttempts: number;
  land: "branch" | "base";
  history: "squash";
}

export const EFFORT_NOTICE = "M1: writers are UNINTEGRATED until M2. Baseline is not verified; no automatic integration or landing. Readers, auto plans, chains and retries are unavailable for efforts.";

export function validateEffortName(name: string): void {
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(name)) {
    throw new Error("effort name must match /^[a-z][a-z0-9-]{0,39}$/");
  }
}

/** Only the documented literal, * and ** path syntax is supported in M1. */
export function validateTouches(paths: unknown): asserts paths is string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.some(p =>
    typeof p !== "string" || !p || p.startsWith("/") ||
    !/^[A-Za-z0-9_.* /-]+$/.test(p) || p.trim() !== p ||
    p.split("/").some(s => !s || s === "." || s === ".."))) {
    throw new Error("effort paths must be nonempty repo-relative globs using literals, * or **; no traversal or absolute paths");
  }
}

export function resolveEffortPolicy(config: Partial<EffortPolicy> = {}, overrides: Partial<EffortPolicy> = {}): EffortPolicy {
  const p = { maxParallel: 2, merger: "auto", mergerMaxAttempts: 1, land: "branch", history: "squash", ...config, ...overrides };
  if (typeof p.verify !== "string") throw new Error('no verify command: set efforts.verify or explicitly pass verify:"" (verification disabled)');
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
  return { verify: p.verify, maxParallel: p.maxParallel, merger: p.merger as EffortPolicy["merger"], mergerMaxAttempts: 1,
    land: p.land as EffortPolicy["land"], history: "squash",
    ...(p.generated ? { generated: { paths: [...p.generated.paths], command: p.generated.command } } : {}) };
}
