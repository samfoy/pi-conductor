// H11: isolation guards run always with fake effects. The real-herdr matrix runs
// only with CONDUCTOR_LIVE_TESTS=1 and never touches an inherited or ambient session.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { tmpDir } from "./helpers/tmp.ts";
import { ambientSnapshot, HerdrLiveFixture, liveEnabled, piEntry, procStartTime, startLiveFixture, writePiWrapper, planLiveIdentity, proveOwnedSocket, refuseInheritedTarget, type LiveEffects, type LiveIdentity, type ProcessIdentity } from "./helpers/herdr-live.ts";

const scratch = realpathSync(tmpDir("h")); // short: unix socket paths are length-limited
let n = 0;
function identity(): LiveIdentity {
  const root = join(scratch, `f${n++}`); mkdirSync(root);
  return planLiveIdentity(root, `unit${String(n).padStart(4, "0")}`, join(scratch, "no-real-home"));
}
function fake(id: LiveIdentity, over: { sessions?: unknown; status?: unknown; holds?: boolean; procs?: ProcessIdentity[]; survive?: boolean } = {}) {
  const log: string[][] = [];
  let serverAlive = true;
  const effects: LiveEffects = {
    async exec(args) {
      log.push(args);
      if (args[0] === "session" && args[1] === "list") return JSON.stringify(over.sessions ?? { sessions: [{ name: id.name, running: true, socket_path: id.socketPath, session_dir: id.sessionDir }] });
      if (args[0] === "status") return JSON.stringify(over.status ?? { running: true, socket: id.socketPath });
      if (args[1] === "stop") { serverAlive = false; return JSON.stringify({ stopped: true, session: { socket_path: id.socketPath } }); }
      if (args[1] === "delete") return JSON.stringify({ deleted: true });
      return JSON.stringify({ result: { pane: { pane_id: args[2], agent: null } } });
    },
    startTime: pid => pid === 4242 ? (serverAlive ? 77 : undefined) : over.procs?.find(p => p.pid === pid && over.survive)?.startTime,
    holdsSocket: () => over.holds ?? true,
    processes: () => over.procs ?? [],
    signal: (pid, signal) => { log.push(["signal", String(pid), signal]); },
    remove: path => { log.push(["remove", path]); },
  };
  const server = { pid: 4242, startTime: 77, exited: () => !serverAlive, wait: async () => !serverAlive };
  return { fixture: new HerdrLiveFixture(id, server, effects), log };
}

test("H11 harness refuses inherited herdr targets before any control", () => {
  for (const key of ["HERDR_SOCKET_PATH", "HERDR_SESSION", "HERDR_PANE_ID", "HERDR_ENV"]) {
    assert.throws(() => refuseInheritedTarget({ PATH: "/usr/bin", [key]: "ambient" }), /refuses inherited herdr target/);
  }
  refuseInheritedTarget({ PATH: "/usr/bin" });
  assert.equal(liveEnabled({}), false, "the default suite never starts a live session");
  assert.equal(liveEnabled({ CONDUCTOR_LIVE_TESTS: "1" }), true);
});

test("H11 identity refuses ambient/wrong names and session collisions", () => {
  const root = join(scratch, "names"); mkdirSync(root);
  for (const unique of ["", "codex", "Upper1234", "has space1", "a".repeat(17), "../../x1234"]) assert.throws(() => planLiveIdentity(root, unique, scratch), /refuses session name/);
  const id = planLiveIdentity(root, "abcd1234", scratch);
  assert.equal(id.socketPath, join(root, "c", "herdr", "sessions", "conductor-h11-abcd1234", "herdr.sock"));
  mkdirSync(id.sessionDir, { recursive: true });
  assert.throws(() => planLiveIdentity(root, "abcd1234", scratch), /collision/);
  const home = join(scratch, "home"); mkdirSync(join(home, ".config", "herdr", "sessions", "conductor-h11-efgh5678"), { recursive: true });
  assert.throws(() => planLiveIdentity(root, "efgh5678", home), /collision/, "a same-named real session is never shadowed");
  assert.throws(() => planLiveIdentity("relative/root", "abcd9999", scratch), /canonical absolute/);
});

test("H11 socket ownership proof refuses each single-field mismatch", () => {
  const id = identity();
  const entry = { name: id.name, running: true, socket_path: id.socketPath, session_dir: id.sessionDir };
  const good = { sessions: { sessions: [entry, { name: "default", running: true, socket_path: "/ambient/herdr.sock", session_dir: "/ambient" }] }, status: { running: true, socket: id.socketPath }, serverAlive: true, holdsSocket: true };
  assert.deepEqual(proveOwnedSocket(id, good), { ok: true });
  const variants: Array<[string, typeof good]> = [
    ["session name not unique", { ...good, sessions: { sessions: [entry, entry] } }],
    ["session name not unique", { ...good, sessions: { sessions: [{ ...entry, name: "codex" }] } }],
    ["session socket mismatch", { ...good, sessions: { sessions: [{ ...entry, socket_path: "/ambient/herdr.sock" }] } }],
    ["session socket mismatch", { ...good, sessions: { sessions: [{ ...entry, running: false }] } }],
    ["session socket mismatch", { ...good, sessions: { sessions: [{ ...entry, session_dir: "/ambient" }] } }],
    ["server status socket mismatch", { ...good, status: { running: true, socket: "/ambient/herdr.sock" } }],
    ["server status socket mismatch", { ...good, status: { running: false, socket: id.socketPath } }],
    ["owned server process identity changed", { ...good, serverAlive: false }],
    ["socket not held by owned server", { ...good, holdsSocket: false }],
    ["session list unavailable", { ...good, sessions: {} as never }],
  ];
  for (const [reason, ev] of variants) assert.deepEqual(proveOwnedSocket(id, ev), { ok: false, reason });
});

