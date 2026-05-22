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
 *   /conductor focus [agent-id]      — open the focused-stream overlay
 *   /conductor history [N]           — list past sub-agent runs (default 20)
 *   /conductor pin <agent-id>        — pin a run (protect from GC)
 *   /conductor unpin <agent-id>      — unpin a run
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { PersonaResolution, Run, RunRecord, RunStatus } from "./types.ts";
import { STATUS_GLYPH } from "./status-glyph.ts";
import { resolvePersonas } from "./personas.ts";
import { loadConfig, projectConfigPath, userConfigPath } from "./config.ts";
import {
  elapsedStr,
  forceTerminate,
  formatUsage,
  pauseRun,
  resumeRun,
  runDir,
  runsRoot,
  type RunRegistry,
} from "./runs.ts";
import { SpawnQueue } from "./queue.ts";
import { buildDoctorReport, renderReconcileSummary } from "./doctor.ts";
import { buildHistoryReport } from "./history.ts";
import { isPinned, pinRun, unpinRun } from "./gc/pinning.ts";
import {
  defaultLivenessProbe,
  reconcileOrphansAtStartup,
} from "./reconcile-startup.ts";
import { runGc, type RunGcResult } from "./gc/index.ts";
import { walkInventory } from "./gc/inventory.ts";
import { planReclaim, type ReclaimAction } from "./gc/policy.ts";
import { classifyStall, resolveKillOnStall } from "./watchdog.ts";

interface RegisterCommandsOpts {
  getCwd: () => string;
  getRegistry: () => RunRegistry;
  getQueue: () => SpawnQueue;
  /** Read/write the conductor-mode flag for this session. */
  getConductorMode: () => boolean;
  setConductorMode: (on: boolean) => void;
  /** Open the focused-stream overlay (no-op when no UI ctx). */
  openFocusedOverlay: (id?: string) => void;
  /**
   * v0.9.x Slice 4: most recent post-startup reconcile result captured
   * by `src/index.ts:session_start`. Optional so existing callers
   * (tests, edge cases) keep compiling without forcing the lastReconcile
   * dep through every entry point. The doctor surface treats undefined
   * as "never run."
   */
  getLastReconcile?: () => import("./reconcile-startup.ts").PostStartupReconcileResult | undefined;
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
  "history",
  "pin",
  "unpin",
  "gc",
  "reconcile",
  "watchdog",
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
        case "history":
          runHistory(opts, ctx, subRest);
          return;
        case "pin":
          await runPin(ctx, subRest);
          return;
        case "unpin":
          await runUnpin(ctx, subRest);
          return;
        case "gc":
          await runGcCmd(opts, ctx, subRest);
          return;
        case "reconcile":
          await runReconcileCmd(opts, ctx, subRest);
          return;
        case "watchdog":
          runWatchdog(opts, ctx, subRest);
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
    lastReconcile: opts.getLastReconcile?.(),
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
  return `  ${STATUS_GLYPH[r.status] ?? "·"} ${r.id.padEnd(20)} ${r.persona.padEnd(14)} ${r.status.padEnd(9)} ${elapsedStr(r.startTime, r.finishedAt).padEnd(6)} ${usagePart}${hint}`;
}

export function statusGlyph(s: string): string {
  return STATUS_GLYPH[s as RunStatus] ?? "·";
}

