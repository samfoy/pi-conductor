import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HookResult, MergeResult, MergerWal, Run, RunStatus } from "../types.ts";
import { isTerminal } from "../types.ts";
import { runHook } from "../hook-runner.ts";
import { buildMergeCommitMessage } from "../worktree.ts";
import { readProcessStartTime } from "../reconcile-startup.ts";
import { allocateRunId, forceTerminate, getFinalText, writeRecord, type RunRegistry } from "../runs.ts";
import { subtreeCost } from "../delegation.ts";
import { effortGit, effortOwner, effortTip } from "./open.ts";
import { assertEffortOwner, acquireClaim, assertClaim, releaseClaim, effortDir, readEffort, writeEffort, type EffortOwner, type EffortRecord } from "./store.ts";
import { assertCandidate, checkedCas, StaleTipError, effortEnv, mergeTree, shellQuote } from "./git.ts";
import { nextIntegration } from "./core.ts";
import { changedPaths, regenerateCandidate } from "./generated.ts";
import { isGeneratedPath } from "./policy.ts";
import { stopOwnedProcessGroup, type OwnedProcessGroup } from "./process-group.ts";
import { acceptMergerOutcome, mergerTask, observeMerger, prepareMergerWorkspace, writeMergerContext, type MergerLaunch } from "./merger.ts";

export interface IntegrationOutcome { terminal: RunStatus; mergeResult: MergeResult; landedCommit?: string }
interface Job {
  run: Run; owner: EffortOwner; notify: () => void; resolve: (outcome: IntegrationOutcome) => void;
  cancelled: boolean; suspended: boolean; finished: boolean;
  stop?: () => Promise<void>; flight?: Promise<void>; ready?: Promise<void>;
  teardownError?: Error;
  claim?: { path: string; owner: EffortOwner };
  result?: Promise<IntegrationOutcome>;
  finishing?: Promise<void>;
  /** M6a: a merger claim is outstanding; the drain skips the entry until its outcome. */
  parked?: boolean;
  /** M6a: needs this effort's single merger slot; recomputed from the current tip when it frees. */
  deferred?: boolean;
  /** M6a: an accepted proposal re-enters ahead of FIFO work. */
  front?: boolean;
  merger?: { run?: Run; launching?: Promise<Run>; off?: () => void; settling?: Promise<void>; status?: RunStatus };
}

