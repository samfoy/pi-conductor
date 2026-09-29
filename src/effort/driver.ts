import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HookResult, MergeResult, Run, RunStatus } from "../types.ts";
import { runHook } from "../hook-runner.ts";
import { buildMergeCommitMessage } from "../worktree.ts";
import { readProcessStartTime } from "../reconcile-startup.ts";
import { writeRecord } from "../runs.ts";
import { effortGit, effortOwner, effortTip } from "./open.ts";
import { assertEffortOwner, effortDir, readEffort, writeEffort, type EffortOwner, type EffortRecord } from "./store.ts";
import { assertCandidate, checkedCas, effortEnv, mergeTree, shellQuote } from "./git.ts";
import { nextIntegration } from "./core.ts";
import { stopOwnedProcessGroup, type OwnedProcessGroup } from "./process-group.ts";

export interface IntegrationOutcome { terminal: RunStatus; mergeResult: MergeResult; landedCommit?: string }
interface Job {
  run: Run; owner: EffortOwner; notify: () => void; resolve: (outcome: IntegrationOutcome) => void;
  cancelled: boolean; suspended: boolean; finished: boolean;
  stop?: () => Promise<void>; flight?: Promise<void>; ready?: Promise<void>;
  teardownError?: Error;
  claim?: { path: string; token: string };
}

/** One FIFO per canonical root; an exclusive disk claim also fences other registries/sessions. */
export class EffortDriver {
  private queues = new Map<string, Job[]>();
  private flights = new Set<string>();

  enqueue(run: Run, notify: () => void): Promise<IntegrationOutcome> {
    const owner = effortOwner(run.parentSessionId);
    const record = readEffort(run.effort!.gitRoot, run.effort!.name)!;
    assertEffortOwner(record, owner);
    if (run.status !== "integrating" || !run.integration || run.pendingAsk || run.reconciledAtStartup) throw new Error("only observed hook-passed completions may enter integration");
    return new Promise(resolve => {
      const job: Job = { run, owner, notify, resolve, cancelled: false, suspended: !!run.integrationSuspended, finished: false };
      run.integrationControl = {
        cancel: () => {
          if (job.cancelled || job.finished) return;
          this.fence(job);
          job.cancelled = true; void job.stop?.();
          if (!job.flight) this.finish(job, { terminal: "killed", mergeResult: { success: false, reason: "killed" } });
        },
        suspend: async () => {
          job.suspended = true; run.integrationControl = undefined;
          await job.stop?.();
          try { await job.flight; } catch { if (job.teardownError) throw job.teardownError; }
        },
      };
      writeEffort({ ...record, queue: [...new Set([...(record.queue ?? []), run.id])], updatedAt: Date.now() });
      job.ready = this.persist(job);
      void job.ready.catch(() => {});
      const root = record.gitRoot;
      const queue = this.queues.get(root) ?? [];
      queue.push(job); this.queues.set(root, queue);
      void this.drain(root);
    });
  }

