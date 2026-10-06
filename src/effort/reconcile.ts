import { assertSupportedRuntime } from "../runtime.ts";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { buildOrphanRun, readProcessStartTime } from "../reconcile-startup.ts";
import { RunRegistry, runsRoot, writeRecord, getFinalText } from "../runs.ts";
import { settleRun } from "../run-pipeline.ts";
import { runHook } from "../hook-runner.ts";
import { measureEffortFootprint } from "./admit.ts";
import { isTerminal, type Run, type RunRecord, type ResolvedHook } from "../types.ts";
import type { ConductorEventEmitter } from "../conductor-events.ts";
import { effortGit, effortOwner, effortTip } from "./open.ts";
import { acquireClaim, adoptEffort, assertRunEffortOwner, effortDir, readEffort, releaseClaim, writeEffort, writeDurableFile, type EffortRecord } from "./store.ts";
import { assertCandidate, assertCandidateIndexFlags, integratedCandidate, mergeTree, effortEnv } from "./git.ts";
import { stopOwnedProcessGroup } from "./process-group.ts";

export interface RecoveryOptions {
  registry: RunRegistry;
  sessionId: string;
  onComplete?: (run: Run) => void;
  events?: ConductorEventEmitter;
  resume?: boolean;
}
export function validateSource(run: Run): string {
  if (!run.effort || !run.worktreeBranch) throw new Error("preserved source branch missing");
  const oid = effortGit(run.effort.gitRoot, "rev-parse", "--verify", `refs/heads/${run.worktreeBranch}^{commit}`);
  if (run.worktreePath && existsSync(run.worktreePath)) {
    assertCandidateIndexFlags(run.worktreePath);
    if (effortGit(run.worktreePath, "rev-parse", "HEAD") !== oid || effortGit(run.worktreePath, "status", "--porcelain", "--untracked-files=all")) throw new Error("source changed or dirty; preserve and inspect before requeue");
  }
  return oid;
}
function records(record: EffortRecord): RunRecord[] {
  if (!existsSync(runsRoot())) return [];
  return readdirSync(runsRoot()).sort().flatMap(id => {
    const path = join(runsRoot(), id, "record.json");
    if (!existsSync(path)) return [];
    const r = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    if (r.effort?.gitRoot !== record.gitRoot || r.effort.name !== record.name) return [];
    if (r.id !== id || r.recordPath !== path || r.finalPath !== join(runsRoot(), id, "final.md") || r.transcriptPath !== join(runsRoot(), id, "transcript.jsonl")) throw new Error(`noncanonical effort run record: ${id}`);
    return [r];
  });
}
/** No-op evidence also requires current tree equality; a completed JSON record alone is insufficient. */
function provenNoop(record: EffortRecord, run: Run): boolean {
  if (!run.integration?.noopTip) return false;
  const tip = effortTip(record);
  if (record.gatedTip !== tip) return false;
  const merged = mergeTree(record.gitRoot, tip, run.integration.branchHead);
  return merged.kind === "clean" && merged.tree === effortGit(record.gitRoot, "rev-parse", `${tip}^{tree}`);
}
/** M6a: a merger candidate is disposable only once a reachable landed commit names that merger. */
function landedByMerger(record: EffortRecord, run: Run, oid: string): boolean {
  const m = run.integration?.merger;
  if (m?.outcome !== "accepted" || oid !== m.outputOid || !run.landedCommit) return false;
  effortGit(record.gitRoot, "merge-base", "--is-ancestor", run.landedCommit, record.intRef);
  return effortGit(record.gitRoot, "show", "-s", "--format=%B", run.landedCommit).split("\n").filter(line => line === `Conductor-Merger: ${m.runId}`).length === 1;
}
/** Only known clean detached ancestors are disposable; failed/unreachable/dirty evidence stays. */
async function cleanupCandidates(record: EffortRecord, run: Run): Promise<void> {
  const e = run.integration;
  if (!e || e.commandPending || e.process || !run.mergeResult?.success) return;
  const others = records(record).filter(r => r.id !== run.id && (r.status === "integrating" || r.status === "running" || r.status === "paused"));
  const prefix = join(record.gitRoot, ".worktrees", "conductor-cand", record.name) + "/";
  const removed = new Set<string>();
  for (const path of e.candidates ?? []) {
    if (!path.startsWith(prefix) || !existsSync(path) || others.some(r => r.integration?.candidatePath === path || r.integration?.candidates?.includes(path) || r.worktreePath === path)) continue;
    try {
      if (realpathSync(path) !== path) continue;
      const oid = effortGit(path, "rev-parse", "HEAD");
      assertCandidate(path, oid);
      if (effortGit(path, "status", "--porcelain", "--ignored", "--untracked-files=all")) continue;
      if (path === e.merger?.candidatePath) { if (!landedByMerger(record, run, oid)) continue; }
      else effortGit(record.gitRoot, "merge-base", "--is-ancestor", oid, record.intRef);
      assertRunEffortOwner(run);
      effortGit(record.gitRoot, "worktree", "remove", path);
      removed.add(path);
    } catch { /* uncertainty preserves the workspace, never force removal */ }
  }
  if (removed.size) {
    e.candidates = (e.candidates ?? []).filter(path => !removed.has(path));
    if (e.candidatePath && removed.has(e.candidatePath)) e.candidatePath = undefined;
    await writeRecord(run, () => assertRunEffortOwner(run));
  }
}
function uncertainDelivery(run: Run): void {
  run.integration!.delivery = "uncertain";
  run.integration!.reason = "delivery uncertain after crash or legacy dispatch; automatic callbacks suppressed (notification/events/memory may be missing)";
}
export async function recoverEffort(original: EffortRecord, opts: RecoveryOptions): Promise<{ runs: Run[]; done: Promise<void> }> {
  if (process.env.CONDUCTOR_SUBAGENT === "1") return { runs: [], done: Promise.resolve() };
  for (const run of [...records(original), ...opts.registry.list().filter(r => r.effort?.gitRoot === original.gitRoot && r.effort.name === original.name)]) assertSupportedRuntime(run.runtime);
  if (!readEffort(original.gitRoot, original.name)) throw new Error("effort record missing; ownership recovery refused");
  let record = adoptEffort(original, effortOwner(opts.sessionId));
  const active = opts.registry.list().filter(r => r.effort?.gitRoot === original.gitRoot && r.effort.name === original.name && r.integrationControl);
  if (active.length) {
    if (!opts.resume) return { runs: active, done: Promise.resolve() };
    if (original.status !== "paused") throw new Error("resume requires a paused effort, not an active integration");
    for (const run of active) { assertRunEffortOwner(run); await run.integrationControl!.suspend(); }
    await opts.registry.integrations.whenIdle(original.gitRoot);
  }
  const lock = join(effortDir(original.gitRoot, "integration-driver"), "driver.lock");
  const claim = acquireClaim(lock, effortOwner(randomUUID()));
  const runnable: Run[] = [], restored: Run[] = [];
  try {
    const saved = records(record);
    for (const run of saved) assertSupportedRuntime(run.runtime);
    const order = [...new Set([...(record.queue ?? []), ...saved.filter(r => r.status === "integrating").sort((a, b) => (a.integration?.enqueuedAt ?? a.startTime) - (b.integration?.enqueuedAt ?? b.startTime) || a.id.localeCompare(b.id)).map(r => r.id)])];
    const missing = [...new Set([...record.members, ...order])].filter(id => !saved.some(r => r.id === id));
    record = { ...record, members: [...new Set([...record.members, ...saved.map(r => r.id)])], queue: order,
      ...(opts.resume ? { status: "open" as const, pausedReason: undefined, pausedRun: undefined, gatedTip: undefined } : {}),
      ...(missing.length ? { status: "paused" as const, pausedReason: `missing durable member records: ${missing.join(", ")}; preserve pending order` } : {}) };
    writeEffort(record);
    const ordered = [...saved].sort((a, b) => {
      const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
      return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi) || a.id.localeCompare(b.id);
    });
    for (const savedRun of ordered) {
      const previous = opts.registry.get(savedRun.id);
      if (previous?.proc || previous?.integrationControl) continue;
      if (previous?.runtime === "herdr" && !previous.integration && previous.herdrOwnership) {
        previous.herdrOwnership.assert();
        previous.effort = { ...previous.effort!, owner: record.owner };
        previous.parentSessionId = record.owner.sessionId; previous.parentPid = record.owner.pid; previous.parentStartTime = record.owner.startTime;
        previous.integrationSuspended = false; previous.herdrEffortAuthorized = true;
        await writeRecord(previous, () => { previous.herdrOwnership!.assert(); assertRunEffortOwner(previous); });
        previous.herdrResumeSettlement?.();
        restored.push(previous); continue;
      }
      // A stream claim is not effort authority, and a missing proc handle is not a dead writer.
      if (savedRun.runtime === "herdr" && !savedRun.integration) continue;
      const run = buildOrphanRun(savedRun, savedRun.status);
      run.recordWrite = previous?.recordWrite;
      run.effort = { ...run.effort!, owner: record.owner };
      run.parentSessionId = record.owner.sessionId; run.parentPid = record.owner.pid; run.parentStartTime = record.owner.startTime;
      run.integrationSuspended = false;
      if (run.integration?.delivery === "intent") uncertainDelivery(run);
      opts.registry.register(run); restored.push(run);
      try {
        const candidate = run.integration && integratedCandidate(record, run);
        if (candidate || provenNoop({ ...record, gatedTip: original.gatedTip }, run)) {
          if (run.integration!.deliveryProtocol !== 1) uncertainDelivery(run);
          if (run.integration?.process) await stopOwnedProcessGroup(run.integration.process);
          run.status = "integrating";
          run.landedCommit = candidate || undefined;
          run.integration!.state = "accepted";
          run.mergeResult = { success: true, verify: run.integration!.verify, verifyDisabled: !record.policy.verify, ...(candidate ? {} : { nothingToCommit: true }) };
          if (run.integration) { run.integration.process = undefined; run.integration.commandPending = false; }
          await settleRun(run, "completed", run.exitCode, opts);
          await cleanupCandidates(record, run);
          record = readEffort(record.gitRoot, record.name)!;
          record = { ...record, queue: (record.queue ?? []).filter(id => id !== run.id) };
          writeEffort(record);
          continue;
        }
        if (run.status === "blocked") {
          // Explicit effort adoption establishes the current answer owner; no gate or child launch.
          await writeRecord(run, () => assertRunEffortOwner(run));
          continue;
        }
        if (run.status !== "integrating") {
          if (run.status === "running" || run.status === "paused" || run.status === "queued") {
            let liveOrUnknown = !!run.pid;
            if (run.pid) {
              try { process.kill(run.pid, 0); }
              catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") liveOrUnknown = false; }
            }
            if (liveOrUnknown) {
              run.status = "paused"; run.errorMessage = "lost writer process identity unresolved; no automatic gate or requeue";
            } else { run.status = "killed"; run.errorMessage = "lost writer; explicit human requeue requires source and original hook validation"; }
          }
          if (run.status === "completed") { run.status = "merge_conflict"; run.mergeResult = { success: false, reason: "error" }; run.errorMessage = "completed JSON has no reachable correlated integration proof; work preserved"; }
          if (run.effort) run.effort.footprintUnknown = !run.mergeResult?.success;
          await writeRecord(run, () => assertRunEffortOwner(run));
          if (order.includes(run.id)) throw new Error("queue/WAL disagreement: no durable hook-passed integrating record");
          continue;
        }
        const e = run.integration;
        if (!e || !e.branchHead || !Number.isFinite(e.enqueuedAt) || e.verifyIdentity.command !== record.policy.verify || e.verifyIdentity.timeoutSeconds !== record.policy.verifyTimeoutSeconds || e.verifyIdentity.retries !== record.policy.verifyRetries) throw new Error("integration WAL or frozen verification policy missing/mismatched");
        if (!["queued", "merging", "generating", "verifying", "verified", "resolving", "paused", "cancelled"].includes(e.state)) throw new Error(`unsupported recovery state ${e.state}; preserve for human inspection`);
        if (e.commandPending && !e.process) throw new Error("interrupted command launch has unknown process identity; preserve work");
        if (e.process) await stopOwnedProcessGroup(e.process);
        e.process = undefined; e.commandPending = false; e.teardownError = undefined;
        if (validateSource(run) !== (e.sourceHead ?? e.branchHead)) throw new Error("source branch head changed; original OID and work retained");
        if (record.status === "paused" || (e.state === "paused" && !opts.resume) || e.state === "cancelled") throw new Error(record.pausedReason ?? e.reason ?? "paused entry requires explicit human resume");
        if (e.state === "resolving") await restoreMerger(run, opts);
        else { e.state = "queued"; e.reason = undefined; }
        if (opts.resume) e.casFailures = 0;
        await writeRecord(run, () => assertRunEffortOwner(run));
        runnable.push(run);
      } catch (error) {
        // A resolving entry keeps its merger claim's state, so a human resume re-reads that merger.
        if (run.integration) { if (run.integration.state !== "resolving" || !run.integration.merger) run.integration.state = "paused"; run.integration.reason = (error as Error).message; }
        run.integrationSuspended = true;
        record = { ...readEffort(record.gitRoot, record.name)!, status: "paused", pausedReason: (error as Error).message, pausedRun: run.id };
        writeEffort(record);
        await writeRecord(run, () => assertRunEffortOwner(run));
      }
      opts.registry.notify(run);
    }
  } finally { releaseClaim(lock, claim); }
  const done = Promise.all(runnable.map(async run => {
    const outcome = await opts.registry.integrations.enqueue(run, () => opts.registry.notify(run), true);
    run.mergeResult = outcome.mergeResult; run.landedCommit = outcome.landedCommit;
    await settleRun(run, outcome.terminal, run.exitCode, opts);
    await cleanupCandidates(readEffort(run.effort!.gitRoot, run.effort!.name)!, run);
  })).then(() => {});
  void done.catch(() => {});
  return { runs: restored, done };
}