function runHistory(
  _opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
  arg: string,
): void {
  const root = runsRoot();
  if (!existsSync(root)) {
    ctx.ui.notify(
      "no run history yet. Spawn a sub-agent and it'll show up here.",
      "info",
    );
    return;
  }

  const parsed = parseInt(arg, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;

  const report = buildHistoryReport(
    {
      listRunIds: () => {
        try {
          return readdirSync(root, { withFileTypes: true })
            .filter((d) => d.isDirectory())
            .map((d) => d.name);
        } catch {
          return [];
        }
      },
      readRecord: (id: string): RunRecord | undefined => {
        const p = join(runDir(id), "record.json");
        try {
          return JSON.parse(readFileSync(p, "utf8")) as RunRecord;
        } catch {
          return undefined;
        }
      },
      readFinalText: (id: string): string | undefined => {
        const p = join(runDir(id), "final.md");
        try {
          return readFileSync(p, "utf8");
        } catch {
          return undefined;
        }
      },
      statMtime: (id: string): number => {
        // Use record.json's mtime: it's rewritten on every status change,
        // so it tracks last activity with sub-second resolution. The run
        // dir's mtime is only updated on entry creation/deletion on most
        // filesystems (ext4), which would order rewrites by creation
        // time, not last activity.
        try {
          return statSync(join(runDir(id), "record.json")).mtimeMs;
        } catch {
          // Fall back to dir mtime if record.json is missing.
          try {
            return statSync(runDir(id)).mtimeMs;
          } catch {
            return 0;
          }
        }
      },
      isPinned: (id: string): boolean => existsSync(join(runDir(id), ".pinned")),
      isArchived: (id: string): boolean => existsSync(join(runDir(id), ".archived")),
    },
    { limit },
  );

  ctx.ui.notify(report, "info");
}

// ── Pinning subcommands (v0.9 GC slice 4) ─────────────────────

/**
 * Defense-in-depth on `<agent_id>` shape so a malicious-or-mistyped
 * input cannot escape the runs dir via path traversal. Allocator
 * outputs match `<persona>-<4hex>` (with an optional `-<timestamp>`
 * collision-fallback suffix per `runs.ts:allocateRunId`); this regex
 * is intentionally permissive of letters/digits/underscores/hyphens
 * to tolerate future id formats while still rejecting `..`, `/`, etc.
 */
const AGENT_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** Exported for unit tests; called from the slash dispatch above. */
export async function runPin(
  ctx: ExtensionCommandContext,
  arg: string,
): Promise<void> {
  const id = arg.trim();
  if (!id) {
    ctx.ui.notify("usage: /conductor pin <agent-id>", "warning");
    return;
  }
  if (!AGENT_ID_RE.test(id)) {
    ctx.ui.notify(`invalid agent_id format: "${id}"`, "warning");
    return;
  }
  const root = runsRoot();
  if (!existsSync(join(root, id))) {
    ctx.ui.notify(`No such run: ${id}`, "warning");
    return;
  }
  if (isPinned(root, id)) {
    ctx.ui.notify(`Already pinned: ${id}.`, "info");
    return;
  }
  try {
    await pinRun(root, id);
    ctx.ui.notify(`Pinned ${id}.`, "info");
  } catch (e: unknown) {
    ctx.ui.notify(`pin failed: ${(e as Error)?.message ?? e}`, "warning");
  }
}

/** Exported for unit tests; called from the slash dispatch above. */
export async function runUnpin(
  ctx: ExtensionCommandContext,
  arg: string,
): Promise<void> {
  const id = arg.trim();
  if (!id) {
    ctx.ui.notify("usage: /conductor unpin <agent-id>", "warning");
    return;
  }
  if (!AGENT_ID_RE.test(id)) {
    ctx.ui.notify(`invalid agent_id format: "${id}"`, "warning");
    return;
  }
  const root = runsRoot();
  if (!existsSync(join(root, id))) {
    ctx.ui.notify(`No such run: ${id}`, "warning");
    return;
  }
  if (!isPinned(root, id)) {
    ctx.ui.notify(`Not pinned: ${id}.`, "info");
    return;
  }
  try {
    await unpinRun(root, id);
    ctx.ui.notify(`Unpinned ${id}.`, "info");
  } catch (e: unknown) {
    ctx.ui.notify(`unpin failed: ${(e as Error)?.message ?? e}`, "warning");
  }
}

// ── /conductor gc ───────────────────────────────────────────────────────────────────

/**
 * Dependencies `runGcCmd` actually needs. Structural so tests can pass a
 * minimal shape without mocking the full `RegisterCommandsOpts`.
 */
export interface GcCmdOpts {
  getCwd: () => string;
  getRegistry: () => RunRegistry;
}

interface ParsedGcFlags {
  dryRun: boolean;
  force: boolean;
  verbose: boolean;
  help: boolean;
  persona?: string;
}

const GC_HELP_TEXT = [
  "/conductor gc [flags]  — reclaim disk used by run records.",
  "",
  "  --dry-run           plan only, no disk mutation; print summary.",
  "  --force             documented no-op for manual gc (debounce only",
  "                      applies to auto-gc on session_start).",
  "  --persona=<name>    scope to a single persona's runs.",
  "  --verbose           include per-action lines, not just totals.",
  "  --help              print this listing.",
].join("\n");

/**
 * Tiny single-purpose flag parser. Returns `{ ok: false, error }` on any
 * unknown flag or empty `--persona=` so the slash command can render a
 * tight error notify rather than swallowing the input. Position-free.
 */
function parseGcFlags(arg: string): { ok: true; flags: ParsedGcFlags } | { ok: false; error: string } {
  const out: ParsedGcFlags = {
    dryRun: false,
    force: false,
    verbose: false,
    help: false,
  };
  const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    if (tok === "--dry-run") out.dryRun = true;
    else if (tok === "--force") out.force = true;
    else if (tok === "--verbose") out.verbose = true;
    else if (tok === "--help" || tok === "-h") out.help = true;
    else if (tok.startsWith("--persona=")) {
      const value = tok.slice("--persona=".length);
      if (!value) {
        return { ok: false, error: "missing value for --persona=<name>" };
      }
      out.persona = value;
    } else {
      return { ok: false, error: `unknown flag: ${tok}` };
    }
  }
  return { ok: true, flags: out };
}