  private fence(job: Job): EffortRecord {
    if (job.cancelled || job.suspended) throw new Error("integration cancelled or suspended; work preserved");
    const record = readEffort(job.run.effort!.gitRoot, job.run.effort!.name);
    if (!record) throw new Error("effort record missing");
    assertEffortOwner(record, job.owner);
    if (job.claim && JSON.parse(readFileSync(job.claim.path, "utf8")).token !== job.claim.token) throw new Error("integration driver claim changed");
    return record;
  }
  private async persist(job: Job): Promise<void> {
    await writeRecord(job.run, () => { this.fence(job); });
    job.notify();
  }
  private finish(job: Job, outcome: IntegrationOutcome): void {
    if (job.finished || job.suspended) return;
    job.finished = true;
    try {
      const record = readEffort(job.run.effort!.gitRoot, job.run.effort!.name)!;
      assertEffortOwner(record, job.owner);
      writeEffort({ ...record, queue: (record.queue ?? []).filter(id => id !== job.run.id), updatedAt: Date.now() });
    } catch { /* terminal evidence survives; unresolved queue metadata is retained for inspection */ }
    job.run.integration!.state = outcome.terminal === "completed" ? "accepted" : "paused";
    if (!outcome.mergeResult.success) job.run.integration!.reason = outcome.mergeResult.reason;
    if (outcome.terminal === "killed") { job.run.integration!.state = "cancelled"; job.run.integration!.reason = "killed; work preserved"; }
    job.run.integrationControl = undefined;
    job.resolve(outcome);
  }
  private pause(job: Job, reason: string): void {
    job.run.integration!.state = "paused"; job.run.integration!.reason = reason;
    try {
      const record = this.fence(job);
      writeEffort({ ...record, status: "paused", pausedReason: reason, updatedAt: Date.now() });
      void this.persist(job).catch(() => {});
    } catch {
      try { assertEffortOwner(readEffort(job.run.effort!.gitRoot, job.run.effort!.name)!, job.owner); }
      catch { job.suspended = true; job.run.integrationControl = undefined; }
    }
    job.notify();
  }
  private async drain(root: string): Promise<void> {
    if (this.flights.has(root)) return;
    this.flights.add(root);
    const lockDir = effortDir(root, "integration-driver");
    const lock = join(lockDir, "driver.lock"); const token = randomUUID();
    let claimed = false;
    try {
      mkdirSync(lockDir, { recursive: true });
      writeFileSync(lock, JSON.stringify({ token, pid: process.pid, startTime: readProcessStartTime(process.pid) }), { flag: "wx" });
      claimed = true;
      for (const job of this.queues.get(root) ?? []) {
        if (job.finished || job.suspended || job.cancelled) continue;
        try {
          await job.ready;
          job.claim = { path: lock, token };
          const record = this.fence(job);
          if (record.status === "paused") { this.pause(job, record.pausedReason ?? "effort paused"); continue; }
          job.flight = this.integrate(job);
          await job.flight;
        } catch (error) {
          if (job.teardownError) { claimed = false; this.pause(job, job.teardownError.message); break; }
          if (job.cancelled) this.finish(job, { terminal: "killed", mergeResult: { success: false, reason: "killed" } });
          else this.pause(job, (error as Error).message);
        } finally { job.flight = undefined; job.claim = undefined; }
      }
    } catch (error) {
      for (const job of this.queues.get(root) ?? []) if (!job.finished) this.pause(job, `integration driver ownership unresolved: ${(error as Error).message}`);
    } finally {
      try { if (claimed && JSON.parse(readFileSync(lock, "utf8")).token === token) unlinkSync(lock); } catch { /* uncertain ownership: preserve claim */ }
      this.flights.delete(root);
      this.queues.set(root, (this.queues.get(root) ?? []).filter(job => !job.finished));
    }
  }

