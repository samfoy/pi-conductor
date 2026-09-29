import type { HookResult } from "../types.ts";

export type VerifyDecision = "accept" | "retry" | "pause" | "verify_failed" | "verify_timeout";
/** Retry only a bounded red result on the same immutable candidate. */
export function nextIntegration(result: HookResult, attempts: number, retries: number): VerifyDecision {
  if (result.passed) return "accept";
  if (result.failureKind === "spawn_error" || result.failureKind === "runaway_output" || result.exitCode === 127 || result.exitCode === 126) return "pause";
  if (attempts <= retries) return "retry";
  return result.failureKind === "timeout" ? "verify_timeout" : "verify_failed";
}

export type MergeTreeResult = { kind: "clean"; tree: string } | { kind: "conflict"; tree: string; conflicts: string[] } | { kind: "error"; error: string };
/** --name-only -z: tree, conflicted paths, empty separator, optional informational records. */
export function parseMergeTree(stdout: string, exit: number | null, stderr = ""): MergeTreeResult {
  const [tree, ...fields] = stdout.split("\0");
  if (stdout.endsWith("\0") && /^[0-9a-f]{40,64}$/.test(tree ?? "")) {
    if (exit === 0 && fields[0] === "") return { kind: "clean", tree };
    const end = fields.indexOf("");
    if (exit === 1 && end > 0 && end < fields.length - 1) return { kind: "conflict", tree, conflicts: fields.slice(0, end) };
  }
  return { kind: "error", error: stderr || `merge-tree failed or malformed output (${exit}): ${stdout}` };
}