function bytesHuman(n: number): string {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function sumBytes(actions: readonly ReclaimAction[], kind: ReclaimAction["kind"]): number {
  let total = 0;
  for (const a of actions) {
    if (a.kind === kind && (a.kind === "cold-archive" || a.kind === "delete")) {
      total += a.bytesReclaimed;
    }
  }
  return total;
}

/**
 * Format the `RunGcResult` for the slash command. Shape matches the
 * v0.9-gc-plan.md "Slice 6" output spec; A3 totals always present.
 *
 * Per-action listing capped at 20 entries (plan §"Risks") with a
 * "(N more — see /conductor history)" footer when more are present.
 */
function formatGcResult(
  result: RunGcResult,
  actions: readonly ReclaimAction[],
  flags: ParsedGcFlags,
): string {
  const lines: string[] = [];
  const dryTag = flags.dryRun ? " (dry-run)" : "";
  lines.push(`GC plan${dryTag} (n=${result.scanned} scanned):`);

  // Tier byte sums come from the inventory because dry-run executes
  // nothing (`result.totalBytesReclaimed === 0`).
  const archiveBytes = sumBytes(actions, "cold-archive");
  const deleteBytes = sumBytes(actions, "delete");
  const totalBytes = archiveBytes + deleteBytes;

  lines.push(
    `  archive: ${result.planSummary.archive} runs, ~${bytesHuman(archiveBytes)}`,
  );
  lines.push(
    `  delete:  ${result.planSummary.delete} runs, ~${bytesHuman(deleteBytes)}`,
  );
  lines.push(
    `  reconcile: ${result.planSummary.reconcile} orphan${result.planSummary.reconcile === 1 ? "" : "s"}`,
  );
  lines.push(`  keep: ${result.planSummary.keep} runs`);

  // Oracle amendment A3: dry-run output MUST include all four totals
  // by name so users can pipeline against them. Always emit — cheap on
  // wet runs and harmless to consumers that ignore them.
  lines.push("");
  lines.push("Totals:");
  lines.push(`  bytes_to_reclaim:  ${bytesHuman(totalBytes)} (${totalBytes} B)`);
  lines.push(`  runs_to_archive:   ${result.planSummary.archive}`);
  lines.push(`  runs_to_delete:    ${result.planSummary.delete}`);
  lines.push(`  runs_lose_resume:  ${result.runsLoseResume}`);

  if (!flags.dryRun) {
    lines.push("");
    lines.push(
      `Reclaimed: ${bytesHuman(result.totalBytesReclaimed)} ` +
        `(${result.archived.length} archived, ${result.deleted.length} deleted, ` +
        `${result.failed.length} failed) in ${result.durationMs}ms`,
    );
  }

  if (flags.verbose) {
    const acts = actions.filter(
      (a) =>
        a.kind === "cold-archive" ||
        a.kind === "delete" ||
        a.kind === "reconcile-orphan",
    );
    if (acts.length > 0) {
      lines.push("");
      lines.push("Per-action:");
      const cap = 20;
      for (const a of acts.slice(0, cap)) {
        const tag =
          a.kind === "cold-archive"
            ? "cold-archive"
            : a.kind === "delete"
              ? "delete       "
              : "reconcile    ";
        const bytes =
          a.kind === "cold-archive" || a.kind === "delete"
            ? bytesHuman(a.bytesReclaimed)
            : "—";
        lines.push(
          `  ${tag}  ${a.id.padEnd(28)} ${bytes.padStart(10)}  ${a.reason ?? ""}`,
        );
      }
      if (acts.length > cap) {
        lines.push(`  (${acts.length - cap} more — see /conductor history)`);
      }
    }
  }

  return lines.join("\n");
}

/**
 * `/conductor gc` slash subcommand. Manual gc never debounces, so
 * `--force` is a documented no-op (it only matters to `maybeAutoRunGc`).
 *
 * Spec: docs/v0.9-gc-plan.md "Slice 6"; oracle A3.
 */
export async function runGcCmd(
  opts: GcCmdOpts,
  ctx: ExtensionCommandContext,
  arg: string,
): Promise<void> {
  const parsed = parseGcFlags(arg);
  if (!parsed.ok) {
    ctx.ui.notify(`${parsed.error}\n\n${GC_HELP_TEXT}`, "warning");
    return;
  }
  const flags = parsed.flags;

  if (flags.help) {
    ctx.ui.notify(GC_HELP_TEXT, "info");
    return;
  }

  const cwd = opts.getCwd();
  const cfg = loadConfig(cwd);
  const root = runsRoot();
  const registry = opts.getRegistry();

  // Re-derive the action list for verbose output + accurate byte sums.
  // `runGc` doesn't return its plan; one extra `walkInventory` is cheap
  // for an interactive slash command.
  const inventoryFull = await walkInventory(root, registry);
  const inventory = flags.persona
    ? inventoryFull.filter((e) => e.persona === flags.persona)
    : inventoryFull;
  const plan = planReclaim(inventory, cfg.gc, Date.now());

  let result: RunGcResult;
  try {
    result = await runGc({
      runsRoot: root,
      config: cfg.gc,
      registry,
      dryRun: flags.dryRun,
      persona: flags.persona,
    });
  } catch (e: unknown) {
    ctx.ui.notify(`gc failed: ${(e as Error)?.message ?? e}`, "warning");
    return;
  }

  const out = formatGcResult(result, plan.actions, flags);
  ctx.ui.notify(out, "info");
}

// ── /conductor reconcile ────────────────────────────────────────────────────
//
// v0.9.x Slice 4. Manual re-trigger of the post-startup orphan reconcile
// pass. Mirrors `/conductor gc` shape: arg-parser, deps wiring, pure
// renderer (`renderReconcileSummary` from doctor.ts) for output.
//
// `--dry-run` threads `dryRun: true` into `reconcileOrphansAtStartup`
// (single-deps-flag option per design §6 + slice-4 builder note). The
// scanner walks + classifies + reports identically; the dryRun branch
// short-circuits writeFile + registry.register so disk and registry
// stay untouched. Drives the same renderer as the doctor section.

const RECONCILE_HELP_TEXT = [
  "/conductor reconcile [--dry-run]  — re-run post-startup orphan reconcile.",
  "",
  "  --dry-run           classify + report; do NOT mutate disk or registry.",
  "  --help              print this listing.",
].join("\n");

interface ParsedReconcileFlags {
  dryRun: boolean;
  help: boolean;
}

function parseReconcileFlags(
  arg: string,
): { ok: true; flags: ParsedReconcileFlags } | { ok: false; error: string } {
  const out: ParsedReconcileFlags = { dryRun: false, help: false };
  const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    if (tok === "--dry-run") out.dryRun = true;
    else if (tok === "--help" || tok === "-h") out.help = true;
    else return { ok: false, error: `unknown flag: ${tok}` };
  }
  return { ok: true, flags: out };
}