  private async command(job: Job, cwd: string, command: string, logPath: string): Promise<HookResult> {
    this.fence(job);
    const run = job.run; const entry = run.integration!;
    entry.logPath = logPath;
    const tmpDir = join(dirname(logPath), "tmp"); mkdirSync(tmpDir, { recursive: true });
    let group: OwnedProcessGroup | undefined;
    let teardown: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      if (!group) return Promise.resolve();
      if (!teardown) {
        teardown = stopOwnedProcessGroup(group);
        void teardown.catch(error => {
          job.teardownError = new Error(`integration process-group teardown unconfirmed: ${(error as Error).message}`);
          entry.teardownError = job.teardownError.message;
          job.suspended = true; run.integrationControl = undefined;
          this.pause(job, job.teardownError.message);
          void writeRecord(run, () => assertEffortOwner(readEffort(run.effort!.gitRoot, run.effort!.name)!, job.owner)).catch(() => {});
        });
      }
      return teardown;
    };
    job.stop = stop;
    const monitor = setInterval(() => {
      try { this.fence(job); } catch { if (!job.cancelled) { job.suspended = true; run.integrationControl = undefined; } void stop(); }
    }, 100);
    let result: HookResult;
    try {
      result = await runHook({
        resolved: { command, source: "project", timeoutSeconds: entry.verifyIdentity.timeoutSeconds },
        runId: run.id, persona: run.persona, runDir: dirname(run.recordPath), finalPath: run.finalPath,
        transcriptPath: run.transcriptPath, parentCwd: cwd, logPath, tmpDir,
        extraEnv: effortEnv({ CONDUCTOR_EFFORT: run.effort!.name, CONDUCTOR_CANDIDATE: entry.candidateOid, TMPDIR: tmpDir }),
        onEnd: result => { if (entry.state === "verifying") entry.verify = result; },
        deps: { killGroup: () => { void stop(); } },
        onProc: proc => { if (proc.pid) { group = { pid: proc.pid, startTime: readProcessStartTime(proc.pid) }; entry.process = { ...group }; } void this.persist(job).catch(() => { if (!job.cancelled) { job.suspended = true; run.integrationControl = undefined; } void stop(); }); },
      });
    } finally {
      clearInterval(monitor);
      try { if (teardown) await teardown; }
      finally { job.stop = undefined; }
    }
    this.fence(job);
    return result;
  }

  private async integrate(job: Job): Promise<void> {
    const run = job.run; const entry = run.integration!;
    let record = this.fence(job);
    const root = record.gitRoot;
    const expected = effortTip(record);
    entry.expectedTip = expected; entry.state = "merging";
    await this.persist(job);
    const dir = join(effortDir(root, record.name), "verify", `${run.id}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const candidate = join(root, ".worktrees", "conductor-cand", record.name, `${run.id}-${randomUUID()}`);
    entry.candidatePath = candidate;
    this.fence(job); effortGit(root, "worktree", "add", "--detach", candidate, expected);
    if (record.gatedTip !== expected) {
      const result = entry.verifyIdentity.command ? await this.command(job, candidate, entry.verifyIdentity.command, join(dir, "baseline.log")) : undefined;
      assertCandidate(candidate, expected);
      record = this.fence(job);
      writeEffort({ ...record, baseline: { oid: expected, result, disabled: !result }, ...(result?.passed === false ? {} : { gatedTip: expected }), updatedAt: Date.now() });
      if (result?.passed === false) { this.pause(job, `baseline ${expected} failed: ${result.logPath}: ${result.tailText}`); return; }
    }
    this.fence(job);
    const merged = mergeTree(root, expected, entry.branchHead);
    if (merged.kind !== "clean") {
      this.finish(job, { terminal: "merge_conflict", mergeResult: merged.kind === "conflict" ? { success: false, reason: "conflict", conflicts: merged.conflicts } : { success: false, reason: "error", errorMessage: merged.error } }); return;
    }
    if (merged.tree === effortGit(root, "rev-parse", `${expected}^{tree}`)) {
      this.fence(job);
      if (effortTip(record) !== expected) throw new Error("integration tip changed before no-op acceptance");
      this.finish(job, { terminal: "completed", mergeResult: { success: true, nothingToCommit: true, verifyDisabled: !entry.verifyIdentity.command } }); return;
    }
    this.fence(job); assertCandidate(candidate, expected);
    effortGit(candidate, "read-tree", "--reset", "-u", merged.tree);
    const message = join(dir, "commit-message");
    writeFileSync(message, `${buildMergeCommitMessage(run.persona, run.id, run.task)}\n\nConductor-Effort: ${record.name}\nConductor-Run: ${run.id}\n`);
    entry.commitHook = await this.command(job, candidate, `git commit -F ${shellQuote(message)}`, join(dir, "commit.log"));
    if (!entry.commitHook.passed) { this.pause(job, `candidate commit hooks failed: ${entry.commitHook.logPath}: ${entry.commitHook.tailText}`); return; }
    entry.candidateOid = effortGit(candidate, "rev-parse", "HEAD");
    entry.candidateTree = effortGit(candidate, "rev-parse", "HEAD^{tree}");
    assertCandidate(candidate, entry.candidateOid);
    if (effortGit(candidate, "show", "-s", "--format=%P", "HEAD") !== expected) throw new Error("candidate must have exactly the expected tip as its sole parent");
    const body = effortGit(candidate, "show", "-s", "--format=%B", "HEAD");
    for (const trailer of [`Conductor-Effort: ${record.name}`, `Conductor-Run: ${run.id}`]) if (body.split("\n").filter(line => line === trailer).length !== 1) throw new Error("candidate hook changed required trailers");
    entry.state = "verifying";
    await this.persist(job);
    if (entry.verifyIdentity.command) {
      for (;;) {
        entry.attempts++;
        entry.verify = await this.command(job, candidate, entry.verifyIdentity.command, join(dir, `verify-${entry.attempts}.log`));
        assertCandidate(candidate, entry.candidateOid);
        const action = nextIntegration(entry.verify, entry.attempts, entry.verifyIdentity.retries);
        await this.persist(job);
        if (action === "accept") break;
        if (action === "retry") continue;
        if (action === "pause") { this.pause(job, `verify cannot run: ${entry.verify.logPath}: ${entry.verify.tailText}`); return; }
        this.finish(job, { terminal: "merge_conflict", mergeResult: { success: false, reason: action, verify: entry.verify } }); return;
      }
    }
    entry.state = "verified";
    // This must acknowledge durable WAL before any reference update. No best-effort writes here.
    await this.persist(job);
    this.fence(job);
    assertCandidate(candidate, entry.candidateOid);
    checkedCas(root, record.intRef, entry.candidateOid, expected, () => { this.fence(job); });
    entry.state = "accepted";
    record = this.fence(job);
    writeEffort({ ...record, gatedTip: entry.candidateOid, queue: (record.queue ?? []).filter(id => id !== run.id), updatedAt: Date.now() });
    this.finish(job, { terminal: "completed", landedCommit: entry.candidateOid, mergeResult: { success: true, verify: entry.verify, flakyVerify: entry.attempts > 1, verifyDisabled: !entry.verifyIdentity.command } });
  }
}
