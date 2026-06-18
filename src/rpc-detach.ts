/**
 * RPC-mode foreground detach mechanism.
 *
 * In TUI mode, Esc keystrokes are intercepted via `onTerminalInput`.
 * In RPC/headless mode (e.g. pi-dashboard), `onTerminalInput` is a no-op
 * stub, so we poll for a sentinel file created by the dashboard's
 * conductor-detach endpoint.
 *
 * The sentinel file path is `/tmp/pi-conductor-detach-<pid>`, scoped by the
 * conductor's PID (which pi-manager tracks via `proc.pid`).
 *
 * Extracted from `src/index.ts` for testability.
 */

import { existsSync, unlinkSync } from "node:fs";

export interface RpcDetachHandle {
  /** Resolves when the sentinel file appears (detach requested). */
  detachSignal: Promise<void>;
  /**
   * Clears the poll interval and cleans up any stale sentinel file.
   * Safe to call multiple times.
   */
  unregister: () => void;
}

/**
 * Create a sentinel-file-based detach handle.
 *
 * @param filePath   Path to the sentinel file to poll for.
 * @param intervalMs Poll interval in milliseconds (default 200).
 */
export function createRpcDetach(
  filePath: string,
  intervalMs = 200,
): RpcDetachHandle {
  let resolveDetach: () => void = () => {};
  const detachSignal = new Promise<void>((res) => {
    resolveDetach = res;
  });

  const pollTimer = setInterval(() => {
    if (existsSync(filePath)) {
      try { unlinkSync(filePath); } catch { /* ignore race */ }
      resolveDetach();
      clearInterval(pollTimer);
    }
  }, intervalMs);

  const unregister = () => {
    clearInterval(pollTimer);
    // Clean up any stale signal file left behind.
    try { if (existsSync(filePath)) unlinkSync(filePath); } catch { /* ignore */ }
  };

  return { detachSignal, unregister };
}
