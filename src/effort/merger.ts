/**
 * M6a automatic merger: workspace setup, the pure acceptance table, spawn guards and the
 * production launcher. The integration driver owns the lifecycle; nothing here integrates.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MergerFor, MergerWal, Persona, Run, RunRecord } from "../types.ts";
import type { ConductorEventEmitter } from "../conductor-events.ts";
import type { SpawnQueue } from "../queue.ts";
import { loadConfig } from "../config.ts";
import { resolvePersonas } from "../personas.ts";
import { resolveTimeoutMs } from "../runs.ts";
import { gitEnv } from "../worktree.ts";
import { effortGit } from "./open.ts";
import { effortDir } from "./store.ts";

/** Only a leftover conflict marker fails `diff --check`; whitespace is the repository hooks' policy. */
const MARKERS_ONLY = "core.whitespace=-blank-at-eol,-blank-at-eof,-space-before-tab,-indent-with-non-tab,-tab-in-indent,-cr-at-eol";
const scrubbed = () => Object.fromEntries(Object.entries(gitEnv()).filter(([key]) => !key.startsWith("HERDR_")));
const run = (cwd: string, args: string[]) => spawnSync("git", args, { cwd, env: scrubbed(), encoding: "utf8", timeout: 30000, maxBuffer: 16 * 1024 * 1024 });

export const MERGER_PERSONA = "merger";

/** A project or user override may not widen or redirect the driver-owned merger. */
export function mergerPersonaError(persona: Pick<Persona, "name" | "readOnly" | "agents" | "worktree">): string | undefined {
  if (persona.name !== MERGER_PERSONA) return `persona ${persona.name} is not the merger`;
  if (persona.readOnly) return "merger persona override sets read_only; refusing to launch";
  if (persona.agents?.length) return "merger persona override sets agents; mergers never delegate";
  if (persona.worktree) return "merger persona override sets worktree; the driver owns the candidate cwd";
}

/** The registered writer's durable, still-open claim for exactly this merger id, nonce and candidate. */
export function mergerClaimError(writer: Pick<Run, "id" | "recordPath"> | undefined, id: string, cwd: string, mergerFor: MergerFor): string | undefined {
  let record: RunRecord | undefined;
  try { record = writer && existsSync(writer.recordPath) ? JSON.parse(readFileSync(writer.recordPath, "utf8")) as RunRecord : undefined; }
  catch { record = undefined; }
  const wal = record?.integration?.merger;
  if (!record || record.id !== mergerFor.writerId || record.effort?.name !== mergerFor.effort || record.effort.gitRoot !== mergerFor.gitRoot) return "merger writer record missing or not in this effort";
  if (!wal || wal.runId !== id || wal.nonce !== mergerFor.nonce || wal.candidatePath !== cwd) return "merger claim does not match this id, nonce and candidate";
  if (record.status !== "integrating" || record.integration?.state !== "resolving" || wal.outcome) return "merger claim is no longer resolving";
}

/** Spawn-time guard shared by the queue and spawnRun: only the driver's claimed merger launches. */
export function mergerSpawnError(opts: {
  persona: Persona; mergerFor?: MergerFor; cwd: string; effort?: string; touches?: string[]; worktree?: boolean; mergeStrategy?: string;
  delegation?: unknown; onChain?: unknown; onRetry?: unknown; retryMaxAttempts?: number; steerable?: boolean;
}, id: string | undefined, writer: Pick<Run, "id" | "recordPath"> | undefined): string | undefined {
  if (!opts.mergerFor) return opts.persona.name === MERGER_PERSONA ? "the merger persona is driver-owned: only effort integration launches it" : undefined;
  const personaError = mergerPersonaError(opts.persona);
  if (personaError) return personaError;
  if (opts.effort !== undefined || opts.touches !== undefined || opts.worktree || (opts.mergeStrategy !== undefined && opts.mergeStrategy !== "none") ||
      opts.delegation || opts.onChain || opts.onRetry || (opts.retryMaxAttempts ?? 1) !== 1 || opts.steerable) return "incompatible merger spawn options (effort, worktree, merge, delegation, chain, retry or steering)";
  if (id !== undefined && id !== opts.mergerFor.runId) return "merger id differs from the claimed id";
  return mergerClaimError(writer, opts.mergerFor.runId, opts.cwd, opts.mergerFor);
}

/**
 * Fresh detached candidate at the immutable setup OID. A conflict gets a real `merge --no-commit`
 * whose unmerged paths must equal merge-tree's evidence; a red verify starts at the failed candidate.
 */
