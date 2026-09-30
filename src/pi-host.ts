import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { SessionManager, VERSION } from "@earendil-works/pi-coding-agent";

/** The version of the package conductor itself imported, which may be a nested copy. */
export const PI_LIBRARY_VERSION = VERSION;

/**
 * Version of the Pi actually executing this process, or "unknown". Conductor's own
 * import can resolve to a nested package copy, so its VERSION is not host evidence
 * unless the host's session object is an instance of that same imported class.
 */
export function hostPiVersion(evidence: { sessionManager?: unknown } = {}, entry: string | undefined = process.argv[1]): string {
  if (evidence.sessionManager instanceof SessionManager) return VERSION;
  if (!entry) return "unknown";
  try {
    const script = realpathSync(entry);
    for (let dir = dirname(script); dir !== dirname(dir); dir = dirname(dir)) {
      let pkg: { name?: unknown; version?: unknown; bin?: unknown };
      try { pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { continue; }
      if (pkg.name === undefined) continue;
      const bins = typeof pkg.bin === "string" ? [pkg.bin] : pkg.bin && typeof pkg.bin === "object" ? Object.values(pkg.bin) : [];
      // The executing script must be this package's declared CLI entry, not any file inside it.
      return pkg.name === "@earendil-works/pi-coding-agent" && typeof pkg.version === "string" &&
        bins.some(bin => typeof bin === "string" && join(dir, bin) === script) ? pkg.version : "unknown";
    }
  } catch { /* unreadable entry: unprovable */ }
  return "unknown";
}