/** Structural dependencies; mirrors GcCmdOpts so tests can pass a minimal shape. */
export interface ReconcileCmdOpts {
  getCwd: () => string;
  getRegistry: () => RunRegistry;
}

/**
 * `/conductor reconcile` slash subcommand. Re-fires
 * `reconcileOrphansAtStartup` against the live registry; with
 * `--dry-run`, classifies + reports without mutating disk or registry.
 *
 * Spec: docs/v0.9.x-post-startup-reconcile-design.md §6.
 */
export async function runReconcileCmd(
  opts: ReconcileCmdOpts,
  ctx: ExtensionCommandContext,
  arg: string,
): Promise<void> {
  const parsed = parseReconcileFlags(arg);
  if (!parsed.ok) {
    ctx.ui.notify(`${parsed.error}\n\n${RECONCILE_HELP_TEXT}`, "warning");
    return;
  }
  const flags = parsed.flags;
  if (flags.help) {
    ctx.ui.notify(RECONCILE_HELP_TEXT, "info");
    return;
  }

  const registry = opts.getRegistry();
  const root = runsRoot();
  try {
    const result = await reconcileOrphansAtStartup({
      runsRoot: root,
      registry,
      isAlive: defaultLivenessProbe,
      now: Date.now(),
      dryRun: flags.dryRun,
    });
    const out = renderReconcileSummary(result, {
      dryRun: flags.dryRun,
      includeHeader: true,
    }).join("\n");
    ctx.ui.notify(out, "info");
  } catch (e: unknown) {
    ctx.ui.notify(
      `reconcile failed: ${(e as Error)?.message ?? String(e)}`,
      "warning",
    );
  }
}

