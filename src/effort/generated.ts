import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HookResult } from "../types.ts";
import { effortGit } from "./open.ts";
import { assertCandidateIndexFlags } from "./git.ts";
import { isGeneratedPath, type EffortPolicy } from "./policy.ts";

/** No rename inference: both the deletion and addition must satisfy the boundary. */
export function changedPaths(cwd: string, before: string, after: string): string[] {
  return effortGit(cwd, "diff-tree", "-r", "--no-renames", "--name-only", "-z", before, after).split("\0").filter(Boolean);
}

// Read actual bytes, including ignored files; git diff alone misses ignored/assume-unchanged writes.
// Never follow symlinks. Candidate dependencies normally resolve upward rather than living here.
function snapshot(cwd: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(readdirSync(join(cwd, prefix)).flatMap(name => {
    const path = prefix ? `${prefix}/${name}` : name;
    const file = join(cwd, path), stat = lstatSync(file);
    if (stat.isDirectory() && path !== ".git") return Object.entries(snapshot(cwd, path));
    if (stat.isSymbolicLink()) return [[path, `link:${readlinkSync(file)}`]];
    if (!stat.isFile()) throw new Error(`generated candidate contains unsupported file type: ${JSON.stringify(path)}`);
    return [[path, `${stat.mode}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`]];
  }));
}

export async function regenerateCandidate(cwd: string, expectedHead: string, generated: NonNullable<EffortPolicy["generated"]>, evidencePath: string,
  command: () => Promise<HookResult>, fence: () => void): Promise<HookResult> {
  const beforeTree = effortGit(cwd, "write-tree");
  const before = snapshot(cwd);
  writeFileSync(evidencePath, JSON.stringify({ tree: beforeTree, files: before }, null, 2));
  for (const [path, value] of Object.entries(before)) {
    if (isGeneratedPath(path, generated) && value.startsWith("link:")) throw new Error(`generated symlink artifacts are unsupported: ${JSON.stringify(path)}`);
  }
  const result = await command();
  if (!result.passed) return result;
  fence();
  if (effortGit(cwd, "rev-parse", "HEAD") !== expectedHead || effortGit(cwd, "rev-parse", "--abbrev-ref", "HEAD") !== "HEAD") throw new Error("generated command changed candidate HEAD/ref");
  const after = snapshot(cwd);
  const paths = [...new Set([
    ...Object.keys(before), ...Object.keys(after),
  ])].filter(path => before[path] !== after[path]);
  const staged = changedPaths(cwd, beforeTree, effortGit(cwd, "write-tree"));
  const changed = [...new Set([...paths, ...staged])];
  const outside = changed.filter(path => path === ".git" || !isGeneratedPath(path, generated));
  if (outside.length) throw new Error(`generated command edited paths outside generated policy: ${JSON.stringify(outside)}`);
  assertCandidateIndexFlags(cwd);
  for (const path of changed) {
    if (after[path]?.startsWith("link:")) throw new Error(`generated symlink artifacts are unsupported: ${JSON.stringify(path)}`);
  }
  // Literal, concrete leaf paths only, including tracked deletions and explicitly allowed ignored additions.
  for (const path of changed) {
    fence();
    if (after[path] === undefined) effortGit(cwd, "update-index", "--force-remove", "--", path);
    else effortGit(cwd, "--literal-pathspecs", "add", "--force", "--", path);
  }
  return result;
}