test("H11 control refuses a wrong socket before issuing the control command", async () => {
  const id = identity();
  const { fixture, log } = fake(id, { status: { running: true, socket: "/home/user/.config/herdr/herdr.sock" } });
  await assert.rejects(fixture.cli(["pane", "list"]), /ownership refused: server status socket mismatch/);
  assert.deepEqual(log.map(a => a.slice(0, 2).join(" ")), ["session list", "status server"], "only read-only proof calls ran");
  const held = fake(identity(), { holds: false });
  await assert.rejects(held.fixture.cli(["pane", "list"]), /socket not held/);
  assert.ok(!held.log.some(a => a[0] === "pane"));
});

test("H11 cleanup refuses unowned pane IDs and foreign bindings with zero calls", async () => {
  const id = identity();
  const { fixture, log } = fake(id);
  await assert.rejects(fixture.closeOwnedPane("w9:p9"), /refuses to close unowned pane/);
  assert.throws(() => fixture.adopt({ socketPath: "/home/user/.config/herdr/herdr.sock", paneId: "w1:p1" }), /another socket/);
  await assert.rejects(fixture.closeOwnedPane("w1:p1"), /unowned/, "a refused adoption grants nothing");
  assert.equal(log.length, 0, "no call was issued");
  fixture.adopt({ socketPath: id.socketPath, paneId: "w1:p2" });
  await fixture.closeOwnedPane("w1:p2");
  assert.deepEqual(log.filter(a => a[0] === "pane").map(a => a.join(" ")), ["pane get w1:p2", "pane close w1:p2"]);
});

test("H11 teardown without socket proof never stops, deletes or removes", async () => {
  const id = identity();
  const { fixture, log } = fake(id, { sessions: { sessions: [] } });
  const report = await fixture.teardown(50);
  assert.equal(report.clean, false);
  assert.equal(report.preserved, id.root);
  assert.ok(!log.some(a => a[1] === "stop" || a[1] === "delete" || a[0] === "remove"), JSON.stringify(log));
});

test("H11 teardown preserves evidence when captured owned processes survive", async () => {
  const id = identity();
  const { fixture, log } = fake(id, { procs: [{ pid: 999, startTime: 5, argv: "pi" }], survive: true });
  const report = await fixture.teardown(100);
  assert.equal(report.clean, false);
  assert.deepEqual(report.leftovers.map(p => p.pid), [999]);
  assert.deepEqual(log.filter(a => a[0] === "signal"), [["signal", "999", "SIGTERM"]], "only the exact captured identity is signalled");
  assert.ok(!log.some(a => a[0] === "remove" || a[1] === "delete"));
});

test("H11 clean teardown stops, awaits exit, deletes, then removes only the fixture root", async () => {
  const id = identity();
  const { fixture, log } = fake(id, { procs: [{ pid: 999, startTime: 5, argv: "pi" }] });
  const report = await fixture.teardown(100);
  assert.equal(report.clean, true, report.notes.join("; "));
  const order = log.map(a => a[0] === "remove" ? `remove ${a[1]}` : a.slice(0, 2).join(" ")).filter(s => /stop|delete|remove/.test(s));
  assert.deepEqual(order, ["session stop", "session delete", `remove ${id.root}`]);
});

// ── Opt-in live matrix ───────────────────────────────────────────────────────
const LIVE = liveEnabled(process.env);
const piRoots = (process.env.CONDUCTOR_H11_PI_ROOTS ?? "").split(":").filter(Boolean);
const worktree = realpathSync(new URL("..", import.meta.url).pathname);
const jsonLines = (path: string): Record<string, any>[] => !existsSync(path) ? [] : readFileSync(path, "utf8").split("\n").flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });

async function until<T>(label: string, ms: number, probe: () => T | undefined | false | Promise<T | undefined | false>, why: () => string = () => ""): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`H11 ${label} not observed within ${ms}ms ${why()}`.trim());
    await new Promise(r => setTimeout(r, 50));
  }
}