// ── /conductor watchdog ─────────────────────────────────────────────────
//
// v0.10 Slice 4. One subcommand today (`status`); kept as a dispatcher
// so future slices (e.g. `/conductor watchdog reset`, `/conductor
// watchdog tune`) can land without reshuffling the SUBCOMMANDS array.

/**
 * Slash dispatcher for `/conductor watchdog <sub>`. Currently routes:
 * - `status` (default when subRest is empty) → table of active runs
 *   with stall classification, per-run thresholds, kill_on_stall.
 *
 * Anything else → warning notify.
 */
export function runWatchdog(
  opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
  subRest: string,
): void {
  const [sub] = subRest.split(/\s+/);
  switch (sub) {
    case "":
    case "status":
      runWatchdogStatus(opts, ctx);
      return;
    default:
      ctx.ui.notify(
        `unknown watchdog subcommand: ${sub}. Try: /conductor watchdog status`,
        "warning",
      );
  }
}

/**
 * Render the `/conductor watchdog status` report and notify. Pure
 * report builder lives in {@link buildWatchdogStatusReport} so tests
 * can drive it directly without faking ExtensionCommandContext.
 */
function runWatchdogStatus(
  opts: RegisterCommandsOpts,
  ctx: ExtensionCommandContext,
): void {
  const cfg = loadConfig(opts.getCwd());
  const out = buildWatchdogStatusReport({
    registry: opts.getRegistry(),
    watchdogConfig: {
      softThresholdSeconds: cfg.watchdog.defaultSoftSeconds,
      hardThresholdSeconds: cfg.watchdog.defaultHardSeconds,
      graceSeconds: cfg.watchdog.graceSeconds,
    },
    defaultKillOnStall: cfg.watchdog.defaultKillOnStall,
    enabled: cfg.watchdog.enabled,
    now: Date.now(),
  });
  ctx.ui.notify(out, "info");
}