const MERGER_EXIT_BOUND_MS = 10_000;
/** Exit proof from this process's own handle; a recovered record needs a dead pid. */
async function mergerExited(m: Run): Promise<boolean> {
  const t = m.transport;
  if (t?.kind === "herdr") return t.waitForExit();
  if (t?.kind === "subprocess") {
    if (!m.processOpen) return true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([t.closed, new Promise(resolve => { timer = setTimeout(resolve, MERGER_EXIT_BOUND_MS); })]);
    clearTimeout(timer);
    return !m.processOpen;
  }
  if (!m.pid) return true;
  try { process.kill(m.pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** One FIFO per canonical root; an exclusive disk claim also fences other registries/sessions. */
export class EffortDriver {
  private queues = new Map<string, Job[]>();
  private flights = new Map<string, Promise<void>>();
  private seen = new Map<string, Set<Job>>();
  private launch?: MergerLaunch;

  // A private field, so a serialized registry (spawn option snapshots) never cycles through it.
  readonly #registry: RunRegistry;
  constructor(registry: RunRegistry) { this.#registry = registry; }

  /** Only a configured lead launches mergers; without one, `auto` keeps the M5 conflict outcome. */
  configureMerger(launch: MergerLaunch | undefined): void { this.launch = launch; }

  whenIdle(root: string): Promise<void> { return this.flights.get(root) ?? Promise.resolve(); }

  enqueue(run: Run, notify: () => void, recovered = false): Promise<IntegrationOutcome> {
    const owner = run.effort!.owner ?? effortOwner(run.parentSessionId);
    const record = readEffort(run.effort!.gitRoot, run.effort!.name)!;
    assertEffortOwner(record, owner);
    if (run.effort!.role !== "writer" || run.status !== "integrating" || !run.integration || run.pendingAsk || (run.reconciledAtStartup && !recovered)) throw new Error("only observed hook-passed writer completions may enter integration");
    run.integration.deliveryProtocol = 1;
    const prior = this.queues.get(record.gitRoot)?.find(job => job.run.id === run.id && !job.finished && !job.suspended);
    if (prior) return prior.result!;
    let job!: Job;
    const result = new Promise<IntegrationOutcome>(resolve => {
      job = { run, owner, notify, resolve, cancelled: false, suspended: !!run.integrationSuspended, finished: false };
      run.integrationControl = {
        cancel: () => {
          if (job.cancelled || job.finished) return;
          this.fence(job);
          job.cancelled = true; void job.stop?.();
          if (job.parked) { void this.cancelMerger(job); return; }
          if (!job.flight) void this.finish(job, { terminal: "killed", mergeResult: { success: false, reason: "killed" } });
        },
        suspend: () => {
          if (run.integrationSuspension) return run.integrationSuspension;
          // A suspended entry stops watching its merger and signals nothing; recovery decides.
          job.merger?.off?.();
          const suspending = Promise.resolve().then(async () => {
            await job.stop?.();
            try { await job.flight; } catch { if (job.teardownError) throw job.teardownError; }
          });
          run.integrationSuspension = suspending;
          // A rejected transition stays discoverable: later shutdowns must not infer quiescence.
          void suspending.then(() => { if (run.integrationSuspension === suspending) run.integrationSuspension = undefined; }, () => {});
          job.suspended = true; run.integrationControl = undefined;
          return suspending;
        },
      };
      job.ready = this.persist(job).then(() => {
        const current = this.fence(job);
        writeEffort({ ...current, queue: [...new Set([...(current.queue ?? []), run.id])], updatedAt: Date.now() });
      });
      void job.ready.catch(() => {});
      if (run.integration!.state === "resolving") {
        job.parked = true;
        void job.ready.then(() => this.readopt(job)).catch(error => { job.parked = false; this.pause(job, `merger recovery unresolved: ${(error as Error).message}`); });
      }
      const root = record.gitRoot;
      const queue = this.queues.get(root) ?? [];
      queue.push(job); this.queues.set(root, queue);
      if (!this.flights.has(root)) {
        this.flights.set(root, Promise.resolve().then(() => this.drain(root)));
      }
    });
    job.result = result;
    return result;
  }

  private fence(job: Job): EffortRecord {
    if (job.cancelled || job.suspended) throw new Error("integration cancelled or suspended; work preserved");
    const record = readEffort(job.run.effort!.gitRoot, job.run.effort!.name);
    if (!record) throw new Error("effort record missing");
    assertEffortOwner(record, job.owner);
    if (job.claim) assertClaim(job.claim.path, job.claim.owner);
    return record;
  }
  private async persist(job: Job): Promise<void> {
    await writeRecord(job.run, () => { this.fence(job); });
    job.notify();
  }
  private finish(job: Job, outcome: IntegrationOutcome): Promise<void> {
    return job.finishing ??= this.finishOnce(job, outcome);
  }
  private async finishOnce(job: Job, outcome: IntegrationOutcome): Promise<void> {
    if (job.finished || job.suspended) return;
    job.merger?.off?.(); job.parked = false;
    job.run.integration!.state = outcome.terminal === "completed" ? "accepted" : "paused";
    if (!outcome.mergeResult.success) job.run.integration!.reason = outcome.mergeResult.reason;
    if (outcome.terminal === "killed") { job.run.integration!.state = "cancelled"; job.run.integration!.reason = "killed; work preserved"; }
    await writeRecord(job.run, () => {
      const record = readEffort(job.run.effort!.gitRoot, job.run.effort!.name)!;
      assertEffortOwner(record, job.owner);
      if (job.claim) assertClaim(job.claim.path, job.claim.owner);
    });
    const record = readEffort(job.run.effort!.gitRoot, job.run.effort!.name)!;
    assertEffortOwner(record, job.owner);
    writeEffort({ ...record, queue: (record.queue ?? []).filter(id => id !== job.run.id), updatedAt: Date.now() });
    job.finished = true;
    job.run.integrationControl = undefined;
    job.resolve(outcome);
    this.wake(record.gitRoot);
  }
  private pause(job: Job, reason: string): void {
    job.run.integration!.state = "paused"; job.run.integration!.reason = reason;
    try {
      const record = this.fence(job);
      writeEffort({ ...record, status: "paused", pausedReason: reason, pausedRun: job.run.id, updatedAt: Date.now() });
      void this.persist(job).catch(() => {});
    } catch {
      try { assertEffortOwner(readEffort(job.run.effort!.gitRoot, job.run.effort!.name)!, job.owner); }
      catch { job.suspended = true; job.run.integrationControl = undefined; }
    }
    job.notify();
  }
  /** Front re-entries first, then FIFO; parked entries wait for their merger. */
  private next(root: string, seen: Set<Job>): Job | undefined {
    const eligible = (job: Job) => !seen.has(job) && !job.finished && !job.suspended && !job.cancelled && !job.parked && !(job.deferred && this.mergerBusy(job));
    const queue = this.queues.get(root) ?? [];
    return queue.find(job => job.front && eligible(job)) ?? queue.find(eligible);
  }
  private mergerBusy(job: Job): boolean {
    return (this.queues.get(job.run.effort!.gitRoot) ?? []).some(other => other !== job && other.parked && !other.finished && other.run.effort!.name === job.run.effort!.name);
  }
  /** Revisit re-entries and deferred entries in the current flight, or start one. */
  private wake(root: string): void {
    const seen = this.seen.get(root);
    for (const job of this.queues.get(root) ?? []) if (job.front || job.deferred) seen?.delete(job);
    if (!this.flights.has(root) && (this.queues.get(root) ?? []).some(job => !job.finished && !job.suspended && (job.front || job.deferred))) {
      this.flights.set(root, Promise.resolve().then(() => this.drain(root)));
    }
  }
  private async drain(root: string): Promise<void> {
    const lockDir = effortDir(root, "integration-driver");
    const lock = join(lockDir, "driver.lock");
    let claim: EffortOwner | undefined;
    let claimed = false;
    const seen = new Set<Job>();
    this.seen.set(root, seen);
    try {
      mkdirSync(lockDir, { recursive: true });
      claim = acquireClaim(lock, effortOwner(randomUUID()));
      claimed = true;
      for (let job = this.next(root, seen); job; job = this.next(root, seen)) {
        seen.add(job);
        try {
          await job.ready;
          job.claim = { path: lock, owner: claim };
          const record = this.fence(job);
          if (record.status === "paused") { this.pause(job, record.pausedReason ?? "effort paused"); continue; }
          job.front = false; job.deferred = false;
          const current = job;
          job.flight = (async () => {
            for (;;) {
              try { await this.integrate(current); return; }
              catch (error) {
                if (!(error instanceof StaleTipError)) throw error;
                current.run.integration!.casFailures = (current.run.integration!.casFailures ?? 0) + 1;
                await this.persist(current);
                if (current.run.integration!.casFailures >= 3) throw new Error("integration ref moved outside the queue: three CAS failures; resume requires inspection");
              }
            }
          })();
          await job.flight;
          if (job.cancelled && !job.parked) await this.finish(job, { terminal: "killed", mergeResult: { success: false, reason: "killed" } });
        } catch (error) {
          if (job.teardownError) { claimed = false; this.pause(job, job.teardownError.message); break; }
          if (job.cancelled) { if (!job.parked) await this.finish(job, { terminal: "killed", mergeResult: { success: false, reason: "killed" } }); }
          else this.pause(job, (error as Error).message);
        } finally { job.flight = undefined; job.claim = undefined; }
      }
    } catch (error) {
      for (const job of this.queues.get(root) ?? []) if (!job.finished && !job.parked) this.pause(job, `integration driver ownership unresolved: ${(error as Error).message}`);
    } finally {
      try { if (claimed && claim) releaseClaim(lock, claim); } catch { /* uncertain ownership: preserve claim */ }
      if (this.seen.get(root) === seen) this.seen.delete(root);
      this.flights.delete(root);
      this.queues.set(root, (this.queues.get(root) ?? []).filter(job => !job.finished));
    }
  }

  private async command(job: Job, cwd: string, command: string, logPath: string): Promise<HookResult> {
    this.fence(job);
    const run = job.run; const entry = run.integration!;
    entry.logPath = logPath;
    const tmpDir = join(dirname(logPath), "tmp"); mkdirSync(tmpDir, { recursive: true });
    entry.commandPending = true; entry.process = undefined;
    await this.persist(job);
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
        onEnd: result => {
          if (entry.state === "verifying") entry.verify = result;
          if (entry.state === "generating") entry.generation = result;
        },
        deps: { killGroup: () => { void stop(); } },
        onProc: proc => { if (proc.pid) { group = { pid: proc.pid, startTime: readProcessStartTime(proc.pid) }; entry.process = { ...group }; } void this.persist(job).catch(() => { if (!job.cancelled) { job.suspended = true; run.integrationControl = undefined; } void stop(); }); },
      });
    } finally {
      clearInterval(monitor);
      try { if (teardown) await teardown; }
      finally { job.stop = undefined; }
    }
    this.fence(job);
    if (group) await stop();
    entry.commandPending = false; entry.process = undefined;
    await this.persist(job);
    return result;
  }

  private async integrate(job: Job): Promise<void> {
    const run = job.run; const entry = run.integration!;
    let record = this.fence(job);
    const root = record.gitRoot;
    const expected = effortTip(record);
    entry.sourceHead ??= entry.branchHead;
    entry.expectedTip = expected; entry.state = "merging";
    entry.candidateOid = undefined; entry.candidateTree = undefined; entry.verifiedOid = undefined;
    entry.noopTip = undefined; entry.attempts = 0; entry.verify = undefined;
    await this.persist(job);
    const dir = join(effortDir(root, record.name), "verify", `${run.id}-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const candidate = join(root, ".worktrees", "conductor-cand", record.name, `${run.id}-${randomUUID()}`);
    entry.candidatePath = candidate;
    entry.candidates = [...new Set([...(entry.candidates ?? []), candidate])];
    await this.persist(job);
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
    if (merged.kind === "error") {
      await this.finish(job, { terminal: "merge_conflict", mergeResult: { success: false, reason: "error", errorMessage: merged.error } }); return;
    }
    const generated = record.policy.generated;
    if (generated) {
      entry.mergeTree = merged.tree;
      entry.conflicts = merged.kind === "conflict" ? [...merged.conflicts] : [];
      entry.mergeEvidencePath = join(dir, "merge-tree.z");
      writeFileSync(entry.mergeEvidencePath, merged.output);
      this.fence(job); assertCandidate(candidate, expected);
      effortGit(candidate, "read-tree", "--reset", "-u", merged.tree);
      copyFileSync(effortGit(candidate, "rev-parse", "--git-path", "index"), join(dir, "merge.index"));
      await this.persist(job);
    }
    if (merged.kind === "conflict" && (!generated || !merged.conflicts.every(path => isGeneratedPath(path, generated)))) {
      if (await this.park(job, record, "conflict", { conflicts: merged.conflicts })) return;
      await this.finish(job, { terminal: "merge_conflict", mergeResult: { success: false, reason: "conflict", conflicts: merged.conflicts, ...this.exhausted(entry, record, run.id) } }); return;
    }
    if (merged.kind === "clean" && merged.tree === effortGit(root, "rev-parse", `${expected}^{tree}`)) {
      this.fence(job);
      if (effortTip(record) !== expected) throw new Error("integration tip changed before no-op acceptance");
      entry.noopTip = expected;
      await this.persist(job);
      await this.finish(job, { terminal: "completed", mergeResult: { success: true, nothingToCommit: true, verifyDisabled: !entry.verifyIdentity.command } }); return;
    }
    this.fence(job);
    if (!generated) {
      assertCandidate(candidate, expected);
      effortGit(candidate, "read-tree", "--reset", "-u", merged.tree);
    }
    if (generated && (merged.kind === "conflict" || changedPaths(candidate, expected, merged.tree).some(path => isGeneratedPath(path, generated)))) {
      // Seed conflicted outputs from the current tip (including its deletions), never from marker blobs.
      // Only the original conflict paths change; the ordinary source merge stays intact.
      if (merged.kind === "conflict") {
        const present = new Set([...effortGit(candidate, "ls-files", "-z").split("\0"), ...effortGit(candidate, "ls-tree", "-r", "--name-only", "-z", expected).split("\0")]);
        const paths = merged.conflicts.filter(path => present.has(path));
        if (paths.length) effortGit(candidate, "--literal-pathspecs", "restore", `--source=${expected}`, "--staged", "--worktree", "--", ...paths);
      }
      entry.preGenerationTree = effortGit(candidate, "write-tree");
      entry.state = "generating";
      await this.persist(job);
      const result = await regenerateCandidate(candidate, expected, generated, join(dir, "generation-before.json"), async () => {
        entry.generation = await this.command(job, candidate, generated.command, join(dir, "generate.log"));
        return entry.generation;
      }, () => { this.fence(job); });
      if (!result.passed) { this.pause(job, `generated command ${result.failureKind ?? "failed"}: ${result.logPath}: ${result.tailText}`); return; }
      entry.state = "merging";
    }
    const merger = entry.merger?.outcome === "accepted" && entry.branchHead === entry.merger.outputOid ? entry.merger.runId : undefined;
    const trailers = [`Conductor-Effort: ${record.name}`, `Conductor-Run: ${run.id}`, ...(merger ? [`Conductor-Merger: ${merger}`] : [])];
    const message = join(dir, "commit-message");
    writeFileSync(message, `${buildMergeCommitMessage(run.persona, run.id, run.task)}\n\n${trailers.join("\n")}\n`);
    entry.commitHook = await this.command(job, candidate, `git commit -F ${shellQuote(message)}`, join(dir, "commit.log"));
    if (!entry.commitHook.passed) { this.pause(job, `candidate commit hooks failed: ${entry.commitHook.logPath}: ${entry.commitHook.tailText}`); return; }
    entry.candidateOid = effortGit(candidate, "rev-parse", "HEAD");
    entry.candidateTree = effortGit(candidate, "rev-parse", "HEAD^{tree}");
    assertCandidate(candidate, entry.candidateOid);
    if (effortGit(candidate, "show", "-s", "--format=%P", "HEAD") !== expected) throw new Error("candidate must have exactly the expected tip as its sole parent");
    const body = effortGit(candidate, "show", "-s", "--format=%B", "HEAD");
    for (const trailer of trailers) if (body.split("\n").filter(line => line === trailer).length !== 1) throw new Error("candidate hook changed required trailers");
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
        if (await this.park(job, record, action, { verifyLog: entry.verify.tailText })) return;
        await this.finish(job, { terminal: "merge_conflict", mergeResult: { success: false, reason: action, verify: entry.verify, ...this.exhausted(entry, record, run.id) } }); return;
      }
    }
    entry.state = "verified"; entry.verifiedOid = entry.candidateOid;
    // This must acknowledge durable WAL before any reference update. No best-effort writes here.
    await this.persist(job);
    this.fence(job);
    assertCandidate(candidate, entry.candidateOid);
    checkedCas(root, record.intRef, entry.candidateOid, expected, () => { this.fence(job); });
    entry.state = "accepted";
    record = this.fence(job);
    writeEffort({ ...record, gatedTip: entry.candidateOid, queue: (record.queue ?? []).filter(id => id !== run.id), updatedAt: Date.now() });
    await this.finish(job, { terminal: "completed", landedCommit: entry.candidateOid, mergeResult: { success: true, verify: entry.verify, flakyVerify: entry.attempts > 1, verifyDisabled: !entry.verifyIdentity.command } });
  }

  private exhausted(entry: NonNullable<Run["integration"]>, record?: EffortRecord, id?: string): Partial<MergeResult> {
    const m = entry.merger;
    // A hint for the human, never an action: only the interactive command can start this attempt.
    if (!m) return record && id && record.policy.merger !== "off" && !entry.resolveRequested
      ? { errorMessage: `No merger ran (efforts.merger "${record.policy.merger}"). A human may start one confirmed merger attempt with /conductor effort resolve ${id}; source and candidates preserved.` } : {};
    return { errorMessage: m.outcome === "accepted" ? `merger ${m.runId} proposal ${m.outputOid?.slice(0, 12)} did not re-gate on the current tip; its one attempt is spent and no second merger runs. Candidate ${m.candidatePath} and source preserved.`
      : `merger ${m.runId} ${m.reason ?? "attempt spent"}; candidate ${m.candidatePath} and source preserved.` };
  }

  /**
   * M6a: hand a conflict or twice-red verify to the effort's one merger. The claim is durable before
   * persona resolution or spawn. Returns false when policy, a spent attempt or no launcher applies.
   */
  private async park(job: Job, record: EffortRecord, kind: MergerWal["kind"], extra: { conflicts?: string[]; verifyLog?: string }): Promise<boolean> {
    const run = job.run, entry = run.integration!;
    // M6b: `ask` launches only for the source an interactive human confirmed; `off` never does.
    const confirmed = !!entry.resolveRequested && entry.resolveRequested.sourceHead === entry.sourceHead;
    if (!this.launch || entry.merger || !(record.policy.merger === "auto" || (record.policy.merger === "ask" && confirmed))) return false;
    if (this.mergerBusy(job)) {
      job.deferred = true; entry.state = "queued"; entry.reason = "waiting for this effort's merger; recomputed against the tip when it frees";
      await this.persist(job); return true;
    }
    const root = record.gitRoot;
    const runId = allocateRunId("merger", new Map(this.#registry.list().map(r => [r.id, r])));
    const wal: MergerWal = { attempt: 1, nonce: randomUUID(), runId, kind, setupOid: kind === "conflict" ? entry.expectedTip! : entry.candidateOid!,
      sourceHead: entry.sourceHead!, expectedTip: entry.expectedTip!, claimedAt: Date.now(),
      candidatePath: join(root, ".worktrees", "conductor-cand", record.name, `${run.id}-merger-1`), ...(extra.conflicts ? { conflicts: [...extra.conflicts] } : {}) };
    entry.merger = wal; entry.state = "resolving"; entry.reason = `merger ${runId} claimed`;
    entry.candidates = [...new Set([...(entry.candidates ?? []), wal.candidatePath])];
    await this.persist(job);
    job.parked = true;
    let files: string[];
    try {
      this.fence(job);
      prepareMergerWorkspace(root, wal);
      files = writeMergerContext(root, record.name, run, wal, extra.verifyLog);
      await this.persist(job);
    } catch (error) {
      // A kill at the claim's own notification found no parked entry to cancel; settle it here.
      if (job.cancelled) { await this.cancelMerger(job); return true; }
      job.parked = false;
      this.pause(job, `merger setup refused: ${(error as Error).message}; claim spent, candidate ${wal.candidatePath} preserved`);
      return true;
    }
    // A kill (already routed to cancelMerger) or suspend during setup launches nothing.
    if (job.cancelled || job.suspended) return true;
    try {
      const mergerFor = { writerId: run.id, runId, nonce: wal.nonce, effort: record.name, gitRoot: root, owner: job.owner };
      const launching = this.launch({ writer: run, wal, mergerFor, task: mergerTask(run, wal, entry.verifyIdentity.command), files });
      job.merger = { launching };
      const merger = await launching;
      job.merger.run = merger;
      // A cancel or suspend that arrived during the launch owns the late merger.
      if (job.cancelled || job.suspended) return true;
      this.watch(job, merger);
    } catch (error) {
      if (job.cancelled) return true;
      job.parked = false;
      wal.outcome = "rejected"; wal.reason = `not started: ${(error as Error).message}`;
      await this.finish(job, { terminal: "merge_conflict", mergeResult: { success: false, reason: kind, conflicts: extra.conflicts, ...this.exhausted(entry) } });
    }
    return true;
  }

  /** Job-owned and fenced: removed on finish, suspend or cancel. */
  private watch(job: Job, merger: Run): void {
    const off = this.#registry.onChange(r => { if (r.id === merger.id && r === this.#registry.get(merger.id)) this.observe(job, r); });
    job.merger = { ...job.merger, run: merger, off: () => { off(); if (job.merger) job.merger.off = undefined; } };
    this.observe(job, merger);
  }
  private observe(job: Job, m: Run): void {
    if (job.finished || job.suspended || job.cancelled || !job.merger?.off) return;
    if (isTerminal(m.status)) { job.merger.off(); void this.settleMerger(job, m); return; }
    if (job.merger.status === m.status) return;
    job.merger.status = m.status;
    const entry = job.run.integration!;
    entry.reason = m.status === "blocked" ? `merger ${m.id} blocked: ${JSON.stringify(m.pendingAsk?.question ?? "")}` : `merger ${m.id} ${m.status}`;
    void this.persist(job).catch(() => {});
  }

  private settleMerger(job: Job, m: Run): Promise<void> {
    return job.merger!.settling ??= (async () => {
      const run = job.run, entry = run.integration!, wal = entry.merger!;
      const root = run.effort!.gitRoot;
      try {
        const exited = await mergerExited(m);
        await m.recordWrite;
        if (job.finished || job.suspended || job.cancelled) return;
        this.fence(job);
        const finalText = getFinalText(m.messages) || (existsSync(m.finalPath) ? readFileSync(m.finalPath, "utf8") : "");
        const verdict = acceptMergerOutcome(wal, realpathSync(effortGit(root, "rev-parse", "--path-format=absolute", "--git-common-dir")), observeMerger(m, wal, finalText, exited));
        wal.cost ??= subtreeCost(m, this.#registry.list());
        job.parked = false;
        if (verdict.ok) {
          wal.outcome = "accepted"; wal.outputOid = verdict.outputOid;
          entry.branchHead = verdict.outputOid; entry.state = "queued";
          entry.reason = `merger ${wal.runId} proposal ${verdict.outputOid.slice(0, 12)} re-entering against the current tip`;
          await this.persist(job);
          job.front = true; this.wake(root);
          return;
        }
        wal.outcome = "rejected"; wal.reason = verdict.reason;
        await this.finish(job, { terminal: "merge_conflict", mergeResult: { success: false, reason: wal.kind, conflicts: wal.conflicts, ...this.exhausted(entry) } });
      } catch (error) {
        job.parked = false;
        if (!job.cancelled && !job.suspended) this.pause(job, `merger outcome unresolved: ${(error as Error).message}; candidate and source preserved`);
        this.wake(root);
      }
    })();
  }

  /** Writer kill: cancel a queued, launching, live or blocked merger, wait for its exit, settle once. */
  private async cancelMerger(job: Job): Promise<void> {
    job.merger?.off?.();
    const m = job.merger?.run ?? await job.merger?.launching?.catch(() => undefined);
    if (m && !isTerminal(m.status)) forceTerminate(m, "killed", this.#registry);
    const exited = m ? await mergerExited(m) : true;
    const wal = job.run.integration!.merger;
    if (wal && !wal.outcome) {
      wal.outcome = "rejected"; wal.reason = `writer killed; merger ${m ? `cancelled${exited ? "" : " (exit unconfirmed)"}` : "never started"}`;
      if (m) wal.cost ??= subtreeCost(m, this.#registry.list());
    }
    job.parked = false;
    await this.finish(job, { terminal: "killed", mergeResult: { success: false, reason: "killed" } });
  }

  /** Recovery: re-park a restored resolving entry on its canonical merger, or settle it from the WAL. */
  private async readopt(job: Job): Promise<void> {
    const entry = job.run.integration!, wal = entry.merger;
    if (!wal) throw new Error("resolving entry has no merger claim");
    const m = this.#registry.get(wal.runId);
    if (wal.outcome || !m || m.mergerFor?.nonce !== wal.nonce || m.mergerFor.writerId !== job.run.id || m.cwd !== wal.candidatePath) {
      if (!wal.outcome) { wal.outcome = "rejected"; wal.reason = m ? "merger record does not match the claim" : "launch uncertain: claim without a merger record; attempt spent"; }
      job.parked = false;
      await this.finish(job, { terminal: "merge_conflict", mergeResult: { success: false, reason: wal.kind, conflicts: wal.conflicts, ...this.exhausted(entry) } });
      return;
    }
    if (m.status === "blocked") {
      // The adopting owner answers; nothing is launched here.
      m.mergerFor = { ...m.mergerFor, owner: job.owner };
      m.parentPid = job.owner.pid; m.parentSessionId = job.owner.sessionId; m.parentStartTime = job.owner.startTime;
      await writeRecord(m, () => { this.fence(job); });
    }
    this.watch(job, m);
  }
}