/**
 * M6a: register the claimed merger's canonical record, or decide it never ran. A live or unknown
 * merger pauses for a human with zero signals; a dead non-terminal one is lost, never authority.
 */
async function restoreMerger(writer: Run, opts: RecoveryOptions): Promise<void> {
  const wal = writer.integration!.merger;
  if (!wal) throw new Error("resolving entry has no merger claim; preserve for inspection");
  if (wal.outcome) return;
  let merger = opts.registry.get(wal.runId);
  const path = join(runsRoot(), wal.runId, "record.json");
  if (!merger && existsSync(path)) {
    const saved = JSON.parse(readFileSync(path, "utf8")) as RunRecord;
    if (saved.id !== wal.runId || saved.recordPath !== path || saved.mergerFor?.writerId !== writer.id || saved.mergerFor.nonce !== wal.nonce) throw new Error(`noncanonical merger record ${wal.runId}; preserve for inspection`);
    merger = buildOrphanRun(saved, saved.status);
  }
  if (!merger) return; // claim without a record: the driver spends the attempt
  if (!isTerminal(merger.status) && merger.status !== "blocked") {
    let live = merger.status !== "queued";
    if (merger.pid) {
      try { process.kill(merger.pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") live = false; }
    }
    if (live) throw new Error(`merger ${merger.id} live or unknown after restart; no signal sent. Resume the effort once it settles`);
    merger.status = "killed"; merger.finishedAt = Date.now();
    merger.errorMessage = "lost merger: its process is gone without a terminal record; not authority";
    await writeRecord(merger);
  }
  if (!opts.registry.get(merger.id)) opts.registry.register(merger);
}

/** Slash-command only: the caller has obtained explicit human confirmation. */
export async function requeueEffortRun(run: Run, opts: RecoveryOptions, replacement?: string, expectedOid?: string): Promise<{ done: Promise<void> }> {
  assertSupportedRuntime(run.runtime);
  if (!run.effort || run.status === "blocked" || run.status === "running" || run.status === "paused" || (run.status === "integrating" && (!run.integrationSuspended || run.integrationControl || run.integration?.state !== "paused"))) throw new Error("requeue requires a stopped preserved writer, never a blocked ask or live assignment");
  let record = adoptEffort(readEffort(run.effort.gitRoot, run.effort.name)!, effortOwner(opts.sessionId));
  const lock = join(effortDir(record.gitRoot, "integration-driver"), "driver.lock");
  const claim = acquireClaim(lock, effortOwner(randomUUID()));
  try {
    if (record.status === "paused" && record.pausedRun !== run.id) throw new Error(`effort paused: ${record.pausedReason}; use human effort resume first`);
    if (integratedCandidate(record, run) || provenNoop(record, run)) throw new Error("work is already integrated; never requeue to recreate delivery (manual repost may duplicate a notification)");
    const gate: ResolvedHook | null | undefined = replacement === undefined ? run.effort.gate : { command: replacement, source: "per-call", timeoutSeconds: run.effort.gate?.timeoutSeconds ?? 300 };
    if (gate === undefined) throw new Error("original hook is unknown/unreconstructable; provide an explicit human replacement with --hook <command>");
    const head = validateSource(run);
    if (head !== (run.integration?.sourceHead ?? run.integration?.branchHead ?? head) && expectedOid !== head) throw new Error(`source branch head changed; inspect and confirm exact OID with --oid=${head}`);
    if (expectedOid && expectedOid !== head) throw new Error("source OID no longer matches human confirmation");
    if (run.integration?.commandPending && !run.integration.process) throw new Error("previous gate launch identity unknown; preserve and inspect");
    if (run.integration?.process) await stopOwnedProcessGroup(run.integration.process);
    run.effort = { ...run.effort, owner: record.owner, gate };
    run.parentPid = record.owner.pid; run.parentSessionId = record.owner.sessionId; run.parentStartTime = record.owner.startTime;
    const path = join(record.gitRoot, ".worktrees", "conductor-cand", record.name, `${run.id}-regate-${randomUUID()}`);
    const prior = run.integration;
    // The merger attempt never decrements: a requeue re-gates the source without a second merger.
    run.integration = { state: "paused", branchHead: head, sourceHead: head, enqueuedAt: Date.now(), attempts: 0, ...(prior?.merger ? { merger: prior.merger } : {}),
      verifyIdentity: { command: record.policy.verify, timeoutSeconds: record.policy.verifyTimeoutSeconds, retries: record.policy.verifyRetries },
      resultText: prior?.resultText || getFinalText(run.messages) || (existsSync(run.finalPath) ? readFileSync(run.finalPath, "utf8") : "(no saved result)"),
      candidates: [...(prior?.candidates ?? []), path], candidatePath: path, commandPending: !!gate };
    await writeRecord(run, () => assertRunEffortOwner(run));
    effortGit(record.gitRoot, "worktree", "add", "--detach", path, head);
    if (gate) {
      const subdir = run.worktreePath && run.effort.cwd ? relative(run.worktreePath, run.effort.cwd) : "";
      if (subdir.startsWith("..")) throw new Error("original hook cwd cannot be reconstructed safely");
      const cwd = join(path, subdir);
      const dir = join(effortDir(record.gitRoot, record.name), "verify", `${run.id}-regate-${randomUUID()}`);
      mkdirSync(dir, { recursive: true });
      let recording = Promise.resolve();
      let teardown: Promise<void> | undefined;
      const stop = () => {
        if (!run.integration!.process) return Promise.resolve();
        teardown ??= stopOwnedProcessGroup(run.integration!.process);
        void teardown.catch(() => {});
        return teardown;
      };
      const finalPath = join(dirname(run.recordPath), "gate-final.md");
      writeDurableFile(finalPath, run.integration.resultText!, () => assertRunEffortOwner(run));
      const result = await runHook({ resolved: gate, runId: run.id, persona: run.persona, runDir: dirname(run.recordPath), finalPath, transcriptPath: run.transcriptPath,
        parentCwd: run.cwd, cwd, worktreePath: path, logPath: join(dir, "gate.log"), tmpDir: join(dir, "tmp"), extraEnv: effortEnv(), deps: { killGroup: () => { void stop(); } },
        onProc: proc => { if (proc.pid) { run.integration!.process = { pid: proc.pid, startTime: readProcessStartTime(proc.pid) }; recording = writeRecord(run, () => assertRunEffortOwner(run)); void recording.catch(() => { void stop(); }); } },
      });
      await stop();
      await recording;
      run.hookResult = result;
      run.integration.commandPending = false; run.integration.process = undefined;
      await writeRecord(run, () => assertRunEffortOwner(run));
      if (!result.passed) throw new Error(`original hook rejected requeue: ${result.logPath}`);
    }
    assertRunEffortOwner(run); assertCandidate(path, head);
    if (validateSource(run) !== head) throw new Error("source changed while its gate ran; preserve both checkouts");
    run.integration.commandPending = false;
    Object.assign(run.integration, measureEffortFootprint(run, head, record.policy), { state: "queued" });
    run.status = "integrating"; run.integrationSuspended = false; run.mergeResult = undefined; run.errorMessage = undefined;
    await writeRecord(run, () => assertRunEffortOwner(run));
    record = readEffort(record.gitRoot, record.name)!;
    writeEffort({ ...record, status: "open", pausedReason: undefined, pausedRun: undefined, gatedTip: undefined, members: [...new Set([...record.members, run.id])], queue: [...new Set([...(record.queue ?? []), run.id])] });
  } finally { releaseClaim(lock, claim); }
  const done = opts.registry.integrations.enqueue(run, () => opts.registry.notify(run), true).then(async outcome => {
    run.mergeResult = outcome.mergeResult; run.landedCommit = outcome.landedCommit;
    await settleRun(run, outcome.terminal, run.exitCode, opts);
    await cleanupCandidates(readEffort(run.effort!.gitRoot, run.effort!.name)!, run);
  });
  void done.catch(() => {});
  return { done };
}
