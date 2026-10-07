/**
 * Test fixtures that never outlive their test file.
 *
 * tmpDir: a fresh temp dir under `os.tmpdir()`, removed when the file's
 * process exits. node --test runs each file in its own process, and by exit
 * every fire-and-forget write a spawned run makes (record.json, final.md,
 * hook logs) has landed, so none can re-create a directory after removal.
 * Not `after()`: inside a beforeEach it fires before the test body runs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];
let preserved = false;

/** A failing test keeps every fixture root of its process for inspection; returns them. */
export function preserveTmpDirs(): string[] {
  preserved = true;
  return [...made];
}

export function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  if (made.push(dir) === 1) process.once("exit", removeAll);
  return dir;
}

function removeAll(): void {
  if (preserved) return;
  for (const dir of made) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // A leftover dir must never turn a green file red at exit.
    }
  }
}

/**
 * For a file whose spawns would otherwise start the real pi: npm puts
 * node_modules/.bin/pi on PATH, and against the real HOME it loads the
 * user's extensions and writes run dirs into ~/.pi/agent/conductor/runs.
 * Points HOME at a temp dir and PI_BIN at a stub that exits 1 at once, as
 * an unconfigured pi would; an idle stub would hang a file whose test marks
 * the run terminal by hand, since the timeout then never kills it. Call at
 * module level; the file's process ends with it, so the env goes no further.
 */
export function sandboxPi(): { home: string; piBin: string } {
  const root = tmpDir("conductor-sandbox-pi-");
  const home = join(root, "home");
  mkdirSync(home);
  const piBin = join(root, "pi-stub.mjs");
  writeFileSync(piBin, "process.exit(1);\n");
  process.env.HOME = home;
  process.env.PI_BIN = piBin;
  return { home, piBin };
}
