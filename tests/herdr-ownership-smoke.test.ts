import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { tmpDir, sandboxPi } from "./helpers/tmp.ts";
import { readProcessStartTime } from "../src/reconcile-startup.ts";
import { readHerdrOwner } from "../src/herdr/ownership.ts";
sandboxPi();

test("H10 real dead owner, two simultaneous claimants: one generation winner, no live-owner theft", { timeout: 20000 }, async t => {
  const dir = tmpDir("h10-claim-race-");
  const source = `import { claimHerdrOwner } from ${JSON.stringify(new URL("../src/herdr/ownership.ts", import.meta.url).href)};
    import { readProcessStartTime } from ${JSON.stringify(new URL("../src/reconcile-startup.ts", import.meta.url).href)};
    process.on("message", msg => {
      if (msg === "claim") {
        try { const owner = claimHerdrOwner(process.argv[1], { epoch: String(process.pid), sessionId: "fixture", pid: process.pid, startTime: readProcessStartTime(process.pid), socketPath: "/fake/socket", runId: "run", launchNonce: "nonce", at: Date.now() }); process.send({ won: true, generation: owner.identity.generation }); }
        catch (error) { process.send({ won: false, error: error.message }); }
      } else process.exit(0);
    }); process.send("ready");`;
  const children: { proc: ReturnType<typeof spawn>; exited: boolean; start?: number; exit: Promise<unknown> }[] = [];
  const start = async () => {
    const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source, dir], { env: { HOME: dir, TMPDIR: dir, PATH: process.env.PATH }, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    const c = { proc, exited: false, start: readProcessStartTime(proc.pid!), exit: Promise.resolve() as Promise<unknown> };
    c.exit = once(proc, "exit").then(() => { c.exited = true; }); children.push(c);
    assert.equal((await once(proc, "message"))[0], "ready"); return c;
  };
  t.after(async () => {
    for (const c of children) if (!c.exited && c.proc.signalCode === null && readProcessStartTime(c.proc.pid!) === c.start) c.proc.kill("SIGKILL");
    await Promise.all(children.map(c => c.exit));
  });
  const old = await start(); const oldMessage = once(old.proc, "message"); old.proc.send!("claim"); assert.equal((await oldMessage)[0].generation, 0);
  old.proc.send!("exit"); await old.exit;
  const contenders = await Promise.all([start(), start()]);
  const outcomes = contenders.map(c => once(c.proc, "message")); for (const c of contenders) c.proc.send!("claim");
  const results = (await Promise.all(outcomes)).map(([message]) => message);
  assert.equal(results.filter(r => r.won).length, 1); assert.equal(results.find(r => r.won).generation, 1);
  assert.equal(readHerdrOwner(dir)?.generation, 1);
  assert.match(results.find(r => !r.won).error, /takeover refused|claim changed|EEXIST|claim/);
});