for (const piRoot of LIVE ? (piRoots.length ? piRoots : [""]) : ["(gated)"]) {
  const version = LIVE && piRoot ? JSON.parse(readFileSync(join(piRoot, "package.json"), "utf8")).version : piRoot;
  test(`H11 live: real herdr ${version} interactive Pi child lifecycle`, { skip: LIVE ? false : "set CONDUCTOR_LIVE_TESTS=1 and CONDUCTOR_H11_PI_ROOTS for isolated real herdr", timeout: 330000 }, async t => {
    assert.ok(piRoot, "CONDUCTOR_H11_PI_ROOTS must name explicit Pi package roots; a missing prerequisite is a failure, not a skip");
    const herdrBin = realpathSync(process.env.CONDUCTOR_H11_HERDR_BIN ?? execFileSync("sh", ["-c", "command -v herdr"], { encoding: "utf8" }).trim());
    const integration = process.env.CONDUCTOR_H11_HERDR_INTEGRATION ?? join(userInfo().homedir, ".pi", "agent", "extensions", "herdr-agent-state.ts");
    assert.match(readFileSync(integration, "utf8"), /HERDR_INTEGRATION_ID=pi\n\/\/ HERDR_INTEGRATION_VERSION=9/);
    const parent = realpathSync(tmpDir("h"));
    const ambient = ambientSnapshot(parent);
    const alt = process.env.CONDUCTOR_H11_ALT_PI_ROOT ?? piRoots.find(r => r !== piRoot);
    const evidence = { pi: version, piCli: piEntry(piRoot), conductor: join(worktree, "dist", "index.js"), herdr: execFileSync(herdrBin, ["--version"], { encoding: "utf8" }).trim(), integration, netns: process.env.CONDUCTOR_H11_NETNS !== "0" };
    t.diagnostic(`H11 versions ${JSON.stringify(evidence)}`);
    const fx = await startLiveFixture({ piRoot, worktree, herdrBin, integration, netns: evidence.netns }, randomUUID().replace(/-/g, "").slice(0, 12), parent);
    const root = fx.id.root, runs = join(root, "home", ".pi", "agent", "conductor", "runs");
    t.diagnostic(`H11 fixture ${fx.id.name} server pid ${fx.server.pid}/${fx.server.startTime} socket ${fx.id.socketPath}`);
    let report: Awaited<ReturnType<typeof fx.teardown>> | undefined;
    const work = join(root, "work");
    try {
      const cliVersion = execFileSync(join(root, "bin", "pi"), ["--version"], { env: fx.env, cwd: work, encoding: "utf8", timeout: 30000 }).trim();
      t.diagnostic(`H11 fixture pi --version: ${cliVersion}`);
      assert.match(cliVersion, new RegExp(`\\b${version.replace(/\./g, "\\.")}\\b`), "the pinned executable reports its own version");
      // Miniature effort repository: generated gen/all.txt, independent verify, a recorded repository hook.
      const git = (...args: string[]) => execFileSync("git", args, { cwd: work, env: fx.env, encoding: "utf8", timeout: 20000 }).trim();
      mkdirSync(join(work, "src")); mkdirSync(join(work, "gen")); mkdirSync(join(work, ".githooks"));
      writeFileSync(join(work, "src", "base.txt"), "base\n");
      writeFileSync(join(work, "gen.sh"), "mkdir -p gen && cat src/*.txt > gen/all.txt\n");
      writeFileSync(join(work, "verify.sh"), 'cat src/*.txt | cmp -s - gen/all.txt || { echo "generated drift"; exit 1; }\necho "verified $(git rev-parse HEAD) candidate=${CONDUCTOR_CANDIDATE:-}"\n');
      writeFileSync(join(work, "gen", "all.txt"), "base\n");
      writeFileSync(join(work, ".githooks", "pre-commit"), '#!/bin/sh\nprintf "%s\\n" "$(git rev-parse --show-toplevel)" >> "$(git rev-parse --git-common-dir)/h11-hook.log"\n', { mode: 0o755 });
      writeFileSync(join(work, ".gitignore"), ".worktrees/\n");
      git("init", "-q", "-b", "main"); git("config", "core.hooksPath", ".githooks");
      git("add", "."); git("commit", "-q", "-m", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(root, "pads", "retire.txt"), Array.from({ length: 150 }, (_, i) => `evidence line ${i}: context pressure sample ${"x".repeat(24)}`).join("\n"));
      const record = (id: string) => JSON.parse(readFileSync(join(runs, id, "record.json"), "utf8"));
      const leadStarts = () => readdirSync(join(root, "obs")).filter(f => f.startsWith("lead-")  && f.includes("-start-")).sort((a, b) => Number(a.split("-").at(-1)!.slice(0, -5)) - Number(b.split("-").at(-1)!.slice(0, -5))).map(f => JSON.parse(readFileSync(join(root, "obs", f), "utf8")));
      const paneText = async (pane: string) => (await fx.cli(["pane", "read", pane, "--source", "recent-unwrapped", "--lines", "400"])).text as string;
      let leadPane = await fx.createWorkspace(work, "h11-lead");
      let leadName = "lead";
      const startLead = async (name: string, args: string[] = []) => {
        const before = leadStarts().length;
        const started = await fx.cli(["agent", "start", name, "--kind", "pi", "--pane", leadPane, "--timeout", "60000", "--", "--session-dir", join(root, "lead-sessions"), ...args], 65000);
        assert.equal(started.result?.agent?.agent, "pi", JSON.stringify(started));
        return until("lead session_start", 20000, () => leadStarts().length > before && leadStarts().at(-1));
      };
      let lead = await startLead(leadName);
      assert.equal(lead.version, version); assert.equal(lead.mode, "tui");
      let step = 0;
      const leadTool = async (tool: string, args: Record<string, unknown>) => {
        const name = `s${++step}`;
        writeFileSync(join(root, "script", `${name}.json`), JSON.stringify({ tool, args }));
        await fx.cli(["agent", "wait", leadName, "--until", "idle", "--until", "done", "--timeout", "30000"], 35000);
        await fx.cli(["agent", "prompt", leadName, `H11 ${name}`], 15000);
        const obs = join(root, "obs", `lead-tool-h11_${name}.json`);
        return until(`lead ${tool} result`, 60000, () => existsSync(obs) && JSON.parse(readFileSync(obs, "utf8")));
      };
      const spawnChild = async (task: string, runtime = "herdr", extra: Record<string, unknown> = {}) => {
        const r = await leadTool("ensemble_spawn", { persona: "oracle", task, runtime, foreground: false, ...extra });
        assert.equal(r.isError, false, JSON.stringify(r.result));
        return r.result.details.agent_id as string;
      };
      // A terminal record can land before final.md; completed also waits for the published final.
      const status = (id: string, ...want: string[]) => until(`${id} status ${want.join("|")}`, 90000, () => {
        if (!existsSync(join(runs, id, "record.json"))) return false;
        const r = record(id);
        return want.includes(r.status) && (r.status !== "completed" || existsSync(join(runs, id, "final.md"))) && r;
      }, () => JSON.stringify(existsSync(join(runs, id, "record.json")) ? { status: record(id).status, error: record(id).errorMessage } : {}));
      const hello = (id: string) => JSON.parse(readFileSync(join(runs, id, "launch", `${record(id).herdr.launchNonce}.json`), "utf8"));
      const events = (id: string) => { const nonce = record(id).herdr.launchNonce; return jsonLines(join(runs, id, "transcript.jsonl")).filter(e => e._c?.n === nonce); };
      const notifications = (id: string) => jsonLines(lead.sessionFile).filter(e => e.type === "custom_message" && JSON.stringify(e).includes("<sub-agent-completed>") && JSON.stringify(e).includes(id)).length;
      const gone = (h: { pid: number; pidStartTime: number }) => procStartTime(h.pid) !== h.pidStartTime;
      const release = (token: string) => writeFileSync(join(root, "script", `release-${token}`), "go");
      let b1 = "", k4 = "";
      const held = (token: string, id: string) => until(`child ${token} held`, 60000, () => {
        if (existsSync(join(runs, id, "record.json")) && ["failed", "killed", "completed"].includes(record(id).status)) throw new Error(`H11 ${id} ended before its barrier: ${record(id).status} ${record(id).errorMessage}`);
        return existsSync(join(root, "obs", `child-${token}-held.json`));
      });

      await t.test("spawn -> stream -> agent_settled -> child exit -> shell scrollback", async () => {
        const id = await spawnChild("H11-CHILD basic b1");
        const r = await status(id, "completed", "failed", "killed");
        assert.equal(r.status, "completed", r.errorMessage);
        fx.adopt(r.herdr);
        assert.equal(r.runtime, "herdr"); assert.equal(r.herdr.socketPath, fx.id.socketPath);
        const h = hello(id);
        const host = readdirSync(join(root, "obs")).filter(f => f.startsWith(`child-${h.pid}-start-`)).map(f => JSON.parse(readFileSync(join(root, "obs", f), "utf8")));
        assert.equal(host.length, 1); assert.equal(host[0].version, version, "the pane child runs the pinned host Pi");
        assert.equal(h.piVersion, version, "hello reports the executing host Pi");
        t.diagnostic(`H11 hello piVersion=${h.piVersion} piLibraryVersion=${h.piLibraryVersion}; agentName=${r.herdr.agentName}`);
        assert.equal(r.herdr.versionWarning, undefined, "same host version on lead and child");
        assert.match(r.herdr.agentName, /^[a-z][a-z0-9_-]{0,31}$/);
        assert.equal(h.sessionFile, r.herdr.sessionFile);
        await until("child pid exit", 15000, () => gone(h));
        const types = events(id).map(e => e.type === "conductor_child" ? `child:${e.event}` : e.type);
        assert.deepEqual([types[0], types.includes("agent_start"), types.at(-1)], ["child:launch", true, "agent_settled"], types.join(","));
        assert.equal(events(id).find(e => e.type === "agent_start")?.initialRequestId !== undefined, true, "native start correlated to the accepted request");
        assert.match(readFileSync(join(runs, id, "final.md"), "utf8"), /H11 final b1 漢🙂 verified/);
        await until("pane agent release after child exit", 15000, async () => !(await fx.cli(["pane", "get", r.herdr.paneId])).result.pane.agent);
        const scroll = await paneText(r.herdr.paneId);
        assert.match(scroll, /H11 final b1/); assert.match(scroll, /To resume this session/);
        await until("single completion notification", 20000, () => notifications(id) === 1);
        assert.equal(record(id).herdr.settlement.delivery, "attempted");
        b1 = id;
      });

      await t.test("semantic parity with a subprocess faux run", async () => {
        const id = await spawnChild("H11-CHILD basic b1", "subprocess");
        const r = await status(id, "completed", "failed");
        assert.equal(r.status, "completed", r.errorMessage);
        const h = record(b1);
        assert.equal(readFileSync(join(runs, id, "final.md"), "utf8").trim(), readFileSync(join(runs, b1, "final.md"), "utf8").trim());
        assert.equal(r.usage.turns, h.usage.turns); assert.equal(r.usage.output, h.usage.output);
        t.diagnostic(`H11 usage subprocess=${JSON.stringify(r.usage)} herdr=${JSON.stringify(h.usage)}`);
        const assistant = (lines: Record<string, any>[]) => lines.filter(e => e.type === "message_end" && e.message?.role === "assistant").map(e => JSON.stringify(e.message.content));
        assert.deepEqual(assistant(jsonLines(join(runs, id, "transcript.jsonl"))), assistant(events(b1)));
      });

      await t.test("live steer and follow_up are input-accepted then executed in order", async () => {
        // One control is in flight until Pi consumes it, so the follow-up is sent during the steered turn.
        const id = await spawnChild("H11-CHILD hold2 s2");
        await held("s2", id);
        const steer = await leadTool("ensemble_send", { agent_id: id, message: "H11 steer s2", streaming_behavior: "steer", foreground: false });
        assert.equal(steer.result.details.status, "accepted-input", `steer: ${JSON.stringify(steer.result)}`);
        release("s2");
        await held("s2-2", id);
        const follow = await leadTool("ensemble_send", { agent_id: id, message: "H11 follow s2", streaming_behavior: "follow_up", foreground: false });
        assert.equal(follow.result.details.status, "accepted-input", `follow_up: ${JSON.stringify(follow.result)}`);
        release("s2-2");
        const r = await status(id, "completed", "failed");
        assert.equal(r.status, "completed", r.errorMessage);
        fx.adopt(r.herdr);
        const final = readFileSync(join(runs, id, "final.md"), "utf8");
        assert.match(final, /H11 steer s2/); assert.match(final, /H11 follow s2/);
        assert.ok(final.indexOf("H11 steer s2") < final.indexOf("H11 follow s2"), final);
      });

      await t.test("owner ask blocks, child exits, reply relaunches the same session in the proven pane", async () => {
        const id = await spawnChild("H11-CHILD ask a3");
        const blocked = await status(id, "blocked", "failed", "completed");
        assert.equal(blocked.status, "blocked", blocked.errorMessage);
        assert.equal(blocked.pendingAsk.question, "H11 question a3?");
        fx.adopt(blocked.herdr);
        await until("asking child exit", 15000, () => gone(hello(id)));
        const first = blocked.herdr;
        const reply = await leadTool("ensemble_send", { agent_id: id, message: "H11 answer a3", foreground: false });
        assert.equal(reply.isError, false, JSON.stringify(reply.result));
        const r = await status(id, "completed", "failed", "blocked");
        assert.equal(r.status, "completed", r.errorMessage);
        assert.equal(r.pendingAsk, undefined);
        assert.equal(r.herdr.sessionFile, first.sessionFile); assert.notEqual(r.herdr.launchNonce, first.launchNonce);
        assert.equal(r.herdr.paneId, first.paneId, "a proven empty prior pane is reused"); assert.equal(r.herdr.createdTab, false);
        assert.notEqual(r.herdr.agentName, first.agentName, "same-pane relaunch uses a fresh physical alias");
        assert.match(readFileSync(join(runs, id, "final.md"), "utf8"), /owner-answer[\s\S]*H11 answer a3/);
      });

      await t.test("kill signals only the proven child and keeps pane scrollback", async () => {
        const id = k4 = await spawnChild("H11-CHILD hold k4");
        await held("k4", id);
        const r0 = record(id); fx.adopt(r0.herdr);
        const shell = (await fx.cli(["pane", "process-info", "--pane", r0.herdr.paneId])).result.process_info.shell_pid;
        const killed = await leadTool("ensemble_kill", { agent_id: id });
        assert.equal(killed.isError, false, JSON.stringify(killed.result));
        const r = await status(id, "killed", "failed", "completed");
        assert.equal(r.status, "killed");
        await until("killed child exit", 15000, () => gone(hello(id)));
        const info = (await fx.cli(["pane", "process-info", "--pane", r0.herdr.paneId])).result.process_info;
        assert.equal(info.shell_pid, shell, "the pane shell was not signalled");
        assert.match(await paneText(r0.herdr.paneId), /H11-CHILD hold k4/, "killed child TUI output remains in scrollback");
        release("k4");
      });

      await t.test("manually closing the own idle pane, then resume creates a new tab", async () => {
        const before = record(b1).herdr;
        await fx.closeOwnedPane(before.paneId);
        const sent = await leadTool("ensemble_send", { agent_id: b1, message: "H11 resume r5", foreground: false });
        assert.equal(sent.isError, false, JSON.stringify(sent.result));
        const r = await until("resumed completion", 90000, () => { const x = record(b1); return x.status === "completed" && x.herdr.launchNonce !== before.launchNonce && /H11 resume r5/.test(readFileSync(join(runs, b1, "final.md"), "utf8")) && x; });
        fx.adopt(r.herdr);
        assert.notEqual(r.herdr.paneId, before.paneId); assert.equal(r.herdr.createdTab, true);
        assert.equal(r.herdr.sessionFile, before.sessionFile);
        assert.match(readFileSync(join(runs, b1, "final.md"), "utf8"), /H11 saw b1: H11 resume r5/);
      });

      await t.test("native automatic compaction retires the context under exit-at-settle", async () => {
        // Analyst is pinned to the 8K faux window; repeated reads grow context until Pi's own policy compacts.
        const twin = await spawnChild("H11-CHILD retire t6", "subprocess", { persona: "analyst" });
        const id = await spawnChild("H11-CHILD retire t6", "herdr", { persona: "analyst" });
        const r = await status(id, "completed", "failed"), s = await status(twin, "completed", "failed");
        fx.adopt(r.herdr);
        const compactions = readdirSync(join(root, "obs")).filter(f => f.startsWith("child-") && f.includes("-compact-")).map(f => JSON.parse(readFileSync(join(root, "obs", f), "utf8")));
        t.diagnostic(`H11 retirement herdr=${r.contextRetired} subprocess=${s.contextRetired} compactions=${JSON.stringify(compactions)}`);
        assert.equal(r.contextRetired, true, JSON.stringify({ status: r.status, error: r.errorMessage, subprocessRetired: s.contextRetired, compactions }));
        assert.ok(compactions.some(c => c.runId === id && c.reason !== "manual"), "an automatic native compaction, not a manual one");
        assert.match(readFileSync(join(runs, id, "final.md"), "utf8"), /retirement instruction received/, "the child saw A2's finalize instruction and handed off");
        const saved = readFileSync(r.herdr.sessionFile, "utf8");
        assert.match(saved, /"customType":"conductor-context-retired"/);
        // Conductor tools report refusals as details.error results (not thrown), like every other tool error.
        const refused = await leadTool("ensemble_send", { agent_id: id, message: "H11 after retirement", foreground: false });
        assert.match(String(refused.result.details?.error), /Session retired due to context pressure/, JSON.stringify(refused.result));
      });

      await t.test("lead /reload fences the old owner; one completion after reattach", async () => {
        const id = await spawnChild("H11-CHILD hold l7");
        await held("l7", id); fx.adopt(record(id).herdr);
        await fx.cli(["agent", "prompt", leadName, "/reload"], 15000);
        const owner = join(runs, id, "owner");
        await until("reload owner handoff", 30000, () => existsSync(join(owner, "000000.json.released")) && existsSync(join(owner, "000001.json")));
        release("l7");
        const r = await status(id, "completed", "failed");
        assert.equal(r.status, "completed", r.errorMessage);
        assert.equal(r.herdr.ownerGeneration, 1);
        await until("post-reload notification", 20000, () => notifications(id) >= 1);
        assert.equal(notifications(id), 1, "old-module callbacks stayed inert");
      });

      await t.test("lead crash then a fresh lead reattaches and settles once", async () => {
        const id = await spawnChild("H11-CHILD hold c8");
        await held("c8", id); fx.adopt(record(id).herdr);
        const info = (await fx.cli(["pane", "process-info", "--pane", leadPane])).result.process_info;
        const leadProc = info.foreground_processes.find((p: { name: string }) => p.name === "pi");
        const ownerClaim = JSON.parse(readFileSync(join(runs, id, "owner", `${String(record(id).herdr.ownerGeneration).padStart(6, "0")}.json`), "utf8"));
        assert.equal(leadProc.pid, ownerClaim.pid, "the crash target is the proven owning lead");
        assert.equal(procStartTime(leadProc.pid), ownerClaim.startTime);
        process.kill(leadProc.pid, "SIGKILL");
        await until("lead exit", 15000, () => procStartTime(leadProc.pid) !== ownerClaim.startTime);
        await until("lead pane shell", 15000, async () => !(await fx.cli(["pane", "get", leadPane])).result.pane.agent);
        leadName = "lead2";
        lead = await startLead(leadName);
        const next = join(runs, id, "owner", `${String(ownerClaim.generation + 1).padStart(6, "0")}.json`);
        await until("takeover claim", 30000, () => existsSync(next) && JSON.parse(readFileSync(next, "utf8")).pid !== ownerClaim.pid);
        release("c8");
        const r = await status(id, "completed", "failed");
        assert.equal(r.status, "completed", r.errorMessage);
        await until("single post-crash notification", 20000, () => notifications(id) === 1);
      });

      const effortTip = () => git("rev-parse", "refs/heads/conductor-int/h11");
      const hookLog = () => existsSync(join(work, ".git", "h11-hook.log")) ? readFileSync(join(work, ".git", "h11-hook.log"), "utf8").trim().split("\n") : [];
      const spawnWriter = async (task: string, token: string) => {
        const r = await leadTool("ensemble_spawn", { persona: "builder", task, runtime: "herdr", effort: "h11", touches: ["src/**"], on_complete_hook: `test -f src/${token}.txt`, foreground: false });
        assert.equal(r.isError, false, JSON.stringify(r.result));
        return r.result.details.agent_id as string;
      };
      const integrated = async (id: string, token: string, previousTip: string) => {
        const r = await status(id, "completed", "failed", "merge_conflict", "hook_failed", "killed", "blocked");
        assert.equal(r.status, "completed", JSON.stringify({ error: r.errorMessage, integration: r.integration, merge: r.mergeResult }));
        fx.adopt(r.herdr);
        const tip = effortTip();
        assert.notEqual(tip, previousTip, "CAS advanced the integration ref");
        assert.equal(git("show", `${tip}:src/${token}.txt`), `from ${token}`);
        const raw = (spec: string) => execFileSync("git", ["show", spec], { cwd: work, env: fx.env, encoding: "utf8", timeout: 20000 });
        const sources = git("ls-tree", "--name-only", `${tip}:src`).split("\n");
        assert.ok(sources.includes(`${token}.txt`));
        assert.equal(raw(`${tip}:gen/all.txt`), sources.map(f => raw(`${tip}:src/${f}`)).join(""), "generated artifact rebuilt from the integrated sources, not the writer's stale copy");
        assert.equal(git("merge-base", "--is-ancestor", previousTip, tip), "");
        assert.equal(git("rev-parse", "HEAD"), base, "main checkout untouched"); assert.equal(git("rev-parse", "--abbrev-ref", "HEAD"), "main");
        assert.equal(git("status", "--porcelain"), "", "main checkout clean");
        t.diagnostic(`H11 effort ${id} ${previousTip.slice(0, 8)} -> ${tip.slice(0, 8)} integration=${JSON.stringify(r.integration)?.slice(0, 600)}`);
        return { r, tip };
      };

      await t.test("effort writer: persona hook -> generated artifact -> verify -> CAS on real herdr", async () => {
        const hooksBefore = hookLog().length;
        const id = await spawnWriter("H11-CHILD write e9", "e9");
        const { r } = await integrated(id, "e9", base);
        assert.equal(r.runtime, "herdr"); assert.ok(r.effort, "an effort writer");
        assert.ok(hookLog().length >= hooksBefore + 2, "repository hook ran for the writer commit and the candidate commit");
        assert.equal(git("show", `${r.integration.branchHead}:gen/all.txt`), "stale e9", "the writer's own artifact was stale");
        assert.ok(r.integration.generation?.passed, `generation evidence: ${JSON.stringify(r.integration.generation)}`);
        assert.match(readFileSync(r.integration.verify.logPath, "utf8"), /^verified [0-9a-f]{40} candidate=/m);
        await until("single effort notification", 20000, () => notifications(id) === 1);
      });

      await t.test("effort writer survives a lead crash; the fresh lead recovers and integrates once", async () => {
        const before = effortTip();
        const id = await spawnWriter("H11-CHILD holdwrite e10", "e10");
        await held("e10", id); fx.adopt(record(id).herdr);
        const info = (await fx.cli(["pane", "process-info", "--pane", leadPane])).result.process_info;
        const leadProc = info.foreground_processes.find((p: { name: string }) => p.name === "pi");
        const start = procStartTime(leadProc.pid), deadGeneration = record(id).herdr.ownerGeneration;
        const oldSession = lead.sessionFile;
        assert.equal(JSON.parse(readFileSync(join(runs, id, "owner", `${String(deadGeneration).padStart(6, "0")}.json`), "utf8")).pid, leadProc.pid, "the crash target is the proven stream owner");
        process.kill(leadProc.pid, "SIGKILL");
        await until("lead exit", 15000, () => procStartTime(leadProc.pid) !== start);
        await until("lead pane shell", 15000, async () => !(await fx.cli(["pane", "get", leadPane])).result.pane.agent);
        leadName = "lead3"; lead = await startLead(leadName);
        // Stream recovery and effort recovery may each claim; the newest generation must belong to the fresh lead.
        const newest = () => readdirSync(join(runs, id, "owner")).filter(f => /^\d{6}\.json$/.test(f)).sort().at(-1)!;
        await until("herdr stream takeover by the fresh lead", 30000, () => Number(newest().slice(0, 6)) > deadGeneration && JSON.parse(readFileSync(join(runs, id, "owner", newest()), "utf8")).pid === lead.pid);
        t.diagnostic(`H11 effort crash owner generations ${readdirSync(join(runs, id, "owner")).sort().join(",")}`);
        release("e10");
        await integrated(id, "e10", before);
        await until("single post-crash effort notification", 20000, () => notifications(id) === 1);
        assert.equal(jsonLines(oldSession).filter(e => e.type === "custom_message" && JSON.stringify(e).includes(id)).length, 0, "the crashed lead published nothing for it");
      });

      await t.test("restarts keep terminal statuses and scrollback panes", async () => {
        // Two crashes and one /reload have happened; a requested kill must stay killed.
        assert.equal(record(k4).status, "killed", record(k4).errorMessage);
        for (const id of readdirSync(runs)) {
          const r = record(id);
          if (r.runtime !== "herdr" || !r.herdr) continue;
          const pane = await fx.cli(["pane", "get", r.herdr.paneId]).catch(e => ({ error: String(e) }));
          assert.ok("result" in pane, `${id} (${r.status}) pane ${r.herdr.paneId} still present: ${JSON.stringify(pane)}`);
        }
      });

      await t.test("a lead/child host Pi version mismatch is detected, persisted and shown", { skip: alt ? false : "needs a second explicit Pi root in CONDUCTOR_H11_PI_ROOTS" }, async () => {
        const altVersion = JSON.parse(readFileSync(join(alt!, "package.json"), "utf8")).version;
        await fx.cli(["agent", "send-keys", leadName, "ctrl+c"]); await fx.cli(["agent", "send-keys", leadName, "ctrl+c"]);
        await until("lead quit", 20000, async () => !(await fx.cli(["pane", "get", leadPane])).result.pane.agent);
        writePiWrapper(join(root, "altbin"), alt!);
        leadPane = await fx.createWorkspace(work, "h11-mismatch", { PATH: `${join(root, "altbin")}:${fx.env.PATH}` });
        leadName = "leadm"; lead = await startLead(leadName);
        assert.equal(lead.version, altVersion, "the lead runs the other Pi version");
        const id = await spawnChild("H11-CHILD basic m11");
        const r = await status(id, "completed", "failed");
        assert.equal(r.status, "completed", r.errorMessage); fx.adopt(r.herdr);
        assert.equal(hello(id).piVersion, version, "the child runs the matrix version");
        assert.equal(r.herdr.versionWarning, `Pi version mismatch: lead ${altVersion}, child ${version}`);
        await until("mismatch notification", 20000, () => notifications(id) === 1);
        assert.ok(jsonLines(lead.sessionFile).some(e => e.type === "custom_message" && JSON.stringify(e).includes(`reason=\\"pi-version\\">Pi version mismatch: lead ${altVersion}, child ${version}`)), "shown on the completion envelope");
      });
    } finally {
      const diag = process.env.CONDUCTOR_H11_DIAG;
      if (diag) {
        // Opt-in evidence copy for diagnosis; the fixture root itself is removed on clean teardown.
        const out = join(diag, `pi-${version}`); mkdirSync(out, { recursive: true });
        for (const id of existsSync(runs) ? readdirSync(runs) : []) {
          const dir = join(runs, id);
          for (const f of ["record.json", "transcript.jsonl", "final.md", "session", "inbox", "owner"]) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(out, `${id}-${f}`), { recursive: true });
          try { const b = JSON.parse(readFileSync(join(dir, "record.json"), "utf8")).herdr; if (b?.paneId && b.socketPath === fx.id.socketPath) writeFileSync(join(out, `${id}-pane.txt`), JSON.stringify(await fx.cli(["pane", "get", b.paneId])) + "\n" + (await fx.cli(["pane", "read", b.paneId, "--source", "recent-unwrapped", "--lines", "120"])).text); } catch (e) { writeFileSync(join(out, `${id}-pane.txt`), String(e)); }
        }
        cpSync(join(root, "obs"), join(out, "obs"), { recursive: true });
        try { writeFileSync(join(out, "lead-pane.txt"), (await fx.cli(["pane", "read", [...fx.panes][0], "--source", "recent-unwrapped", "--lines", "200"])).text); } catch (e) { writeFileSync(join(out, "lead-pane.txt"), String(e)); }
        if (existsSync(join(root, "lead-sessions"))) cpSync(join(root, "lead-sessions"), join(out, "lead-sessions"), { recursive: true });
      }
      for (const f of existsSync(join(root, "script")) ? ["s2", "k4", "l7", "c8", "e10"] : []) writeFileSync(join(root, "script", `release-${f}`), "teardown");
      if (existsSync(join(root, "script"))) writeFileSync(join(root, "script", "release-s2-2"), "teardown");
      report = await fx.teardown();
      t.diagnostic(`H11 teardown ${JSON.stringify({ clean: report.clean, server: report.server, captured: report.captured.length, leftovers: report.leftovers, notes: report.notes, preserved: report.preserved })}`);
      t.diagnostic(`H11 captured ${JSON.stringify(report.captured.map(p => `${p.pid}:${p.startTime}:${p.argv.slice(0, 60)}`))}`);
    }
    assert.equal(report.clean, true, `teardown preserved evidence at ${report.preserved}: ${report.notes.join("; ")}`);
    assert.equal(ambientSnapshot(parent), ambient, "ambient herdr processes and real session registry unchanged");
  });
}