export function prepareMergerWorkspace(root: string, wal: MergerWal): void {
  effortGit(root, "worktree", "add", "--detach", wal.candidatePath, wal.setupOid);
  if (effortGit(wal.candidatePath, "rev-parse", "HEAD") !== wal.setupOid) throw new Error("merger candidate is not at its setup OID");
  if (wal.kind !== "conflict") return;
  const merge = run(wal.candidatePath, ["merge", "--no-ff", "--no-commit", wal.sourceHead]);
  if (merge.error || (merge.status !== 0 && merge.status !== 1)) throw new Error(`merger setup merge failed: ${merge.error?.message ?? merge.stderr}`);
  const unmerged = [...new Set(effortGit(wal.candidatePath, "ls-files", "-u", "-z").split("\0").filter(Boolean).map(entry => entry.slice(entry.indexOf("\t") + 1)))].sort();
  const expected = [...new Set(wal.conflicts ?? [])].sort();
  if (JSON.stringify(unmerged) !== JSON.stringify(expected)) throw new Error(`merger setup unmerged paths ${JSON.stringify(unmerged)} differ from merge-tree conflicts ${JSON.stringify(expected)}`);
}

/** Evidence outside the candidate, attached through A5 files; returns the absolute paths. */
export function writeMergerContext(root: string, effort: string, writer: Run, wal: MergerWal, verifyLog?: string): string[] {
  const dir = join(effortDir(root, effort), "merge", `${writer.id}-${wal.attempt}`);
  mkdirSync(dir, { recursive: true });
  const base = effortGit(root, "merge-base", wal.expectedTip, wal.sourceHead);
  const paths = wal.kind === "conflict" ? ["--", ...(wal.conflicts ?? [])] : [];
  const files: Record<string, string> = {
    "conflict.md": `# Merger context (${wal.kind})\n\nWriter: ${writer.id} (${writer.persona})\nIntegration tip: ${wal.expectedTip}\nWriter head: ${wal.sourceHead}\nSetup: ${wal.setupOid}\n` +
      (wal.kind === "conflict" ? `\nConflicted paths:\n${(wal.conflicts ?? []).map(p => `- ${p}`).join("\n")}\n` : "\nThe effort verify command failed twice on the setup candidate.\n"),
    "ours.diff": effortGit(root, "diff", base, wal.expectedTip, ...paths),
    "theirs.diff": effortGit(root, "diff", base, wal.sourceHead, ...paths),
    "slices.md": `# Writer task\n\n${writer.task}\n`,
    "writer-report.md": writer.integration?.resultText || "(no saved writer report)",
  };
  if (verifyLog !== undefined) files["verify.log"] = verifyLog;
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text || "(empty)\n");
  wal.contextDir = dir;
  return Object.keys(files).map(name => join(dir, name));
}

export function mergerTask(writer: Run, wal: MergerWal, verify: string): string {
  const what = wal.kind === "conflict"
    ? `Resolve the textual conflict between the effort integration tip and writer ${writer.id}. The merge is in progress in your cwd.`
    : `Fix the effort verify failure on writer ${writer.id}'s candidate in your cwd.`;
  return `${what}\nEffort verify command: ${verify ? `\`${verify}\`` : "(disabled; repository hooks still apply)"}\n` +
    "Commit your resolution with an ordinary hooked `git commit` on the detached HEAD and leave the candidate clean, " +
    "or end with `## Verdict: cannot-resolve`. The evidence files below are outside the candidate.";
}

export interface MergerFacts {
  status: Run["status"]; runId: string; nonce?: string; cwd: string; repository?: string;
  head?: string; detached: boolean; descends: boolean; mergeHead: boolean; unmerged: string; unsafeIndex: string;
  dirty: string; diffCheck: number | null; finalText: string; exitConfirmed: boolean;
}

