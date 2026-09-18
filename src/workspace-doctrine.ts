import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

export const MAX_WALK_DEPTH = 6;
export const MAX_DOCTRINE_CHARS = 24_000;
export const DOCTRINE_HEADING = "## Workspace doctrine";

function walkDirs(start: string): string[] {
  const home = resolve(homedir());
  const temp = resolve(tmpdir());
  const dirs: string[] = [];
  let current = resolve(start);
  for (let depth = 0; depth <= MAX_WALK_DEPTH; depth++) {
    if (current !== home && current !== temp) dirs.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return dirs;
}

function findAgentsMd(start: string): string | undefined {
  for (const dir of walkDirs(start)) {
    const candidate = join(dir, "AGENTS.md");
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Missing and unreadable files are a silent no-op.
    }
  }
  return undefined;
}

function gitRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export function childNativeAgentsDirs(workdir: string): string[] {
  const start = resolve(workdir);
  const root = gitRoot(start);
  if (!root || root === start) return [start];
  const rel = relative(root, start);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) return [start];
  const dirs = [root];
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    dirs.push(current);
  }
  return dirs;
}

function truncateDoctrine(text: string, path: string): string {
  const head = text.slice(0, MAX_DOCTRINE_CHARS);
  const newline = head.lastIndexOf("\n");
  const body = newline > 0 ? head.slice(0, newline) : head;
  return (
    `${body}\n\n[workspace doctrine truncated at ${MAX_DOCTRINE_CHARS / 1000} KB - ` +
    `read ${path} for the remainder]`
  );
}

export function loadWorkspaceDoctrine(workdir: string): string {
  try {
    if (!workdir || !statSync(workdir).isDirectory()) return "";
    const start = resolve(workdir);
    const path = findAgentsMd(start);
    if (!path || childNativeAgentsDirs(start).includes(dirname(path))) return "";
    let text = readFileSync(path, "utf8").trim();
    if (!text) return "";
    if (text.length > MAX_DOCTRINE_CHARS) text = truncateDoctrine(text, path);
    return `${DOCTRINE_HEADING}\n\nFrom ${path}. These rules govern this workspace.\n\n${text}`;
  } catch {
    return "";
  }
}
