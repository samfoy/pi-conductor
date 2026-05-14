/**
 * pi-conductor — Extension entry point.
 *
 * v0.1 (read-only):
 *   - persona discovery + resolution (builtin / user / project layering)
 *   - tools: ensemble_list, ensemble_status (status is a stub until v0.2)
 *   - slash commands: /conductor list, /conductor show, /conductor doctor
 *
 * v0.2 will add spawning (foreground default, inline streaming, background
 * notification cards, queueing with auto-downgrade), the ensemble TUI panel,
 * and the conductor mode system prompt.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCommands } from "./commands.ts";
import { registerTools } from "./tools.ts";

export default function (pi: ExtensionAPI): void {
  // Cwd is provided by the extension context; we capture it on session_start
  // and refresh on agent_turn_start so commands and tools see the right value.
  let cwd = process.cwd();

  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
  });

  pi.on("turn_start", async (_event, ctx) => {
    cwd = ctx.cwd;
  });

  const opts = { getCwd: () => cwd };

  registerTools(pi, opts);
  registerCommands(pi, opts);
}
