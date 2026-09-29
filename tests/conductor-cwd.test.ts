/**
 * Conductor default cwd: path resolution, the shared override controller,
 * and its wiring through the extension (ensemble_cwd tool, `/conductor
 * cwd`, appendEntry persistence, session_start restore, ensemble panel).
 *
 * The wiring tests load the real extension against a stub pi. HOME is
 * sandboxed with a user config that disables GC, so session_start's
 * background work touches only the temp dir.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import conductor from "../src/index.ts";
import {
  CWD_ENTRY_TYPE,
  createCwdController,
  formatCwdInfo,
  latestCwdOverride,
  resolveCwdArg,
} from "../src/conductor-cwd.ts";
import { CONDUCTOR_LLM_TOOLS, CONDUCTOR_LLM_TOOL_NAMES } from "../src/types.ts";
import { buildPiArgs } from "../src/runs.ts";

function withTmp<T>(fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "conductor-cwd-"));
  const realHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  mkdirSync(join(root, "home"), { recursive: true });
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => {
      if (realHome === undefined) delete process.env.HOME;
      else process.env.HOME = realHome;
      rmSync(root, { recursive: true, force: true });
    });
}

// ── resolveCwdArg ────────────────────────────────────────────────────

test("resolveCwdArg: relative paths resolve against the base; ~ and ~/x against HOME", () =>
  withTmp((root) => {
    mkdirSync(join(root, "base", "sub"), { recursive: true });
    mkdirSync(join(root, "home", "proj"), { recursive: true });
    assert.deepEqual(resolveCwdArg("sub", join(root, "base")), { ok: true, cwd: join(root, "base", "sub") });
    assert.deepEqual(resolveCwdArg("..", join(root, "base", "sub")), { ok: true, cwd: join(root, "base") });
    assert.deepEqual(resolveCwdArg("~", "/"), { ok: true, cwd: join(root, "home") });
    assert.deepEqual(resolveCwdArg("~/proj", "/"), { ok: true, cwd: join(root, "home", "proj") });
    assert.deepEqual(resolveCwdArg(join(root, "base"), "/elsewhere"), { ok: true, cwd: join(root, "base") });
  }));

test("resolveCwdArg: rejects a missing path, a file, and an empty string", () =>
  withTmp((root) => {
    writeFileSync(join(root, "file.txt"), "x");
    const missing = resolveCwdArg("nope", root);
    assert.equal(missing.ok, false);
    assert.match(!missing.ok ? missing.error : "", /does not exist/);
    const file = resolveCwdArg("file.txt", root);
    assert.equal(file.ok, false);
    assert.match(!file.ok ? file.error : "", /not a directory/);
    assert.equal(resolveCwdArg("  ", root).ok, false);
  }));

// ── Controller ───────────────────────────────────────────────────────

test("controller: set, reset, and persistence through the injected persist", () =>
  withTmp((root) => {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const persisted: Array<{ cwd: string | null }> = [];
    let changes = 0;
    const ctl = createCwdController({ sessionCwd: a, persist: (d) => persisted.push(d), onChange: () => changes++ });

    assert.deepEqual(ctl.info(), { cwd: a, source: "session start" });
    assert.equal(ctl.override(), undefined);

    const set = ctl.change({ path: "../b" });
    assert.deepEqual(set, { ok: true, info: { cwd: b, source: "override" } });
    assert.equal(ctl.get(), b);
    assert.deepEqual(persisted, [{ cwd: b }]);

    ctl.setSessionCwd(a);
    assert.equal(ctl.get(), b, "a session cwd reassignment must not clobber the override");

    const bad = ctl.change({ path: "missing" });
    assert.equal(bad.ok, false);
    assert.equal(ctl.get(), b, "a rejected path leaves the override in place");

    assert.equal(ctl.change({ path: b, reset: true }).ok, false, "path and reset together are rejected");
    assert.deepEqual(ctl.change({}), { ok: true, info: { cwd: b, source: "override" } });
    assert.equal(persisted.length, 1, "a read does not persist");

    assert.deepEqual(ctl.change({ reset: true }), { ok: true, info: { cwd: a, source: "session start" } });
    assert.deepEqual(persisted, [{ cwd: b }, { cwd: null }]);
    assert.equal(changes, 2);
  }));

test("controller: restore takes the latest conductor-cwd entry and drops a vanished directory", () =>
  withTmp((root) => {
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const entry = (cwd: string | null) => ({ type: "custom", customType: CWD_ENTRY_TYPE, data: { cwd } });
    const other = { type: "custom", customType: "something-else", data: { cwd: "/nope" } };

    assert.equal(latestCwdOverride([entry(a), other, entry(b)]), b);
    assert.equal(latestCwdOverride([entry(b), entry(null)]), undefined);
    assert.equal(latestCwdOverride([other, { type: "message" }]), undefined);

    const ctl = createCwdController({ sessionCwd: a, persist: () => {} });
    assert.equal(ctl.restore([entry(b)]), undefined);
    assert.deepEqual(ctl.info(), { cwd: b, source: "override" });
    ctl.restore([entry(b), entry(null)]);
    assert.deepEqual(ctl.info(), { cwd: a, source: "session start" });

    const warning = ctl.restore([entry(join(root, "gone"))]);
    assert.match(warning ?? "", /gone/);
    assert.equal(ctl.override(), undefined);
  }));

test("formatCwdInfo names the source", () => {
  assert.equal(formatCwdInfo({ cwd: "/x", source: "override" }), "cwd: /x (override)");
  assert.equal(formatCwdInfo({ cwd: "/y", source: "session start" }), "cwd: /y (session start)");
});

// ── Always-excluded tool list ────────────────────────────────────────

test("ensemble_cwd is in the always-excluded child tool list", () => {
  assert.equal(CONDUCTOR_LLM_TOOLS.cwd, "ensemble_cwd");
  assert.ok(CONDUCTOR_LLM_TOOL_NAMES.includes("ensemble_cwd"));
  const args = buildPiArgs({ kind: "resume", sessionPath: "/s.jsonl", prompt: "p", steerable: false });
  assert.ok(args[args.indexOf("--exclude-tools") + 1]!.split(",").includes("ensemble_cwd"));
});

// ── Extension wiring via a stub pi ───────────────────────────────────

interface Entry {
  type: string;
  customType?: string;
  data?: unknown;
}

function stubPi(entries: Entry[]) {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<any> }>();
  let command: { handler: (args: string, ctx: unknown) => Promise<void> } | undefined;
  const pi = {
    on: (ev: string, h: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(ev, [...(handlers.get(ev) ?? []), h]);
    },
    registerFlag() {}, getFlag() {},
    registerTool: (t: { name: string; execute: any }) => void tools.set(t.name, t),
    registerCommand: (_name: string, c: any) => {
      command = c;
    },
    registerMessageRenderer: () => {},
    registerShortcut: () => {},
    sendMessage: () => {},
    appendEntry: (customType: string, data: unknown) => void entries.push({ type: "custom", customType, data }),
  };
  conductor(pi as any);
  const fire = async (ev: string, event: unknown, ctx: unknown) => {
    for (const h of handlers.get(ev) ?? []) await h(event, ctx);
  };
  return { tools, command: () => command!, fire };
}

function stubCtx(cwd: string, entries: Entry[]) {
  const notes: string[] = [];
  const widgets: Array<string[] | undefined> = [];
  const theme = { fg: (_slot: string, s: string) => s, bold: (s: string) => s };
  const ctx = {
    cwd,
    hasUI: false,
    ui: {
      notify: (m: string) => void notes.push(m),
      setWidget: (_key: string, factory: any) =>
        void widgets.push(factory ? factory({}, theme).render(400).map((l: string) => l.trimEnd()) : undefined),
      onTerminalInput: () => () => {},
      theme,
    },
    sessionManager: {
      getBranch: () => entries,
      getEntries: () => entries,
      getLeafId: () => null,
      getSessionId: () => "sess-cwd",
    },
  };
  return { ctx, notes, widgets };
}

function sandboxConfig(root: string): void {
  const dir = join(root, "home", ".pi", "agent", "extensions", "conductor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ gc: { enabled: false } }),
  );
}

test("extension: ensemble_cwd and /conductor cwd share one override that persists, survives session_start, and restores", () =>
  withTmp(async (root) => {
    sandboxConfig(root);
    const a = join(root, "a");
    const b = join(root, "b");
    mkdirSync(a);
    mkdirSync(b);
    const prevSub = process.env.CONDUCTOR_SUBAGENT;
    delete process.env.CONDUCTOR_SUBAGENT;
    const entries: Entry[] = [];
    const first = stubPi(entries);
    const { ctx, notes, widgets } = stubCtx(a, entries);
    const instances = [first];
    try {
      await first.fire("session_start", {}, ctx);
      const cwdTool = first.tools.get("ensemble_cwd")!;
      assert.ok(cwdTool, "ensemble_cwd is registered");
      assert.deepEqual((await cwdTool.execute("t0", {})).details, { cwd: a, source: "session start" });

      const set = await cwdTool.execute("t1", { path: "../b" });
      assert.deepEqual(set.details, { cwd: b, source: "override" });
      assert.equal(set.content[0].text, `cwd: ${b} (override)`);
      assert.deepEqual(entries.at(-1), { type: "custom", customType: CWD_ENTRY_TYPE, data: { cwd: b } });
      assert.ok(widgets.at(-1)?.includes(`cwd: ${b}`), `panel shows the override; got ${JSON.stringify(widgets.at(-1))}`);

      // ctx.cwd reassignments on turn_start / session_start keep the override.
      // Check right after turn_start: the next session_start restores the
      // override from the entries, which would hide a turn_start clobber.
      await first.fire("turn_start", {}, ctx);
      assert.deepEqual((await cwdTool.execute("t2a", {})).details, { cwd: b, source: "override" }, "after turn_start");
      // (session_start re-arms timers, so pair it with a shutdown as pi does.)
      await first.fire("session_shutdown", { reason: "reload" }, ctx);
      await first.fire("session_start", {}, ctx);
      assert.deepEqual((await cwdTool.execute("t2", {})).details, { cwd: b, source: "override" }, "after session_start");
      await first.command().handler("cwd", ctx);
      assert.equal(notes.at(-1), `cwd: ${b} (override)`);

      // /reload: a fresh extension instance restores from the session entries.
      const second = stubPi(entries);
      instances.push(second);
      await second.fire("session_start", {}, ctx);
      assert.deepEqual((await second.tools.get("ensemble_cwd")!.execute("t3", {})).details, {
        cwd: b,
        source: "override",
      });

      await second.command().handler("cwd --reset", ctx);
      assert.equal(notes.at(-1), `cwd: ${a} (session start)`);
      assert.deepEqual(entries.at(-1), { type: "custom", customType: CWD_ENTRY_TYPE, data: { cwd: null } });
      assert.equal(widgets.at(-1), undefined, "panel clears once the override is gone and no runs are active");

      await second.command().handler("cwd missing-dir", ctx);
      assert.match(notes.at(-1) ?? "", /does not exist/);

      const third = stubPi(entries);
      instances.push(third);
      await third.fire("session_start", {}, ctx);
      assert.deepEqual((await third.tools.get("ensemble_cwd")!.execute("t4", {})).details, {
        cwd: a,
        source: "session start",
      });
    } finally {
      for (const i of instances) await i.fire("session_shutdown", { reason: "reload" }, ctx);
      // Let session_start's setImmediate reconcile / GC passes settle before the sandbox goes.
      await new Promise((r) => setTimeout(r, 20));
      if (prevSub === undefined) delete process.env.CONDUCTOR_SUBAGENT;
      else process.env.CONDUCTOR_SUBAGENT = prevSub;
    }
  }));

test("/conductor cwd keeps repeated whitespace inside a path", () =>
  withTmp(async (root) => {
    sandboxConfig(root);
    const spaced = join(root, "two  spaces");
    mkdirSync(spaced);
    mkdirSync(join(root, "two spaces")); // what the collapsed argument would name
    const prevSub = process.env.CONDUCTOR_SUBAGENT;
    delete process.env.CONDUCTOR_SUBAGENT;
    const entries: Entry[] = [];
    const pi = stubPi(entries);
    const { ctx, notes } = stubCtx(root, entries);
    try {
      await pi.fire("session_start", {}, ctx);
      await pi.command().handler("cwd  two  spaces", ctx);
      assert.equal(notes.at(-1), `cwd: ${spaced} (override)`);
    } finally {
      await pi.fire("session_shutdown", { reason: "reload" }, ctx);
      await new Promise((r) => setTimeout(r, 20));
      if (prevSub === undefined) delete process.env.CONDUCTOR_SUBAGENT;
      else process.env.CONDUCTOR_SUBAGENT = prevSub;
    }
  }));
