/**
 * pi-conductor — Tools registered with pi.
 *
 * v0.1 ships only read-only tools: ensemble_list and ensemble_status.
 * Spawning, sending, pausing, etc. arrive in v0.2+.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Persona } from "./types.ts";
import { resolvePersonas } from "./personas.ts";
import { loadConfig } from "./config.ts";

interface RegisterToolsOpts {
  /** Returns the current cwd (provided by the extension lifecycle hooks). */
  getCwd: () => string;
}

export function registerTools(pi: ExtensionAPI, opts: RegisterToolsOpts): void {
  // ── ensemble_list ──────────────────────────────────────────────────

  pi.registerTool({
    name: "ensemble_list",
    label: "List personas",
    description:
      "List the conductor sub-agent personas available in this workspace. " +
      "Returns each persona's name, one-line description, model/thinking config, " +
      "context-inheritance mode, and source (builtin / user / project).",
    promptSnippet: "List available conductor sub-agent personas",
    promptGuidelines: [
      "Call ensemble_list when you need to know which personas are installed before spawning one.",
      "The returned descriptions are short — read the persona body via /conductor show <name> if you need the full system prompt.",
    ],
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const cwd = opts.getCwd();
      const cfg = loadConfig(cwd);
      const resolved = await resolvePersonas({
        cwd,
        personaOverrides: cfg.personaOverrides,
      });

      const personas = [...resolved.personas.values()].sort((a, b) =>
        a.name.localeCompare(b.name),
      );

      return {
        content: [{ type: "text" as const, text: formatPersonaListForLLM(personas) }],
        details: {
          count: personas.length,
          personas: personas.map(personaSummary),
          errors: resolved.errors,
        },
      };
    },
  });

  // ── ensemble_status ────────────────────────────────────────────────

  pi.registerTool({
    name: "ensemble_status",
    label: "Sub-agent status",
    description:
      "Report status of currently-running, queued, paused, and recently-finished sub-agents. " +
      "v0.1 stub — will return live state once spawning lands in v0.2.",
    promptSnippet: "Check status of conductor sub-agents",
    promptGuidelines: [
      "ensemble_status is a stub in v0.1; it will report empty until v0.2 ships spawning.",
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.String({ description: "Filter to a specific agent_id; omit for all." }),
      ),
    }),
    async execute(_id, _params) {
      return {
        content: [
          {
            type: "text" as const,
            text: "No sub-agents are running. (Spawning lands in pi-conductor v0.2.)",
          },
        ],
        details: { running: [], queued: [], paused: [], finished: [] },
      };
    },
  });
}

// ── Formatting helpers ────────────────────────────────────────────────

function personaSummary(p: Persona): Record<string, unknown> {
  return {
    name: p.name,
    description: p.description,
    model: p.model ?? "<inherited>",
    thinking: p.thinking ?? "<inherited>",
    inheritContext: p.inheritContext,
    inheritSkills: p.inheritSkills,
    timeoutMinutes: p.timeoutMinutes,
    source: p.source,
  };
}

function formatPersonaListForLLM(personas: Persona[]): string {
  if (personas.length === 0) {
    return "No personas resolved. Check ~/.pi/agent/conductor/personas/ and `<cwd>/.pi/conductor/personas/`.";
  }
  const lines: string[] = [`${personas.length} personas:`, ""];
  for (const p of personas) {
    const cfg: string[] = [];
    cfg.push(`source=${p.source}`);
    cfg.push(`model=${p.model ?? "inherited"}`);
    cfg.push(`thinking=${p.thinking ?? "inherited"}`);
    cfg.push(`context=${p.inheritContext}`);
    lines.push(`  ${p.name.padEnd(14)} — ${p.description}`);
    lines.push(`  ${" ".repeat(14)}   [${cfg.join(", ")}]`);
  }
  return lines.join("\n");
}
