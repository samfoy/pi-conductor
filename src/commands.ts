/**
 * pi-conductor — Slash commands.
 *
 * v0.2 lineup:
 *   /conductor list                  — list resolved personas
 *   /conductor show <persona>        — display a persona's full file
 *   /conductor doctor                — health check
 *   /conductor on | off              — toggle PI_CONDUCTOR_MODE for this session
 *   /conductor status                — alias for ensemble_status formatting
 *   /conductor stop <agent-id|all>   — kill a running sub-agent
 *   /conductor pause <agent-id|all>  — SIGSTOP
 *   /conductor resume <agent-id|all> — SIGCONT
 *   /conductor queue                 — show the spawn queue
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { existsSync } from "node:fs";
import type { PersonaResolution, Run } from "./types.ts";
import { resolvePersonas } from "./personas.ts";
import { loadConfig, projectConfigPath, userConfigPath } from "./config.ts";
import {
  elapsedStr,
  forceTerminate,
  formatUsage,
  pauseRun,
  resumeRun,
  type RunRegistry,
} from "./runs.ts";
import { SpawnQueue } from "./queue.ts";
import { buildDoctorReport } from "./doctor.ts";

interface RegisterCommandsOpts {
  getCwd: () => string;
  getRegistry: () => RunRegistry;
  getQueue: () => SpawnQueue;
  /** Read/write the conductor-mode flag for this session. */
  getConductorMode: () => boolean;
  setConductorMode: (on: boolean) => void;
  /** Open the focused-stream overlay (no-op when no UI ctx). */
  openFocusedOverlay: (id?: string) => void;
}

const SUBCOMMANDS = [
  "list",
  "show",
  "doctor",
  "on",
  "off",
  "status",
  "stop",
  "pause",
  "resume",
  "queue",
  "focus",
];

