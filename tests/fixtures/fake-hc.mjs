#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs";
import {basename, isAbsolute} from "node:path";
const statePath = process.env.FAKE_HC_STATE;
if (!statePath) process.exit(90);
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (process.env.HC_SOCKET !== state.socket) process.exit(90);
const args = process.argv.slice(2);
state.calls.push({args, socket: process.env.HC_SOCKET,
  routingNames: Object.keys(process.env).filter(k => k.startsWith("HC_") || k.startsWith("HERDR_")).sort()});
state.terminals ??= {};
state.next ??= 1;
const save = () => writeFileSync(statePath, JSON.stringify(state));
save();
const print = value => console.log(JSON.stringify(value));
const fail = (exit, kind, message, hint) => {
  console.error(JSON.stringify({error: {hint, kind, message}}));
  process.exit(exit);
};
const notFound = target => fail(3, "not_found", `no terminal "${target}"`, "see `hc ls --all`");
const find = target => state.terminals[target] ??
  Object.values(state.terminals).find(t => t.name === target && t.state === "live") ??
  Object.values(state.terminals).find(t => t.name === target);
const view = t => {
  const record = {...t};
  if (record.state !== "live") delete record.foreground;
  return record;
};
const target = () => args.find((a, i) => i > 0 && !a.startsWith("--") && args[i - 1] !== "--lines");

if (state.fault === "hang") setInterval(() => {}, 1000);
else if (state.fault === "garbage") console.log("not json " + process.env.SENTINEL_SECRET);
else if (state.fault === "overflow") process.stdout.write("x".repeat(200000));
else if (state.fault === "stderr-overflow") process.stderr.write("x".repeat(200000));
else if (state.fault === "plain-nonzero") { console.error(args.join(" ") + process.env.SENTINEL_SECRET); process.exit(7); }
else if (state.fault === "envelope") {
  (state.stream === "stdout" ? console.log : console.error)(JSON.stringify(state.envelope));
  process.exit(state.exit ?? 1);
} else if (state.fault === "response") process.stdout.write(typeof state.response === "string" ? state.response : JSON.stringify(state.response) + "\n");
else if (args[0] === "server" && args[1] === "status") {
  const live = Object.values(state.terminals).filter(t => t.state === "live").length;
  print({core: {id: state.coreId ?? "fakecore0000000000000000000000000", name: "fake-host"}, finished: Object.keys(state.terminals).length - live,
    holder: null, holders: [], installed_by: null, live, pid: process.pid, uptime_ms: 1, version: state.version ?? "0.1.19"});
} else if (args[0] === "run") {
  const sep = args.indexOf("--");
  const flags = args.slice(1, sep), argv = args.slice(sep + 1);
  const value = name => { const i = flags.indexOf(name); return i < 0 ? undefined : flags[i + 1]; };
  const labels = Object.fromEntries(flags.flatMap((f, i) => f === "--label" ? [flags[i + 1].split(/=(.*)/s).slice(0, 2)] : []));
  const name = value("--name"), cwd = value("--cwd") ?? process.cwd(), parent = value("--parent");
  if (Object.values(state.terminals).some(t => t.name === name && t.state === "live")) {
    fail(1, "name_taken", `a live terminal is already named "${name}"`, "pick another name, or kill the one holding it");
  }
  if (parent !== undefined && !find(parent)) notFound(parent);
  if (!isAbsolute(cwd) || argv[0].startsWith("/nonexistent")) {
    fail(1, "spawn_failed", `cannot start "${argv[0]}": No such file or directory (os error 2)`, "check the program name and cwd");
  }
  const address = `t${state.next++}`;
  const pid = state.pids?.[name] ?? 40000 + state.next;
  state.terminals[address] = {address, argv, cols: 200, created_ms: Date.now(), cwd, die_with_parent: parent !== undefined && !flags.includes("--outlive-parent"),
    exit_code: null, finished_ms: null, foreground: {argv, cwd, name: basename(argv[0]), pid}, identity: "ghostty", keep: false, labels,
    name, notify: !flags.includes("--no-notify"), parent: parent === undefined ? null : find(parent).address, pid, reason: null,
    reported: false, rm: false, rows: 120, screen: "exact", signal: null, state: "live", status: null, status_ms: null,
    template: null, title: "", turn: 0};
  save();
  print({address, agent: basename(argv[0]), cwd, name, ...(parent === undefined ? {} : {parent: find(parent).address}), state: "live", turn: 0});
} else if (args[0] === "get") {
  const t = find(target()) ?? notFound(target());
  print(view(t));
} else if (args[0] === "read") {
  const t = find(target()) ?? notFound(target());
  process.stdout.write(state.screens?.[t.address] ?? "\n");
} else if (args[0] === "kill") {
  const t = find(target()) ?? notFound(target());
  if (t.state === "live") Object.assign(t, {state: "finished", reason: "killed", signal: 1, finished_ms: Date.now()});
  save(); print(view(t));
} else if (args[0] === "rm") {
  const t = find(target()) ?? notFound(target());
  if (t.state === "live") fail(1, "live", `${t.address} is still running`, `kill it first: hc kill ${t.address}`);
  delete state.terminals[t.address];
  save(); print({removed: t.address});
} else fail(2, "usage", `unrecognized subcommand '${args[0]}'`, "see `hc --help`");