/** Read the candidate. Any Git error leaves the corresponding fact failing, never passing. */
export function observeMerger(merger: Pick<Run, "status" | "id" | "mergerFor" | "cwd" | "messages" | "finalPath">, wal: MergerWal, finalText: string, exitConfirmed: boolean): MergerFacts {
  const cwd = wal.candidatePath;
  const out = (args: string[]) => { const r = run(cwd, args); return r.status === 0 ? r.stdout.trim() : undefined; };
  const exists = existsSync(cwd);
  const head = exists ? out(["rev-parse", "--verify", "HEAD^{commit}"]) : undefined;
  const common = exists ? out(["rev-parse", "--path-format=absolute", "--git-common-dir"]) : undefined;
  return {
    status: merger.status, runId: merger.id, nonce: merger.mergerFor?.nonce, cwd: merger.cwd,
    repository: common && existsSync(common) ? realpathSync(common) : undefined,
    head,
    detached: exists && run(cwd, ["symbolic-ref", "-q", "HEAD"]).status === 1,
    descends: !!head && run(cwd, ["merge-base", "--is-ancestor", wal.setupOid, head]).status === 0,
    mergeHead: !exists || run(cwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).status !== 1,
    unmerged: exists ? out(["ls-files", "-u"]) ?? "unreadable" : "missing",
    unsafeIndex: exists ? (out(["ls-files", "-v", "-z"]) ?? "unreadable").split("\0").filter(e => e && !e.startsWith("H ")).join(", ") : "missing",
    dirty: exists ? out(["status", "--porcelain", "--ignored", "--untracked-files=all"]) ?? "unreadable" : "missing",
    diffCheck: head ? run(cwd, ["-c", MARKERS_ONLY, "diff", "--check", wal.setupOid, head]).status : null,
    finalText, exitConfirmed,
  };
}

export interface MergerRequest { writer: Run; wal: MergerWal; mergerFor: MergerFor; task: string; files: string[] }
/** Resolves with the registered merger (running, or a queued placeholder); throws before any spawn on refusal. */
export type MergerLaunch = (request: MergerRequest) => Promise<Run>;

/** Production launcher: persona resolution happens here, after the driver's durable claim. */
export function createMergerLauncher(deps: { queue: SpawnQueue; notify?: (run: Run) => void; events?: ConductorEventEmitter; timeoutMs?: number }): MergerLaunch {
  return async ({ wal, mergerFor, task, files }) => {
    const root = mergerFor.gitRoot;
    const cfg = loadConfig(root);
    // The main checkout's project roster, never a persona file the writer's branch put in the candidate.
    const persona = (await resolvePersonas({ cwd: root, personaOverrides: cfg.personaOverrides })).personas.get(MERGER_PERSONA);
    if (!persona) throw new Error("merger persona unavailable (disabled or broken override)");
    const refused = mergerPersonaError(persona);
    if (refused) throw new Error(refused);
    const ov = cfg.personaOverrides[MERGER_PERSONA] ?? {};
    const result = deps.queue.enqueueOrSpawn({
      persona, task, files, mode: "background", cwd: wal.candidatePath, model: ov.model ?? persona.model, thinking: ov.thinking ?? persona.thinking,
      timeoutMs: deps.timeoutMs ?? resolveTimeoutMs(persona, ov, cfg), parentSessionId: mergerFor.owner.sessionId,
      worktree: false, mergeStrategy: "none", retryMaxAttempts: 1, inheritContextOverride: "none", steerable: false, mergerFor,
      // Only its owner question becomes a card; its terminal result belongs to the writer's one card.
      onComplete: r => { if (r.status === "blocked") deps.notify?.(r); }, events: deps.events,
    });
    return result.kind === "spawned" ? result.run : result.placeholderRun;
  };
}

export type MergerVerdict = { ok: true; outputOid: string } | { ok: false; reason: string };

/** The whole authority table. Merger text can only reject; it never substitutes for a Git fact. */
export function acceptMergerOutcome(wal: MergerWal, repository: string, f: MergerFacts): MergerVerdict {
  const no = (reason: string): MergerVerdict => ({ ok: false, reason });
  if (f.status !== "completed") return no(`merger ${f.status}`);
  if (!f.exitConfirmed) return no("merger process exit unconfirmed");
  if (f.runId !== wal.runId || f.nonce !== wal.nonce || f.cwd !== wal.candidatePath) return no("merger identity does not match the claim");
  if (f.repository !== repository) return no("candidate is not in the effort repository");
  if (/^## Verdict: cannot-resolve\s*$/m.test(f.finalText)) return no("merger reported cannot-resolve");
  if (!f.head || !f.detached) return no("candidate HEAD is not detached");
  if (f.head === wal.setupOid) return no("merger made no commit");
  if (!f.descends) return no("merger commit does not descend from the setup OID");
  if (f.mergeHead) return no("a merge is still in progress");
  if (f.unmerged) return no("candidate has unmerged index entries");
  if (f.unsafeIndex) return no(`candidate has hidden index flags: ${f.unsafeIndex}`);
  if (f.dirty) return no("candidate has uncommitted, untracked or ignored files");
  if (f.diffCheck !== 0) return no("merger commit leaves conflict markers (diff --check)");
  return { ok: true, outputOid: f.head };
}