export function registerCommands(pi: ExtensionAPI, opts: RegisterCommandsOpts): void {
  pi.registerCommand("conductor", {
    description: "pi-conductor: list, show, doctor, on/off, status, stop/pause/resume/queue",
    getArgumentCompletions: (prefix: string) => {
      const items = SUBCOMMANDS.map((s) => ({ value: s, label: s }));
      const head = prefix.split(/\s+/)[0] ?? "";
      const filtered = items.filter((i) => i.value.startsWith(head));
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (rawArgs, ctx) => {
      const args = (rawArgs ?? "").trim();
      const [sub, ...rest] = args.split(/\s+/);
      const subRest = rest.join(" ").trim();

      switch (sub) {
        case "":
        case "list":
          await runList(opts, ctx);
          return;
        case "show":
          await runShow(opts, ctx, subRest);
          return;
        case "doctor":
          await runDoctor(opts, ctx);
          return;
        case "on":
          opts.setConductorMode(true);
          ctx.ui.notify(
            "conductor mode ON — system prompt addendum will be injected at every turn.",
            "info",
          );
          return;
        case "off":
          opts.setConductorMode(false);
          ctx.ui.notify("conductor mode OFF.", "info");
          return;
        case "status":
          runStatus(opts, ctx);
          return;
        case "stop":
          runStop(opts, ctx, subRest);
          return;
        case "pause":
          runPause(opts, ctx, subRest);
          return;
        case "resume":
          runResume(opts, ctx, subRest);
          return;
        case "queue":
          runQueueCmd(opts, ctx);
          return;
        case "focus":
          runFocus(opts, ctx, subRest);
          return;
        default:
          ctx.ui.notify(
            `unknown subcommand: ${sub}. Try one of: ${SUBCOMMANDS.join(", ")}.`,
            "warning",
          );
      }
    },
  });
}

async function runList(opts: RegisterCommandsOpts, ctx: ExtensionCommandContext): Promise<void> {
  const cwd = opts.getCwd();
  const cfg = loadConfig(cwd);
  const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
  const personas = [...resolved.personas.values()].sort((a, b) => a.name.localeCompare(b.name));

  if (personas.length === 0) {
    ctx.ui.notify(
      "no personas resolved. Add files under ~/.pi/agent/conductor/personas/ or <cwd>/.pi/conductor/personas/",
      "warning",
    );
    return;
  }

  const lines: string[] = [`${personas.length} personas resolved:`, ""];
  for (const p of personas) {
    const cfgBits: string[] = [];
    cfgBits.push(`source=${p.source}`);
    if (p.model) cfgBits.push(`model=${p.model}`);
    if (p.thinking) cfgBits.push(`thinking=${p.thinking}`);
    cfgBits.push(`context=${p.inheritContext}`);
    lines.push(`  ${p.name.padEnd(14)} — ${p.description}`);
    lines.push(`  ${" ".repeat(14)}   [${cfgBits.join(", ")}]`);
  }
  if (resolved.errors.length > 0) {
    lines.push("", `${resolved.errors.length} parse errors:`);
    for (const e of resolved.errors) {
      lines.push(`  ✗ ${e.path}: ${e.reason}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function runShow(
  opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
  name: string,
): Promise<void> {
  if (!name) {
    ctx.ui.notify("usage: /conductor show <persona-name>", "warning");
    return;
  }
  const cwd = opts.getCwd();
  const cfg = loadConfig(cwd);
  const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
  const p = resolved.personas.get(name);
  if (!p) {
    ctx.ui.notify(
      `persona "${name}" not found. Run /conductor list to see what's available.`,
      "warning",
    );
    return;
  }

  const lines: string[] = [];
  lines.push(`# ${p.name}`);
  lines.push(`source: ${p.source} (${p.sourcePath})`);
  lines.push(`description: ${p.description}`);
  lines.push(`model: ${p.model ?? "<inherited>"}`);
  lines.push(`thinking: ${p.thinking ?? "<inherited>"}`);
  lines.push(`inherit_context: ${p.inheritContext}`);
  lines.push(`inherit_skills: ${p.inheritSkills}`);
  lines.push(
    `default_reads: ${p.defaultReads.length === 0 ? "(none)" : p.defaultReads.join(", ")}`,
  );
  lines.push(`worktree: ${p.worktree}`);
  lines.push(`timeout_minutes: ${p.timeoutMinutes}`);
  lines.push("");
  lines.push("## System prompt");
  lines.push("");
  lines.push(p.systemPrompt);

  ctx.ui.notify(lines.join("\n"), "info");
}

async function runDoctor(
  opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const report = await buildDoctorReport({
    cwd: opts.getCwd(),
    registry: opts.getRegistry(),
    queue: opts.getQueue(),
    conductorMode: opts.getConductorMode(),
  });
  ctx.ui.notify(report, "info");
}

function runStatus(opts: RegisterCommandsOpts, ctx: ExtensionCommandContext): void {
  const registry = opts.getRegistry();
  const queue = opts.getQueue();
  const all = registry.list();
  if (all.length === 0 && queue.size() === 0) {
    ctx.ui.notify("no sub-agents.", "info");
    return;
  }

  const lines: string[] = [];
  for (const r of all) lines.push(formatRunRow(r));
  if (queue.size() > 0) {
    lines.push("");
    lines.push(`Queue (${queue.size()}):`);
    for (const p of queue.list()) {
      lines.push(`  ${p.id.padEnd(20)} ${p.persona.name.padEnd(14)} (requested=${p.requestedMode})`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

function runStop(
  opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
  arg: string,
): void {
  const registry = opts.getRegistry();
  if (!arg) {
    ctx.ui.notify("usage: /conductor stop <agent-id|all>", "warning");
    return;
  }
  const targets = arg === "all" ? registry.list() : [registry.get(arg)].filter(Boolean) as Run[];
  if (targets.length === 0) {
    ctx.ui.notify(`no sub-agent matching "${arg}"`, "warning");
    return;
  }
  let n = 0;
  for (const r of targets) {
    if (r.status === "queued") {
      opts.getQueue().removeQueued(r.id);
      n++;
    } else if (r.status === "running" || r.status === "paused") {
      forceTerminate(r, "killed", registry);
      n++;
    }
  }
  ctx.ui.notify(`stopped ${n} sub-agent(s)`, "info");
}

function runPause(
  opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
  arg: string,
): void {
  const registry = opts.getRegistry();
  if (!arg) {
    ctx.ui.notify("usage: /conductor pause <agent-id|all>", "warning");
    return;
  }
  const targets =
    arg === "all" ? registry.list().filter((r) => r.status === "running") : [registry.get(arg)].filter(Boolean) as Run[];
  let n = 0;
  for (const r of targets) {
    if (pauseRun(r, registry)) n++;
  }
  ctx.ui.notify(`paused ${n} sub-agent(s)`, "info");
}

function runResume(
  opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
  arg: string,
): void {
  const registry = opts.getRegistry();
  if (!arg) {
    ctx.ui.notify("usage: /conductor resume <agent-id|all>", "warning");
    return;
  }
  const targets =
    arg === "all" ? registry.list().filter((r) => r.status === "paused") : [registry.get(arg)].filter(Boolean) as Run[];
  let n = 0;
  for (const r of targets) {
    if (resumeRun(r, registry)) n++;
  }
  ctx.ui.notify(`resumed ${n} sub-agent(s)`, "info");
}

function runQueueCmd(opts: RegisterCommandsOpts, ctx: ExtensionCommandContext): void {
  const queue = opts.getQueue();
  if (queue.size() === 0) {
    ctx.ui.notify("queue is empty.", "info");
    return;
  }
  const lines: string[] = [`Queue (${queue.size()}):`];
  for (const [i, p] of queue.list().entries()) {
    const waited = elapsedStr(p.enqueuedAt);
    lines.push(
      `  ${i + 1}. ${p.id.padEnd(20)} ${p.persona.name.padEnd(14)} requested=${p.requestedMode} waited=${waited}`,
    );
  }
  ctx.ui.notify(lines.join("\n"), "info");
}


function runFocus(
  opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
  arg: string,
): void {
  const id = arg.trim() || undefined;
  if (id) {
    const registry = opts.getRegistry();
    if (!registry.get(id)) {
      ctx.ui.notify(
        `agent_id "${id}" not found. Run /conductor status to see active sub-agents.`,
        "warning",
      );
      return;
    }
  }
  opts.openFocusedOverlay(id);
}

function formatRunRow(r: Run): string {
  const u = formatUsage(r.usage);
  const usagePart = u ? `[${u}]` : "";
  const hint = r.lastToolCall ? ` → ${r.lastToolCall}` : "";
  return `  ${statusGlyph(r.status)} ${r.id.padEnd(20)} ${r.persona.padEnd(14)} ${r.status.padEnd(9)} ${elapsedStr(r.startTime, r.finishedAt).padEnd(6)} ${usagePart}${hint}`;
}

function statusGlyph(s: string): string {
  switch (s) {
    case "queued":
      return "◌";
    case "running":
      return "●";
    case "paused":
      return "⏸";
    case "completed":
      return "✓";
    case "failed":
      return "✗";
    case "killed":
      return "■";
    case "timeout":
      return "⏱";
    default:
      return "·";
  }
}
