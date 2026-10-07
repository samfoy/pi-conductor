// M6b crash child (tests/effort-resolve.test.ts). It owns a session in a parent-made private repo.
//   conflict:      open an `ask` effort, settle builder-a's conflict with one card, exit normally.
//   resolve-crash: as conflict, then a confirmed human resolve whose enqueue SIGKILLs this process,
//                  i.e. after the acknowledged generation WAL and before the driver sees it.
//   recover-crash: recover as a new owner; the merger launch SIGKILLs this process after the
//                  driver's durable claim and before any merger record exists.
import "./no-live-scope.ts";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openEffort } from "../../src/effort/open.ts";
import { readEffort } from "../../src/effort/store.ts";
import { recoverEffort, resolveEffortRun } from "../../src/effort/reconcile.ts";
import { settleRun } from "../../src/run-pipeline.ts";
import { RunRegistry, runDir, runsRoot } from "../../src/runs.ts";
import { reconcileOrphansAtStartup } from "../../src/reconcile-startup.ts";
import { emptyUsage, type Run } from "../../src/types.ts";
import { git } from "./effort-integration.ts";
import { land } from "./effort-merger.ts";

const [root, mode, evidence] = process.argv.slice(2) as [string, string, string];
const mark = (name: string, text = "") => writeFileSync(join(evidence, name), text);
const card = (r: Run) => appendFileSync(join(evidence, `cards-${mode}`), `${r.id}:${r.status}\n`);
const crash = (marker: string, text = ""): never => { mark(marker, text); process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL did not end the process"); };

if (mode === "conflict" || mode === "resolve-crash") {
  const record = openEffort(root, "probe", `owner-${mode}`, { verify: "true", merger: "ask" });
  const worktree = join(root, ".worktrees", "builder-a"), branch = "conductor-wt/builder-a", dir = runDir("builder-a");
  land(root, record.intRef, { base: "landed\n" });
  const registry = new RunRegistry();
  const run: Run = { id: "builder-a", persona: "builder", task: "Implement builder-a", mode: "background", status: "integrating", startTime: Date.now(), lastEventAt: Date.now(), messages: [], usage: { ...emptyUsage(), cost: 0.01 }, cwd: root,
    parentSessionId: record.owner.sessionId, parentPid: record.owner.pid, parentStartTime: record.owner.startTime,
    effort: { name: record.name, gitRoot: root, role: "writer", spawnBase: record.baseOid, cwd: worktree, owner: record.owner, gate: null },
    integration: { state: "queued", branchHead: git(worktree, "rev-parse", "HEAD"), enqueuedAt: Date.now(), attempts: 0, resultText: "builder-a report: implemented and committed.",
      verifyIdentity: { command: record.policy.verify, timeoutSeconds: record.policy.verifyTimeoutSeconds, retries: record.policy.verifyRetries } },
    worktreePath: worktree, worktreeBranch: branch, recordPath: join(dir, "record.json"), transcriptPath: join(dir, "transcript.jsonl"), finalPath: join(dir, "final.md") };
  registry.register(run);
  const outcome = await registry.integrations.enqueue(run, () => registry.notify(run));
  run.mergeResult = outcome.mergeResult; run.landedCommit = outcome.landedCommit;
  await settleRun(run, outcome.terminal, 0, { registry, onComplete: card });
  mark("conflict-settled", run.status);
  if (mode === "resolve-crash") {
    registry.integrations.enqueue = (() => crash("generation-acknowledged", readFileSync(run.recordPath, "utf8"))) as never;
    await resolveEffortRun(run, { registry, sessionId: record.owner.sessionId, onComplete: card }, async () => true);
    mark("unreachable-after-enqueue");
  }
} else if (mode === "recover-crash") {
  const registry = new RunRegistry();
  registry.integrations.configureMerger(async request => crash("merger-claim-durable", JSON.stringify(JSON.parse(readFileSync(request.writer.recordPath, "utf8")).integration.merger)));
  await reconcileOrphansAtStartup({ runsRoot: runsRoot(), registry, isAlive: () => false, selfSessionId: "owner-recover-crash", now: Date.now() });
  const { done } = await recoverEffort(readEffort(root, "probe")!, { registry, sessionId: "owner-recover-crash", onComplete: card });
  await done;
  mark("unreachable-after-recovery");
} else throw new Error(`unknown mode ${mode}`);
