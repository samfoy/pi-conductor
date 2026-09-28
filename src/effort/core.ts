import type { HookResult } from "../types.ts";

export type VerifyDecision = "accept" | "retry" | "pause" | "verify_failed" | "verify_timeout";
/** Retry only a bounded red result on the same immutable candidate. */
export function nextIntegration(result: HookResult, attempts: number, retries: number): VerifyDecision {
  if (result.passed) return "accept";
  if (result.failureKind === "spawn_error" || result.failureKind === "runaway_output" || result.exitCode === 127 || result.exitCode === 126) return "pause";
  if (attempts <= retries) return "retry";
  return result.failureKind === "timeout" ? "verify_timeout" : "verify_failed";
}

export type MergeTreeResult = { kind: "clean"; tree: string } | { kind: "conflict"; conflicts: string[] } | { kind: "error"; error: string };
export function parseMergeTree(stdout: string, exit: number | null, stderr = ""): MergeTreeResult {
  const [tree, ...lines] = stdout.split("\n");
  if (exit === 0 && /^[0-9a-f]{40,64}$/.test(tree ?? "")) return { kind: "clean", tree };
  if (exit === 1 && /^[0-9a-f]{40,64}$/.test(tree ?? "")) return { kind: "conflict", conflicts: lines.slice(0, lines.indexOf("") < 0 ? lines.length : lines.indexOf("")) };
  return { kind: "error", error: stderr || `merge-tree failed (${exit}): ${stdout}` };
}