interface WatchdogConfigForReport {
  readonly softThresholdSeconds: number;
  readonly hardThresholdSeconds: number;
  readonly graceSeconds: number;
}

/**
 * Pure renderer for `/conductor watchdog status`. Output shape mirrors
 * the example in docs/v0.10-watchdog-design.md §5: `<N> active runs`
 * banner, then a header row, then one row per active (running, not
 * paused, not terminal) run with its silent-seconds count, classified
 * state, threshold pair, and kill_on_stall action descriptor.
 *
 * Empty-state when no active runs: a single line. Disabled-state when
 * watchdog.enabled === false: a leading `(watchdog DISABLED)` note so
 * operators don't think the empty table means "no stalls".
 *
 * Exported so the slice-4 commands-watchdog tests can pin output shape
 * without setting up the full ExtensionCommandContext + cwd plumbing.
 */
export function buildWatchdogStatusReport(args: {
  registry: RunRegistry;
  watchdogConfig: WatchdogConfigForReport;
  defaultKillOnStall: boolean;
  enabled: boolean;
  now: number;
}): string {
  const { registry, watchdogConfig, defaultKillOnStall, enabled, now } = args;
  // Active = non-terminal AND not paused (paused runs intentionally
  // freeze their lastEventAt; they're not stall candidates).
  const active = registry
    .list()
    .filter(
      (r) =>
        r.status !== "completed" &&
        r.status !== "failed" &&
        r.status !== "killed" &&
        r.status !== "timeout" &&
        r.status !== "hook_failed" &&
        r.status !== "paused" &&
        r.status !== "queued",
    );

  const lines: string[] = [];
  lines.push("## Watchdog");
  if (!enabled) lines.push("(watchdog DISABLED)");
  lines.push(
    `${active.length} active run${active.length === 1 ? "" : "s"}`,
  );
  lines.push("");

  if (active.length === 0) {
    lines.push("  (no active runs)");
    return lines.join("\n");
  }

  // Column widths chosen to match the §5 example: id ≥14, persona ≥10,
  // silent ≥6, state ≥7, threshold ≥10, action wraps. Padding picks
  // max(actual, minimum) so longer ids don't visually collapse.
  const idW = Math.max(14, ...active.map((r) => r.id.length));
  const personaW = Math.max(10, ...active.map((r) => r.persona.length));
  lines.push(
    "  " +
      "id".padEnd(idW) +
      "  " +
      "persona".padEnd(personaW) +
      "  " +
      "silent".padEnd(7) +
      "  " +
      "state".padEnd(7) +
      "  " +
      "threshold".padEnd(11) +
      "  " +
      "action",
  );
  for (const r of active) {
    const c = classifyStall(r, now, watchdogConfig);
    const silent = c ? `${c.silentSeconds}s` : "—";
    const state = c ? c.severity : "fresh";
    const soft = c ? c.softThresholdSeconds : watchdogConfig.softThresholdSeconds;
    const hard = c ? c.hardThresholdSeconds : watchdogConfig.hardThresholdSeconds;
    const threshold = `${soft}s/${hard}s`;
    const kos = resolveKillOnStall(r, defaultKillOnStall);
    const action =
      state === "fresh"
        ? "—"
        : kos
          ? "kill (kill_on_stall=true)"
          : "warn (kill_on_stall=false)";
    lines.push(
      "  " +
        r.id.padEnd(idW) +
        "  " +
        r.persona.padEnd(personaW) +
        "  " +
        silent.padEnd(7) +
        "  " +
        state.padEnd(7) +
        "  " +
        threshold.padEnd(11) +
        "  " +
        action,
    );
  }
  return lines.join("\n");
}
