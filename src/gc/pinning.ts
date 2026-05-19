/**
 * pi-conductor — Pinning sidecar primitives.
 *
 * Per design D4: pinning is an empty `.pinned` file inside <runDir>.
 * Existence is the signal; mtime is the date-pinned (advisory). The
 * policy engine (slice 1) already filters pinned runs out of
 * `cold-archive`/`delete` actions via `entry.pinned` flag derived from
 * `walkInventory`'s sidecar detection. Slice 4 just lands the
 * write/read primitives the slash UI calls.
 *
 * Spec: docs/v0.9-gc-design.md §D4; docs/v0.9-gc-plan.md "Slice 4".
 */

import { existsSync } from "node:fs";
import { stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SIDECAR = ".pinned";

/**
 * Mark a run as pinned. Creates an empty `<runsRoot>/<agentId>/.pinned`
 * marker file. Idempotent — already-pinned is a no-op overwrite of an
 * empty file. Throws with a clear message if the runDir does not exist
 * or is not a directory (so we never leave a dangling sidecar).
 */
export async function pinRun(runsRoot: string, agentId: string): Promise<void> {
  const dir = join(runsRoot, agentId);
  let st;
  try {
    st = await stat(dir);
  } catch {
    throw new Error(`no such run directory: ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  await writeFile(join(dir, SIDECAR), "");
}

/**
 * Remove the pinning sidecar. Idempotent — absent file (or absent
 * runDir entirely) is silently fine. Other errors propagate.
 */
export async function unpinRun(runsRoot: string, agentId: string): Promise<void> {
  const path = join(runsRoot, agentId, SIDECAR);
  try {
    await unlink(path);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === "ENOENT") return;
    throw e;
  }
}

/**
 * True iff `<runsRoot>/<agentId>/.pinned` exists. Sync — used in hot
 * paths (history rendering, slash command pre-checks) where async
 * adds no value.
 */
export function isPinned(runsRoot: string, agentId: string): boolean {
  return existsSync(join(runsRoot, agentId, SIDECAR));
}
