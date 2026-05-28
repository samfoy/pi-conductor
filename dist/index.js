// src/index.ts
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey as matchesKey2 } from "@earendil-works/pi-tui";

// src/commands.ts
import { existsSync as existsSync8, readdirSync as readdirSync2, readFileSync as readFileSync3, statSync as statSync3 } from "node:fs";
import { join as join11 } from "node:path";

// src/status-glyph.ts
var STATUS_GLYPH = {
  queued: "\u25CC",
  running: "\u25CF",
  paused: "\u23F8",
  completed: "\u2713",
  failed: "\u2717",
  killed: "\u25A0",
  timeout: "\u23F1",
  hook_failed: "\u2297"
};

// src/personas.ts
import { readdir, readFile, stat } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/types.ts
var THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
];
var CONTEXT_INHERITANCE = [
  "none",
  "filtered",
  "filtered_compact",
  "full"
];
var DEFAULT_CONFIG = {
  defaultTimeoutMinutes: 60,
  maxConcurrent: 4,
  maxConcurrentWriteCapable: 1,
  queueOnConcurrencyCap: true,
  autoOpenFocusOnSpawn: false,
  defaultSpawnMode: "foreground",
  defaultMode: "off",
  personaOverrides: {},
  conductorPromptPath: null,
  gc: {
    enabled: true,
    completedTtlDays: 30,
    failedTtlDays: 60,
    totalSizeBudgetBytes: 5 * 1024 * 1024 * 1024,
    transcriptSizeCapBytes: 100 * 1024 * 1024,
    orphanReconcileAfterHours: 24,
    autoOnSessionStart: true,
    autoDebounceHours: 6,
    perPersonaTtlDays: {}
  },
  watchdog: {
    enabled: true,
    defaultSoftSeconds: 120,
    defaultHardSeconds: 600,
    graceSeconds: 30,
    tickIntervalSeconds: 30,
    defaultKillOnStall: false
  },
  // v0.12 steering: built-in default OFF — mirrors v0.10 kill_on_stall
  // posture (PRD.md:517). No autonomous-chain field data justifies
  // flipping it. Slice 1 ships the field; slice 4 wires per-call.
  defaultSteerable: false
};
function emptyUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}
function toRunRecord(r) {
  return {
    id: r.id,
    persona: r.persona,
    task: r.task,
    model: r.model,
    thinking: r.thinking,
    mode: r.mode,
    status: r.status,
    startTime: r.startTime,
    pid: r.pid,
    parentPid: r.parentPid,
    parentStartTime: r.parentStartTime,
    finishedAt: r.finishedAt,
    pausedAt: r.pausedAt,
    exitCode: r.exitCode,
    stopReason: r.stopReason,
    errorMessage: r.errorMessage,
    usage: r.usage,
    cwd: r.cwd,
    recordPath: r.recordPath,
    transcriptPath: r.transcriptPath,
    finalPath: r.finalPath,
    sessionPath: r.sessionPath,
    systemPrompt: r.systemPrompt,
    steerable: r.steerable,
    streamingMode: r.streamingMode,
    hookResult: r.hookResult,
    thisInvocationStartedAt: r.thisInvocationStartedAt,
    thisInvocationUsageBaseline: r.thisInvocationUsageBaseline,
    resumeCount: r.resumeCount
  };
}
var TERMINAL_STATUSES = [
  "completed",
  "failed",
  "killed",
  "timeout",
  "hook_failed"
];
function isTerminal(s) {
  return TERMINAL_STATUSES.includes(s);
}

// src/personas.ts
var WRITE_CAPABLE_PERSONAS = /* @__PURE__ */ new Set([
  "builder",
  "simplifier"
]);
function resolveBuiltinPersonasDir(metaUrl) {
  const here = realpathSync(fileURLToPath(metaUrl));
  return resolve(dirname(here), "..", "personas");
}
function builtinPersonasDir() {
  return resolveBuiltinPersonasDir(import.meta.url);
}
function userPersonasDir() {
  return join(homedir(), ".pi", "agent", "conductor", "personas");
}
function projectPersonasDir(cwd) {
  return join(cwd, ".pi", "conductor", "personas");
}
var FRONTMATTER_FENCE = "---";
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== FRONTMATTER_FENCE) {
    return { frontmatter: {}, body: text };
  }
  let endIdx = -1;
  for (let i2 = 1; i2 < lines.length; i2++) {
    if (lines[i2]?.trim() === FRONTMATTER_FENCE) {
      endIdx = i2;
      break;
    }
  }
  if (endIdx === -1) {
    throw new Error("frontmatter opened with `---` but never closed");
  }
  const fmLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join("\n");
  const frontmatter = {};
  let i = 0;
  while (i < fmLines.length) {
    const raw = fmLines[i] ?? "";
    const line = raw.trim();
    i++;
    if (!line || line.startsWith("#")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) {
      throw new Error(`frontmatter line missing colon: "${line}"`);
    }
    const key = line.slice(0, colon).trim();
    const valuePart = line.slice(colon + 1).trim();
    if (valuePart === "") {
      const items = [];
      while (i < fmLines.length) {
        const next = fmLines[i] ?? "";
        const trimmed = next.trim();
        if (trimmed.startsWith("- ")) {
          items.push(unquote(trimmed.slice(2).trim()));
          i++;
        } else if (trimmed === "" || trimmed.startsWith("#")) {
          i++;
        } else {
          break;
        }
      }
      frontmatter[key] = items;
    } else {
      frontmatter[key] = parseScalar(valuePart);
    }
  }
  return { frontmatter, body };
}
function unquote(s) {
  if (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}
function parseScalar(s) {
  const u = unquote(s);
  if (u === "true") return true;
  if (u === "false") return false;
  if (/^-?\d+$/.test(u)) return Number.parseInt(u, 10);
  if (/^-?\d+\.\d+$/.test(u)) return Number.parseFloat(u);
  return u;
}
function validateAndBuild(raw, source, sourcePath) {
  const { frontmatter, body } = raw;
  const name = requireString(frontmatter, "name");
  const description = requireString(frontmatter, "description");
  const model = optionalString(frontmatter, "model");
  const thinking = optionalEnum(frontmatter, "thinking", THINKING_LEVELS);
  const inheritContext = optionalEnum(frontmatter, "inherit_context", CONTEXT_INHERITANCE) ?? "filtered";
  const inheritSkills = optionalBoolean(frontmatter, "inherit_skills") ?? false;
  const defaultReads = optionalStringList(frontmatter, "default_reads") ?? [];
  const worktree = optionalBoolean(frontmatter, "worktree") ?? false;
  const timeoutMinutes = optionalNumber(frontmatter, "timeout_minutes") ?? 60;
  const readOnly = optionalBoolean(frontmatter, "read_only") ?? false;
  if (timeoutMinutes <= 0 || timeoutMinutes > 24 * 60) {
    throw new Error(`timeout_minutes must be in (0, 1440]; got ${timeoutMinutes}`);
  }
  const systemPrompt = body.trim();
  if (!systemPrompt) {
    throw new Error("system prompt body is empty");
  }
  return {
    name,
    description,
    model,
    thinking,
    inheritContext,
    inheritSkills,
    defaultReads,
    worktree,
    timeoutMinutes,
    systemPrompt,
    source,
    sourcePath,
    readOnly
  };
}
function requireString(fm, key) {
  const v = fm[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`required field "${key}" is missing or empty`);
  }
  return v.trim();
}
function optionalString(fm, key) {
  const v = fm[key];
  if (v === void 0) return void 0;
  if (typeof v !== "string") {
    throw new Error(`field "${key}" must be a string; got ${typeof v}`);
  }
  return v.trim() === "" ? void 0 : v.trim();
}
function optionalEnum(fm, key, allowed) {
  const v = fm[key];
  if (v === void 0) return void 0;
  if (typeof v !== "string" || !allowed.includes(v)) {
    throw new Error(`field "${key}" must be one of ${allowed.join("|")}; got ${String(v)}`);
  }
  return v;
}
function optionalBoolean(fm, key) {
  const v = fm[key];
  if (v === void 0) return void 0;
  if (typeof v !== "boolean") {
    throw new Error(`field "${key}" must be a boolean; got ${typeof v}`);
  }
  return v;
}
function optionalNumber(fm, key) {
  const v = fm[key];
  if (v === void 0) return void 0;
  if (typeof v !== "number") {
    throw new Error(`field "${key}" must be a number; got ${typeof v}`);
  }
  return v;
}
function optionalStringList(fm, key) {
  const v = fm[key];
  if (v === void 0) return void 0;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new Error(`field "${key}" must be a list of strings`);
  }
  return v.map((s) => s.trim()).filter(Boolean);
}
async function loadPersonasFromDir(dir, source) {
  const personas = [];
  const errors = [];
  if (!existsSync(dir)) return { personas, errors };
  let entries;
  try {
    entries = await readdir(dir);
  } catch (e) {
    errors.push({ path: dir, reason: `cannot read directory: ${e.message}` });
    return { personas, errors };
  }
  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    try {
      const st = await stat(filePath);
      if (!st.isFile()) continue;
      const text = await readFile(filePath, "utf-8");
      const raw = parseFrontmatter(text);
      const persona = validateAndBuild(raw, source, filePath);
      personas.push(persona);
    } catch (e) {
      errors.push({ path: filePath, reason: e.message });
    }
  }
  return { personas, errors };
}
async function resolvePersonas(opts) {
  const overrides = opts.personaOverrides ?? {};
  const builtin = await loadPersonasFromDir(builtinPersonasDir(), "builtin");
  const user = await loadPersonasFromDir(userPersonasDir(), "user");
  const project = await loadPersonasFromDir(projectPersonasDir(opts.cwd), "project");
  const errors = [...builtin.errors, ...user.errors, ...project.errors];
  const personas = /* @__PURE__ */ new Map();
  const shadowed = /* @__PURE__ */ new Map();
  const ordered = [...builtin.personas, ...user.personas, ...project.personas];
  for (const p of ordered) {
    const list = shadowed.get(p.name) ?? [];
    list.push(p);
    shadowed.set(p.name, list);
    personas.set(p.name, p);
  }
  for (const [name, ov] of Object.entries(overrides)) {
    if (ov.disabled) {
      personas.delete(name);
      continue;
    }
    const base = personas.get(name);
    if (!base) continue;
    personas.set(name, {
      ...base,
      model: ov.model ?? base.model,
      thinking: ov.thinking ?? base.thinking,
      timeoutMinutes: ov.timeoutMinutes ?? base.timeoutMinutes,
      inheritContext: ov.inheritContext ?? base.inheritContext,
      inheritSkills: ov.inheritSkills ?? base.inheritSkills
    });
  }
  return { personas, shadowed, errors };
}

// src/config.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { join as join2 } from "node:path";
function userConfigPath() {
  return join2(homedir2(), ".pi", "agent", "extensions", "conductor", "config.json");
}
function projectConfigPath(cwd) {
  return join2(cwd, ".pi", "conductor.json");
}
function safeReadJson(path) {
  if (!existsSync2(path)) return { value: null };
  try {
    return { value: JSON.parse(readFileSync(path, "utf-8")) };
  } catch (e) {
    return {
      value: null,
      error: { path, reason: e.message }
    };
  }
}
function mergeConfig(base, raw) {
  if (!raw || typeof raw !== "object") return base;
  const r = raw;
  const out = { ...base };
  if (typeof r.defaultTimeoutMinutes === "number" && r.defaultTimeoutMinutes > 0) {
    out.defaultTimeoutMinutes = r.defaultTimeoutMinutes;
  }
  if (typeof r.maxConcurrent === "number" && r.maxConcurrent >= 1) {
    out.maxConcurrent = Math.floor(r.maxConcurrent);
  }
  if (typeof r.maxConcurrentWriteCapable === "number" && r.maxConcurrentWriteCapable >= 1) {
    out.maxConcurrentWriteCapable = Math.floor(r.maxConcurrentWriteCapable);
  }
  if (typeof r.queueOnConcurrencyCap === "boolean") {
    out.queueOnConcurrencyCap = r.queueOnConcurrencyCap;
  }
  if (typeof r.autoOpenFocusOnSpawn === "boolean") {
    out.autoOpenFocusOnSpawn = r.autoOpenFocusOnSpawn;
  }
  if (r.defaultSpawnMode === "foreground" || r.defaultSpawnMode === "background") {
    out.defaultSpawnMode = r.defaultSpawnMode;
  }
  if (r.defaultMode === "on" || r.defaultMode === "off") {
    out.defaultMode = r.defaultMode;
  }
  if (typeof r.defaultSteerable === "boolean") {
    out.defaultSteerable = r.defaultSteerable;
  }
  if (r.personaOverrides && typeof r.personaOverrides === "object") {
    const incoming = r.personaOverrides;
    const merged = { ...out.personaOverrides };
    for (const [name, fields] of Object.entries(incoming)) {
      if (!fields || typeof fields !== "object") continue;
      merged[name] = { ...merged[name] ?? {}, ...fields };
    }
    out.personaOverrides = merged;
  }
  if (typeof r.conductorPromptPath === "string") {
    out.conductorPromptPath = r.conductorPromptPath;
  }
  if (r.gc && typeof r.gc === "object") {
    out.gc = mergeGcConfig(out.gc, r.gc);
  }
  return out;
}
function mergeGcConfig(base, raw) {
  const out = { ...base };
  if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
  if (typeof raw.completedTtlDays === "number" && raw.completedTtlDays > 0) {
    out.completedTtlDays = Math.floor(raw.completedTtlDays);
  }
  if (typeof raw.failedTtlDays === "number" && raw.failedTtlDays > 0) {
    out.failedTtlDays = Math.floor(raw.failedTtlDays);
  }
  if (typeof raw.totalSizeBudgetBytes === "number" && raw.totalSizeBudgetBytes >= 0) {
    out.totalSizeBudgetBytes = Math.floor(raw.totalSizeBudgetBytes);
  }
  if (typeof raw.transcriptSizeCapBytes === "number" && raw.transcriptSizeCapBytes >= 0) {
    out.transcriptSizeCapBytes = Math.floor(raw.transcriptSizeCapBytes);
  }
  if (typeof raw.orphanReconcileAfterHours === "number" && raw.orphanReconcileAfterHours > 0) {
    out.orphanReconcileAfterHours = raw.orphanReconcileAfterHours;
  }
  if (typeof raw.autoOnSessionStart === "boolean") {
    out.autoOnSessionStart = raw.autoOnSessionStart;
  }
  if (typeof raw.autoDebounceHours === "number" && raw.autoDebounceHours >= 0) {
    out.autoDebounceHours = raw.autoDebounceHours;
  }
  if (raw.perPersonaTtlDays && typeof raw.perPersonaTtlDays === "object") {
    const incoming = raw.perPersonaTtlDays;
    const merged = { ...out.perPersonaTtlDays };
    for (const [name, days] of Object.entries(incoming)) {
      if (typeof days === "number" && days > 0) {
        merged[name] = Math.floor(days);
      }
    }
    out.perPersonaTtlDays = merged;
  }
  return out;
}
function loadConfigWithErrors(cwd) {
  const errors = [];
  const u = safeReadJson(userConfigPath());
  if (u.error) errors.push(u.error);
  const userCfg = mergeConfig({ ...DEFAULT_CONFIG }, u.value);
  const p = safeReadJson(projectConfigPath(cwd));
  if (p.error) errors.push(p.error);
  const projectCfg = mergeConfig({ ...DEFAULT_CONFIG }, p.value);
  let merged = mergeConfig({ ...DEFAULT_CONFIG }, u.value);
  merged = mergeConfig(merged, p.value);
  return { config: merged, user: userCfg, project: projectCfg, errors };
}
function loadConfig(cwd) {
  return loadConfigWithErrors(cwd).config;
}

// src/runs.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile as writeFile2, appendFile } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";

// src/rpc-stdin.ts
function findRawCr(value, depth = 0) {
  if (depth > 16) return false;
  if (typeof value === "string") return value.includes("\r");
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    for (const item of value) if (findRawCr(item, depth + 1)) return true;
    return false;
  }
  for (const key of Object.keys(value)) {
    if (findRawCr(value[key], depth + 1)) return true;
  }
  return false;
}
var RpcStdinQueue = class {
  stream;
  queue = [];
  /** The entry currently awaiting its write callback, if any. */
  inFlightEntry = null;
  /** True after destroy(); subsequent enqueues reject immediately. */
  destroyed = false;
  constructor(stream) {
    this.stream = stream;
  }
  /**
   * Enqueue a command for sequenced JSON-line write. Resolves when
   * the kernel acknowledges the write; rejects on EPIPE / ECANCELED
   * (with `cause` set to the underlying `Error`) or if the queue has
   * been destroyed.
   *
   * Embedded LF / CR characters in the stringified payload are
   * rejected synchronously (LF-only framing invariant).
   */
  enqueue(cmd) {
    return new Promise((resolve2, reject) => {
      if (this.destroyed) {
        reject(new Error("RpcStdinQueue is destroyed; cannot enqueue"));
        return;
      }
      if (findRawCr(cmd)) {
        reject(
          new Error(
            "embedded carriage return in command payload string field; LF-only framing forbids raw CR"
          )
        );
        return;
      }
      let json;
      try {
        json = JSON.stringify(cmd);
      } catch (e) {
        reject(new Error(`failed to JSON.stringify command: ${e.message}`));
        return;
      }
      const entry = {
        json,
        resolve: () => {
          if (entry.settled) return;
          entry.settled = true;
          resolve2();
        },
        reject: (err) => {
          if (entry.settled) return;
          entry.settled = true;
          reject(err);
        },
        settled: false
      };
      this.queue.push(entry);
      this.pump();
    });
  }
  /**
   * Synchronously reject every pending entry (in-flight + queued)
   * with an Error whose message embeds the supplied reason. Idempotent:
   * a second destroy() call is a no-op.
   */
  destroy(reason) {
    if (this.destroyed) return;
    this.destroyed = true;
    const err = new Error(`RpcStdinQueue destroyed: ${reason}`);
    if (this.inFlightEntry) {
      const e = this.inFlightEntry;
      this.inFlightEntry = null;
      e.reject(err);
    }
    const drained = this.queue.splice(0, this.queue.length);
    for (const entry of drained) {
      entry.reject(err);
    }
  }
  // ── Internals ───────────────────────────────────────────────────
  /**
   * Pump the next queued entry into the stream, one at a time.
   * Callback-based so we observe back-pressure correctly: the
   * Writable's _write callback fires only after the chunk is
   * accepted into the internal buffer (or rejected).
   */
  pump() {
    if (this.inFlightEntry !== null || this.destroyed) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.inFlightEntry = entry;
    const line = entry.json + "\n";
    if (!this.stream || this.stream.writableEnded || this.stream.destroyed) {
      this.inFlightEntry = null;
      const err = new Error("RpcStdinQueue: underlying stream is not writable");
      entry.reject(err);
      this.pump();
      return;
    }
    const onWriteSettled = (err) => {
      if (this.inFlightEntry === entry) {
        this.inFlightEntry = null;
      }
      if (err) {
        const wrapped = new Error(
          `RpcStdinQueue write failed: ${err.message}`
        );
        wrapped.cause = err;
        entry.reject(wrapped);
      } else {
        entry.resolve();
      }
      if (!this.destroyed) this.pump();
    };
    try {
      this.stream.write(line, "utf8", onWriteSettled);
    } catch (e) {
      onWriteSettled(e);
    }
  }
};

// src/runs.ts
import { dirname as dirname4, join as join4 } from "node:path";

// src/gc/id-reuse.ts
var recentlyDeletedIds = /* @__PURE__ */ new Set();
function noteDeletedId(id) {
  recentlyDeletedIds.add(id);
}
function noteAllocatedId(id, log = (l) => console.error(l)) {
  if (recentlyDeletedIds.has(id)) {
    log(`gc.id_reused: ${id}`);
  }
}

// src/tool-summary.ts
import { visibleWidth } from "@earendil-works/pi-tui";
var MAX_SUMMARY_LEN = 50;
var MAX_KV_VALUE_LEN = 30;
var ELLIPSIS = "\u2026";
var ELLIPSIS_W = 1;
function shortenMiddle(text, max) {
  if (max <= 0) return "";
  if (visibleWidth(text) <= max) return text;
  if (max === ELLIPSIS_W) return ELLIPSIS;
  if (max < 3) return text.slice(0, max);
  const budget = max - ELLIPSIS_W;
  const headLen = Math.ceil(budget * 0.6);
  const tailLen = budget - headLen;
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(text.length - tailLen) : "";
  return head + ELLIPSIS + tail;
}
function summarizeToolArgs(name, args) {
  switch (name) {
    case "bash":
      return shortenMiddle(String(args.command ?? ""), MAX_SUMMARY_LEN);
    case "read":
    case "write":
    case "edit":
      return shorten(String(args.file_path ?? args.path ?? ""), MAX_SUMMARY_LEN);
    case "grep":
      return shorten(String(args.pattern ?? ""), MAX_SUMMARY_LEN);
    default: {
      const pairs = [];
      for (const [k, v] of Object.entries(args)) {
        const repr = typeof v === "string" ? v : JSON.stringify(v);
        pairs.push(`${k}=${shorten(repr, MAX_KV_VALUE_LEN)}`);
      }
      return shorten(pairs.join(" "), MAX_SUMMARY_LEN);
    }
  }
}
function shorten(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

// src/event-handler.ts
var NONE = { kind: "none" };
var UPDATED = { kind: "updated" };
function applyEvent(run, event) {
  if (!event || typeof event !== "object") return NONE;
  const e = event;
  if (typeof e.type !== "string") return NONE;
  if (run.streamingMode === "rpc" && bumpOnRpcLine(run, Date.now(), e.type)) {
    run.lastEventAt = Date.now();
  }
  if (e.type === "response") {
    routeRpcResponse(run, e);
    return UPDATED;
  }
  if (e.type === "extension_ui_request") {
    return handleExtensionUiRequest(run, e);
  }
  if (e.type === "agent_end") {
    return { kind: "finalize", status: "completed", exitCode: 0 };
  }
  if (e.type === "turn_end") {
    if (!e.message) return NONE;
    const msg = e.message;
    const content = msg.content;
    const hasToolCall = Array.isArray(content) ? content.some((p) => p?.type === "toolCall") : false;
    const stopReason = msg.stopReason;
    const errored = stopReason === "error" || stopReason === "aborted";
    if (!hasToolCall && !errored) {
      return { kind: "finalize", status: "completed", exitCode: 0 };
    }
    return NONE;
  }
  if (e.type === "message_end") {
    if (!e.message) return NONE;
    const msg = e.message;
    run.messages.push(msg);
    run.lastEventAt = Date.now();
    if (msg.role === "assistant") {
      run.usage.turns += 1;
      const u = msg.usage;
      if (u) {
        run.usage.input += u.input || 0;
        run.usage.output += u.output || 0;
        run.usage.cacheRead += u.cacheRead || 0;
        run.usage.cacheWrite += u.cacheWrite || 0;
        run.usage.cost += u.cost?.total || 0;
      }
      const m = msg.model;
      if (m && !run.model) run.model = m;
      const sr = msg.stopReason;
      if (sr) run.stopReason = sr;
      const em = msg.errorMessage;
      if (em && !run.errorMessage) run.errorMessage = em;
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part?.type === "toolCall") {
            run.lastToolCall = formatToolCallShort(part.name, part.arguments);
          }
        }
      }
    }
    return UPDATED;
  }
  if (e.type === "tool_result_end") {
    if (!e.message) return NONE;
    run.messages.push(e.message);
    run.lastEventAt = Date.now();
    return UPDATED;
  }
  if (e.type === "tool_execution_update") {
    run.lastEventAt = Date.now();
    return UPDATED;
  }
  return NONE;
}
function bumpOnRpcLine(_run, _now, evtType) {
  return evtType === "response";
}
function routeRpcResponse(run, evt) {
  const id = evt.id;
  if (typeof id !== "string" || !run.pendingAcks) return UPDATED;
  const entry = run.pendingAcks.get(id);
  if (!entry) return UPDATED;
  clearTimeout(entry.timer);
  run.pendingAcks.delete(id);
  entry.resolve(evt.success === true);
  return UPDATED;
}
function handleExtensionUiRequest(run, evt) {
  const id = evt.id;
  const method = evt.method ?? "unknown";
  console.warn(
    `sub-agent ${run.id} emitted ${method} request under steerable=true; auto-cancelled`
  );
  if (!run.rpcStdinQueue || typeof id !== "string") return UPDATED;
  void run.rpcStdinQueue.enqueue({ type: "extension_ui_response", id, cancelled: true }).catch(() => {
  });
  return UPDATED;
}
function shortenPath(p) {
  const home = process.env.HOME || "";
  return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}
function formatToolCallShort(name, args) {
  const a = args ?? {};
  switch (name) {
    case "bash": {
      const cmd = a.command ?? "...";
      return `$ ${shortenMiddle(cmd, 51)}`;
    }
    case "read":
      return `read ${shortenPath(a.file_path || a.path || "...")}`;
    case "write":
      return `write ${shortenPath(a.file_path || a.path || "...")}`;
    case "edit":
      return `edit ${shortenPath(a.file_path || a.path || "...")}`;
    case "grep":
      return `grep ${a.pattern ?? "..."}`;
    default:
      return name;
  }
}

// src/context-filter.ts
var DEFAULT_TOOL_PREFIXES = ["ensemble_", "subagent"];
var DEFAULT_CUSTOM_TYPE_PREFIXES = ["ensemble-notification", "subagent"];
function matchesAnyPrefix(name, prefixes) {
  for (const p of prefixes) {
    if (name.startsWith(p)) return true;
  }
  return false;
}
function filterParentContext(messages, opts = {}) {
  const excludeToolPrefixes = opts.excludeToolPrefixes ?? DEFAULT_TOOL_PREFIXES;
  const excludeCustomTypePrefixes = opts.excludeCustomTypePrefixes ?? DEFAULT_CUSTOM_TYPE_PREFIXES;
  const excludeCustomTypesExact = opts.excludeCustomTypes ?? [];
  const dropBashEx = opts.dropBashExcludeFromContext ?? true;
  const dropThinking = opts.dropThinking ?? true;
  const excludedCallIds = /* @__PURE__ */ new Set();
  const droppedAssistantIndices = /* @__PURE__ */ new Set();
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    let willDrop = false;
    for (const block of content) {
      if (block?.type === "toolCall" && typeof block.name === "string" && matchesAnyPrefix(block.name, excludeToolPrefixes)) {
        willDrop = true;
        break;
      }
    }
    if (!willDrop) continue;
    droppedAssistantIndices.add(i);
    for (const block of content) {
      if (block?.type === "toolCall" && typeof block.id === "string") {
        excludedCallIds.add(block.id);
      }
    }
  }
  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const role = msg.role;
    switch (role) {
      case "user":
        out.push(msg);
        break;
      case "assistant": {
        if (droppedAssistantIndices.has(i)) break;
        const content = msg.content;
        if (!Array.isArray(content)) {
          out.push(msg);
          break;
        }
        const filtered = content.filter((block) => {
          if (block?.type === "thinking" && dropThinking) return false;
          if (block?.type !== "toolCall") return true;
          if (typeof block.name !== "string") return true;
          return !matchesAnyPrefix(block.name, excludeToolPrefixes);
        });
        if (filtered.length === 0) break;
        if (filtered.length === content.length) {
          out.push(msg);
        } else {
          const rewritten = { ...msg, content: filtered };
          if (msg.stopReason === "toolUse" && !filtered.some((b) => b?.type === "toolCall")) {
            rewritten.stopReason = "stop";
          }
          out.push(rewritten);
        }
        break;
      }
      case "toolResult": {
        const callId = msg.toolCallId;
        if (typeof callId === "string" && excludedCallIds.has(callId)) break;
        out.push(msg);
        break;
      }
      case "bashExecution": {
        if (dropBashEx && msg.excludeFromContext === true) break;
        out.push(msg);
        break;
      }
      case "custom": {
        const customType = msg.customType;
        if (typeof customType === "string") {
          if (excludeCustomTypesExact.includes(customType)) break;
          if (matchesAnyPrefix(customType, excludeCustomTypePrefixes)) break;
        }
        out.push(msg);
        break;
      }
      case "branchSummary":
      case "compactionSummary":
        out.push(msg);
        break;
      default:
        out.push(msg);
        break;
    }
  }
  return out;
}
function filterParentContextCompact(messages, opts = {}) {
  const filtered = filterParentContext(messages, opts);
  const out = [];
  let elidedAssistantBlocks = 0;
  for (const msg of filtered) {
    if (msg.role !== "assistant") {
      out.push(msg);
      continue;
    }
    const content = msg.content;
    if (!Array.isArray(content)) {
      elidedAssistantBlocks += 1;
      continue;
    }
    const kept = [];
    for (const block of content) {
      if (block?.type === "text") {
        elidedAssistantBlocks += 1;
        continue;
      }
      kept.push(block);
    }
    if (kept.length === 0) {
      continue;
    }
    out.push({ ...msg, content: kept });
  }
  if (elidedAssistantBlocks === 0) return out;
  const header = {
    role: "assistant",
    content: [
      {
        type: "text",
        text: `[conductor narration elided: ${elidedAssistantBlocks} prose block(s) from the parent removed in filtered_compact mode. Tool calls, file reads, and user messages preserved. Your task is in the LAST user message below.]`
      }
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "synthetic",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    },
    stopReason: "stop",
    timestamp: 0
  };
  return [header, ...out];
}

// src/inherit-context.ts
function resolveInheritContext(perCall, persona) {
  return perCall ?? persona.inheritContext;
}

// src/session-seed.ts
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname as dirname2 } from "node:path";
function newEntryId() {
  return randomBytes(4).toString("hex");
}
function newSessionId() {
  return randomBytes(16).toString("hex");
}
function seedSessionFile(path, messages, cwd) {
  mkdirSync(dirname2(path), { recursive: true });
  const lines = [];
  const now = (/* @__PURE__ */ new Date()).toISOString();
  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id: newSessionId(),
      timestamp: now,
      cwd
    })
  );
  let parentId = null;
  for (const message of messages) {
    const id = newEntryId();
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        message
      })
    );
    parentId = id;
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

// src/substance-check.ts
var SUBSTANTIVE_MIN_CHARS = 200;
var ORIENT_PHRASE_RE = /^\s*(let me|now i'?ll|next i'?ll|i'?ll now|i need to|let's|first[,]?\s+i)\b/i;
function isNonSubstantiveFinalMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    const texts = [];
    let lastBlockKind;
    for (const part of content) {
      const kind = part?.type;
      if (typeof kind === "string") lastBlockKind = kind;
      if (kind === "text") {
        const t = part.text;
        if (typeof t === "string") texts.push(t);
      }
    }
    const finalText = texts.join("").trim();
    const lastIsThinking = typeof lastBlockKind === "string" && lastBlockKind.startsWith("thinking");
    if (finalText.length === 0 || lastIsThinking) {
      return {
        warn: true,
        reason: "no_text",
        message: `Final assistant message contained no terminal text (last block: ${lastBlockKind ?? "<empty>"}).`
      };
    }
    if (finalText.length < SUBSTANTIVE_MIN_CHARS) {
      return {
        warn: true,
        reason: "too_short",
        message: `Final assistant text is ${finalText.length} chars (< ${SUBSTANTIVE_MIN_CHARS}); likely an orient-yourself preamble rather than the substantive report.`
      };
    }
    if (ORIENT_PHRASE_RE.test(finalText)) {
      const preview = finalText.slice(0, 80).replace(/\s+/g, " ");
      return {
        warn: true,
        reason: "orient_phrase",
        message: `Final assistant text begins with an orient-yourself phrase ("${preview}\u2026"); likely the sub-agent stopped mid-plan.`
      };
    }
    return { warn: false };
  }
  return {
    warn: true,
    reason: "no_text",
    message: "Run produced no assistant messages."
  };
}

// src/hook-cascade.ts
var DEFAULT_HOOK_TIMEOUT_SECONDS = 300;
function resolveOnCompleteHook(input) {
  const layers = [
    { source: "per-call", spec: input.perCall },
    { source: "project", spec: input.project },
    { source: "user", spec: input.user },
    { source: "persona", spec: input.persona }
  ];
  for (const { source, spec } of layers) {
    if (spec === void 0) continue;
    if (spec.command === void 0) continue;
    if (spec.command === "") {
      return void 0;
    }
    return {
      command: spec.command,
      timeoutSeconds: spec.timeoutSeconds ?? DEFAULT_HOOK_TIMEOUT_SECONDS,
      source
    };
  }
  return void 0;
}

// src/hook-runner.ts
import {
  spawn as childProcessSpawn
} from "node:child_process";
import { mkdirSync as mkdirSync2, createWriteStream } from "node:fs";
import { dirname as dirname3 } from "node:path";
var DEFAULT_HOOK_MAX_LOG_BYTES = 10 * 1024 * 1024;
var SIGKILL_GRACE_MS = 2e3;
var TAIL_MAX_LINES = 50;
var TAIL_MAX_BYTES = 4 * 1024;
function defaultKillGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (e) {
    const code = e.code;
    if (code === "ESRCH" || code === "EPERM") return;
    try {
      console.error(`[hook-runner] unexpected kill error: ${e.message}`);
    } catch {
    }
  }
}
function runHook(opts) {
  const deps = opts.deps ?? {};
  const spawn2 = deps.spawn ?? childProcessSpawn;
  const maxLogBytes = deps.maxLogBytes ?? DEFAULT_HOOK_MAX_LOG_BYTES;
  const killGroup = deps.killGroup ?? defaultKillGroup;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const startedAt = now();
  const logPath = `${opts.runDir}/hook.log`;
  try {
    mkdirSync2(dirname3(logPath), { recursive: true });
  } catch {
  }
  const env = {
    ...process.env,
    CONDUCTOR_RUN_ID: opts.runId,
    CONDUCTOR_PERSONA: opts.persona,
    CONDUCTOR_FINAL_TEXT_PATH: opts.finalPath,
    CONDUCTOR_TRANSCRIPT_PATH: opts.transcriptPath,
    CONDUCTOR_RUN_DIR: opts.runDir,
    CONDUCTOR_HOOK_LOG: logPath,
    CONDUCTOR_PARENT_CWD: opts.parentCwd
  };
  const spawnOpts = {
    shell: true,
    detached: true,
    cwd: opts.parentCwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  };
  let proc;
  try {
    proc = spawn2(opts.resolved.command, spawnOpts);
  } catch (e) {
    return Promise.resolve({
      passed: false,
      command: opts.resolved.command,
      exitCode: null,
      durationMs: now() - startedAt,
      logPath,
      tailText: `(spawn error) ${e.message}`,
      tailBytes: 0,
      tailLines: 0,
      failureKind: "spawn_error"
    });
  }
  if (opts.onProc) {
    try {
      opts.onProc(proc);
    } catch {
    }
  }
  return new Promise((resolve2) => {
    let resolved = false;
    let killReason;
    let timeoutHandle;
    let killEscalationHandle;
    let totalBytes = 0;
    const tailLines = [];
    let tailLineBuffer = "";
    let tailByteCount = 0;
    const logStream = createWriteStream(logPath, { flags: "w" });
    logStream.on("error", () => {
    });
    const finalize = (exitCode, signal) => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle !== void 0) clearTimer(timeoutHandle);
      if (killEscalationHandle !== void 0) clearTimer(killEscalationHandle);
      if (tailLineBuffer.length > 0) {
        appendTailLine(tailLines, tailLineBuffer);
        tailLineBuffer = "";
      }
      const tailText = renderTail(tailLines);
      const tailBytes = Buffer.byteLength(tailText, "utf8");
      const tailLineCount = tailText.length === 0 ? 0 : tailText.split("\n").length;
      let failureKind;
      let passed = false;
      if (killReason === "runaway_output") {
        failureKind = "runaway_output";
      } else if (killReason === "timeout") {
        failureKind = "timeout";
      } else if (signal !== null) {
        failureKind = "signal";
      } else if (exitCode === 0) {
        passed = true;
      } else {
        failureKind = "exited";
      }
      const finishStream = new Promise((res) => {
        logStream.once("finish", () => res());
        logStream.once("error", () => res());
        try {
          logStream.end();
        } catch {
          res();
        }
      });
      void finishStream.then(() => {
        resolve2({
          passed,
          command: opts.resolved.command,
          exitCode,
          durationMs: now() - startedAt,
          logPath,
          tailText,
          tailBytes,
          tailLines: tailLineCount,
          failureKind
        });
      });
    };
    const escalateToSigkill = () => {
      if (resolved) return;
      if (proc.pid === void 0) return;
      killGroup(proc.pid, "SIGKILL");
    };
    const beginGroupKill = (reason) => {
      if (killReason !== void 0) return;
      killReason = reason;
      if (proc.pid === void 0) return;
      killGroup(proc.pid, "SIGTERM");
      killEscalationHandle = setTimer(escalateToSigkill, SIGKILL_GRACE_MS);
    };
    const onChunk = (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      totalBytes += buf.length;
      try {
        logStream.write(buf);
      } catch {
      }
      const text = buf.toString("utf8");
      const merged = tailLineBuffer + text;
      const lines = merged.split("\n");
      tailLineBuffer = lines.pop() ?? "";
      for (const line of lines) appendTailLine(tailLines, line);
      tailByteCount = capTailBytes(tailLines, tailByteCount, line_length(tailLineBuffer));
      if (totalBytes >= maxLogBytes && killReason === void 0) {
        beginGroupKill("runaway_output");
      }
    };
    proc.stdout?.on("data", onChunk);
    proc.stderr?.on("data", onChunk);
    proc.on("error", (e) => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle !== void 0) clearTimer(timeoutHandle);
      if (killEscalationHandle !== void 0) clearTimer(killEscalationHandle);
      try {
        logStream.end();
      } catch {
      }
      resolve2({
        passed: false,
        command: opts.resolved.command,
        exitCode: null,
        durationMs: now() - startedAt,
        logPath,
        tailText: `(spawn error) ${e.message}`,
        tailBytes: 0,
        tailLines: 0,
        failureKind: "spawn_error"
      });
    });
    proc.on("close", (code, signal) => {
      finalize(code, signal);
    });
    timeoutHandle = setTimer(() => {
      beginGroupKill("timeout");
    }, opts.resolved.timeoutSeconds * 1e3);
  });
}
function appendTailLine(lines, line) {
  lines.push(line);
  if (lines.length > TAIL_MAX_LINES) {
    lines.splice(0, lines.length - TAIL_MAX_LINES);
  }
}
function capTailBytes(lines, _currentBytes, _pendingBytes) {
  let total = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    total += Buffer.byteLength(lines[i] ?? "", "utf8") + 1;
    if (total > TAIL_MAX_BYTES) {
      lines.splice(0, i + 1);
      return total - (Buffer.byteLength(lines[0] ?? "", "utf8") + 1);
    }
  }
  return total;
}
function line_length(s) {
  return Buffer.byteLength(s, "utf8");
}
function renderTail(lines) {
  if (lines.length === 0) return "";
  return lines.join("\n");
}

// src/reconcile-startup.ts
import { readFile as readFile2, readdir as readdir2, stat as stat2, writeFile } from "node:fs/promises";
import { readFileSync as readFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
function classifyRecord(record, isAlive, _now, selfPid = process.pid, isParentAlive = (pid, startTime) => defaultParentLivenessProbe(pid, startTime)) {
  const status = record.status;
  if (TERMINAL_STATUSES.includes(status)) {
    return "skip-terminal";
  }
  if (record.parentPid !== void 0 && record.parentPid !== selfPid && isParentAlive(record.parentPid, record.parentStartTime)) {
    return "skip-foreign";
  }
  if (status === "queued") {
    return "reclassify-failed-queued";
  }
  if (record.pid === void 0) {
    return "reclassify-pre-schema";
  }
  if (!isAlive(record.pid)) {
    return "reclassify-killed";
  }
  if (record.streamingMode === "rpc") {
    return "reclassify-killed";
  }
  return "readopt";
}
var defaultSignaler = (pid, signal) => {
  process.kill(pid, signal);
};
function defaultLivenessProbe(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = e?.code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}
function readProcessStartTime(pid) {
  if (process.platform !== "linux") return void 0;
  try {
    const raw = readFileSync2(`/proc/${pid}/stat`, "utf-8");
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0) return void 0;
    const fields = raw.slice(closeParen + 2).split(" ");
    const startTimeStr = fields[19];
    if (!startTimeStr) return void 0;
    const n = Number(startTimeStr);
    return Number.isFinite(n) ? n : void 0;
  } catch {
    return void 0;
  }
}
function defaultParentLivenessProbe(pid, expectedStartTime) {
  if (!defaultLivenessProbe(pid)) return false;
  if (expectedStartTime === void 0) return true;
  const observed = readProcessStartTime(pid);
  if (observed === void 0) return true;
  return observed === expectedStartTime;
}
async function reconcileOrphansAtStartup(deps) {
  const result = {
    scanned: 0,
    readopted: [],
    reclassified: [],
    preSchema: [],
    unresumable: [],
    skippedForeign: [],
    errors: []
  };
  let entries;
  try {
    entries = await readdir2(deps.runsRoot);
  } catch (e) {
    const code = e?.code;
    if (code === "ENOENT") return result;
    result.errors.push({
      id: "<runsRoot>",
      message: `readdir failed: ${e?.message ?? String(e)}`
    });
    return result;
  }
  for (const id of entries) {
    const recordPath = join3(deps.runsRoot, id, "record.json");
    try {
      let raw;
      try {
        raw = await readFile2(recordPath, "utf-8");
      } catch (e) {
        const code = e?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          continue;
        }
        throw e;
      }
      result.scanned++;
      let record;
      try {
        record = JSON.parse(raw);
      } catch (e) {
        result.errors.push({
          id,
          message: `JSON parse error: ${e?.message ?? String(e)}`
        });
        continue;
      }
      if (deps.registry.has(record.id ?? id)) {
        continue;
      }
      const verdict = classifyRecord(
        record,
        deps.isAlive,
        deps.now,
        deps.selfPid ?? process.pid,
        deps.isParentAlive ?? defaultParentLivenessProbe
      );
      const dryRun = deps.dryRun === true;
      switch (verdict) {
        case "skip-terminal":
          break;
        case "skip-foreign":
          result.skippedForeign.push(record.id);
          break;
        case "readopt": {
          const orphan = buildOrphanRun(record, "running");
          if (!dryRun) deps.registry.register(orphan);
          result.readopted.push(record.id);
          await checkSessionResumability(record, result);
          break;
        }
        case "reclassify-killed":
        case "reclassify-pre-schema": {
          let errorMessage;
          let isRpcDetached = false;
          if (verdict === "reclassify-pre-schema") {
            errorMessage = "orphaned: pre-pid-schema record (post-startup reconcile)";
          } else if (record.streamingMode === "rpc" && record.pid !== void 0 && deps.isAlive(record.pid)) {
            errorMessage = "orphaned: rpc-stream-detached";
            isRpcDetached = true;
          } else {
            errorMessage = "orphaned: process gone (post-startup reconcile)";
          }
          if (!dryRun) {
            await reclassifyOnDisk({
              recordPath,
              record,
              nextStatus: "killed",
              errorMessage,
              now: deps.now
            });
          }
          if (isRpcDetached && record.pid !== void 0 && !dryRun) {
            const sig = deps.signal ?? defaultSignaler;
            try {
              sig(record.pid, "SIGTERM");
            } catch (e) {
              const code = e?.code;
              if (code !== "ESRCH" && code !== "EPERM") {
                result.errors.push({
                  id: record.id,
                  message: `SIGTERM rpc-orphan: ${e?.message ?? String(e)}`
                });
              }
            }
          }
          const orphan = buildOrphanRun({
            ...record,
            status: "killed",
            finishedAt: deps.now,
            errorMessage
          }, "killed");
          if (!dryRun) deps.registry.register(orphan);
          result.reclassified.push(record.id);
          if (verdict === "reclassify-pre-schema") {
            result.preSchema.push(record.id);
          }
          await checkSessionResumability(record, result);
          break;
        }
        case "reclassify-failed-queued": {
          const errorMessage = "orphaned: queue entry abandoned at startup (post-startup reconcile)";
          if (!dryRun) {
            await reclassifyOnDisk({
              recordPath,
              record,
              nextStatus: "failed",
              errorMessage,
              now: deps.now
            });
          }
          const orphan = buildOrphanRun({
            ...record,
            status: "failed",
            finishedAt: deps.now,
            errorMessage
          }, "failed");
          if (!dryRun) deps.registry.register(orphan);
          result.reclassified.push(record.id);
          break;
        }
      }
    } catch (e) {
      result.errors.push({
        id,
        message: e?.message ?? String(e)
      });
    }
  }
  return result;
}
function buildOrphanRun(record, status) {
  return {
    id: record.id,
    persona: record.persona,
    task: record.task,
    model: record.model,
    thinking: record.thinking,
    mode: record.mode,
    status,
    startTime: record.startTime,
    finishedAt: record.finishedAt,
    pausedAt: record.pausedAt,
    pid: record.pid,
    exitCode: record.exitCode,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    lastEventAt: record.finishedAt ?? record.startTime,
    messages: [],
    usage: record.usage ?? emptyUsage(),
    cwd: record.cwd,
    recordPath: record.recordPath,
    transcriptPath: record.transcriptPath,
    finalPath: record.finalPath,
    sessionPath: record.sessionPath,
    systemPrompt: record.systemPrompt,
    hookResult: record.hookResult
    // proc intentionally undefined: we have no handle.
  };
}
async function reclassifyOnDisk(opts) {
  const updated = {
    ...opts.record,
    status: opts.nextStatus,
    finishedAt: opts.now,
    errorMessage: opts.errorMessage
  };
  await writeFile(opts.recordPath, JSON.stringify(updated, null, 2));
}
async function checkSessionResumability(record, result) {
  if (!record.sessionPath) {
    return;
  }
  try {
    await stat2(record.sessionPath);
  } catch {
    result.unresumable.push(record.id);
  }
}

// src/runs.ts
function runsRoot() {
  return join4(homedir3(), ".pi", "agent", "conductor", "runs");
}
function runDir(id) {
  return join4(runsRoot(), id);
}
function collectInheritedSkillPaths(opts) {
  const home = opts.homeDir ?? homedir3();
  const exists = opts.existsFn ?? existsSync3;
  const candidates = [
    join4(home, ".pi", "agent", "skills"),
    join4(opts.cwd, ".pi", "skills")
  ];
  return candidates.filter((p) => exists(p));
}
function resolveTimeoutMs(persona, ov, cfg) {
  const minutes = ov?.timeoutMinutes ?? persona?.timeoutMinutes ?? cfg.defaultTimeoutMinutes;
  return minutes * 6e4;
}
function findSessionFile(sessionDir) {
  let entries;
  try {
    entries = readdirSync(sessionDir);
  } catch {
    return void 0;
  }
  let bestPath;
  let bestMtime = -Infinity;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const full = join4(sessionDir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.mtimeMs > bestMtime) {
      bestMtime = st.mtimeMs;
      bestPath = full;
    }
  }
  return bestPath;
}
function discoverSessionPathIfMissing(run, sessionDir) {
  if (!sessionDir) return;
  if (run.sessionPath) return;
  const found = findSessionFile(sessionDir);
  if (found) run.sessionPath = found;
}
var PRONOUNCEABLE_CHARS = "abcdefghijklmnpqrstuvwxyz0123456789";
function shortHash() {
  let s = "";
  for (let i = 0; i < 4; i++) {
    s += PRONOUNCEABLE_CHARS[Math.floor(Math.random() * PRONOUNCEABLE_CHARS.length)];
  }
  return s;
}
function allocateRunId(persona, registry) {
  for (let i = 0; i < 32; i++) {
    const id = `${persona}-${shortHash()}`;
    if (!registry.has(id) && !existsSync3(runDir(id))) {
      noteAllocatedId(id);
      return id;
    }
  }
  return `${persona}-${shortHash()}-${Date.now()}`;
}
function buildSubagentEnv(baseEnv = process.env) {
  return { ...baseEnv, CONDUCTOR_SUBAGENT: "1" };
}
function getPiInvocation(args) {
  const piBinEnv = process.env.PI_BIN;
  if (piBinEnv && existsSync3(piBinEnv)) {
    return { command: process.execPath, args: [piBinEnv, ...args] };
  }
  const currentScript = process.argv[1];
  const isBunVirtual = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtual && existsSync3(currentScript)) {
    const looksLikePi = /(^|\/)(pi|cli\.js)$/.test(currentScript) && currentScript.includes("pi-coding-agent");
    if (looksLikePi) {
      return { command: process.execPath, args: [currentScript, ...args] };
    }
  }
  const execName = (process.execPath.split("/").pop() || "").toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}
var SUBAGENT_NESTING_GUARD = [
  "IMPORTANT: You are running as a pi-conductor sub-agent. Do NOT attempt to spawn",
  "further sub-agents (no calls to ensemble_spawn, subagent, agent, delegate, etc).",
  "Complete the entire task yourself and return your findings."
].join(" ");
var READ_ONLY_PERSONA_ENFORCER = [
  "[READ-ONLY PERSONA ENFORCER]",
  "You are a read-only persona. You MAY: read files, run tests",
  "(orientation), git inspection, run mutations IN-PLACE for",
  "verification (followed by IMMEDIATE restoration via git checkout).",
  "You MUST NOT: edit, write, or otherwise mutate any tracked file",
  "beyond mutation-test-and-restore cycles. You MUST NOT: run",
  "git commit, git add, git push, git merge, git rebase, git tag, or",
  "any operation that changes the repository's tracked state. If your",
  "review concludes you have advice for the parent conductor, RETURN",
  "that advice in your output \u2014 do not act on it. Acting beyond your",
  "review scope is the failure mode documented in docs/backlog.md",
  "item 13.",
  "[END READ-ONLY PERSONA ENFORCER]"
].join("\n");
function assemblePersonaSystemPrompt(persona) {
  if (persona.readOnly === true) {
    return `${READ_ONLY_PERSONA_ENFORCER}

${persona.systemPrompt}`;
  }
  return persona.systemPrompt;
}
function buildSubAgentPrompt(persona, task) {
  const parts = [SUBAGENT_NESTING_GUARD, ""];
  if (persona.defaultReads.length > 0) {
    parts.push("Read these files first if they exist (they are part of your context):");
    for (const f of persona.defaultReads) parts.push(`  - ${f}`);
    parts.push("");
  }
  parts.push("## Task");
  parts.push("");
  parts.push(task);
  return parts.join("\n");
}
function buildPiArgs(opts) {
  const args = opts.steerable ? ["--mode", "rpc"] : ["--mode", "json", "-p"];
  if (opts.kind === "fresh") {
    args.push("--session-dir", opts.sessionDir);
  } else {
    args.push("--session", opts.sessionPath);
  }
  if (opts.model) args.push("--model", opts.model);
  if (opts.thinking) args.push("--thinking", opts.thinking);
  if (opts.kind === "fresh") {
    args.push("--append-system-prompt", opts.systemPrompt);
  } else if (opts.systemPrompt) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (opts.skillPaths && opts.skillPaths.length > 0) {
    for (const p of opts.skillPaths) args.push("--skill", p);
  }
  if (!opts.steerable) {
    args.push(opts.prompt);
  }
  return args;
}
function buildResumePiArgs(run, message) {
  if (!run.sessionPath) {
    throw new Error(
      `buildResumePiArgs called on run ${run.id} without sessionPath; validateSendable should have rejected this earlier`
    );
  }
  return buildPiArgs({
    kind: "resume",
    sessionPath: run.sessionPath,
    prompt: message,
    model: run.model,
    thinking: run.thinking,
    systemPrompt: run.systemPrompt,
    // v0.12 steering: spawn-resume on a terminal run is always
    // print-mode by design (§4.4 archived-run compat / Q10 lock).
    // RPC mode is NOT sticky across the original-subprocess boundary
    // — the previous RPC subprocess is gone, so the fresh `pi
    // --session` resume picks the safer print-mode default. A per-call
    // "resume into RPC" is deliberately not exposed in v0.12.
    steerable: false
  });
}
function trimLeadingNonUser(messages) {
  let i = 0;
  while (i < messages.length && messages[i]?.role !== "user") i++;
  return messages.slice(i);
}
function filteredHistorySentinel() {
  return {
    role: "user",
    content: '<filtered-history>\n[YOU ARE A FRESH SUB-AGENT.]\n\nThe transcript above is your PARENT conductor\'s history, filtered for context. You did not perform any of those file reads, tool calls, or commits \u2014 they happened before you existed. Your task is the LAST user-role message in this transcript; everything before it is background.\n\nSub-agents have inhaled parent identity in the past (witness: docs/backlog.md item 12, builder-4gsl 2026-05-27, refused its task entirely). If you find yourself thinking "I already shipped this" or "I shouldn\'t be a sub-agent", STOP. The brief at the bottom IS your task. Execute it.\n\nTwo further notes on the filtered transcript above:\n\n1. **Your brief is the LAST user-role message in this transcript.** Earlier user-role messages were the parent conductor talking to itself or to its user; they are framing, not your task. Treat them as background context.\n\n2. **Some assistant prose may discuss YOU in the third person** \u2014 sentences like "spawning critic-X to gate Y" or "holding the turn while inspector runs". That prose is leftover orchestration narration from the parent. It is NOT a quote of your brief, NOT instructions to you, and NOT a conversation you are part of. Ignore it; do not meta-comment on it.\n\nThe following entry types were dropped before you saw this transcript:\n  - Orchestration tool calls (ensemble_*, subagent) and their results\n  - Sub-agent completion notifications (`<sub-agent-completed>` cards)\n  - The conductor\'s internal reasoning (`thinking` blocks)\n  - Bash commands marked with the `!!` excludeFromContext flag\n\nIf you see a dangling reference to prior orchestration ("the inspector said X", "as oracle noted") and you do not see a matching tool result above, that reference is from a dropped turn \u2014 treat the claim with skepticism.\n\nNow: read your brief (the last user message), do the work, return your result.\n</filtered-history>',
    timestamp: 0
  };
}
function planSpawnPiArgs(opts) {
  const { persona, parentMessages = [], sessionDir, systemPrompt, prompt, cwd, model, thinking, skillPaths } = opts;
  const steerable = opts.steerable === true;
  const effectiveInheritContext = resolveInheritContext(
    opts.inheritContextOverride,
    persona
  );
  let seedMessages = null;
  let dropped = false;
  if ((effectiveInheritContext === "filtered" || effectiveInheritContext === "filtered_compact") && parentMessages.length > 0) {
    const filterFn = effectiveInheritContext === "filtered_compact" ? filterParentContextCompact : filterParentContext;
    const filtered = filterFn(parentMessages);
    dropped = filtered.length !== parentMessages.length;
    if (!dropped) {
      for (let i = 0; i < parentMessages.length; i++) {
        if (filtered[i] !== parentMessages[i]) {
          dropped = true;
          break;
        }
      }
    }
    const trimmed = trimLeadingNonUser(filtered);
    if (trimmed.length > 0) seedMessages = trimmed;
  } else if (effectiveInheritContext === "full" && parentMessages.length > 0) {
    const trimmed = trimLeadingNonUser(parentMessages);
    if (trimmed.length > 0) seedMessages = trimmed;
  }
  if (seedMessages && dropped) {
    seedMessages = [filteredHistorySentinel(), ...seedMessages];
  }
  if (seedMessages) {
    const seededSessionPath = join4(sessionDir, "seeded.jsonl");
    seedSessionFile(seededSessionPath, seedMessages, cwd);
    return {
      mode: "resume",
      seededSessionPath,
      piArgs: buildPiArgs({
        kind: "resume",
        sessionPath: seededSessionPath,
        prompt,
        model,
        thinking,
        // Re-inject the persona body — the seeded JSONL has no system
        // prompt entry. Without this the sub-agent boots with pi's
        // default coding-agent prompt and loses its persona identity.
        systemPrompt,
        skillPaths,
        // v0.12 slice 4 — thread the cascade-collapsed steerable
        // through to the argv builder so resume-shaped RPC spawns
        // (seeded session + steerable=true) emit `--mode rpc` and
        // skip the trailing positional prompt.
        steerable
      })
    };
  }
  return {
    mode: "fresh",
    piArgs: buildPiArgs({
      kind: "fresh",
      sessionDir,
      systemPrompt,
      prompt,
      model,
      thinking,
      skillPaths,
      // v0.12 slice 4 — cascade-collapsed steerable threaded into the
      // fresh-mode argv builder. `false` (default) preserves today's
      // print-mode behaviour.
      steerable
    })
  };
}
var RunRegistry = class {
  runs = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Set();
  list() {
    return [...this.runs.values()];
  }
  get(id) {
    return this.runs.get(id);
  }
  has(id) {
    return this.runs.has(id);
  }
  register(run) {
    this.runs.set(run.id, run);
    this.notify(run);
  }
  countActive() {
    let n = 0;
    for (const r of this.runs.values()) {
      if (!isTerminal(r.status) && r.status !== "queued") n++;
    }
    return n;
  }
  /**
   * v0.9 Item 2(c): count active runs whose persona name is in the given set.
   * Used by SpawnQueue to enforce maxConcurrentWriteCapable.
   */
  countActiveBy(personaNames) {
    let n = 0;
    for (const r of this.runs.values()) {
      if (!isTerminal(r.status) && r.status !== "queued" && personaNames.has(r.persona)) {
        n++;
      }
    }
    return n;
  }
  countQueued() {
    let n = 0;
    for (const r of this.runs.values()) {
      if (r.status === "queued") n++;
    }
    return n;
  }
  /** Subscribe to any run state change. Returns an unsubscribe fn. */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  notify(run) {
    for (const fn of this.listeners) {
      try {
        fn(run);
      } catch {
      }
    }
  }
};
function recordSpawnedProc(run, proc) {
  run.proc = proc;
  run.pid = proc.pid;
}
function snapshotInvocationMarkers(run) {
  run.thisInvocationStartedAt = Date.now();
  run.thisInvocationUsageBaseline = {
    turns: run.usage.turns,
    input: run.usage.input,
    output: run.usage.output,
    cost: run.usage.cost
  };
  run.resumeCount = (run.resumeCount ?? 0) + 1;
}
function stampSpawnStreamingMode(run, steerable) {
  run.steerable = steerable;
  run.streamingMode = steerable ? "rpc" : "print";
}
async function attachSpawnedProc(run, proc) {
  recordSpawnedProc(run, proc);
  await writeRecord(run);
}
function spawnRun(opts) {
  const id = opts.preAllocatedId ?? allocateRunId(opts.persona.name, mapFromRegistry(opts.registry));
  const dir = runDir(id);
  mkdirSync3(dir, { recursive: true });
  const run = {
    id,
    persona: opts.persona.name,
    task: opts.task,
    model: opts.model,
    thinking: opts.thinking,
    mode: opts.mode,
    status: "running",
    startTime: Date.now(),
    lastEventAt: Date.now(),
    messages: [],
    usage: emptyUsage(),
    cwd: opts.cwd,
    recordPath: join4(dir, "record.json"),
    transcriptPath: join4(dir, "transcript.jsonl"),
    finalPath: join4(dir, "final.md"),
    sessionPath: void 0,
    // Capture the persona body now so future ensemble_send calls can
    // re-pass it on resume. Pi doesn't persist system prompts to disk.
    // Item 13: assemblePersonaSystemPrompt prepends the read-only
    // enforcer when persona.readOnly is true. Captured ONCE here so
    // resumes re-pass the already-prepended body without doubling it.
    systemPrompt: assemblePersonaSystemPrompt(opts.persona),
    // Item 15: per-invocation markers. Initial spawn IS the start of
    // the (sole, so far) invocation, so:
    //   - thisInvocationStartedAt mirrors startTime
    //   - thisInvocationUsageBaseline is zeros (delta from spawn-time = lifetime)
    //   - resumeCount = 0 (no resumes yet)
    // sendToRun re-stamps these on every resume BEFORE the subprocess fires.
    thisInvocationStartedAt: Date.now(),
    thisInvocationUsageBaseline: { turns: 0, input: 0, output: 0, cost: 0 },
    resumeCount: 0,
    // v0.10 watchdog (Slice 3) per-spawn overrides; undefined falls
    // back to conductor-wide defaults at watchdog dispatch time.
    killOnStall: opts.killOnStall,
    softStallSeconds: opts.softStallSeconds,
    // Ownership scoping: persist the conductor host pid (and Linux
    // start-time fingerprint) so sibling pi sessions reading the
    // global runs/ root can skip-foreign records they don't own.
    // Survives /reload (in-process re-import). See
    // `classifyRecord` `skip-foreign` branch.
    parentPid: process.pid,
    parentStartTime: readProcessStartTime(process.pid),
    // v0.12 slice 4 — stamp the cascade-collapsed steerable on the Run
    // BEFORE the spawn pipeline runs. `runPiSubprocess` re-stamps via
    // `stampSpawnStreamingMode` (idempotent) once the subprocess is
    // up; setting it here means resolveSendStrategy and the watchdog
    // see a consistent shape during the brief pre-spawn window.
    steerable: opts.steerable === true
  };
  opts.registry.register(run);
  void writeRecord(run);
  const prompt = buildSubAgentPrompt(opts.persona, opts.task);
  const sessionDir = join4(dir, "session");
  mkdirSync3(sessionDir, { recursive: true });
  const plan = planSpawnPiArgs({
    persona: opts.persona,
    parentMessages: opts.parentMessages,
    sessionDir,
    // Item 13: prepend read-only enforcer when applicable. Same
    // assembly used at the Run.systemPrompt capture above so the
    // initial spawn argv and resume argv stay byte-identical for
    // a given persona.
    systemPrompt: assemblePersonaSystemPrompt(opts.persona),
    prompt,
    cwd: opts.cwd,
    model: opts.model,
    thinking: opts.thinking,
    // PRD #15: when `inherit_skills: true`, pass the parent's user +
    // project skill dirs to the sub-agent via `--skill <path>`. The
    // flag is consumed at spawn time and not propagated into the
    // sub-agent's env, so a sub-agent spawning a further sub-agent
    // does NOT re-inherit (we discourage that pattern anyway).
    skillPaths: opts.persona.inheritSkills ? collectInheritedSkillPaths({ cwd: opts.cwd }) : void 0,
    // v0.12 slice 4 — thread the cascade-collapsed steerable so the
    // argv shape matches the runPiSubprocess `steerable` we pass
    // below. Both must agree or pi will boot with the wrong stdio.
    steerable: opts.steerable === true,
    // Item 12 candidate #3 — thread the per-call inherit_context
    // override into planSpawnPiArgs so the filter selection (filtered
    // / filtered_compact / full / none) honors the LLM tool's per-call
    // arg above the persona's frontmatter. See src/inherit-context.ts.
    inheritContextOverride: opts.inheritContextOverride
  });
  if (plan.seededSessionPath) run.sessionPath = plan.seededSessionPath;
  const done = runPiSubprocess(run, plan.piArgs, {
    registry: opts.registry,
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    onUpdate: opts.onUpdate,
    onComplete: opts.onComplete,
    // Only let the subprocess discover a session file when we didn't pre-seed
    // one — in resume mode the path is fixed.
    sessionDir: plan.seededSessionPath ? void 0 : sessionDir,
    // v0.12 slice 4 — thread the cascade-collapsed steerable into
    // runPiSubprocess so the subprocess `stdio[0]` branch (`pipe` vs
    // `ignore`) and the post-spawn `Run.streamingMode` stamp match
    // the argv shape produced above. Slice 3 hard-coded `false`; the
    // dead value was a known TODO.
    steerable: opts.steerable === true,
    // v0.12 slice 4 — when steerable, the prompt is delivered as the
    // first `prompt` RPC command on stdin (not as the trailing argv
    // positional, which RPC mode ignores). `runPiSubprocess` enqueues
    // it via `RpcStdinQueue` once the subprocess is up.
    initialPrompt: opts.steerable === true ? prompt : void 0,
    // v0.11 on_complete_hook (slice 2): resolve at spawn time from the
    // current config layers + persona frontmatter. Per-call args land
    // in slice 3; for slice 2 the per-call layer is always undefined.
    // Tests inject `resolvedHook` directly via the spawn-options surface.
    resolvedHook: resolveCloseHook(
      opts.cwd,
      opts.persona.name,
      void 0,
      // per-call (slice 3)
      hookSpecFromPersona(opts.persona)
    )
  });
  return { run, done };
}
function resolveCloseHook(cwd, personaName, perCall, personaFrontmatter) {
  const layered = loadConfigWithErrors(cwd);
  const project = hookSpecFromOverride(
    layered.project.personaOverrides[personaName]
  );
  const user = hookSpecFromOverride(
    layered.user.personaOverrides[personaName]
  );
  const input = {
    perCall,
    project,
    user,
    persona: personaFrontmatter
  };
  return resolveOnCompleteHook(input);
}
function hookSpecFromOverride(override) {
  if (!override) return void 0;
  if (override.onCompleteHook === void 0) return void 0;
  return {
    command: override.onCompleteHook,
    timeoutSeconds: override.onCompleteHookTimeoutSeconds
  };
}
function hookSpecFromPersona(persona) {
  if (persona.onCompleteHook === void 0) return void 0;
  return {
    command: persona.onCompleteHook,
    timeoutSeconds: persona.onCompleteHookTimeoutSeconds
  };
}
function runPiSubprocess(run, piArgs, opts) {
  const invocation = getPiInvocation(piArgs);
  const stdinKind = opts.steerable ? "pipe" : "ignore";
  let proc;
  try {
    proc = spawn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      shell: false,
      stdio: [stdinKind, "pipe", "pipe"],
      env: buildSubagentEnv()
    });
  } catch (e) {
    run.status = "failed";
    run.errorMessage = `spawn failed: ${e.message}`;
    run.finishedAt = Date.now();
    opts.registry.notify(run);
    void writeRecord(run);
    void writeFinal(run);
    if (opts.onComplete) opts.onComplete(run);
    return Promise.resolve(run);
  }
  void attachSpawnedProc(run, proc);
  stampSpawnStreamingMode(run, opts.steerable === true);
  if (opts.steerable === true && proc.stdin) {
    const queue = new RpcStdinQueue(proc.stdin);
    run.rpcStdinQueue = queue;
    if (typeof opts.initialPrompt === "string" && opts.initialPrompt.length > 0) {
      void queue.enqueue({
        id: `init-${run.id}`,
        type: "prompt",
        message: opts.initialPrompt
      }).catch(() => {
      });
    }
  }
  run.timeoutTimer = setTimeout(() => {
    if (run.status === "running" || run.status === "paused") {
      forceTerminate(run, "timeout", opts.registry, opts.onComplete);
    }
  }, opts.timeoutMs);
  let buffer = "";
  let stderr = "";
  let finalized = false;
  let donePromiseResolve;
  const done = new Promise((resolve2) => {
    donePromiseResolve = resolve2;
  });
  const finalize = async (terminal, exitCode) => {
    if (finalized) return;
    finalized = true;
    if (run.timeoutTimer) {
      clearTimeout(run.timeoutTimer);
      run.timeoutTimer = void 0;
    }
    if (buffer.trim()) processLine(buffer);
    if (terminal === "completed" && exitCode === 0 && opts.resolvedHook && !isTerminal(run.status)) {
      try {
        terminal = await applyHookToTerminal(
          run,
          opts.resolvedHook,
          terminal
        );
      } catch (e) {
        run.hookResult = {
          passed: false,
          command: opts.resolvedHook.command,
          exitCode: null,
          durationMs: 0,
          logPath: "",
          tailText: `(applyHookToTerminal threw) ${e.message}`,
          tailBytes: 0,
          tailLines: 0,
          failureKind: "spawn_error"
        };
        terminal = "hook_failed";
      }
    }
    if (!applyCloseHandlerTerminal(run, terminal, exitCode)) {
      discoverSessionPathIfMissing(run, opts.sessionDir);
      run.proc = void 0;
      try {
        proc.kill();
      } catch {
      }
      donePromiseResolve(run);
      return;
    }
    if (terminal === "failed" && !run.errorMessage) {
      run.errorMessage = stderr.trim() || `pi subprocess exited with code ${exitCode}`;
    }
    applySubstanceCheck(run, terminal);
    discoverSessionPathIfMissing(run, opts.sessionDir);
    run.proc = void 0;
    opts.registry.notify(run);
    try {
      proc.kill();
    } catch {
    }
    Promise.all([writeRecord(run), writeFinal(run)]).catch(() => {
    }).finally(() => {
      if (opts.onComplete) {
        try {
          opts.onComplete(run);
        } catch {
        }
      }
      donePromiseResolve(run);
    });
  };
  const processLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    void appendFile(run.transcriptPath, line + "\n").catch(() => {
    });
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    const effect = applyEvent(run, event);
    if (effect.kind === "finalize") {
      void finalize(effect.status, effect.exitCode);
      return;
    }
    if (effect.kind === "updated") {
      opts.registry.notify(run);
      if (opts.onUpdate) opts.onUpdate(run);
    }
  };
  proc.stdout?.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) processLine(line);
  });
  proc.stderr?.on("data", (data) => {
    stderr += data.toString();
  });
  proc.on("close", (code) => {
    if (finalized) return;
    if ((code ?? 0) === 0) void finalize("completed", 0);
    else void finalize("failed", code ?? 0);
  });
  proc.on("error", () => {
    run.errorMessage = "failed to spawn pi process";
    void finalize("failed", 1);
  });
  proc.unref();
  return done;
}
function mapFromRegistry(r) {
  const m = /* @__PURE__ */ new Map();
  for (const x of r.list()) m.set(x.id, x);
  return m;
}
function validateSendable(run) {
  const r = resolveSendStrategy(run, "auto");
  if (r.strategy.kind === "rejected") {
    return { ok: false, reason: r.strategy.reason };
  }
  if (run.sessionPath && !existsSync3(run.sessionPath)) {
    return {
      ok: false,
      reason: `sub-agent ${run.id} session file is missing on disk: ${run.sessionPath}`
    };
  }
  return { ok: true };
}
function resolveSendStrategy(run, behavior = "auto") {
  if (run.status === "running") {
    const isRpc = run.streamingMode === "rpc";
    if (!isRpc) {
      return {
        strategy: {
          kind: "rejected",
          reason: `sub-agent ${run.id} is not steerable; mark steerable: true at spawn to send messages while the subprocess is alive. (Currently running; wait for it to finish before sending again.)`
        }
      };
    }
    if (behavior === "steer") return { strategy: { kind: "rpc-steer" } };
    if (behavior === "follow_up" || behavior === "auto") {
      return { strategy: { kind: "rpc-follow-up" } };
    }
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} is currently running; resume is for terminal runs only. Use streaming_behavior=steer or follow_up to send to the live subprocess.`
      }
    };
  }
  if (run.status === "paused") {
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} is paused; resume it first via /conductor resume ${run.id}.`
      }
    };
  }
  if (run.status === "queued") {
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} is queued and has not started yet; wait for it to start before sending.`
      }
    };
  }
  if (behavior === "steer") {
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} has already finished; cannot steer a terminal run. Send without streaming_behavior to spawn a fresh subprocess.`
      }
    };
  }
  if (behavior === "follow_up") {
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} has already finished; cannot follow_up a terminal run. Send without streaming_behavior to spawn a fresh subprocess.`
      }
    };
  }
  if (!run.sessionPath) {
    return {
      strategy: {
        kind: "rejected",
        reason: `sub-agent ${run.id} has no resumable session on disk (sessionPath unset).`
      }
    };
  }
  return { strategy: { kind: "spawn-resume" } };
}
var RPC_ACK_TIMEOUT_MS = 3e4;
var rpcSendCounter = 0;
function enqueueRpcSendWithAck(run, type, message) {
  const queue = run.rpcStdinQueue;
  if (!queue) {
    return {
      kind: "epipe",
      reason: `sub-agent ${run.id} finished before steer was delivered (stdin queue gone).`
    };
  }
  if (!run.pendingAcks) run.pendingAcks = /* @__PURE__ */ new Map();
  rpcSendCounter += 1;
  const id = `send-${run.id}-${rpcSendCounter}`;
  const ackPromise = new Promise(
    (resolve2, reject) => {
      const timer = setTimeout(() => {
        run.pendingAcks?.delete(id);
        reject(
          new Error(
            `ack timeout \u2014 sub-agent may have received the message; check via ensemble_status`
          )
        );
      }, RPC_ACK_TIMEOUT_MS);
      run.pendingAcks.set(id, {
        resolve: (delivered) => resolve2({ delivered, deliveredAt: Date.now() }),
        reject,
        timer
      });
    }
  );
  let epipeFlag = null;
  void queue.enqueue({ id, type, message }).catch((err) => {
    const entry = run.pendingAcks?.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      run.pendingAcks?.delete(id);
      entry.reject(
        new Error(
          `sub-agent ${run.id} finished before steer was delivered (${err.message}).`
        )
      );
    }
    epipeFlag = { msg: err.message };
  });
  if (epipeFlag) {
    return {
      kind: "epipe",
      reason: `sub-agent ${run.id} finished before steer was delivered.`
    };
  }
  return { kind: "queued", ack: ackPromise };
}
function sendToRun(run, message, opts) {
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      kind: "rejected",
      reason: `cannot send an empty message to sub-agent ${run.id}.`
    };
  }
  const behavior = opts.streamingBehavior ?? "auto";
  const decision = resolveSendStrategy(run, behavior);
  if (decision.strategy.kind === "rejected") {
    return { kind: "rejected", reason: decision.strategy.reason };
  }
  if (decision.strategy.kind === "rpc-steer" || decision.strategy.kind === "rpc-follow-up") {
    const cmdType = decision.strategy.kind === "rpc-steer" ? "steer" : "follow_up";
    if (opts.killOnStall !== void 0) run.killOnStall = opts.killOnStall;
    if (opts.softStallSeconds !== void 0) run.softStallSeconds = opts.softStallSeconds;
    snapshotInvocationMarkers(run);
    const result = enqueueRpcSendWithAck(run, cmdType, trimmed);
    if (result.kind === "epipe") {
      return { kind: "rejected", reason: result.reason };
    }
    const done2 = new Promise((resolve2) => {
      const unsub = opts.registry.onChange((r) => {
        if (r.id === run.id && isTerminal(r.status)) {
          unsub();
          resolve2(r);
        }
      });
    });
    return { kind: "started", run, done: done2, ack: result.ack };
  }
  if (run.sessionPath && !existsSync3(run.sessionPath)) {
    return {
      kind: "rejected",
      reason: `sub-agent ${run.id} session file is missing on disk: ${run.sessionPath}`
    };
  }
  run.status = "running";
  run.finishedAt = void 0;
  run.exitCode = void 0;
  run.errorMessage = void 0;
  run.stopReason = void 0;
  run.lastToolCall = void 0;
  run.lastEventAt = Date.now();
  run.stalledSince = void 0;
  snapshotInvocationMarkers(run);
  if (opts.killOnStall !== void 0) run.killOnStall = opts.killOnStall;
  if (opts.softStallSeconds !== void 0) run.softStallSeconds = opts.softStallSeconds;
  opts.registry.notify(run);
  const sessionPath = run.sessionPath;
  const piArgs = buildResumePiArgs(run, trimmed);
  const done = runPiSubprocess(run, piArgs, {
    registry: opts.registry,
    cwd: run.cwd,
    timeoutMs: opts.timeoutMs,
    onUpdate: opts.onUpdate,
    onComplete: opts.onComplete,
    // Re-discover sessionPath on finalize — the file path is stable but the
    // mtime updates, which lets future sends still find it.
    sessionDir: dirname4(sessionPath),
    // v0.12 steering: spawn-resume on a terminal run is always
    // print-mode by design (§4.4 archived-run compat / Q10 lock).
    // The live RPC paths (`rpc-steer` / `rpc-follow-up`) ride the
    // existing subprocess via `Run.rpcStdinQueue` and never hit this
    // branch — see the early-return in `sendToRun` above. This
    // argument is hard-coded `false` because `pi --session` resume
    // does not promise to re-enter RPC mode (the original subprocess
    // is gone; no stickiness across the boundary).
    steerable: false,
    initialPrompt: void 0,
    // v0.11 on_complete_hook (slice 2): re-resolve at every terminal
    // transition so config changes between spawn and re-fire are
    // honored (§4.6: each terminal is a fresh gate). Per-call layer
    // wires in slice 3; persona-frontmatter layer in slice 4.
    resolvedHook: resolveCloseHook(run.cwd, run.persona)
  });
  return { kind: "started", run, done };
}
function applyCloseHandlerTerminal(run, terminal, exitCode) {
  if (isTerminal(run.status)) return false;
  run.status = terminal;
  run.exitCode = exitCode;
  run.finishedAt = Date.now();
  return true;
}
function applySubstanceCheck(run, terminal) {
  if (terminal !== "completed") return;
  if (run.nonSubstantiveFinal) return;
  const check = isNonSubstantiveFinalMessage(run.messages);
  if (check.warn && check.reason && check.message) {
    run.nonSubstantiveFinal = { reason: check.reason, message: check.message };
  }
}
async function applyHookToTerminal(run, resolvedHook, terminal, deps = {}) {
  try {
    await writeFinal(run);
  } catch {
  }
  const runHookImpl = deps.runHookImpl ?? runHook;
  run.hookExecuting = true;
  try {
    const hookResult = await runHookImpl({
      resolved: resolvedHook,
      runId: run.id,
      persona: run.persona,
      runDir: dirname4(run.finalPath),
      finalPath: run.finalPath,
      transcriptPath: run.transcriptPath,
      parentCwd: run.cwd,
      onProc: (proc) => {
        run.hookProc = proc;
      }
    });
    if (isTerminal(run.status)) {
      return run.status;
    }
    run.hookResult = hookResult;
    if (!hookResult.passed) {
      return "hook_failed";
    }
    return terminal;
  } finally {
    run.hookExecuting = false;
    run.hookProc = void 0;
  }
}
function forceTerminate(run, reason, registry, onComplete, killGroup = defaultKillGroup) {
  if (isTerminal(run.status)) return;
  if (run.parentPid !== void 0 && run.parentPid !== process.pid) {
    console.warn(
      `forceTerminate: refusing to mutate foreign run id=${run.id} ownerPid=${run.parentPid} selfPid=${process.pid}`
    );
    return;
  }
  if (run.timeoutTimer) {
    clearTimeout(run.timeoutTimer);
    run.timeoutTimer = void 0;
  }
  if (run.streamingMode === "rpc") {
    if (run.pendingAcks) {
      const err = new Error(`RpcStdinQueue destroyed: force-terminate`);
      for (const entry of run.pendingAcks.values()) {
        clearTimeout(entry.timer);
        try {
          entry.reject(err);
        } catch {
        }
      }
      run.pendingAcks.clear();
    }
    if (run.rpcStdinQueue) {
      try {
        run.rpcStdinQueue.destroy("force-terminate");
      } catch {
      }
    }
  }
  if (run.proc) {
    try {
      run.proc.kill("SIGTERM");
    } catch {
    }
    setTimeout(() => {
      try {
        run.proc?.kill("SIGKILL");
      } catch {
      }
    }, 2e3).unref();
  }
  if (run.hookProc?.pid !== void 0) {
    const hookPid = run.hookProc.pid;
    try {
      killGroup(hookPid, "SIGTERM");
    } catch {
    }
    setTimeout(() => {
      try {
        killGroup(hookPid, "SIGKILL");
      } catch {
      }
    }, 2e3).unref();
    run.hookProc = void 0;
  }
  run.status = reason === "timeout" ? "timeout" : reason === "stalled" ? "killed" : "killed";
  if (reason === "stalled" && !run.errorMessage) {
    run.errorMessage = "watchdog: hard-stalled (no events past hard threshold)";
  }
  run.finishedAt = Date.now();
  registry.notify(run);
  void writeRecord(run);
  void writeFinal(run);
  if (onComplete) {
    try {
      onComplete(run);
    } catch {
    }
  }
}
var defaultSignaler2 = (pid, signal) => {
  process.kill(pid, signal);
};
function pauseRun(run, registry, signaler = defaultSignaler2) {
  if (run.status !== "running") return false;
  if (!run.proc?.pid) return false;
  try {
    signaler(run.proc.pid, "SIGSTOP");
  } catch {
    return false;
  }
  run.status = "paused";
  run.pausedAt = Date.now();
  registry.notify(run);
  void writeRecord(run);
  return true;
}
function resumeRun(run, registry, signaler = defaultSignaler2) {
  if (run.status !== "paused") return false;
  if (!run.proc?.pid) return false;
  try {
    signaler(run.proc.pid, "SIGCONT");
  } catch {
    return false;
  }
  run.status = "running";
  run.pausedAt = void 0;
  registry.notify(run);
  void writeRecord(run);
  return true;
}
async function reconcileRecord(run, status, errorMessage, finishedAt) {
  run.status = status;
  run.finishedAt = finishedAt;
  run.errorMessage = errorMessage;
  await writeRecord(run);
}
async function writeRecord(run) {
  try {
    await mkdir(dirname4(run.recordPath), { recursive: true });
    await writeFile2(run.recordPath, JSON.stringify(toRunRecord(run), null, 2));
  } catch {
  }
}
async function writeFinal(run) {
  try {
    await mkdir(dirname4(run.finalPath), { recursive: true });
    await writeFile2(run.finalPath, getFinalText(run.messages) || "(no output)");
  } catch {
  }
}
function getFinalText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
      const texts = [];
      for (const part of msg.content) {
        if (part.type === "text") texts.push(part.text);
      }
      if (texts.length > 0) return texts.join("").trim();
    }
  }
  return "";
}
function formatTokens(n) {
  if (n < 1e3) return String(n);
  if (n < 1e4) return `${(n / 1e3).toFixed(1)}k`;
  if (n < 1e6) return `${Math.round(n / 1e3)}k`;
  return `${(n / 1e6).toFixed(1)}M`;
}
function formatUsage(u) {
  const parts = [];
  if (u.turns) parts.push(`${u.turns}t`);
  if (u.input) parts.push(`\u2191${formatTokens(u.input)}`);
  if (u.output) parts.push(`\u2193${formatTokens(u.output)}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(3)}`);
  return parts.join(" ");
}
function elapsedStr(start, end) {
  const s = ((end || Date.now()) - start) / 1e3;
  if (s < 60) return `${Math.round(s)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

// src/doctor.ts
import { existsSync as existsSync6 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join7 } from "node:path";

// src/gc/last-gc.ts
import { existsSync as existsSync4, statSync as statSync2, utimesSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname5, join as join5 } from "node:path";
function lastGcMarkerPath(runsRoot2) {
  return join5(dirname5(runsRoot2), ".last-gc");
}
function readLastGcMtime(runsRoot2) {
  const path = lastGcMarkerPath(runsRoot2);
  if (!existsSync4(path)) return null;
  try {
    return statSync2(path).mtimeMs;
  } catch {
    return null;
  }
}
function writeLastGcMtime(runsRoot2, now) {
  const path = lastGcMarkerPath(runsRoot2);
  try {
    if (!existsSync4(path)) writeFileSync2(path, "");
    const t = new Date(now);
    utimesSync(path, t, t);
  } catch {
  }
}

// src/gc/inventory.ts
import { readdir as readdir3, readFile as readFile3, stat as stat3 } from "node:fs/promises";
import { existsSync as existsSync5 } from "node:fs";
import { join as join6 } from "node:path";
async function safeStat(path) {
  try {
    const s = await stat3(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}
async function readRecord(runDir2) {
  try {
    const text = await readFile3(join6(runDir2, "record.json"), "utf-8");
    const parsed = JSON.parse(text);
    if (typeof parsed.id !== "string" || typeof parsed.persona !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
async function detectSessionPath(runDir2) {
  const sessionDir = join6(runDir2, "session");
  if (!existsSync5(sessionDir)) return false;
  try {
    const entries = await readdir3(sessionDir);
    return entries.some((e) => e.endsWith(".jsonl"));
  } catch {
    return false;
  }
}
async function walkInventory(runsRoot2, registry) {
  if (!existsSync5(runsRoot2)) return [];
  let entries;
  try {
    entries = await readdir3(runsRoot2);
  } catch {
    return [];
  }
  const out = [];
  for (const id of entries) {
    const runDir2 = join6(runsRoot2, id);
    let isDir = false;
    try {
      isDir = (await stat3(runDir2)).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    out.push(await buildEntry(id, runDir2, registry));
  }
  return out;
}
async function buildEntry(id, runDir2, registry) {
  const record = await readRecord(runDir2);
  const transcriptStat = await safeStat(join6(runDir2, "transcript.jsonl"));
  const recordStat = await safeStat(join6(runDir2, "record.json"));
  const finalStat = await safeStat(join6(runDir2, "final.md"));
  const archivedStat = await safeStat(join6(runDir2, ".archived"));
  const pinned = existsSync5(join6(runDir2, ".pinned"));
  const sessionPathPresent = await detectSessionPath(runDir2);
  const inMemory = registry.get(id);
  const transcriptSizeBytes = transcriptStat?.size ?? 0;
  const recordSizeBytes = recordStat?.size ?? 0;
  const finalSizeBytes = finalStat?.size ?? 0;
  const totalSizeBytes = transcriptSizeBytes + recordSizeBytes + finalSizeBytes;
  if (!record) {
    return {
      id,
      runDir: runDir2,
      persona: "<unknown>",
      status: "failed",
      startTime: 0,
      finishedAt: null,
      transcriptMtime: transcriptStat?.mtimeMs ?? null,
      transcriptSizeBytes,
      recordSizeBytes,
      finalSizeBytes,
      totalSizeBytes,
      pinned,
      archived: archivedStat !== null,
      archivedAt: archivedStat?.mtimeMs ?? null,
      sessionPathPresent,
      inMemory,
      malformed: true
    };
  }
  return {
    id,
    runDir: runDir2,
    persona: record.persona,
    status: record.status,
    startTime: record.startTime,
    finishedAt: record.finishedAt ?? null,
    transcriptMtime: transcriptStat?.mtimeMs ?? null,
    transcriptSizeBytes,
    recordSizeBytes,
    finalSizeBytes,
    totalSizeBytes,
    pinned,
    archived: archivedStat !== null,
    archivedAt: archivedStat?.mtimeMs ?? null,
    sessionPathPresent,
    inMemory,
    malformed: false
  };
}

// src/gc/policy.ts
var HOUR_MS = 60 * 60 * 1e3;
var DAY_MS = 24 * HOUR_MS;
function ttlDaysFor(entry, config) {
  const personaOverride = config.perPersonaTtlDays[entry.persona];
  if (typeof personaOverride === "number" && personaOverride > 0) {
    return personaOverride;
  }
  return entry.status === "completed" ? config.completedTtlDays : config.failedTtlDays;
}
function transcriptCapFor(_entry, config) {
  return config.transcriptSizeCapBytes;
}
function planReclaim(inventory, config, now) {
  if (!config.enabled) {
    const totalBytes = inventory.reduce((s, e) => s + e.totalSizeBytes, 0);
    return {
      actions: inventory.map((e) => ({
        kind: "keep",
        id: e.id,
        reason: "gc disabled"
      })),
      totalBytesBefore: totalBytes,
      totalBytesReclaimed: 0,
      pinnedBytes: inventory.filter((e) => e.pinned).reduce((s, e) => s + e.totalSizeBytes, 0),
      runsLoseResume: 0
    };
  }
  const orphanThresholdMs = now - config.orphanReconcileAfterHours * HOUR_MS;
  const actions = [];
  const eligibleForBudget = [];
  for (const entry of inventory) {
    const action = decideForEntry(entry, config, now, orphanThresholdMs);
    actions.push(action);
    if (action.kind === "keep" && action.reason === "within thresholds") {
      eligibleForBudget.push(entry);
    }
  }
  const totalBytesBefore = inventory.reduce((s, e) => s + e.totalSizeBytes, 0);
  let projectedBytes = totalBytesBefore;
  for (const a of actions) {
    if (a.kind === "cold-archive" || a.kind === "delete") projectedBytes -= a.bytesReclaimed;
  }
  if (projectedBytes > config.totalSizeBudgetBytes && eligibleForBudget.length > 0) {
    const ranked = [...eligibleForBudget].sort((a, b) => {
      if (b.transcriptSizeBytes !== a.transcriptSizeBytes) {
        return b.transcriptSizeBytes - a.transcriptSizeBytes;
      }
      return (a.finishedAt ?? a.startTime) - (b.finishedAt ?? b.startTime);
    });
    for (const entry of ranked) {
      if (projectedBytes <= config.totalSizeBudgetBytes) break;
      const idx = actions.findIndex((a) => a.id === entry.id);
      if (idx === -1) continue;
      const reclaim = entry.transcriptSizeBytes;
      actions[idx] = {
        kind: "cold-archive",
        id: entry.id,
        reason: "size-budget eviction (largest-first)",
        bytesReclaimed: reclaim
      };
      projectedBytes -= reclaim;
    }
  }
  let totalBytesReclaimed = 0;
  let runsLoseResume = 0;
  let pinnedBytes = 0;
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    const e = inventory[i];
    if (a.kind === "cold-archive" || a.kind === "delete") {
      totalBytesReclaimed += a.bytesReclaimed;
    }
    if (a.kind === "delete" && e.sessionPathPresent) runsLoseResume++;
    if (e.pinned) pinnedBytes += e.totalSizeBytes;
  }
  return {
    actions,
    totalBytesBefore,
    totalBytesReclaimed,
    pinnedBytes,
    runsLoseResume
  };
}
function decideForEntry(entry, config, now, orphanThresholdMs) {
  if (entry.inMemory) {
    const mem = entry.inMemory;
    const proc = mem.proc;
    if (proc !== void 0 || !isTerminal(mem.status)) {
      return { kind: "keep", id: entry.id, reason: "active in registry" };
    }
  }
  if (entry.status === "running" && !entry.inMemory) {
    const ageBasis = entry.transcriptMtime ?? entry.startTime;
    if (ageBasis < orphanThresholdMs) {
      return {
        kind: "reconcile-orphan",
        id: entry.id,
        reason: `orphaned: status=running, no live process, stale > ${config.orphanReconcileAfterHours}h`
      };
    }
    return {
      kind: "keep",
      id: entry.id,
      reason: "running but fresh; awaiting orphan TTL"
    };
  }
  if (entry.malformed) {
    return {
      kind: "keep",
      id: entry.id,
      reason: "malformed record; surfaced for manual review"
    };
  }
  if (entry.pinned && isTerminal(entry.status)) {
    return { kind: "keep", id: entry.id, reason: "pinned" };
  }
  if (entry.archived) {
    const archivedAt = entry.archivedAt ?? entry.startTime;
    const ageMs = now - archivedAt;
    const ttlDays = ttlDaysFor(entry, config);
    if (ageMs > ttlDays * DAY_MS) {
      return {
        kind: "delete",
        id: entry.id,
        reason: `archived for > ${ttlDays}d`,
        bytesReclaimed: entry.totalSizeBytes,
        losesResume: entry.sessionPathPresent
      };
    }
    return { kind: "keep", id: entry.id, reason: "archived; within TTL" };
  }
  if (isTerminal(entry.status) && entry.transcriptSizeBytes > transcriptCapFor(entry, config)) {
    return {
      kind: "cold-archive",
      id: entry.id,
      reason: `transcript-cap exceeded (${entry.transcriptSizeBytes} > ${transcriptCapFor(entry, config)})`,
      bytesReclaimed: entry.transcriptSizeBytes
    };
  }
  return { kind: "keep", id: entry.id, reason: "within thresholds" };
}

// src/doctor.ts
async function buildDoctorReport(opts) {
  const { config: cfg, errors: configErrors } = loadConfigWithErrors(opts.cwd);
  const resolved = await resolvePersonas({
    cwd: opts.cwd,
    personaOverrides: cfg.personaOverrides
  });
  const lines = ["pi-conductor doctor", ""];
  lines.push(`## Personas (${resolved.personas.size} resolved)`);
  if (resolved.personas.size === 0) {
    lines.push("  \u2717 no personas resolved");
  } else {
    const counts = countBySource(resolved);
    lines.push(`  \u2713 builtin=${counts.builtin}, user=${counts.user}, project=${counts.project}`);
  }
  const shadowed = [...resolved.shadowed.entries()].filter(([, list]) => list.length > 1);
  if (shadowed.length > 0) {
    lines.push("");
    lines.push("## Shadowed (overridden) personas");
    for (const [name, list] of shadowed) {
      const winning = list[list.length - 1];
      lines.push(`  ${name}: ${list.length} sources, winning = ${winning.source}`);
      for (const p of list) {
        const marker = p === winning ? "  \u2713" : "   ";
        lines.push(`    ${marker} ${p.source.padEnd(8)} ${p.sourcePath}`);
      }
    }
  }
  if (resolved.errors.length > 0) {
    lines.push("");
    lines.push(`## Persona parse errors (${resolved.errors.length})`);
    for (const e of resolved.errors) {
      lines.push(`  \u2717 ${e.path}`);
      lines.push(`    ${e.reason}`);
    }
  }
  if (configErrors.length > 0) {
    lines.push("");
    lines.push(`## Config errors (${configErrors.length})`);
    for (const e of configErrors) {
      lines.push(`  \u2717 ${e.path}`);
      lines.push(`    ${e.reason}`);
    }
  }
  const unknownOverrides = Object.keys(cfg.personaOverrides).filter(
    (n) => !resolved.shadowed.has(n)
  );
  if (unknownOverrides.length > 0) {
    lines.push("");
    lines.push("## Unknown persona overrides");
    for (const n of unknownOverrides) {
      lines.push(`  \u26A0 override "${n}" does not match any persona`);
    }
  }
  lines.push("");
  lines.push("## Config files");
  const userPath = userConfigPath();
  const projectPath = projectConfigPath(opts.cwd);
  lines.push(`  user:    ${existsSync6(userPath) ? "\u2713" : "\xB7"} ${userPath}`);
  lines.push(`  project: ${existsSync6(projectPath) ? "\u2713" : "\xB7"} ${projectPath}`);
  const home = opts.homeDir ?? homedir4();
  const legacyDir = join7(home, ".pi", "agent", "extensions", "conductor");
  const legacyJs = join7(legacyDir, "index.js");
  const legacyTs = join7(legacyDir, "index.ts");
  const legacyEntry = existsSync6(legacyJs) ? legacyJs : existsSync6(legacyTs) ? legacyTs : null;
  if (legacyEntry !== null) {
    lines.push("");
    lines.push("## Legacy install path detected");
    lines.push(`  \u26A0 ${legacyEntry}`);
    lines.push(
      "    pi-conductor is being auto-loaded from ~/.pi/agent/extensions/."
    );
    lines.push(
      "    If it is also installed via settings.packages[] or `pi -e`, the"
    );
    lines.push(
      "    dual-load can break persona discovery (0 personas resolved)."
    );
    lines.push(
      `    Recommended fix: rm ${legacyEntry}  (the dir + config.json may stay).`
    );
  }
  lines.push("");
  lines.push("## Resolved config");
  lines.push(`  defaultTimeoutMinutes: ${cfg.defaultTimeoutMinutes}`);
  lines.push(`  maxConcurrent:         ${cfg.maxConcurrent}`);
  lines.push(`  maxConcurrentWriteCapable: ${cfg.maxConcurrentWriteCapable}`);
  lines.push(`  queueOnConcurrencyCap: ${cfg.queueOnConcurrencyCap}`);
  lines.push(`  defaultSpawnMode:      ${cfg.defaultSpawnMode}`);
  lines.push(`  autoOpenFocusOnSpawn:  ${cfg.autoOpenFocusOnSpawn}`);
  lines.push(`  personaOverrides:      ${Object.keys(cfg.personaOverrides).length} entries`);
  lines.push(`  conductorMode:         ${opts.conductorMode ? "ON" : "off"}`);
  lines.push(
    `  gc:                    ${cfg.gc.enabled ? "enabled" : "DISABLED"} (completed=${cfg.gc.completedTtlDays}d, failed=${cfg.gc.failedTtlDays}d, budget=${Math.round(cfg.gc.totalSizeBudgetBytes / (1024 * 1024 * 1024))}GB)`
  );
  lines.push(
    `  gc auto:               ${cfg.gc.autoOnSessionStart ? "ON" : "off"} (debounce=${cfg.gc.autoDebounceHours}h)`
  );
  lines.push(
    `  watchdog:              ${cfg.watchdog.enabled ? "enabled" : "DISABLED"} (soft=${cfg.watchdog.defaultSoftSeconds}s, hard=${cfg.watchdog.defaultHardSeconds}s, grace=${cfg.watchdog.graceSeconds}s)`
  );
  lines.push(
    `  watchdog kill_on_stall: ${cfg.watchdog.defaultKillOnStall ? "ON (default)" : "off (default)"} \u2014 per-spawn override via ensemble_spawn kill_on_stall arg`
  );
  {
    const all = opts.registry.list();
    const activeCount = all.filter(
      (r) => r.status === "running" || r.status === "queued" || r.status === "paused"
    ).length;
    const stalledCount = all.filter((r) => r.stalledSince !== void 0).length;
    lines.push(
      `  watchdog runtime:      active=${activeCount}  stalled=${stalledCount}`
    );
  }
  {
    const root = opts.runsRoot ?? join7(opts.homeDir ?? homedir4(), ".pi", "agent", "conductor", "runs");
    const lastMs = readLastGcMtime(root);
    const lastStr = lastMs === null ? "never" : new Date(lastMs).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    lines.push(`  gc last run:           ${lastStr} (${lastGcMarkerPath(root)})`);
  }
  {
    const runsRoot2 = opts.runsRoot ?? join7(opts.homeDir ?? homedir4(), ".pi", "agent", "conductor", "runs");
    lines.push("");
    lines.push(`## Run records (under ${runsRoot2})`);
    if (!existsSync6(runsRoot2)) {
      lines.push("  (no run records)");
    } else {
      let inventory;
      try {
        inventory = await walkInventory(runsRoot2, opts.registry);
      } catch {
        inventory = [];
      }
      if (inventory.length === 0) {
        lines.push("  (no run records)");
      } else {
        const totalBytes = inventory.reduce((s, e) => s + e.totalSizeBytes, 0);
        const pinned = inventory.filter((e) => e.pinned);
        const pinnedBytes = pinned.reduce((s, e) => s + e.totalSizeBytes, 0);
        lines.push(
          `  total:                 ${inventory.length} runs, ${formatBytes(totalBytes)} on disk`
        );
        lines.push(
          `  pinned:                ${pinned.length} runs (${formatBytes(pinnedBytes)} protected)`
        );
        if (cfg.gc.enabled) {
          const now = opts.now ?? Date.now();
          const plan = planReclaim(inventory, cfg.gc, now);
          let orphans = 0;
          let archives = 0;
          let archiveBytes = 0;
          let deletes = 0;
          let deleteBytes = 0;
          for (const a of plan.actions) {
            if (a.kind === "reconcile-orphan") orphans++;
            else if (a.kind === "cold-archive") {
              archives++;
              archiveBytes += a.bytesReclaimed;
            } else if (a.kind === "delete") {
              deletes++;
              deleteBytes += a.bytesReclaimed;
            }
          }
          lines.push(
            `  orphaned:              ${orphans} records (status=running but stale, not in registry)`
          );
          lines.push(
            `  next eviction (dry):   ${archives} archive (~${formatBytes(archiveBytes)}), ${deletes} delete (~${formatBytes(deleteBytes)})`
          );
        } else {
          let orphans = 0;
          for (const e of inventory) {
            if (e.status === "running" && e.inMemory === void 0) orphans++;
          }
          lines.push(
            `  orphaned:              ${orphans} records (status=running but stale, not in registry)`
          );
          lines.push(`  (GC disabled)`);
        }
      }
    }
  }
  lines.push("");
  lines.push("## Post-startup reconcile");
  if (opts.lastReconcile === void 0) {
    lines.push("  last run:              never (no reconcile this session)");
  } else {
    for (const ln of renderReconcileSummary(opts.lastReconcile, { dryRun: false, includeHeader: false })) {
      lines.push(`  ${ln}`);
    }
  }
  lines.push("");
  lines.push("## Runtime");
  lines.push(`  active:        ${opts.registry.countActive()}`);
  lines.push(`  queued:        ${opts.queue.size()}`);
  lines.push(`  total tracked: ${opts.registry.list().length}`);
  return lines.join("\n");
}
function renderReconcileSummary(result, opts) {
  const lines = [];
  if (opts.includeHeader) {
    lines.push("## Post-startup reconcile");
    if (opts.dryRun) lines.push("(dry-run \u2014 no disk writes, no registry mutation)");
  } else if (opts.dryRun) {
    lines.push("(dry-run \u2014 no disk writes)");
  }
  lines.push(`scanned:      ${result.scanned}`);
  lines.push(`readopted:    ${result.readopted.length}${listSample(result.readopted)}`);
  lines.push(`reclassified: ${result.reclassified.length}${listSample(result.reclassified)}`);
  if (result.preSchema.length > 0) {
    lines.push(
      `pre-pid-schema: ${result.preSchema.length}${listSample(result.preSchema)}`
    );
  }
  lines.push(`unresumable:  ${result.unresumable.length}${listSample(result.unresumable)}`);
  lines.push(`errors:       ${result.errors.length}`);
  if (result.errors.length > 0) {
    const cap = 8;
    for (const e of result.errors.slice(0, cap)) {
      lines.push(`  ${e.id}: ${e.message}`);
    }
    if (result.errors.length > cap) {
      lines.push(`  (${result.errors.length - cap} more)`);
    }
  }
  return lines;
}
function listSample(ids) {
  if (ids.length === 0) return "";
  const cap = 8;
  const shown = ids.slice(0, cap);
  const more = ids.length > cap ? ` \u2026 (+${ids.length - cap} more)` : "";
  return ` (${shown.join(", ")}${more})`;
}
function countBySource(resolved) {
  const counts = { builtin: 0, user: 0, project: 0 };
  for (const p of resolved.personas.values()) {
    counts[p.source] = (counts[p.source] ?? 0) + 1;
  }
  return counts;
}
function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}

// src/history.ts
var EXCERPT_MAX_CHARS = 120;
function buildHistoryReport(deps, opts) {
  const ids = deps.listRunIds();
  const entries = [];
  for (const id of ids) {
    const record = deps.readRecord(id);
    if (!record) continue;
    entries.push({ id, record, mtime: deps.statMtime(id) });
  }
  if (entries.length === 0) {
    return "no run history yet. Spawn a sub-agent with ensemble_spawn or /conductor and it'll show up here.";
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  const total = entries.length;
  const shown = entries.slice(0, Math.max(0, opts.limit));
  const lines = [];
  lines.push(`run history \u2014 showing ${shown.length} of ${total}:`);
  lines.push("");
  for (const e of shown) {
    const r = e.record;
    const glyph = STATUS_GLYPH[r.status] ?? "\xB7";
    const elapsed = elapsedStr(r.startTime, r.finishedAt);
    const usage = formatUsage(r.usage);
    const usagePart = usage ? ` [${usage}]` : "";
    const pinned = deps.isPinned(e.id);
    const archived = deps.isArchived(e.id);
    const markerParts = [];
    if (pinned) markerParts.push("[P]");
    if (archived) markerParts.push("[A]");
    const markers = markerParts.length > 0 ? ` ${markerParts.join("")}` : "";
    const head = `  ${glyph} ${r.id.padEnd(20)} ${r.persona.padEnd(14)} ${r.status.padEnd(9)} ${elapsed}${usagePart}${markers}`;
    lines.push(head);
    if (archived) {
      lines.push("      (archived; resume creates new transcript)");
    }
    if (r.status === "completed") {
      const final = deps.readFinalText(e.id);
      if (final && final.trim()) {
        const excerpt = truncate(collapseWhitespace(final), EXCERPT_MAX_CHARS);
        lines.push(`      \u2192 "${excerpt}"`);
      }
    } else if (r.errorMessage) {
      const msg = r.errorMessage;
      const isOrphan = msg.startsWith("orphaned:");
      const excerpt = truncate(collapseWhitespace(msg), EXCERPT_MAX_CHARS);
      lines.push(`      \u2192 ${isOrphan ? "\u2398 " : ""}${excerpt}`);
    }
  }
  return lines.join("\n");
}
function truncate(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "\u2026";
}
function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

// src/gc/pinning.ts
import { existsSync as existsSync7 } from "node:fs";
import { stat as stat4, unlink, writeFile as writeFile3 } from "node:fs/promises";
import { join as join8 } from "node:path";
var SIDECAR = ".pinned";
async function pinRun(runsRoot2, agentId) {
  const dir = join8(runsRoot2, agentId);
  let st;
  try {
    st = await stat4(dir);
  } catch {
    throw new Error(`no such run directory: ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  await writeFile3(join8(dir, SIDECAR), "");
}
async function unpinRun(runsRoot2, agentId) {
  const path = join8(runsRoot2, agentId, SIDECAR);
  try {
    await unlink(path);
  } catch (e) {
    const err = e;
    if (err && err.code === "ENOENT") return;
    throw e;
  }
}
function isPinned(runsRoot2, agentId) {
  return existsSync7(join8(runsRoot2, agentId, SIDECAR));
}

// src/gc/reconcile.ts
import { readFile as readFile4, writeFile as writeFile4 } from "node:fs/promises";
import { join as join9 } from "node:path";
async function reconcileOrphans(actions, runsRoot2, now) {
  const reconciled = [];
  const failed = [];
  for (const action of actions) {
    if (action.kind !== "reconcile-orphan") continue;
    const agentId = action.id;
    const recordPath = join9(runsRoot2, agentId, "record.json");
    let raw;
    try {
      raw = await readFile4(recordPath, "utf-8");
    } catch (e) {
      const err = e;
      if (err && err.code === "ENOENT") {
        continue;
      }
      failed.push({ agentId, error: String(e?.message ?? e) });
      continue;
    }
    let record;
    try {
      record = JSON.parse(raw);
    } catch (e) {
      failed.push({ agentId, error: `parse error: ${e?.message ?? e}` });
      continue;
    }
    if (record.status !== "running") {
      continue;
    }
    const updated = {
      ...record,
      status: "killed",
      finishedAt: now,
      errorMessage: `${action.reason} (reconciled by GC)`
    };
    try {
      await writeFile4(recordPath, JSON.stringify(updated, null, 2));
      reconciled.push(agentId);
    } catch (e) {
      failed.push({ agentId, error: String(e?.message ?? e) });
    }
  }
  return { reconciled, failed };
}

// src/gc/executor.ts
import { readFile as readFile5, rm, stat as stat5, unlink as unlink2, utimes, writeFile as writeFile5, readdir as readdir4 } from "node:fs/promises";
import { join as join10 } from "node:path";
async function executeReclaim(actions, runsRoot2, registryActive, now) {
  const archived = [];
  const deleted = [];
  const failed = [];
  for (const action of actions) {
    if (action.kind !== "cold-archive" && action.kind !== "delete") continue;
    const agentId = action.id;
    const runDir2 = join10(runsRoot2, agentId);
    const actionKind = action.kind;
    if (registryActive.has(agentId)) {
      failed.push({
        agentId,
        action: actionKind,
        error: "active during reclaim (registry has live proc)"
      });
      continue;
    }
    const recordPath = join10(runDir2, "record.json");
    let record;
    try {
      const raw = await readFile5(recordPath, "utf-8");
      record = JSON.parse(raw);
    } catch (e) {
      const err = e;
      if (err && err.code === "ENOENT") {
        if (actionKind === "delete") {
          deleted.push({ agentId, bytesReclaimed: 0 });
          continue;
        }
        failed.push({
          agentId,
          action: actionKind,
          error: "runDir missing during cold-archive"
        });
        continue;
      }
      failed.push({
        agentId,
        action: actionKind,
        error: `record read/parse error: ${e?.message ?? e}`
      });
      continue;
    }
    if (!isTerminal(record.status)) {
      failed.push({
        agentId,
        action: actionKind,
        error: `non-terminal status ${record.status} (changed since plan)`
      });
      continue;
    }
    if (actionKind === "cold-archive") {
      try {
        const bytes = await coldArchive(runDir2, now);
        archived.push({ agentId, bytesReclaimed: bytes });
      } catch (e) {
        failed.push({
          agentId,
          action: actionKind,
          error: `cold-archive failed: ${e?.message ?? e}`
        });
      }
    } else {
      try {
        const bytes = await fullDelete(runDir2);
        deleted.push({ agentId, bytesReclaimed: bytes });
      } catch (e) {
        failed.push({
          agentId,
          action: actionKind,
          error: `delete failed: ${e?.message ?? e}`
        });
      }
    }
  }
  return { archived, deleted, failed };
}
async function coldArchive(runDir2, now) {
  const transcriptPath = join10(runDir2, "transcript.jsonl");
  let bytes = 0;
  try {
    const s = await stat5(transcriptPath);
    bytes = s.size;
  } catch {
  }
  if (bytes > 0) {
    try {
      await unlink2(transcriptPath);
    } catch (e) {
      const err = e;
      if (err?.code !== "ENOENT") throw e;
      bytes = 0;
    }
  }
  const sidecarPath = join10(runDir2, ".archived");
  await writeFile5(sidecarPath, "");
  const nowSec = now / 1e3;
  await utimes(sidecarPath, nowSec, nowSec);
  return bytes;
}
async function fullDelete(runDir2) {
  let bytes = 0;
  try {
    bytes = await walkSize(runDir2);
  } catch (e) {
    const err = e;
    if (err?.code === "ENOENT") return 0;
    throw e;
  }
  await rm(runDir2, { recursive: true, force: true });
  return bytes;
}
async function walkSize(path) {
  let total = 0;
  const entries = await readdir4(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join10(path, entry.name);
    if (entry.isDirectory()) {
      total += await walkSize(child);
    } else if (entry.isFile()) {
      try {
        const s = await stat5(child);
        total += s.size;
      } catch {
      }
    }
  }
  return total;
}

// src/gc/index.ts
var HOUR_MS2 = 60 * 60 * 1e3;
function activeIdSet(registry) {
  const out = /* @__PURE__ */ new Set();
  for (const r of registry.list()) {
    if (r.proc !== void 0) out.add(r.id);
  }
  return out;
}
function resolveNow(now) {
  if (typeof now === "function") return now();
  if (typeof now === "number") return now;
  return Date.now();
}
async function runGc(opts) {
  const startedAt = Date.now();
  const now = resolveNow(opts.now);
  const inventory = await walkInventory(opts.runsRoot, opts.registry);
  const filteredInventory = opts.persona ? inventory.filter((e) => e.persona === opts.persona) : inventory;
  const plan = planReclaim(filteredInventory, opts.config, now);
  const summary = countActions(plan.actions);
  if (opts.dryRun) {
    return {
      scanned: filteredInventory.length,
      planSummary: summary,
      reconciled: [],
      archived: [],
      deleted: [],
      failed: [],
      totalBytesReclaimed: 0,
      runsLoseResume: plan.runsLoseResume,
      durationMs: Math.max(1, Date.now() - startedAt)
    };
  }
  const reconcileResult = await reconcileOrphans(plan.actions, opts.runsRoot, now);
  const reclaimResult = await executeReclaim(
    plan.actions,
    opts.runsRoot,
    activeIdSet(opts.registry),
    now
  );
  for (const d of reclaimResult.deleted) noteDeletedId(d.agentId);
  const totalBytesReclaimed = reclaimResult.archived.reduce((s, a) => s + a.bytesReclaimed, 0) + reclaimResult.deleted.reduce((s, a) => s + a.bytesReclaimed, 0);
  const failed = [
    ...reconcileResult.failed.map((f) => ({
      agentId: f.agentId,
      action: "reconcile",
      error: f.error
    })),
    ...reclaimResult.failed.map((f) => ({
      agentId: f.agentId,
      action: f.action,
      error: f.error
    }))
  ];
  return {
    scanned: filteredInventory.length,
    planSummary: summary,
    reconciled: [...reconcileResult.reconciled],
    archived: [...reclaimResult.archived],
    deleted: [...reclaimResult.deleted],
    failed,
    totalBytesReclaimed,
    runsLoseResume: plan.runsLoseResume,
    durationMs: Math.max(1, Date.now() - startedAt)
  };
}
function countActions(actions) {
  let archive = 0;
  let del = 0;
  let reconcile = 0;
  let keep = 0;
  for (const a of actions) {
    if (a.kind === "cold-archive") archive++;
    else if (a.kind === "delete") del++;
    else if (a.kind === "reconcile-orphan") reconcile++;
    else keep++;
  }
  return { archive, delete: del, reconcile, keep };
}
async function maybeAutoRunGc(opts) {
  if (process.env.CONDUCTOR_SUBAGENT === "1") {
    return { ran: false, reason: "subagent-context" };
  }
  if (!opts.config.enabled) return { ran: false, reason: "disabled" };
  if (!opts.config.autoOnSessionStart) return { ran: false, reason: "auto-disabled" };
  const now = resolveNow(opts.now);
  const last = readLastGcMtime(opts.runsRoot);
  const debounceMs = Math.max(0, opts.config.autoDebounceHours * HOUR_MS2);
  if (!opts.force && last !== null && now - last < debounceMs) {
    return { ran: false, reason: "debounced" };
  }
  const result = await runGc({ ...opts, now });
  writeLastGcMtime(opts.runsRoot, now);
  const log = opts.log ?? ((line) => console.error(line));
  const sumPlan = result.planSummary;
  const failedCount = result.failed.length;
  const mb = (result.totalBytesReclaimed / (1024 * 1024)).toFixed(1);
  log(
    `gc auto: scanned=${result.scanned} archive=${sumPlan.archive} delete=${sumPlan.delete} reconcile=${sumPlan.reconcile} reclaimedMB=${mb} failed=${failedCount} dur=${result.durationMs}ms`
  );
  return { ran: true, result };
}

// src/watchdog.ts
function evaluateRun(run, state, config, now) {
  const current = state ?? { kind: "fresh" };
  if (run.status !== "running") {
    return { transition: { kind: "none" }, nextState: current };
  }
  if (run.pausedAt !== void 0) {
    return { transition: { kind: "none" }, nextState: current };
  }
  if (run.hookExecuting === true) {
    return { transition: { kind: "none" }, nextState: current };
  }
  const ageMs = now - run.startTime;
  if (ageMs < config.graceSeconds * 1e3) {
    return { transition: { kind: "none" }, nextState: current };
  }
  const silentMs = now - run.lastEventAt;
  const silentSeconds = Math.floor(silentMs / 1e3);
  const softMs = config.softThresholdSeconds * 1e3;
  const hardMs = config.hardThresholdSeconds * 1e3;
  if (current.kind !== "fresh" && silentMs < softMs) {
    return {
      transition: { kind: "recovered", previousKind: current.kind },
      nextState: { kind: "fresh" }
    };
  }
  if (silentMs >= hardMs) {
    if (current.kind === "hard") {
      return { transition: { kind: "none" }, nextState: current };
    }
    return {
      transition: {
        kind: "hard",
        silentSeconds,
        thresholdSeconds: config.hardThresholdSeconds
      },
      nextState: { kind: "hard", crossedAt: now }
    };
  }
  if (silentMs >= softMs) {
    if (current.kind === "soft") {
      return { transition: { kind: "none" }, nextState: current };
    }
    return {
      transition: {
        kind: "soft",
        silentSeconds,
        thresholdSeconds: config.softThresholdSeconds
      },
      nextState: { kind: "soft", crossedAt: now }
    };
  }
  return { transition: { kind: "none" }, nextState: current };
}
var DEFAULT_TICK_INTERVAL_MS = 3e4;
function effectiveConfig(run, defaults) {
  const overrideSoft = run.softStallSeconds;
  if (overrideSoft === void 0) return defaults;
  const ratio = defaults.softThresholdSeconds > 0 ? defaults.hardThresholdSeconds / defaults.softThresholdSeconds : 5;
  const scaledHard = Math.max(
    Math.round(overrideSoft * ratio),
    overrideSoft + 60
  );
  return {
    softThresholdSeconds: overrideSoft,
    hardThresholdSeconds: scaledHard,
    graceSeconds: defaults.graceSeconds
  };
}
function resolveKillOnStall(run, defaultKillOnStall) {
  return run.killOnStall ?? defaultKillOnStall;
}
function classifyStall(run, nowMs, defaults) {
  if (run.status !== "running") return null;
  if (run.pausedAt !== void 0) return null;
  if (run.hookExecuting === true) return null;
  const eff = effectiveConfig(run, defaults);
  const silentMs = Math.max(0, nowMs - run.lastEventAt);
  const silentSeconds = Math.floor(silentMs / 1e3);
  const ageMs = nowMs - run.startTime;
  if (ageMs < eff.graceSeconds * 1e3) return null;
  let severity = "fresh";
  if (silentSeconds >= eff.hardThresholdSeconds) severity = "hard";
  else if (silentSeconds >= eff.softThresholdSeconds) severity = "soft";
  return {
    silentSeconds,
    severity,
    softThresholdSeconds: eff.softThresholdSeconds,
    hardThresholdSeconds: eff.hardThresholdSeconds
  };
}
var Watchdog = class {
  constructor(deps) {
    this.deps = deps;
    this.setIntervalFn = deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms));
    this.clearIntervalFn = deps.clearInterval ?? ((t) => globalThis.clearInterval(t));
    this.tickIntervalMs = deps.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  }
  deps;
  states = /* @__PURE__ */ new Map();
  timer = null;
  unsub = null;
  disposed = false;
  setIntervalFn;
  clearIntervalFn;
  tickIntervalMs;
  /**
   * Start the watchdog: subscribe to registry changes + arm interval.
   * Returns a dispose function. R7: when `CONDUCTOR_SUBAGENT=1`, this
   * is a no-op so a sub-agent's conductor extension does not run a
   * watchdog that would race the parent's. Same pattern as the v0.9
   * auto-GC sub-agent skip.
   */
  start() {
    if (process.env.CONDUCTOR_SUBAGENT === "1") {
      return () => {
      };
    }
    if (this.disposed) {
      this.disposed = false;
    }
    this.unsub = this.deps.registry.onChange(() => {
      this.tick();
    });
    this.timer = this.setIntervalFn(() => this.tick(), this.tickIntervalMs);
    if (typeof this.timer?.unref === "function") {
      this.timer.unref();
    }
    return () => {
      if (this.disposed) return;
      this.disposed = true;
      if (this.unsub) {
        this.unsub();
        this.unsub = null;
      }
      if (this.timer) {
        this.clearIntervalFn(this.timer);
        this.timer = null;
      }
      this.states.clear();
    };
  }
  /**
   * Run one detector pass over every run in the registry. Public so
   * tests can drive deterministic ticks; production triggers via
   * `setInterval` and registry change notifications.
   *
   * In sub-agent context this is a guarded no-op (R7) so test
   * environments that flip the env var for a single test don't leak
   * ticks into other tests.
   */
  tick() {
    if (process.env.CONDUCTOR_SUBAGENT === "1") return;
    if (this.deps.isEnabled && !this.deps.isEnabled()) return;
    const now = this.deps.now();
    for (const run of this.deps.registry.list()) {
      const prev = this.states.get(run.id);
      const effective = effectiveConfig(run, this.deps.config);
      const { transition, nextState } = evaluateRun(run, prev, effective, now);
      this.states.set(run.id, nextState);
      if (run.status !== "running") {
        this.states.delete(run.id);
      }
      this.dispatch(run, transition, effective);
    }
  }
  /**
   * Side-effect dispatcher for one transition. Soft/recovered are pure
   * advisories. Hard either kills (`kill_on_stall` true) or warns and
   * leaves the run alive. The kill path performs the **A2 pre-kill
   * recheck**: re-read `now() - run.lastEventAt` and abort the kill if
   * the run recovered between the detector verdict and the dispatch.
   */
  dispatch(run, transition, effective) {
    switch (transition.kind) {
      case "none":
        return;
      case "soft": {
        run.stalledSince = this.deps.now();
        this.deps.log.warn(
          `watchdog: soft-stall on ${run.id} (silent ${transition.silentSeconds}s)`,
          {
            agentId: run.id,
            persona: run.persona,
            silentSeconds: transition.silentSeconds,
            severity: "soft"
          }
        );
        return;
      }
      case "hard": {
        run.stalledSince = this.deps.now();
        const killOnStall = this.deps.isKillOnStall(run);
        if (!killOnStall) {
          this.deps.log.warn(
            `watchdog: hard-stall on ${run.id} (silent ${transition.silentSeconds}s) \u2014 kill_on_stall=false; leaving alive`,
            {
              agentId: run.id,
              persona: run.persona,
              silentSeconds: transition.silentSeconds,
              severity: "hard"
            }
          );
          return;
        }
        const nowAfter = this.deps.now();
        const stillStaleMs = nowAfter - run.lastEventAt;
        if (stillStaleMs < effective.hardThresholdSeconds * 1e3) {
          run.stalledSince = void 0;
          this.states.set(run.id, { kind: "fresh" });
          this.deps.log.info(
            `watchdog: kill aborted for ${run.id} \u2014 recovered before kill (A2)`,
            {
              agentId: run.id,
              persona: run.persona,
              recoveredFrom: "hard"
            }
          );
          return;
        }
        this.deps.log.warn(
          `watchdog: hard-stall on ${run.id} (silent ${transition.silentSeconds}s) \u2014 killing (kill_on_stall=true)`,
          {
            agentId: run.id,
            persona: run.persona,
            silentSeconds: transition.silentSeconds,
            severity: "hard"
          }
        );
        this.deps.kill(run, "stalled");
        return;
      }
      case "recovered": {
        run.stalledSince = void 0;
        this.deps.log.info(
          `watchdog: ${run.id} recovered from ${transition.previousKind}-stall`,
          {
            agentId: run.id,
            persona: run.persona,
            previousKind: transition.previousKind
          }
        );
        return;
      }
    }
  }
};

// src/commands.ts
var SUBCOMMANDS = [
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
  "send"
];
function registerCommands(pi, opts) {
  pi.registerCommand("conductor", {
    description: "pi-conductor: list, show, doctor, on/off, status, stop/pause/resume/queue",
    getArgumentCompletions: (prefix) => {
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
            "conductor mode ON \u2014 system prompt addendum will be injected at every turn.",
            "info"
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
        case "send":
          await runSendCmd(opts, ctx, subRest);
          return;
        default:
          ctx.ui.notify(
            `unknown subcommand: ${sub}. Try one of: ${SUBCOMMANDS.join(", ")}.`,
            "warning"
          );
      }
    }
  });
}
async function runList(opts, ctx) {
  const cwd = opts.getCwd();
  const cfg = loadConfig(cwd);
  const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
  const personas = [...resolved.personas.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (personas.length === 0) {
    ctx.ui.notify(
      "no personas resolved. Add files under ~/.pi/agent/conductor/personas/ or <cwd>/.pi/conductor/personas/",
      "warning"
    );
    return;
  }
  const lines = [`${personas.length} personas resolved:`, ""];
  for (const p of personas) {
    const cfgBits = [];
    cfgBits.push(`source=${p.source}`);
    if (p.model) cfgBits.push(`model=${p.model}`);
    if (p.thinking) cfgBits.push(`thinking=${p.thinking}`);
    cfgBits.push(`context=${p.inheritContext}`);
    lines.push(`  ${p.name.padEnd(14)} \u2014 ${p.description}`);
    lines.push(`  ${" ".repeat(14)}   [${cfgBits.join(", ")}]`);
  }
  if (resolved.errors.length > 0) {
    lines.push("", `${resolved.errors.length} parse errors:`);
    for (const e of resolved.errors) {
      lines.push(`  \u2717 ${e.path}: ${e.reason}`);
    }
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
async function runShow(opts, ctx, name) {
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
      "warning"
    );
    return;
  }
  const lines = [];
  lines.push(`# ${p.name}`);
  lines.push(`source: ${p.source} (${p.sourcePath})`);
  lines.push(`description: ${p.description}`);
  lines.push(`model: ${p.model ?? "<inherited>"}`);
  lines.push(`thinking: ${p.thinking ?? "<inherited>"}`);
  lines.push(`inherit_context: ${p.inheritContext}`);
  lines.push(`inherit_skills: ${p.inheritSkills}`);
  lines.push(
    `default_reads: ${p.defaultReads.length === 0 ? "(none)" : p.defaultReads.join(", ")}`
  );
  lines.push(`worktree: ${p.worktree}`);
  lines.push(`timeout_minutes: ${p.timeoutMinutes}`);
  lines.push("");
  lines.push("## System prompt");
  lines.push("");
  lines.push(p.systemPrompt);
  ctx.ui.notify(lines.join("\n"), "info");
}
async function runDoctor(opts, ctx) {
  const report = await buildDoctorReport({
    cwd: opts.getCwd(),
    registry: opts.getRegistry(),
    queue: opts.getQueue(),
    conductorMode: opts.getConductorMode(),
    lastReconcile: opts.getLastReconcile?.()
  });
  ctx.ui.notify(report, "info");
}
function runStatus(opts, ctx) {
  const registry = opts.getRegistry();
  const queue = opts.getQueue();
  const all = registry.list();
  if (all.length === 0 && queue.size() === 0) {
    ctx.ui.notify("no sub-agents.", "info");
    return;
  }
  const lines = [];
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
function runStop(opts, ctx, arg) {
  const registry = opts.getRegistry();
  if (!arg) {
    ctx.ui.notify("usage: /conductor stop <agent-id|all>", "warning");
    return;
  }
  const targets = arg === "all" ? registry.list() : [registry.get(arg)].filter(Boolean);
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
function runPause(opts, ctx, arg) {
  const registry = opts.getRegistry();
  if (!arg) {
    ctx.ui.notify("usage: /conductor pause <agent-id|all>", "warning");
    return;
  }
  const targets = arg === "all" ? registry.list().filter((r) => r.status === "running") : [registry.get(arg)].filter(Boolean);
  let n = 0;
  for (const r of targets) {
    if (pauseRun(r, registry)) n++;
  }
  ctx.ui.notify(`paused ${n} sub-agent(s)`, "info");
}
function runResume(opts, ctx, arg) {
  const registry = opts.getRegistry();
  if (!arg) {
    ctx.ui.notify("usage: /conductor resume <agent-id|all>", "warning");
    return;
  }
  const targets = arg === "all" ? registry.list().filter((r) => r.status === "paused") : [registry.get(arg)].filter(Boolean);
  let n = 0;
  for (const r of targets) {
    if (resumeRun(r, registry)) n++;
  }
  ctx.ui.notify(`resumed ${n} sub-agent(s)`, "info");
}
function runQueueCmd(opts, ctx) {
  const queue = opts.getQueue();
  if (queue.size() === 0) {
    ctx.ui.notify("queue is empty.", "info");
    return;
  }
  const lines = [`Queue (${queue.size()}):`];
  for (const [i, p] of queue.list().entries()) {
    const waited = elapsedStr(p.enqueuedAt);
    lines.push(
      `  ${i + 1}. ${p.id.padEnd(20)} ${p.persona.name.padEnd(14)} requested=${p.requestedMode} waited=${waited}`
    );
  }
  ctx.ui.notify(lines.join("\n"), "info");
}
function runFocus(opts, ctx, arg) {
  const id = arg.trim() || void 0;
  if (id) {
    const registry = opts.getRegistry();
    if (!registry.get(id)) {
      ctx.ui.notify(
        `agent_id "${id}" not found. Run /conductor status to see active sub-agents.`,
        "warning"
      );
      return;
    }
  }
  opts.openFocusedOverlay(id);
}
var SEND_USAGE = "usage: /conductor send <agent-id> [--steer|--follow-up|--resume] <message>";
var SEND_FLAGS = {
  "--steer": "steer",
  "--follow-up": "follow_up",
  "--resume": "resume"
};
function parseSendCommand(arg) {
  const trimmed = arg.replace(/^\s+/, "").replace(/\s+$/, "");
  if (trimmed.length === 0) {
    return { kind: "error", message: `missing agent-id. ${SEND_USAGE}` };
  }
  const tokens = trimmed.split(/\s+/);
  const agentId = tokens[0];
  const rest = tokens.slice(1);
  let behavior = "auto";
  let flagToken;
  if (rest.length > 0 && SEND_FLAGS[rest[0]] !== void 0) {
    flagToken = rest[0];
    behavior = SEND_FLAGS[flagToken];
    if (rest.length > 1 && SEND_FLAGS[rest[1]] !== void 0) {
      return {
        kind: "error",
        message: `${flagToken} and ${rest[1]} are mutually exclusive; pick one.`
      };
    }
  }
  let remainder = trimmed.slice(agentId.length).replace(/^\s+/, "");
  if (flagToken !== void 0) {
    remainder = remainder.slice(flagToken.length).replace(/^\s+/, "");
  }
  remainder = remainder.replace(/\s+$/, "");
  if (remainder.length === 0) {
    return { kind: "error", message: `missing message. ${SEND_USAGE}` };
  }
  return { kind: "ok", agentId, message: remainder, behavior };
}
async function runSendCmd(opts, ctx, arg) {
  const parsed = parseSendCommand(arg);
  if (parsed.kind === "error") {
    ctx.ui.notify(parsed.message, "warning");
    return;
  }
  const { agentId, message, behavior } = parsed;
  const registry = opts.getRegistry();
  const run = registry.get(agentId);
  if (!run) {
    ctx.ui.notify(
      `agent_id "${agentId}" not found. Run /conductor status to see active sub-agents.`,
      "warning"
    );
    return;
  }
  const check = validateSendable(run);
  if (!check.ok && behavior === "auto") {
    ctx.ui.notify(check.reason, "warning");
    return;
  }
  const cwd = opts.getCwd();
  const cfg = loadConfig(cwd);
  const baseOv = cfg.personaOverrides[run.persona] ?? {};
  const resolved = await resolvePersonas({
    cwd,
    personaOverrides: cfg.personaOverrides
  });
  const persona = resolved.personas.get(run.persona);
  const timeoutMs = resolveTimeoutMs(persona, baseOv, cfg);
  const result = sendToRun(run, message, {
    registry,
    timeoutMs,
    streamingBehavior: behavior
  });
  if (result.kind === "rejected") {
    ctx.ui.notify(result.reason, "warning");
    return;
  }
  if (result.ack !== void 0) {
    ctx.ui.notify(
      `${behavior} dispatched to ${agentId} \u2014 awaiting ack...`,
      "info"
    );
    result.ack.then(
      (ack) => {
        try {
          ctx.ui.notify(
            `${agentId} ack delivered (\u0394 ${ack.deliveredAt - run.lastEventAt}ms)`,
            "info"
          );
        } catch {
        }
      },
      (err) => {
        try {
          ctx.ui.notify(
            `${agentId} ack failed: ${err instanceof Error ? err.message : String(err)}`,
            "warning"
          );
        } catch {
        }
      }
    );
    return;
  }
  ctx.ui.notify(
    `${agentId} resuming via fresh subprocess (streaming_behavior=${behavior})`,
    "info"
  );
}
function formatRunRow(r, livenessProbe = defaultLivenessProbe) {
  const u = formatUsage(r.usage);
  const usagePart = u ? `[${u}]` : "";
  const hint = r.lastToolCall ? ` \u2192 ${r.lastToolCall}` : "";
  const liveness = r.status === "running" && r.pid !== void 0 && !livenessProbe(r.pid) ? " \xB7 pid-gone" : "";
  return `  ${STATUS_GLYPH[r.status] ?? "\xB7"} ${r.id.padEnd(20)} ${r.persona.padEnd(14)} ${r.status.padEnd(9)} ${elapsedStr(r.startTime, r.finishedAt).padEnd(6)} ${usagePart}${hint}${liveness}`;
}
function runHistory(_opts, ctx, arg) {
  const root = runsRoot();
  if (!existsSync8(root)) {
    ctx.ui.notify(
      "no run history yet. Spawn a sub-agent and it'll show up here.",
      "info"
    );
    return;
  }
  const parsed = parseInt(arg, 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 20;
  const report = buildHistoryReport(
    {
      listRunIds: () => {
        try {
          return readdirSync2(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
        } catch {
          return [];
        }
      },
      readRecord: (id) => {
        const p = join11(runDir(id), "record.json");
        try {
          return JSON.parse(readFileSync3(p, "utf8"));
        } catch {
          return void 0;
        }
      },
      readFinalText: (id) => {
        const p = join11(runDir(id), "final.md");
        try {
          return readFileSync3(p, "utf8");
        } catch {
          return void 0;
        }
      },
      statMtime: (id) => {
        try {
          return statSync3(join11(runDir(id), "record.json")).mtimeMs;
        } catch {
          try {
            return statSync3(runDir(id)).mtimeMs;
          } catch {
            return 0;
          }
        }
      },
      isPinned: (id) => existsSync8(join11(runDir(id), ".pinned")),
      isArchived: (id) => existsSync8(join11(runDir(id), ".archived"))
    },
    { limit }
  );
  ctx.ui.notify(report, "info");
}
var AGENT_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
async function runPin(ctx, arg) {
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
  if (!existsSync8(join11(root, id))) {
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
  } catch (e) {
    ctx.ui.notify(`pin failed: ${e?.message ?? e}`, "warning");
  }
}
async function runUnpin(ctx, arg) {
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
  if (!existsSync8(join11(root, id))) {
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
  } catch (e) {
    ctx.ui.notify(`unpin failed: ${e?.message ?? e}`, "warning");
  }
}
var GC_HELP_TEXT = [
  "/conductor gc [flags]  \u2014 reclaim disk used by run records.",
  "",
  "  --dry-run           plan only, no disk mutation; print summary.",
  "  --force             documented no-op for manual gc (debounce only",
  "                      applies to auto-gc on session_start).",
  "  --persona=<name>    scope to a single persona's runs.",
  "  --verbose           include per-action lines, not just totals.",
  "  --help              print this listing."
].join("\n");
function parseGcFlags(arg) {
  const out = {
    dryRun: false,
    force: false,
    verbose: false,
    help: false
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
function bytesHuman(n) {
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}
function sumBytes(actions, kind) {
  let total = 0;
  for (const a of actions) {
    if (a.kind === kind && (a.kind === "cold-archive" || a.kind === "delete")) {
      total += a.bytesReclaimed;
    }
  }
  return total;
}
function formatGcResult(result, actions, flags) {
  const lines = [];
  const dryTag = flags.dryRun ? " (dry-run)" : "";
  lines.push(`GC plan${dryTag} (n=${result.scanned} scanned):`);
  const archiveBytes = sumBytes(actions, "cold-archive");
  const deleteBytes = sumBytes(actions, "delete");
  const totalBytes = archiveBytes + deleteBytes;
  lines.push(
    `  archive: ${result.planSummary.archive} runs, ~${bytesHuman(archiveBytes)}`
  );
  lines.push(
    `  delete:  ${result.planSummary.delete} runs, ~${bytesHuman(deleteBytes)}`
  );
  lines.push(
    `  reconcile: ${result.planSummary.reconcile} orphan${result.planSummary.reconcile === 1 ? "" : "s"}`
  );
  lines.push(`  keep: ${result.planSummary.keep} runs`);
  lines.push("");
  lines.push("Totals:");
  lines.push(`  bytes_to_reclaim:  ${bytesHuman(totalBytes)} (${totalBytes} B)`);
  lines.push(`  runs_to_archive:   ${result.planSummary.archive}`);
  lines.push(`  runs_to_delete:    ${result.planSummary.delete}`);
  lines.push(`  runs_lose_resume:  ${result.runsLoseResume}`);
  if (!flags.dryRun) {
    lines.push("");
    lines.push(
      `Reclaimed: ${bytesHuman(result.totalBytesReclaimed)} (${result.archived.length} archived, ${result.deleted.length} deleted, ${result.failed.length} failed) in ${result.durationMs}ms`
    );
  }
  if (flags.verbose) {
    const acts = actions.filter(
      (a) => a.kind === "cold-archive" || a.kind === "delete" || a.kind === "reconcile-orphan"
    );
    if (acts.length > 0) {
      lines.push("");
      lines.push("Per-action:");
      const cap = 20;
      for (const a of acts.slice(0, cap)) {
        const tag = a.kind === "cold-archive" ? "cold-archive" : a.kind === "delete" ? "delete       " : "reconcile    ";
        const bytes = a.kind === "cold-archive" || a.kind === "delete" ? bytesHuman(a.bytesReclaimed) : "\u2014";
        lines.push(
          `  ${tag}  ${a.id.padEnd(28)} ${bytes.padStart(10)}  ${a.reason ?? ""}`
        );
      }
      if (acts.length > cap) {
        lines.push(`  (${acts.length - cap} more \u2014 see /conductor history)`);
      }
    }
  }
  return lines.join("\n");
}
async function runGcCmd(opts, ctx, arg) {
  const parsed = parseGcFlags(arg);
  if (!parsed.ok) {
    ctx.ui.notify(`${parsed.error}

${GC_HELP_TEXT}`, "warning");
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
  const inventoryFull = await walkInventory(root, registry);
  const inventory = flags.persona ? inventoryFull.filter((e) => e.persona === flags.persona) : inventoryFull;
  const plan = planReclaim(inventory, cfg.gc, Date.now());
  let result;
  try {
    result = await runGc({
      runsRoot: root,
      config: cfg.gc,
      registry,
      dryRun: flags.dryRun,
      persona: flags.persona
    });
  } catch (e) {
    ctx.ui.notify(`gc failed: ${e?.message ?? e}`, "warning");
    return;
  }
  const out = formatGcResult(result, plan.actions, flags);
  ctx.ui.notify(out, "info");
}
var RECONCILE_HELP_TEXT = [
  "/conductor reconcile [--dry-run]  \u2014 re-run post-startup orphan reconcile.",
  "",
  "  --dry-run           classify + report; do NOT mutate disk or registry.",
  "  --help              print this listing."
].join("\n");
function parseReconcileFlags(arg) {
  const out = { dryRun: false, help: false };
  const tokens = arg.split(/\s+/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    if (tok === "--dry-run") out.dryRun = true;
    else if (tok === "--help" || tok === "-h") out.help = true;
    else return { ok: false, error: `unknown flag: ${tok}` };
  }
  return { ok: true, flags: out };
}
async function runReconcileCmd(opts, ctx, arg) {
  const parsed = parseReconcileFlags(arg);
  if (!parsed.ok) {
    ctx.ui.notify(`${parsed.error}

${RECONCILE_HELP_TEXT}`, "warning");
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
      dryRun: flags.dryRun
    });
    const out = renderReconcileSummary(result, {
      dryRun: flags.dryRun,
      includeHeader: true
    }).join("\n");
    ctx.ui.notify(out, "info");
  } catch (e) {
    ctx.ui.notify(
      `reconcile failed: ${e?.message ?? String(e)}`,
      "warning"
    );
  }
}
function runWatchdog(opts, ctx, subRest) {
  const [sub] = subRest.split(/\s+/);
  switch (sub) {
    case "":
    case "status":
      runWatchdogStatus(opts, ctx);
      return;
    default:
      ctx.ui.notify(
        `unknown watchdog subcommand: ${sub}. Try: /conductor watchdog status`,
        "warning"
      );
  }
}
function runWatchdogStatus(opts, ctx) {
  const cfg = loadConfig(opts.getCwd());
  const out = buildWatchdogStatusReport({
    registry: opts.getRegistry(),
    watchdogConfig: {
      softThresholdSeconds: cfg.watchdog.defaultSoftSeconds,
      hardThresholdSeconds: cfg.watchdog.defaultHardSeconds,
      graceSeconds: cfg.watchdog.graceSeconds
    },
    defaultKillOnStall: cfg.watchdog.defaultKillOnStall,
    enabled: cfg.watchdog.enabled,
    now: Date.now()
  });
  ctx.ui.notify(out, "info");
}
function buildWatchdogStatusReport(args) {
  const { registry, watchdogConfig, defaultKillOnStall, enabled, now } = args;
  const active = registry.list().filter(
    (r) => r.status !== "completed" && r.status !== "failed" && r.status !== "killed" && r.status !== "timeout" && r.status !== "hook_failed" && r.status !== "paused" && r.status !== "queued"
  );
  const lines = [];
  lines.push("## Watchdog");
  if (!enabled) lines.push("(watchdog DISABLED)");
  lines.push(
    `${active.length} active run${active.length === 1 ? "" : "s"}`
  );
  lines.push("");
  if (active.length === 0) {
    lines.push("  (no active runs)");
    return lines.join("\n");
  }
  const idW = Math.max(14, ...active.map((r) => r.id.length));
  const personaW = Math.max(10, ...active.map((r) => r.persona.length));
  lines.push(
    "  " + "id".padEnd(idW) + "  " + "persona".padEnd(personaW) + "  " + "silent".padEnd(7) + "  " + "state".padEnd(7) + "  " + "threshold".padEnd(11) + "  action"
  );
  for (const r of active) {
    const c = classifyStall(r, now, watchdogConfig);
    const silent = c ? `${c.silentSeconds}s` : "\u2014";
    const state = c ? c.severity : "fresh";
    const soft = c ? c.softThresholdSeconds : watchdogConfig.softThresholdSeconds;
    const hard = c ? c.hardThresholdSeconds : watchdogConfig.hardThresholdSeconds;
    const threshold = `${soft}s/${hard}s`;
    const kos = resolveKillOnStall(r, defaultKillOnStall);
    const action = state === "fresh" ? "\u2014" : kos ? "kill (kill_on_stall=true)" : "warn (kill_on_stall=false)";
    lines.push(
      "  " + r.id.padEnd(idW) + "  " + r.persona.padEnd(personaW) + "  " + silent.padEnd(7) + "  " + state.padEnd(7) + "  " + threshold.padEnd(11) + "  " + action
    );
  }
  return lines.join("\n");
}

// src/tools.ts
import { Type } from "@sinclair/typebox";

// src/steerable.ts
function collapseSteerableCascade(inputs) {
  return inputs.perCall ?? inputs.project ?? inputs.user ?? inputs.defaultValue;
}

// src/transcript.ts
import { truncateToWidth, visibleWidth as visibleWidth2, wrapTextWithAnsi } from "@earendil-works/pi-tui";
var TOOL_CALL_FOLD_LIMIT = 12;
var THINKING_FOLD_LIMIT = 20;
function foldMarker(hidden) {
  return `  \u22EF ${hidden} more lines  (e expand all \xB7 E collapse all)`;
}
function capBlock(block, limit, width) {
  if (block.length <= limit) return block;
  const hidden = block.length - limit;
  return [...block.slice(0, limit), truncateOrPad(foldMarker(hidden), width)];
}
function renderHeader(run, width) {
  const elapsed = elapsedStr(run.startTime, run.finishedAt);
  const usage = formatUsage(run.usage);
  const glyph = STATUS_GLYPH[run.status] ?? "\xB7";
  const baseLeft = `${glyph} ${run.persona} (${run.id}) \u2014 ${run.status} ${elapsed}`;
  const right = usage ? `[${usage}]` : "";
  const sep = "\u2500".repeat(Math.max(0, width));
  const activity = deriveActivity(run, Date.now());
  let left = baseLeft;
  if (activity !== void 0) {
    const sepText = " \xB7 ";
    const rightW = visibleWidth2(right);
    const baseW = visibleWidth2(baseLeft);
    const minSpace = right ? 1 : 0;
    const budget = width - baseW - rightW - minSpace - visibleWidth2(sepText);
    if (budget >= 2) {
      const fitted = visibleWidth2(activity) <= budget ? activity : truncateToWidth(activity, budget, "\u2026", false);
      left = baseLeft + sepText + fitted;
    }
  }
  const headerLine2 = padOrTruncate(left, right, width);
  return [sep, headerLine2];
}
var IDLE_THRESHOLD_MS = 5e3;
function deriveActivity(run, nowMs) {
  if (run.status !== "running") return void 0;
  const lastEvent = run.lastEventAt ?? run.startTime;
  const idleMs = nowMs - lastEvent;
  if (idleMs >= IDLE_THRESHOLD_MS) {
    const totalSecs = Math.floor(idleMs / 1e3);
    if (totalSecs >= 60) {
      const mins = Math.floor(totalSecs / 60);
      return `idle ${mins}m`;
    }
    return `idle ${totalSecs}s`;
  }
  const last = run.messages.at(-1);
  if (!last) return void 0;
  const role = last.role;
  if (role !== "assistant") return void 0;
  const content = last.content;
  if (!Array.isArray(content)) return void 0;
  for (let i = content.length - 1; i >= 0; i--) {
    const part = content[i];
    const t = part?.type;
    if (t === "toolCall") {
      return formatToolCallShort(String(part.name ?? "tool"), part.arguments);
    }
    if (t === "thinking") return "thinking";
    if (t === "text") return "responding";
  }
  return void 0;
}
function renderTranscript(run, opts) {
  const out = [];
  let assistantTurnIndex = 0;
  let msgIdx = -1;
  const resultsByCallId = /* @__PURE__ */ new Map();
  for (const msg of run.messages) {
    if (msg.role !== "toolResult") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "toolResult" && part.toolUseId) {
        resultsByCallId.set(part.toolUseId, msg);
      }
    }
  }
  for (const msg of run.messages) {
    msgIdx += 1;
    const role = msg.role;
    if (role === "user" || role === "toolResult") {
      continue;
    }
    if (role === "assistant") {
      assistantTurnIndex += 1;
      if (assistantTurnIndex >= 2) {
        out.push(turnSeparator(assistantTurnIndex, opts.width));
      }
      const content = msg.content;
      if (!Array.isArray(content)) continue;
      let partIdx = -1;
      for (const part of content) {
        partIdx += 1;
        switch (part?.type) {
          case "text":
            for (const line of wrap(String(part.text ?? ""), opts.width)) {
              out.push(line);
            }
            break;
          case "thinking":
            if (opts.showThinking) {
              const tkey = `thinking:${msgIdx}:${partIdx}`;
              const expanded = opts.isExpanded?.(tkey, false) ?? false;
              const block = renderThinking(String(part.thinking ?? ""), opts.width);
              const capped = expanded ? block : capBlock(block, THINKING_FOLD_LIMIT, opts.width);
              out.push(...capped);
            } else {
              out.push(renderThinkingSummary(String(part.thinking ?? "")));
            }
            break;
          case "toolCall": {
            const tkey = part.id ? `tool:${part.id}` : `tool:${msgIdx}:${partIdx}`;
            const expanded = opts.isExpanded?.(tkey, false) ?? false;
            const block = renderToolCall(part, resultsByCallId, opts);
            const capped = opts.collapseToolCalls || expanded ? block : capBlock(block, TOOL_CALL_FOLD_LIMIT, opts.width);
            out.push(...capped);
            break;
          }
          default:
            break;
        }
      }
    }
  }
  return out;
}
function turnSeparator(turn, width) {
  const candidate = `\xB7 turn ${turn}`;
  if (visibleWidth2(candidate) > width) return truncateToWidth(candidate, width, "\u2026", false);
  return candidate;
}
function renderThinking(text, width) {
  const out = ["  \u2503 thinking"];
  for (const line of wrap(text, Math.max(8, width - 4))) {
    out.push("  \u2503 " + line);
  }
  return out;
}
function renderThinkingSummary(text) {
  const chars = text.length;
  const lines = text === "" ? 0 : text.split("\n").length;
  const lineWord = lines === 1 ? "line" : "lines";
  return `\xB7 thinking (${chars} chars / ${lines} ${lineWord})`;
}
function renderToolCall(part, resultsByCallId, opts) {
  const name = part.name ?? "tool";
  if (opts.collapseToolCalls) {
    const summary = summarizeToolArgs(name, part.arguments ?? {});
    const line = `\u25B8 ${name}${summary ? " " + summary : ""}`;
    const out2 = [truncateOrPad(line, opts.width)];
    if (part.id) {
      const result = resultsByCallId.get(part.id);
      if (result) {
        const isError = result.isError === true;
        const glyph = isError ? "\u2717" : "\u2713";
        const preview = firstLine(extractFirstResultText(result));
        const outcome = preview ? ` \u21B3 ${glyph} ${preview}` : ` \u21B3 ${glyph}`;
        out2.push(truncateOrPad(outcome, opts.width));
      } else {
        out2.push(truncateOrPad(" \u21B3 \u2026", opts.width));
      }
    }
    return out2;
  }
  const out = [`\u25BE ${name}`];
  if (part.arguments) {
    const json = JSON.stringify(part.arguments, null, 2);
    for (const ln of json.split("\n")) {
      out.push(truncateOrPad("  " + ln, opts.width));
    }
  }
  if (part.id) {
    const result = resultsByCallId.get(part.id);
    if (result) {
      const content = result.content;
      if (Array.isArray(content)) {
        for (const r of content) {
          const text = r?.text ?? r?.output ?? "";
          if (typeof text === "string" && text.trim()) {
            out.push(truncateOrPad("  \u21B3 " + firstLine(text), opts.width));
          }
        }
      }
    }
  }
  return out;
}
function extractFirstResultText(result) {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  for (const r of content) {
    const text = r?.text ?? r?.output ?? "";
    if (typeof text === "string" && text) return text;
  }
  return "";
}
function firstLine(s) {
  const idx = s.indexOf("\n");
  return idx === -1 ? s : s.slice(0, idx);
}
function wrap(text, width) {
  if (width <= 0) return [text];
  return wrapTextWithAnsi(text, width);
}
function truncateOrPad(line, width) {
  if (visibleWidth2(line) <= width) return line;
  return truncateToWidth(line, width, "\u2026", false);
}
function padOrTruncate(left, right, width) {
  if (!right) {
    return visibleWidth2(left) <= width ? left : truncateToWidth(left, width, "\u2026", false);
  }
  const minSpace = 1;
  const leftW = visibleWidth2(left);
  const rightW = visibleWidth2(right);
  if (leftW + minSpace + rightW > width) {
    const leftBudget = Math.max(0, width - rightW - minSpace);
    const leftCut = leftW > leftBudget ? truncateToWidth(left, leftBudget, "\u2026", false) : left;
    const leftCutW = visibleWidth2(leftCut);
    const pad2 = Math.max(minSpace, width - leftCutW - rightW);
    return leftCut + " ".repeat(pad2) + right;
  }
  const pad = width - leftW - rightW;
  return left + " ".repeat(pad) + right;
}

// src/transcript-classify.ts
var HEADER_GLYPHS = /* @__PURE__ */ new Set(["\u25CC", "\u25CF", "\u23F8", "\u2713", "\u2717", "\u25A0", "\u23F1", "\u2297"]);
function classifyLine(line) {
  if (line.length > 0 && /^─+$/.test(line)) {
    return { kind: "ruler" };
  }
  if (line.length >= 2) {
    const first = line[0];
    if (HEADER_GLYPHS.has(first) && line[1] === " ") {
      return { kind: "header", glyph: first };
    }
  }
  if (line.startsWith("\u25B8 ") || line.startsWith("\u25BE ")) {
    return { kind: "tool", glyph: line[0] };
  }
  if (/^\s+↳ /.test(line) || line.startsWith(" \u21B3 ") || line.startsWith("  \u21B3 ")) {
    return { kind: "outcome", glyph: "\u21B3" };
  }
  if (/^· turn \d/.test(line)) {
    return { kind: "turnSep", glyph: "\xB7" };
  }
  if (line.startsWith("\xB7 thinking ") || line === "\xB7 thinking") {
    return { kind: "thinking", glyph: "\xB7" };
  }
  if (line.startsWith("  \u2503")) {
    return { kind: "thinking", glyph: "\u2503" };
  }
  if (/^[↑↓] \d+ hidden/.test(line) || /^[A-Za-z][A-Za-z0-9_-]* \(line \d+\/\d+\)$/.test(line)) {
    return { kind: "scrollHint", glyph: line[0] };
  }
  if (/^ {2}⋯ \d+ more lines {2}\(e expand all · E collapse all\)$/.test(line)) {
    return { kind: "fold", glyph: "\u22EF" };
  }
  if (line.startsWith("Esc ")) {
    return { kind: "footer" };
  }
  return { kind: "text" };
}

// src/transcript-style.ts
function statusColorSlot(status) {
  switch (status) {
    case "running":
      return "accent";
    case "completed":
      return "success";
    case "failed":
    case "killed":
    case "timeout":
    case "hook_failed":
      return "error";
    case "paused":
      return "warning";
    case "queued":
      return "muted";
  }
}
function applyTheme(line, classified, theme, opts = {}) {
  switch (classified.kind) {
    case "header": {
      const slot = opts.status ? statusColorSlot(opts.status) : "accent";
      return theme.fg(slot, line);
    }
    case "ruler":
      return theme.fg("borderMuted", line);
    case "tool": {
      if (line.length < 2) return theme.fg("accent", line);
      const head = line.slice(0, 2);
      const tail = line.slice(2);
      return theme.fg("accent", head) + tail;
    }
    case "outcome": {
      if (line.includes("\u21B3 \u2713")) return theme.fg("success", line);
      if (line.includes("\u21B3 \u2717")) return theme.fg("error", line);
      return theme.fg("dim", line);
    }
    case "thinking":
      return theme.fg("dim", line);
    case "scrollHint":
      return theme.fg("dim", line);
    case "fold":
      return theme.fg("dim", line);
    case "turnSep":
      return theme.fg("dim", line);
    case "footer":
      return theme.fg("dim", line);
    case "text":
      return line;
  }
}
function applyThemeToLines(lines, classify, theme, opts = {}) {
  return lines.map((line) => applyTheme(line, classify(line), theme, opts));
}

// src/foreground-stream.ts
function countToolResultMessages(run) {
  let n = 0;
  for (const m of run.messages) {
    if (m.role === "toolResult") n += 1;
  }
  return n;
}
var SUMMARY_EXCERPT_MAX = 120;
var STREAM_MAX_CHARS = 32 * 1024;
function renderForegroundStream(run, width, theme) {
  const headerLines = renderHeader(run, width);
  const bodyLines = renderTranscript(run, {
    width,
    collapseToolCalls: true,
    showThinking: false
  });
  const merged = bodyLines.length === 0 ? headerLines : [...headerLines, ...bodyLines];
  const lines = theme ? applyThemeToLines(merged, classifyLine, theme, { status: run.status }) : merged;
  const out = lines.join("\n");
  if (out.length <= STREAM_MAX_CHARS) return out;
  let cut = out.length - STREAM_MAX_CHARS;
  const nextNewline = out.indexOf("\n", cut);
  if (nextNewline !== -1 && nextNewline - cut < 1024) cut = nextNewline + 1;
  const tail = out.slice(cut);
  return `\u2026 (transcript truncated to last ~${STREAM_MAX_CHARS} chars) \u2026
${tail}`;
}
function renderForegroundSummary(run) {
  const glyph = STATUS_GLYPH[run.status] ?? "\xB7";
  const verb = run.status === "completed" ? "completed" : run.status === "killed" ? "killed" : run.status === "timeout" ? "timed out" : run.status;
  const perSendStart = run.thisInvocationStartedAt ?? run.startTime;
  const baseline = run.thisInvocationUsageBaseline ?? {
    turns: 0,
    input: 0,
    output: 0,
    cost: 0
  };
  const elapsed = elapsedStr(perSendStart, run.finishedAt);
  const perSendUsage = {
    turns: Math.max(0, run.usage.turns - baseline.turns),
    input: Math.max(0, run.usage.input - baseline.input),
    output: Math.max(0, run.usage.output - baseline.output),
    cost: Math.max(0, run.usage.cost - baseline.cost)
  };
  const usage = formatUsage(perSendUsage);
  const usagePart = usage ? ` [${usage}]` : "";
  const lines = [];
  let headline = `${glyph} ${run.persona}:${run.id} ${verb} in ${elapsed}${usagePart}`;
  if ((run.resumeCount ?? 0) >= 1) {
    const lifetimeElapsed = elapsedStr(run.startTime, run.finishedAt);
    const lifetimeCost = run.usage.cost ? ` $${run.usage.cost.toFixed(3)}` : "";
    headline += ` \xB7 lifetime ${lifetimeElapsed}${lifetimeCost}`;
  }
  lines.push(headline);
  if (run.status === "completed") {
    const final = getFinalText(run.messages);
    if (final) {
      lines.push(`  \u2192 "${truncate2(collapseWhitespace2(final), SUMMARY_EXCERPT_MAX)}"`);
    }
  } else if (run.errorMessage) {
    lines.push(`  \u2192 ${truncate2(collapseWhitespace2(run.errorMessage), SUMMARY_EXCERPT_MAX)}`);
  }
  if (run.transcriptPath) {
    lines.push(`  Transcript: ${run.transcriptPath}`);
  }
  return lines.join("\n");
}
function truncate2(s, max) {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "\u2026";
}
function collapseWhitespace2(s) {
  return s.replace(/\s+/g, " ").trim();
}
var STREAM_DEFAULT_WIDTH = 100;
var STREAM_MIN_WIDTH = 40;
var STREAM_MAX_WIDTH = 240;
function resolveStreamWidth(cols) {
  if (typeof cols !== "number" || !Number.isFinite(cols) || cols <= 0) {
    return STREAM_DEFAULT_WIDTH;
  }
  if (cols < STREAM_MIN_WIDTH) return STREAM_MIN_WIDTH;
  if (cols > STREAM_MAX_WIDTH) return STREAM_MAX_WIDTH;
  return Math.floor(cols);
}
async function awaitOrDetach(done, detach) {
  return Promise.race([
    done.then((value) => ({ kind: "completed", value })),
    detach.then(() => ({ kind: "detached" }))
  ]);
}
function renderForegroundDetachedResult(run) {
  const text = `detached-as-background: ${run.id}
persona=${run.persona} mode=background (was foreground)

Foreground stream detached on user request. The sub-agent continues running in the background; completion will arrive as a <sub-agent-completed> notification. Do NOT re-spawn.`;
  return {
    content: [{ type: "text", text }],
    details: {
      status: "detached-as-background",
      agent_id: run.id,
      persona: run.persona,
      mode: "background"
    }
  };
}
function createUpdateThrottle(fire, opts) {
  const interval = Math.max(0, opts.intervalMs);
  let lastFireAt = -Infinity;
  let pending = null;
  let timer = null;
  let disposed = false;
  const fireNow = (payload) => {
    lastFireAt = Date.now();
    pending = null;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    fire(payload);
  };
  const scheduleTrailing = () => {
    if (timer) return;
    const wait = Math.max(0, interval - (Date.now() - lastFireAt));
    timer = setTimeout(() => {
      timer = null;
      if (disposed) return;
      const p = pending;
      pending = null;
      if (p) fireNow(p.payload);
    }, wait);
  };
  return {
    push(payload) {
      if (disposed) return;
      const now = Date.now();
      if (now - lastFireAt >= interval) {
        fireNow(payload);
        return;
      }
      pending = { payload };
      scheduleTrailing();
    },
    pushImmediate(payload) {
      if (disposed) return;
      fireNow(payload);
    },
    flush() {
      if (disposed) return;
      if (!pending) return;
      const p = pending;
      fireNow(p.payload);
    },
    dispose() {
      disposed = true;
      pending = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}
function installPostDetachCompletionListener(run, registry, pushNotification) {
  let active = true;
  const unsub = registry.onChange((r) => {
    if (!active) return;
    if (r.id !== run.id) return;
    if (!isTerminal(r.status)) return;
    active = false;
    unsub();
    pushNotification(r);
  });
  if (active && isTerminal(run.status)) {
    active = false;
    unsub();
    pushNotification(run);
  }
  return () => {
    if (!active) return;
    active = false;
    unsub();
  };
}

// src/tools.ts
var FOREGROUND_STREAM_INTERVAL_MS = 50;
function registerTools(pi, opts) {
  if (process.env.CONDUCTOR_SUBAGENT === "1") return;
  registerListTool(pi, opts);
  registerStatusTool(pi, opts);
  registerSpawnTool(pi, opts);
  registerSendTool(pi, opts);
  registerPauseTool(pi, opts);
  registerResumeTool(pi, opts);
  registerKillTool(pi, opts);
  registerFocusTool(pi, opts);
}
function registerListTool(pi, opts) {
  pi.registerTool({
    name: "ensemble_list",
    label: "List personas",
    description: "List the conductor sub-agent personas available in this workspace. Returns each persona's name, one-line description, model/thinking config, context-inheritance mode, and source (builtin / user / project).",
    promptSnippet: "List available conductor sub-agent personas",
    promptGuidelines: [
      "Call ensemble_list when you need to know which personas are installed before spawning one.",
      "The returned descriptions are short \u2014 read the persona body via /conductor show <name> if you need the full system prompt."
    ],
    parameters: Type.Object({}),
    async execute(_id, _params) {
      const cwd = opts.getCwd();
      const cfg = loadConfig(cwd);
      const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
      const personas = [...resolved.personas.values()].sort(
        (a, b) => a.name.localeCompare(b.name)
      );
      return {
        content: [{ type: "text", text: formatPersonaListForLLM(personas) }],
        details: {
          count: personas.length,
          personas: personas.map(personaSummary),
          errors: resolved.errors
        }
      };
    }
  });
}
function registerStatusTool(pi, opts) {
  pi.registerTool({
    name: "ensemble_status",
    label: "Sub-agent status",
    description: "Report status of currently-running, queued, paused, and recently-finished sub-agents in this session.",
    promptSnippet: "Check status of conductor sub-agents",
    promptGuidelines: [
      "Use ensemble_status when you need to know which sub-agents are alive (e.g. before deciding whether to spawn another).",
      "Background sub-agents push completion notifications automatically; you don't need to poll."
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.String({ description: "Filter to a specific agent_id; omit for all." })
      )
    }),
    async execute(_id, params) {
      const registry = opts.getRegistry();
      const queue = opts.getQueue();
      const all = registry.list();
      const filtered = params?.agent_id ? all.filter((r) => r.id === params.agent_id) : all;
      const groups = groupByStatus(filtered);
      const queueList = queue.list().map((p) => ({
        id: p.id,
        persona: p.persona.name,
        requestedMode: p.requestedMode,
        enqueuedAt: p.enqueuedAt
      }));
      return {
        content: [
          {
            type: "text",
            text: formatStatusForLLM(groups, queueList.length)
          }
        ],
        details: {
          running: groups.running.map(toStatusSummary),
          queued: groups.queued.map(toStatusSummary),
          paused: groups.paused.map(toStatusSummary),
          finished: [
            ...groups.completed,
            ...groups.failed,
            ...groups.killed,
            ...groups.timeout
          ].map(toStatusSummary),
          queueDetail: queueList
        }
      };
    }
  });
}
function registerSpawnTool(pi, opts) {
  pi.registerTool({
    name: "ensemble_spawn",
    label: "Spawn sub-agent",
    description: "Launch a focused sub-agent using a persona. Foreground (default): blocks until the sub-agent completes; result is returned. Background: returns immediately; completion arrives as a <sub-agent-completed> user-role message that wakes you. When the concurrency cap is reached, foreground spawns auto-downgrade to background.",
    promptSnippet: "Spawn a persona-based sub-agent (foreground or background)",
    promptGuidelines: [
      "Use ensemble_list first if you don't know which personas are available.",
      "Write fully self-contained task prompts \u2014 the sub-agent doesn't see your conversation.",
      "For read-only personas (oracle, redteam, inspector, analyst, profiler, investigator), prefer parallel background spawns.",
      "For write-capable personas (builder, simplifier), run one at a time per set of files.",
      "Foreground spawns may auto-downgrade to background under load \u2014 handle the queued-as-background return cleanly without re-spawning.",
      "Pass timeout_minutes to override the per-persona / global default for a single risky run; default applies if omitted.",
      "Pass kill_on_stall=true on autonomous chains where you can't manually intervene; the v0.10 watchdog will hard-kill a sub-agent that goes silent past its hard threshold.",
      "Pass stall_threshold_seconds (\u2265 30) on spawns whose tool calls are known-slow (npm install, brazil-build, big test suites) to suppress noisy soft-stall advisories."
    ],
    parameters: Type.Object({
      persona: Type.String({
        description: "Persona name. Run ensemble_list to see what's available."
      }),
      task: Type.String({
        description: "Self-contained task prompt for the sub-agent. Include file paths, constraints, and acceptance criteria."
      }),
      foreground: Type.Optional(
        Type.Boolean({
          description: "true (default) blocks until done and streams the sub-agent into the ensemble panel; false runs in background and notifies on completion."
        })
      ),
      timeout_minutes: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 1440,
          description: "Wall-clock timeout for this sub-agent in minutes (1\u20131440). Overrides the per-persona override and the global default. Omit to use the cascade."
        })
      ),
      kill_on_stall: Type.Optional(
        Type.Boolean({
          description: "v0.10 watchdog opt-in. true \u2192 the sub-agent is auto-killed if it goes silent past the hard-stall threshold (default 600s). false / omitted \u2192 advisory-only; the wall-clock timeout still applies. Recommend true on autonomous chains; default off for interactive sessions."
        })
      ),
      stall_threshold_seconds: Type.Optional(
        Type.Integer({
          minimum: 30,
          description: "v0.10 watchdog soft-stall threshold for this spawn, in seconds (\u2265 30). Hard threshold scales with the same ratio as conductor defaults (typically 5\xD7). Override when the persona's expected tool calls are legitimately slow (npm install, brazil-build, large test suites). Default: 120s."
        })
      ),
      steerable: Type.Optional(
        Type.Boolean({
          description: "v0.12 steering opt-in. true \u2192 launch the sub-agent in `pi --mode rpc` so the conductor can `steer` / `follow_up` it mid-run via ensemble_send. false / omitted \u2192 today's `pi --mode json -p` print mode (no steering). Cascade per-call > project > user > built-in default false. Personas using ctx.ui.confirm/select must NOT be spawned with steerable=true (auto-cancelled on the conductor side)."
        })
      ),
      inherit_context: Type.Optional(
        Type.Union(
          [
            Type.Literal("none"),
            Type.Literal("filtered"),
            Type.Literal("filtered_compact"),
            Type.Literal("full")
          ],
          {
            description: "Item 12 candidate #3 \u2014 per-call override for the persona's inherit_context frontmatter. Useful when the parent conductor's narration is contaminating the sub-agent's identity (see docs/backlog.md item 12 for the witnessed builder-4gsl bleed). Cascade: per-call > project config persona override > user config persona override > persona frontmatter. Default: persona frontmatter."
          }
        )
      )
    }),
    async execute(_id, params, signal, onUpdate) {
      const tmRange = validateTimeoutMinutes(params.timeout_minutes);
      if (tmRange) return errorResult(tmRange);
      const stallRange = validateStallThresholdSeconds(params.stall_threshold_seconds);
      if (stallRange) return errorResult(stallRange);
      const cwd = opts.getCwd();
      const cfg = loadConfig(cwd);
      const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
      const persona = resolved.personas.get(params.persona);
      if (!persona) {
        return errorResult(
          `persona "${params.persona}" not found. Run ensemble_list to see what's available.`
        );
      }
      const foreground = params.foreground !== false;
      const mode = foreground ? "foreground" : "background";
      const queue = opts.getQueue();
      const registry = opts.getRegistry();
      const baseOv = cfg.personaOverrides[persona.name] ?? {};
      const ov = params.timeout_minutes !== void 0 ? { ...baseOv, timeoutMinutes: params.timeout_minutes } : baseOv;
      const model = resolveModel(persona, ov);
      const thinking = resolveThinking(persona, ov);
      const timeoutMs = resolveTimeoutMs(persona, ov, cfg);
      const steerable = collapseSteerableCascade({
        perCall: params.steerable,
        project: void 0,
        user: void 0,
        defaultValue: cfg.defaultSteerable ?? false
      });
      const result = queue.enqueueOrSpawn({
        persona,
        task: params.task,
        mode,
        cwd,
        model,
        thinking,
        timeoutMs,
        // Snapshot parent context at spawn time. Honors inherit_context
        // (filtered/full) inside spawnRun via planSpawnPiArgs.
        parentMessages: opts.getParentMessages(),
        // v0.10 Slice 3: per-spawn watchdog overrides. Undefined →
        // conductor default (off / 120s soft).
        killOnStall: params.kill_on_stall,
        softStallSeconds: params.stall_threshold_seconds,
        steerable,
        // Item 12 candidate #3 — per-call inherit_context override.
        // Wins above persona.inheritContext (which already merges
        // project/user personaOverrides). Resolved in planSpawnPiArgs
        // via resolveInheritContext. See src/inherit-context.ts.
        inheritContextOverride: params.inherit_context,
        onUpdate: foreground ? () => {
        } : void 0,
        // foreground uses our own onUpdate below
        onComplete: foreground ? void 0 : (run) => opts.pushCompletionNotification(run)
      });
      if (result.kind === "queued") {
        const p = result.placeholderRun;
        const downgradedNote = result.downgraded ? "Foreground spawn auto-downgraded to background because the concurrency cap is full. The sub-agent is queued; completion will arrive as a <sub-agent-completed> notification." : "Spawn queued; completion will arrive as a <sub-agent-completed> notification.";
        const unsub = registry.onChange((run) => {
          if (run.id === p.id && isTerminalStatus(run.status)) {
            unsub();
            opts.pushCompletionNotification(run);
          }
        });
        return {
          content: [
            {
              type: "text",
              text: `${result.downgraded ? "queued-as-background" : "queued"}: ${p.id}
persona=${p.persona} queue_position=${result.queuePosition}

` + downgradedNote
            }
          ],
          details: {
            status: result.downgraded ? "queued-as-background" : "queued",
            agent_id: p.id,
            queue_position: result.queuePosition,
            persona: p.persona
          }
        };
      }
      if (foreground) {
        const streamWidth = resolveStreamWidth(process.stdout?.columns);
        const streamTheme = opts.getTheme?.();
        const throttle = createUpdateThrottle((r) => {
          if (!onUpdate) return;
          onUpdate({
            content: [
              {
                type: "text",
                text: renderForegroundStream(r, streamWidth, streamTheme)
              }
            ],
            details: {
              agent_id: r.id,
              status: r.status,
              lastToolCall: r.lastToolCall
            }
          });
        }, { intervalMs: FOREGROUND_STREAM_INTERVAL_MS });
        throttle.push(result.run);
        let lastToolResultCount = countToolResultMessages(result.run);
        const unsub = registry.onChange((r) => {
          if (r.id !== result.run.id) return;
          const c = countToolResultMessages(r);
          if (c > lastToolResultCount) {
            lastToolResultCount = c;
            throttle.pushImmediate(r);
          } else {
            throttle.push(r);
          }
        });
        signal?.addEventListener("abort", () => {
          try {
            result.run.proc?.kill("SIGTERM");
          } catch {
          }
        });
        try {
          const detach = opts.registerForegroundDetach();
          try {
            const outcome = await awaitOrDetach(result.done, detach.detachSignal);
            if (outcome.kind === "detached") {
              installPostDetachCompletionListener(
                result.run,
                registry,
                opts.pushCompletionNotification
              );
              return renderForegroundDetachedResult(result.run);
            }
            throttle.flush();
            return foregroundFinalResult(outcome.value);
          } finally {
            detach.unregister();
          }
        } finally {
          throttle.dispose();
          unsub();
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `running: ${result.run.id}
persona=${result.run.persona} mode=background

Spawned in background. Continue with other work; completion will arrive as a <sub-agent-completed> notification.`
          }
        ],
        details: {
          status: "running",
          agent_id: result.run.id,
          mode: "background",
          persona: result.run.persona
        }
      };
    }
  });
}
function registerSendTool(pi, opts) {
  pi.registerTool({
    name: "ensemble_send",
    label: "Send to sub-agent",
    description: "Continue an existing sub-agent's session with a new user-role message. Works on finished sub-agents too (resumes via pi --session). Foreground (default): blocks until the sub-agent's reply arrives. Background: returns immediately; reply arrives as a <sub-agent-completed> notification.",
    promptSnippet: "Send a follow-up message to an existing sub-agent",
    promptGuidelines: [
      "Use ensemble_send when you want to continue working with a sub-agent that already has the context you care about \u2014 don't re-spawn from scratch.",
      "The sub-agent must be in a terminal state (completed/failed/killed/timeout). Running, paused, and queued sub-agents are rejected.",
      "Pass agent_id from a previous ensemble_spawn or ensemble_status result."
    ],
    parameters: Type.Object({
      agent_id: Type.String({
        description: "agent_id of the sub-agent to send to. Get it from ensemble_spawn or ensemble_status."
      }),
      message: Type.String({
        description: "User-role message delivered to the sub-agent's existing session."
      }),
      foreground: Type.Optional(
        Type.Boolean({
          description: "true (default) blocks until the sub-agent finishes its reply; false runs in background and notifies on completion."
        })
      ),
      timeout_minutes: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 1440,
          description: "Wall-clock timeout for this resumed turn in minutes (1\u20131440). Overrides per-persona and global defaults. Send arms a fresh budget per call."
        })
      ),
      kill_on_stall: Type.Optional(
        Type.Boolean({
          description: "v0.10 watchdog opt-in for the resumed turn. true \u2192 auto-kill on hard-stall. Replaces the original spawn's value and persists for subsequent sends. Omit to keep the existing setting."
        })
      ),
      stall_threshold_seconds: Type.Optional(
        Type.Integer({
          minimum: 30,
          description: "v0.10 watchdog soft-stall threshold for the resumed turn, in seconds (\u2265 30). Hard threshold scales with the same ratio as conductor defaults. Replaces the original spawn's value."
        })
      ),
      streaming_behavior: Type.Optional(
        Type.Union(
          [
            Type.Literal("auto"),
            Type.Literal("steer"),
            Type.Literal("follow_up"),
            Type.Literal("resume")
          ],
          {
            description: "v0.12 steering. Default 'auto' \u2192 follow_up for live RPC sub-agents, spawn-resume for terminal ones. 'steer' interrupts the running turn; 'follow_up' queues for the next turn boundary; 'resume' forces a fresh subprocess via pi --session (terminal runs only). Sub-agent must have been spawned with steerable: true for steer/follow_up to work."
          }
        )
      )
    }),
    async execute(_id, params, signal, onUpdate) {
      const tmRange = validateTimeoutMinutes(params.timeout_minutes);
      if (tmRange) return errorResult(tmRange);
      const stallRange = validateStallThresholdSeconds(params.stall_threshold_seconds);
      if (stallRange) return errorResult(stallRange);
      const cwd = opts.getCwd();
      const cfg = loadConfig(cwd);
      const registry = opts.getRegistry();
      const run = registry.get(params.agent_id);
      if (!run) {
        return errorResult(
          `agent_id "${params.agent_id}" not found. Run ensemble_status to see active sub-agents.`
        );
      }
      const foreground = params.foreground !== false;
      const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
      const persona = resolved.personas.get(run.persona);
      const baseOv = cfg.personaOverrides[run.persona] ?? {};
      const ov = params.timeout_minutes !== void 0 ? { ...baseOv, timeoutMinutes: params.timeout_minutes } : baseOv;
      const timeoutMs = resolveTimeoutMs(persona, ov, cfg);
      const result = sendToRun(run, params.message, {
        registry,
        timeoutMs,
        onComplete: foreground ? void 0 : (r) => opts.pushCompletionNotification(r),
        // v0.10 Slice 3: per-send watchdog overrides. Undefined → keep
        // the run's existing values.
        killOnStall: params.kill_on_stall,
        softStallSeconds: params.stall_threshold_seconds,
        // v0.12 slice 4: drive resolveSendStrategy. Undefined → "auto".
        streamingBehavior: params.streaming_behavior
      });
      if (result.kind === "rejected") {
        return errorResult(result.reason);
      }
      if (result.ack !== void 0) {
        try {
          const ackResult = await result.ack;
          return {
            content: [
              {
                type: "text",
                text: `delivered: ${result.run.id}
persona=${result.run.persona} mode=steering (RPC ack received)

The sub-agent acknowledged the message at ${new Date(ackResult.deliveredAt).toISOString()}. It continues running; reply will land on its next message_end.`
              }
            ],
            details: {
              status: "delivered",
              agent_id: result.run.id,
              persona: result.run.persona,
              delivered: ackResult.delivered,
              delivered_at: ackResult.deliveredAt
            }
          };
        } catch (e) {
          return errorResult(e.message);
        }
      }
      if (foreground) {
        const streamWidth = resolveStreamWidth(process.stdout?.columns);
        const streamTheme = opts.getTheme?.();
        const throttle = createUpdateThrottle((r) => {
          if (!onUpdate) return;
          onUpdate({
            content: [
              {
                type: "text",
                text: renderForegroundStream(r, streamWidth, streamTheme)
              }
            ],
            details: {
              agent_id: r.id,
              status: r.status,
              lastToolCall: r.lastToolCall
            }
          });
        }, { intervalMs: FOREGROUND_STREAM_INTERVAL_MS });
        throttle.push(result.run);
        let lastToolResultCount2 = countToolResultMessages(result.run);
        const unsub = registry.onChange((r) => {
          if (r.id !== result.run.id) return;
          const c = countToolResultMessages(r);
          if (c > lastToolResultCount2) {
            lastToolResultCount2 = c;
            throttle.pushImmediate(r);
          } else {
            throttle.push(r);
          }
        });
        signal?.addEventListener("abort", () => {
          try {
            result.run.proc?.kill("SIGTERM");
          } catch {
          }
        });
        try {
          const detach = opts.registerForegroundDetach();
          try {
            const outcome = await awaitOrDetach(result.done, detach.detachSignal);
            if (outcome.kind === "detached") {
              installPostDetachCompletionListener(
                result.run,
                registry,
                opts.pushCompletionNotification
              );
              return renderForegroundDetachedResult(result.run);
            }
            throttle.flush();
            return foregroundFinalResult(outcome.value);
          } finally {
            detach.unregister();
          }
        } finally {
          throttle.dispose();
          unsub();
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `running: ${result.run.id}
persona=${result.run.persona} mode=background (resumed)

Send dispatched in background. Continue with other work; completion will arrive as a <sub-agent-completed> notification.`
          }
        ],
        details: {
          status: "running",
          agent_id: result.run.id,
          mode: "background",
          persona: result.run.persona
        }
      };
    }
  });
}
function registerPauseTool(pi, opts) {
  pi.registerTool({
    name: "ensemble_pause",
    label: "Pause sub-agent",
    description: "SIGSTOP a running sub-agent. The process is alive but not consuming tokens. Use ensemble_resume to continue. Useful for cost control while the user reviews partial output.",
    promptSnippet: "Pause a running sub-agent",
    promptGuidelines: [
      "Use ensemble_pause to halt token consumption on a long-running sub-agent without killing it.",
      "The sub-agent must be in 'running' status; paused/queued/terminal sub-agents are rejected."
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "agent_id of the sub-agent to pause." })
    }),
    async execute(_id, params) {
      const registry = opts.getRegistry();
      const run = registry.get(params.agent_id);
      if (!run) {
        const r = errorResult(
          `agent_id "${params.agent_id}" not found. Run ensemble_status to see active sub-agents.`
        );
        return r;
      }
      if (run.status !== "running") {
        const r = errorResult(
          `cannot pause sub-agent ${run.id}: status is ${run.status} (must be 'running').`
        );
        return r;
      }
      const ok = pauseRun(run, registry);
      if (!ok) {
        const r = errorResult(
          `pause failed for ${run.id}: process handle missing or signal rejected.`
        );
        return r;
      }
      return {
        content: [{ type: "text", text: `paused: ${run.id}` }],
        details: { status: "paused", agent_id: run.id, persona: run.persona }
      };
    }
  });
}
function registerResumeTool(pi, opts) {
  pi.registerTool({
    name: "ensemble_resume",
    label: "Resume sub-agent",
    description: "SIGCONT a paused sub-agent. The sub-agent must have been paused via ensemble_pause first.",
    promptSnippet: "Resume a paused sub-agent",
    promptGuidelines: [
      "Use ensemble_resume to continue a sub-agent previously paused via ensemble_pause.",
      "The sub-agent must be in 'paused' status; running/queued/terminal sub-agents are rejected."
    ],
    parameters: Type.Object({
      agent_id: Type.String({ description: "agent_id of the sub-agent to resume." })
    }),
    async execute(_id, params) {
      const registry = opts.getRegistry();
      const run = registry.get(params.agent_id);
      if (!run) {
        const r = errorResult(
          `agent_id "${params.agent_id}" not found. Run ensemble_status to see active sub-agents.`
        );
        return r;
      }
      if (run.status !== "paused") {
        const r = errorResult(
          `cannot resume sub-agent ${run.id}: status is ${run.status} (must be 'paused').`
        );
        return r;
      }
      const ok = resumeRun(run, registry);
      if (!ok) {
        const r = errorResult(
          `resume failed for ${run.id}: process handle missing or signal rejected.`
        );
        return r;
      }
      return {
        content: [{ type: "text", text: `resumed: ${run.id}` }],
        details: { status: "running", agent_id: run.id, persona: run.persona }
      };
    }
  });
}
function registerKillTool(pi, opts) {
  pi.registerTool({
    name: "ensemble_kill",
    label: "Kill sub-agent",
    description: "Force-terminate a running, paused, or queued sub-agent by `agent_id`. SIGTERM-then-SIGKILL on processes; queued sub-agents are removed from the queue. Use to stop a sub-agent that has run too long, gone off-track, or that you want to abort before completion. The sub-agent's run record is preserved for inspection (transcript, final.md). Idempotent \u2014 calling on an already-terminated sub-agent is a no-op success. Killing via tool never triggers a follow-up turn (consistent with the existing pi convention that tool-initiated kills are silent).",
    promptSnippet: "Force-terminate a sub-agent",
    promptGuidelines: [
      "Use ensemble_kill to abort a sub-agent that is misbehaving, off-track, or no longer needed.",
      "Killable states: running, paused, queued. Already-terminal sub-agents are no-op success.",
      "Run records (transcript, final.md) are preserved for post-mortem inspection."
    ],
    parameters: Type.Object({
      agent_id: Type.String({
        description: "agent_id of the sub-agent to terminate."
      })
    }),
    async execute(_id, params) {
      const registry = opts.getRegistry();
      const queue = opts.getQueue();
      const run = registry.get(params.agent_id);
      if (!run) {
        const r = errorResult(
          `agent_id "${params.agent_id}" not found. Run ensemble_status to see active sub-agents.`
        );
        return r;
      }
      if (run.status === "completed" || run.status === "failed" || run.status === "killed" || run.status === "timeout" || run.status === "hook_failed") {
        return {
          content: [{ type: "text", text: `already ${run.status}: ${run.id} (no-op)` }],
          details: { status: run.status, agent_id: run.id, persona: run.persona }
        };
      }
      if (run.status === "queued") {
        queue.removeQueued(run.id);
      } else {
        forceTerminate(run, "killed", registry);
      }
      return {
        content: [{ type: "text", text: `killed: ${run.id}` }],
        details: { status: "killed", agent_id: run.id, persona: run.persona }
      };
    }
  });
}
function registerFocusTool(pi, opts) {
  pi.registerTool({
    name: "ensemble_focus",
    label: "Focus a sub-agent",
    description: "Request the focused-stream overlay open on a specific sub-agent. When agent_id is omitted, opens the overlay on the currently-focused (most recently active) sub-agent. The user controls the overlay with Esc (close), Tab/Shift+Tab (cycle), arrows (scroll), c (collapse tool calls), t (thinking visibility), k (kill).",
    promptSnippet: "Open the focused-stream overlay on a sub-agent",
    promptGuidelines: [
      "Use ensemble_focus when you want to draw the user's attention to a particular sub-agent's live transcript.",
      "Pass agent_id when you have a specific sub-agent in mind; omit it to open the overlay on the most recently active one."
    ],
    parameters: Type.Object({
      agent_id: Type.Optional(
        Type.String({ description: "agent_id of the sub-agent to focus on (omit for most-recent)." })
      )
    }),
    async execute(_id, params) {
      const model = opts.getModel();
      const id = params?.agent_id;
      if (id) {
        const ok = model.focus(id);
        if (!ok) {
          const details3 = { opened: false, agent_id: id, error: "agent_id not found" };
          return {
            content: [
              {
                type: "text",
                text: `agent_id "${id}" not found. Run ensemble_status to see active sub-agents.`
              }
            ],
            details: details3
          };
        }
        opts.openFocusedOverlay(id);
        const details2 = { opened: true, agent_id: id };
        return {
          content: [{ type: "text", text: `Focused stream opened on ${id}.` }],
          details: details2
        };
      }
      const focused = model.focused();
      if (!focused) {
        const details2 = { opened: false };
        return {
          content: [{ type: "text", text: "No sub-agents to focus on." }],
          details: details2
        };
      }
      opts.openFocusedOverlay(focused.id);
      const details = { opened: true, agent_id: focused.id };
      return {
        content: [{ type: "text", text: `Focused stream opened on ${focused.id}.` }],
        details
      };
    }
  });
}
function resolveModel(p, ov) {
  return ov.model ?? p.model;
}
function resolveThinking(p, ov) {
  return ov.thinking ?? p.thinking;
}
function personaSummary(p) {
  return {
    name: p.name,
    description: p.description,
    model: p.model ?? "<inherited>",
    thinking: p.thinking ?? "<inherited>",
    inheritContext: p.inheritContext,
    inheritSkills: p.inheritSkills,
    timeoutMinutes: p.timeoutMinutes,
    source: p.source
  };
}
function formatPersonaListForLLM(personas) {
  if (personas.length === 0) {
    return "No personas resolved. Check ~/.pi/agent/conductor/personas/ and `<cwd>/.pi/conductor/personas/`.";
  }
  const lines = [`${personas.length} personas:`, ""];
  for (const p of personas) {
    const cfg = [];
    cfg.push(`source=${p.source}`);
    cfg.push(`model=${p.model ?? "inherited"}`);
    cfg.push(`thinking=${p.thinking ?? "inherited"}`);
    cfg.push(`context=${p.inheritContext}`);
    lines.push(`  ${p.name.padEnd(14)} \u2014 ${p.description}`);
    lines.push(`  ${" ".repeat(14)}   [${cfg.join(", ")}]`);
  }
  return lines.join("\n");
}
function groupByStatus(runs) {
  const g = {
    running: [],
    queued: [],
    paused: [],
    completed: [],
    failed: [],
    killed: [],
    timeout: [],
    hook_failed: []
  };
  for (const r of runs) g[r.status].push(r);
  return g;
}
function toStatusSummary(r) {
  return {
    id: r.id,
    persona: r.persona,
    status: r.status,
    elapsed: elapsedStr(r.startTime, r.finishedAt),
    usage: formatUsage(r.usage),
    lastToolCall: r.lastToolCall,
    transcriptPath: r.transcriptPath
  };
}
function formatStatusForLLM(g, queueSize) {
  const lines = [];
  const counts = [];
  if (g.running.length) counts.push(`${g.running.length} running`);
  if (g.paused.length) counts.push(`${g.paused.length} paused`);
  if (g.queued.length || queueSize) counts.push(`${g.queued.length} queued`);
  const finished = g.completed.length + g.failed.length + g.killed.length + g.timeout.length + g.hook_failed.length;
  if (finished) counts.push(`${finished} finished`);
  lines.push(counts.length === 0 ? "No sub-agents." : `Sub-agents: ${counts.join(", ")}.`);
  const groupOrder = [
    ["Running", g.running],
    ["Paused", g.paused],
    ["Queued", g.queued],
    ["Completed", g.completed],
    ["Failed", g.failed],
    ["Killed", g.killed],
    ["Timeout", g.timeout],
    ["Hook failed", g.hook_failed]
  ];
  for (const [label, list] of groupOrder) {
    if (list.length === 0) continue;
    lines.push("");
    lines.push(`${label}:`);
    for (const r of list) {
      const u = formatUsage(r.usage);
      const usagePart = u ? `[${u}]` : "";
      const hint = r.lastToolCall ? ` \u2192 ${r.lastToolCall}` : "";
      lines.push(
        `  ${r.id.padEnd(20)} ${r.persona.padEnd(14)} ${elapsedStr(r.startTime, r.finishedAt).padEnd(6)} ${usagePart}${hint}`
      );
    }
  }
  return lines.join("\n");
}
function foregroundFinalResult(r) {
  const summary = renderForegroundSummary(r);
  if (r.status !== "completed") {
    return {
      content: [{ type: "text", text: summary }],
      details: {
        status: r.status,
        agent_id: r.id,
        persona: r.persona,
        errorMessage: r.errorMessage,
        transcriptPath: r.transcriptPath
      }
    };
  }
  const finalText = getFinalText(r.messages) || "(no output)";
  return {
    content: [{ type: "text", text: summary }],
    details: {
      status: "completed",
      agent_id: r.id,
      persona: r.persona,
      finalText,
      usage: r.usage,
      transcriptPath: r.transcriptPath
    }
  };
}
function errorResult(text) {
  return {
    content: [{ type: "text", text }],
    details: { error: text }
  };
}
function validateTimeoutMinutes(tm) {
  if (tm === void 0) return void 0;
  if (!Number.isFinite(tm) || !Number.isInteger(tm) || tm < 1 || tm > 1440) {
    return `timeout_minutes must be an integer in [1, 1440]; got ${tm}`;
  }
  return void 0;
}
function validateStallThresholdSeconds(s) {
  if (s === void 0) return void 0;
  if (!Number.isFinite(s) || !Number.isInteger(s) || s < 30) {
    return `stall_threshold_seconds must be an integer \u2265 30; got ${s}`;
  }
  return void 0;
}
function isTerminalStatus(s) {
  return s === "completed" || s === "failed" || s === "killed" || s === "timeout" || s === "hook_failed";
}

// src/queue.ts
import { mkdirSync as mkdirSync4 } from "node:fs";
import { join as join12 } from "node:path";
var SpawnQueue = class {
  constructor(registry, maxConcurrent, maxConcurrentWriteCapable = 1) {
    this.registry = registry;
    this.maxConcurrent = maxConcurrent;
    this.maxConcurrentWriteCapable = maxConcurrentWriteCapable;
    this.registry.onChange(() => this.drain());
  }
  registry;
  maxConcurrent;
  maxConcurrentWriteCapable;
  pending = [];
  setMaxConcurrent(n) {
    this.maxConcurrent = Math.max(1, Math.floor(n));
    this.drain();
  }
  setMaxConcurrentWriteCapable(n) {
    this.maxConcurrentWriteCapable = Math.max(1, Math.floor(n));
    this.drain();
  }
  list() {
    return this.pending;
  }
  size() {
    return this.pending.length;
  }
  /**
   * Try to spawn now or enqueue.
   *
   * Returns:
   *   - { run, done }                            if spawned now
   *   - { queued: PendingSpawn, downgraded }     if queued (downgraded=true means foreground→background)
   */
  enqueueOrSpawn(opts) {
    const registry = opts.registry ?? this.registry;
    const slotsFree = this.maxConcurrent - registry.countActive();
    const writeCapable = WRITE_CAPABLE_PERSONAS.has(opts.persona.name);
    const writeSlotsFree = this.maxConcurrentWriteCapable - registry.countActiveBy(WRITE_CAPABLE_PERSONAS);
    const canSpawnNow = slotsFree > 0 && (!writeCapable || writeSlotsFree > 0);
    if (canSpawnNow) {
      const result = spawnRun({ ...opts, registry });
      return { kind: "spawned", run: result.run, done: result.done };
    }
    const id = allocateRunId(opts.persona.name, mapFromRegistry2(registry));
    const dir = runDir(id);
    mkdirSync4(dir, { recursive: true });
    const placeholder = {
      id,
      persona: opts.persona.name,
      task: opts.task,
      model: opts.model,
      thinking: opts.thinking,
      mode: "background",
      // queued runs are always background once they start
      status: "queued",
      startTime: Date.now(),
      lastEventAt: Date.now(),
      messages: [],
      usage: emptyUsage(),
      cwd: opts.cwd,
      recordPath: join12(dir, "record.json"),
      transcriptPath: join12(dir, "transcript.jsonl"),
      finalPath: join12(dir, "final.md")
    };
    registry.register(placeholder);
    const pending = {
      id,
      persona: opts.persona,
      task: opts.task,
      requestedMode: opts.mode,
      effectiveMode: "background",
      cwd: opts.cwd,
      model: opts.model,
      thinking: opts.thinking,
      timeoutMs: opts.timeoutMs,
      enqueuedAt: Date.now(),
      parentMessages: opts.parentMessages,
      onComplete: opts.onComplete,
      killOnStall: opts.killOnStall,
      softStallSeconds: opts.softStallSeconds,
      steerable: opts.steerable,
      inheritContextOverride: opts.inheritContextOverride
    };
    this.pending.push(pending);
    return {
      kind: "queued",
      pending,
      placeholderRun: placeholder,
      downgraded: opts.mode === "foreground",
      queuePosition: this.pending.length
    };
  }
  removeQueued(id) {
    const idx = this.pending.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    this.pending.splice(idx, 1);
    const placeholder = this.registry.get(id);
    if (placeholder && placeholder.status === "queued") {
      forceTerminate(placeholder, "killed", this.registry);
    }
    return true;
  }
  /** Try to start as many queued spawns as possible. Idempotent. */
  drain() {
    let i = 0;
    while (i < this.pending.length) {
      const next = this.pending[i];
      const slotsFree = this.maxConcurrent - this.registry.countActive();
      if (slotsFree <= 0) return;
      const writeCapable = WRITE_CAPABLE_PERSONAS.has(next.persona.name);
      const writeSlotsFree = this.maxConcurrentWriteCapable - this.registry.countActiveBy(WRITE_CAPABLE_PERSONAS);
      if (writeCapable && writeSlotsFree <= 0) {
        i++;
        continue;
      }
      this.pending.splice(i, 1);
      const placeholder = this.registry.get(next.id);
      if (!placeholder || placeholder.status !== "queued") {
        continue;
      }
      spawnRun({
        registry: this.registry,
        persona: next.persona,
        task: next.task,
        mode: next.effectiveMode,
        cwd: next.cwd,
        model: next.model,
        thinking: next.thinking,
        timeoutMs: next.timeoutMs,
        preAllocatedId: next.id,
        parentMessages: next.parentMessages,
        onComplete: next.onComplete,
        killOnStall: next.killOnStall,
        softStallSeconds: next.softStallSeconds,
        steerable: next.steerable,
        inheritContextOverride: next.inheritContextOverride
      });
    }
  }
};
function mapFromRegistry2(r) {
  const m = /* @__PURE__ */ new Map();
  for (const x of r.list()) m.set(x.id, x);
  return m;
}

// src/widget.ts
import { Text } from "@earendil-works/pi-tui";
var WIDGET_KEY = "conductor-ensemble";
var FINISHED_LINGER_MS = 8e3;
function mountEnsembleWidget(registry, getCtx, getWatchdogConfig) {
  const recentlyFinished = [];
  let lingerTimer;
  const render = () => {
    const ctx = getCtx();
    if (!ctx) return;
    const now = Date.now();
    for (let i = recentlyFinished.length - 1; i >= 0; i--) {
      if (recentlyFinished[i].expiresAt <= now) recentlyFinished.splice(i, 1);
    }
    const active = registry.list().filter((r) => r.status !== "completed" && r.status !== "failed" && r.status !== "killed" && r.status !== "timeout" && r.status !== "hook_failed");
    const linger = recentlyFinished.map((e) => e.run);
    if (active.length === 0 && linger.length === 0) {
      ctx.ui.setWidget(WIDGET_KEY, void 0);
      if (lingerTimer) {
        clearTimeout(lingerTimer);
        lingerTimer = void 0;
      }
      return;
    }
    ctx.ui.setWidget(
      WIDGET_KEY,
      (_tui, theme) => {
        const lines = [];
        lines.push(theme.fg("dim", `\u2500\u2500 conductor ensemble (${active.length} active${linger.length ? `, ${linger.length} done` : ""}) \u2500\u2500`));
        const wdCfg = getWatchdogConfig?.();
        for (const r of active) lines.push(formatRow(r, theme, now, wdCfg));
        for (const r of linger) lines.push(formatRow(r, theme, now, wdCfg));
        return new Text(lines.join("\n"), 0, 0);
      },
      { placement: "belowEditor" }
    );
    if (lingerTimer) clearTimeout(lingerTimer);
    if (recentlyFinished.length > 0) {
      const nextExpiry = Math.min(...recentlyFinished.map((e) => e.expiresAt));
      lingerTimer = setTimeout(render, Math.max(50, nextExpiry - now));
    }
  };
  const unsubscribe = registry.onChange((run) => {
    if (run.status === "completed" || run.status === "failed" || run.status === "killed" || run.status === "timeout" || run.status === "hook_failed") {
      const existing = recentlyFinished.find((e) => e.run.id === run.id);
      if (existing) existing.expiresAt = Date.now() + FINISHED_LINGER_MS;
      else recentlyFinished.push({ run, expiresAt: Date.now() + FINISHED_LINGER_MS });
    }
    render();
  });
  render();
  return {
    refresh: render,
    dispose: () => {
      unsubscribe();
      const ctx = getCtx();
      if (ctx) ctx.ui.setWidget(WIDGET_KEY, void 0);
      if (lingerTimer) clearTimeout(lingerTimer);
    }
  };
}
function formatRow(r, theme, nowMs, wdCfg) {
  const glyph = statusGlyph(r.status, theme);
  const name = theme.fg("accent", r.persona) + theme.fg("dim", `:${r.id.split("-").pop() ?? r.id}`);
  const elapsed = theme.fg("dim", elapsedStr(r.startTime, r.finishedAt));
  const activity = r.status === "queued" ? theme.fg("dim", " (queued)") : r.status === "paused" ? theme.fg("warning", " (paused)") : r.lastToolCall ? theme.fg("dim", ` \u2192 ${r.lastToolCall}`) : r.status === "running" ? theme.fg("dim", " starting\u2026") : "";
  const usage = r.usage.turns > 0 ? theme.fg("muted", ` [${formatUsage(r.usage)}]`) : "";
  const stall = formatStallSegment(r, theme, nowMs, wdCfg);
  return `${glyph} ${name} ${elapsed}${activity}${stall}${usage}`;
}
function formatStallSegment(r, theme, nowMs, wdCfg) {
  if (nowMs === void 0 || wdCfg === void 0) return "";
  const c = classifyStall(r, nowMs, wdCfg);
  if (c === null) return "";
  if (c.severity === "fresh") return "";
  if (c.severity === "hard") {
    return theme.fg("error", ` \xB7 STALLED ${c.silentSeconds}s!`);
  }
  return theme.fg("warning", ` \xB7 STALLED ${c.silentSeconds}s`);
}
function statusGlyph(s, theme) {
  const slot = statusColorSlot2(s);
  return theme.fg(slot, STATUS_GLYPH[s]);
}
function statusColorSlot2(s) {
  switch (s) {
    case "queued":
      return "dim";
    case "running":
      return "accent";
    case "paused":
      return "warning";
    case "completed":
      return "success";
    case "failed":
    case "killed":
    case "timeout":
    case "hook_failed":
      return "error";
  }
}

// src/compaction-hook.ts
var KEEP_RECENT_ENVELOPES = 2;
var RESULT_SUMMARY_MAX_CHARS = 200;
var ENVELOPE_RE = /<sub-agent-completed>[\s\S]*?<\/sub-agent-completed>/g;
var RESULT_RE = /(\s*)<result>\n([\s\S]*?)\n(\s*)<\/result>\n?/;
function summarizeResultText(text, max = RESULT_SUMMARY_MAX_CHARS) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max).trimEnd() + "\u2026";
}
function compactEnvelopeBlock(envelopeXml) {
  const m = envelopeXml.match(RESULT_RE);
  if (!m) return envelopeXml;
  const indent = m[1] ?? "  ";
  const body = m[2] ?? "";
  const summary = summarizeResultText(body);
  const replacement = `${indent}<result-summary>${summary}</result-summary>
`;
  return envelopeXml.replace(RESULT_RE, replacement);
}
function findEnvelopes(text) {
  const out = [];
  ENVELOPE_RE.lastIndex = 0;
  let m;
  while ((m = ENVELOPE_RE.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, block: m[0] });
  }
  return out;
}
function rewriteSelected(text, firstEnvelopeIdxOffset, shouldCompact) {
  const hits = findEnvelopes(text);
  if (hits.length === 0) return text;
  let out = "";
  let cursor = 0;
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    out += text.slice(cursor, hit.start);
    const globalIdx = firstEnvelopeIdxOffset + i;
    out += shouldCompact(globalIdx) ? compactEnvelopeBlock(hit.block) : hit.block;
    cursor = hit.end;
  }
  out += text.slice(cursor);
  return out;
}
function rewriteTextInMessage(msg, rewrite) {
  if (msg == null) return msg;
  const content = msg.content;
  if (typeof content === "string") {
    const next = rewrite(content);
    return next === content ? msg : { ...msg, content: next };
  }
  if (Array.isArray(content)) {
    let changed = false;
    const nextBlocks = content.map((block) => {
      if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
        const nextText = rewrite(block.text);
        if (nextText !== block.text) {
          changed = true;
          return { ...block, text: nextText };
        }
      }
      return block;
    });
    return changed ? { ...msg, content: nextBlocks } : msg;
  }
  return msg;
}
function compactOlderEnvelopes(messages, keepRecent = KEEP_RECENT_ENVELOPES) {
  let total = 0;
  const perMessageStart = new Array(messages.length).fill(0);
  for (let i = 0; i < messages.length; i++) {
    perMessageStart[i] = total;
    const msg = messages[i];
    const content = msg?.content;
    if (typeof content === "string") {
      total += findEnvelopes(content).length;
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
          total += findEnvelopes(block.text).length;
        }
      }
    }
  }
  if (total === 0) return messages;
  const compactBefore = total - keepRecent;
  if (compactBefore <= 0) return messages;
  const shouldCompact = (globalIdx) => globalIdx < compactBefore;
  let runningGlobalIdx = 0;
  return messages.map((msg) => {
    const before = runningGlobalIdx;
    return rewriteTextInMessage(msg, (text) => {
      const hits = findEnvelopes(text);
      if (hits.length === 0) return text;
      const startIdx = runningGlobalIdx;
      runningGlobalIdx += hits.length;
      return rewriteSelected(text, startIdx, shouldCompact);
    });
    void before;
  });
}
function installCompactionHook(pi, opts = {}) {
  const keepRecent = opts.keepRecent ?? KEEP_RECENT_ENVELOPES;
  pi.on("context", async (event) => {
    const messages = compactOlderEnvelopes(event.messages, keepRecent);
    return { messages };
  });
  return {
    reset: () => {
    }
  };
}

// src/notifications.ts
function perSendNumbers(run) {
  const startedAt = run.thisInvocationStartedAt ?? run.startTime;
  const finishedAt = run.finishedAt ?? Date.now();
  const baseline = run.thisInvocationUsageBaseline ?? {
    turns: 0,
    input: 0,
    output: 0,
    cost: 0
  };
  return {
    durationMs: Math.max(0, finishedAt - startedAt),
    turns: Math.max(0, run.usage.turns - baseline.turns),
    input: Math.max(0, run.usage.input - baseline.input),
    output: Math.max(0, run.usage.output - baseline.output),
    cost: Math.max(0, run.usage.cost - baseline.cost)
  };
}
function formatCompletionNotification(run) {
  const finalText = getFinalText(run.messages);
  const perSend = perSendNumbers(run);
  const perSendStart = run.thisInvocationStartedAt ?? run.startTime;
  const perSendEnd = run.finishedAt ?? perSendStart + perSend.durationMs;
  const elapsed = elapsedStr(perSendStart, perSendEnd);
  const usageStr = formatUsage({
    turns: perSend.turns,
    input: perSend.input,
    output: perSend.output,
    cost: perSend.cost
  });
  const resumed = (run.resumeCount ?? 0) >= 1;
  const lines = [];
  lines.push("```xml");
  lines.push("<sub-agent-completed>");
  lines.push(`  <agent-id>${run.id}</agent-id>`);
  lines.push(`  <persona>${run.persona}</persona>`);
  lines.push(`  <status>${run.status}</status>`);
  lines.push(`  <duration>${elapsed}</duration>`);
  lines.push(
    `  <usage><turns>${perSend.turns}</turns><input>${perSend.input}</input><output>${perSend.output}</output><cost>${perSend.cost.toFixed(4)}</cost></usage>`
  );
  if (resumed) {
    const lifetimeElapsed = elapsedStr(run.startTime, run.finishedAt);
    lines.push("  <lifetime>");
    lines.push(`    <duration>${lifetimeElapsed}</duration>`);
    lines.push(
      `    <usage><turns>${run.usage.turns}</turns><input>${run.usage.input}</input><output>${run.usage.output}</output><cost>${run.usage.cost.toFixed(4)}</cost></usage>`
    );
    lines.push(`    <cost>${run.usage.cost.toFixed(4)}</cost>`);
    lines.push(`    <resumes>${run.resumeCount ?? 0}</resumes>`);
    lines.push("  </lifetime>");
  }
  if (run.errorMessage) {
    lines.push(`  <error>${escapeXml(run.errorMessage)}</error>`);
  }
  if (run.nonSubstantiveFinal) {
    lines.push(
      `  <warning reason="${run.nonSubstantiveFinal.reason}">${escapeXml(run.nonSubstantiveFinal.message)}</warning>`
    );
  }
  if (finalText) {
    lines.push("  <result>");
    lines.push(escapeXml(finalText));
    lines.push("  </result>");
  }
  lines.push(`  <transcript>${run.transcriptPath}</transcript>`);
  lines.push("</sub-agent-completed>");
  lines.push("```");
  lines.push("");
  const header = headerLine(run, elapsed, usageStr, resumed);
  return [header, "", ...lines].join("\n");
}
function headerLine(run, elapsed, usageStr, resumed) {
  const glyph = run.status === "completed" ? "\u2713" : run.status === "killed" ? "\u25A0" : run.status === "timeout" ? "\u23F1" : "\u2717";
  const verb = run.status === "completed" ? "completed" : run.status === "killed" ? "killed" : run.status === "timeout" ? "timed out" : "failed";
  const usagePart = usageStr ? `, ${usageStr}` : "";
  let line = `## ${glyph} \`${run.persona}\` ${verb} (${elapsed}${usagePart}) \u2014 id \`${run.id}\``;
  if (resumed) {
    const lifetimeElapsed = elapsedStr(run.startTime, run.finishedAt);
    const lifetimeCost = run.usage.cost ? `$${run.usage.cost.toFixed(3)}` : "";
    const suffix = lifetimeCost ? ` \xB7 lifetime ${lifetimeElapsed} ${lifetimeCost}` : ` \xB7 lifetime ${lifetimeElapsed}`;
    line += suffix;
  }
  return line;
}
function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function formatStallNotification(run, args) {
  const elapsed = elapsedStr(run.startTime);
  const lines = [];
  lines.push("```xml");
  lines.push("<sub-agent-stalled>");
  lines.push(`  <agent-id>${run.id}</agent-id>`);
  lines.push(`  <persona>${run.persona}</persona>`);
  lines.push(`  <status>${run.status}</status>`);
  lines.push(`  <duration>${elapsed}</duration>`);
  lines.push(
    `  <stall><severity>${args.severity}</severity><silent-seconds>${args.silentSeconds}</silent-seconds><threshold-seconds>${args.thresholdSeconds}</threshold-seconds></stall>`
  );
  if (run.lastToolCall) {
    lines.push(`  <last-tool>${escapeXml(run.lastToolCall)}</last-tool>`);
  }
  lines.push(`  <transcript>${run.transcriptPath}</transcript>`);
  lines.push("</sub-agent-stalled>");
  lines.push("```");
  lines.push("");
  const glyph = args.severity === "hard" ? "\u26A0" : "\xB7";
  const verb = args.severity === "hard" ? "hard-stalled" : "soft-stalled";
  const lastTool = run.lastToolCall ? `, last: ${run.lastToolCall}` : "";
  const header = `## ${glyph} \`${run.persona}\` ${verb} \u2014 silent ${args.silentSeconds}s${lastTool} \u2014 id \`${run.id}\``;
  return [header, "", ...lines].join("\n");
}
function buildCompletionSendMessageOptions(run) {
  if (run.mode === "background") {
    return { triggerTurn: true };
  }
  return { triggerTurn: true, deliverAs: "followUp" };
}

// src/completion-wake-tracker.ts
var DEFAULT_STALE_THRESHOLD_MS = 3e4;
var DEFAULT_MAX_REFIRES_PER_RUN = 2;
var DEFAULT_TICK_INTERVAL_MS2 = 15e3;
var CompletionWakeTracker = class {
  pending = /* @__PURE__ */ new Map();
  staleThresholdMs;
  maxRefiresPerRun;
  constructor(options = {}) {
    this.staleThresholdMs = options.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
    this.maxRefiresPerRun = options.maxRefiresPerRun ?? DEFAULT_MAX_REFIRES_PER_RUN;
  }
  /** Record that a wake notification has been sent for `runId` at `now`. */
  track(runId, now) {
    this.pending.set(runId, { sentAt: now, refireCount: 0 });
  }
  /** A turn fired — clear every pending entry. The notification chain is
   *  proven to be working for the host. */
  clearOnTurnStart() {
    this.pending.clear();
  }
  /** True iff there is at least one pending wake. */
  hasPending() {
    return this.pending.size > 0;
  }
  /** Test-only: read pending state without mutating. */
  inspectPending() {
    return this.pending;
  }
  /**
   * Drive one tick. Identifies entries that are stale (> threshold old)
   * and either schedules them for re-fire (if under the cap) or marks
   * them expired (if at the cap). The caller is responsible for actually
   * sending the re-fire `pi.sendMessage` call AND for surfacing the
   * expired warning to the user.
   *
   * Side effect: pending entries returned in `refire` get their
   * `sentAt` reset to `now` and `refireCount` incremented. Entries
   * returned in `expired` are removed from the map (the wake is
   * abandoned).
   */
  tick(now) {
    const refire = [];
    const expired = [];
    for (const [runId, entry] of this.pending) {
      const age = now - entry.sentAt;
      if (age <= this.staleThresholdMs) continue;
      if (entry.refireCount >= this.maxRefiresPerRun) {
        expired.push(runId);
        this.pending.delete(runId);
        continue;
      }
      entry.sentAt = now;
      entry.refireCount += 1;
      refire.push(runId);
    }
    return { refire, expired };
  }
  /** Drop a specific run (used when the host learns the run was killed
   *  or the registry no longer knows about it). */
  drop(runId) {
    this.pending.delete(runId);
  }
};

// src/conductor-prompt.ts
function buildConductorSystemPrompt(opts) {
  const personaDescriptions = opts.personas.map((p) => `- \`${p.name}\` \u2014 ${p.description}`).join("\n");
  return `You are running in **pi-conductor** mode.

## 1. Your role \u2014 strict overseer

You are the **conductor**: a manager. Personas are your team. Your job is to:

- Clarify the user's request until you can write a brief that fits one persona.
- Decompose multi-step work into ordered, atomic slices.
- Spawn the right persona for each slice \u2014 usually \`inspector\` / \`analyst\` / \`investigator\` for understanding, \`designer\` / \`planner\` for shape, \`builder\` / \`simplifier\` for changes, \`oracle\` / \`critic\` / \`redteam\` / \`verifier\` for review.
- Synthesize sub-agent findings before reporting to the user.
- Maintain the conversational thread across waves of sub-agents.

**You are not the implementer** *(narrow tiny-action exception in \xA71.5; declaration required)*. Code edits, refactors, test-writing, fact-finding sweeps across the codebase, design decisions, and planning are all *delegated work*. You orchestrate.

## 1.5 Hands-off rules

While conductor mode is ON, every turn you take must obey:

**You MUST NOT:**

- Call \`edit\`, \`write\`, or \`lsp_code_actions\` on any file. Use a \`builder\` or \`simplifier\`.
- Use \`bash\` for tests, builds, formatters, linters, package installs, \`git diff\` patch bodies, \`find\`/\`grep\` sweeps, or anything that touches the codebase substantively. Use \`inspector\`, \`builder\`, or \`verifier\`.
- Read more than ~3 source files in one turn to "look something up." That's an \`inspector\` task.
- Run autoresearch experiments (\`run_experiment\`/\`log_experiment\`) directly \u2014 that's \`profiler\` or \`builder\` work.
- Do TDD red-green-refactor in your own head. The \`builder\` persona has TDD baked in.
- Apply quick fixes from the LSP. That's editing in disguise.

**Principle.** If a tool *produces or mutates code* (\`edit\`, \`write\`, \`code_rewrite\`, \`lsp_code_actions\`, \`run_experiment\`, \`bash\` running tests/builds/installs), it's banned in conductor mode (with the narrow exceptions enumerated below). If a tool *produces facts about code* (\`read\`, \`cat\`, \`lsp_diagnostics\`/\`hover\`/\`definition\`/\`references\`, \`code_overview\`, \`ast_search\`, orientation \`bash\`), it's orientation \u2014 subject to the \u22643-files-per-turn cap. When in doubt, default to orientation only if the call is short, scoped, and produces facts, not code.

**You MAY (these don't count as implementation):**

- Read project meta-docs (\`PRD.md\`, \`AGENTS.md\`, \`CONTRIBUTING.md\`, \`README.md\`, and any \`design.md\` / \`plan.md\` / \`context.md\` in the working tree) \u2014 they're written *for you*.
- Run orientation bash: \`git status\`, \`git log --oneline -N\`, \`git diff --stat\`, \`ls\`, \`pwd\`, \`wc -l\`, narrowly-scoped \`find\` (max-depth 2). No long output, no patch bodies. Forensic git plumbing (\`git reflog\`, \`git fsck --lost-found\`, \`git log <dangling-sha>\`, \`git show --stat\`) belongs here too \u2014 read-only, produces facts about repo state.
- **Read up to ~3 files in a turn** to confirm a fact for a brief \u2014 *and that includes dependency typedefs, vendored code, and anything under \`node_modules/\` / \`vendor/\`*. They all count toward the same budget. If you're reaching file four (or your second \`node_modules/\` lookup), that's the signal to spawn \`inspector\`.
- **Read sub-agent outputs and transcripts** as needed for synthesis: \`<sub-agent-completed>\` envelopes, the \`<transcript>\` and \`<result>\` fields, and per-run \`final.md\` / \`record.json\` files. These are *orientation for the conversation thread*, not implementation \u2014 they don't count toward the \u22643-source-files cap.
- Use all \`ensemble_*\` tools and \`/conductor\` slash commands. That's the job.
- Use \`knowledge_search\`, \`session_search\`, \`kb_read\`, and \`memory_*\` \u2014 conversational lookup, not code edits.
- Talk to the user: clarify, summarize, ask for permission on risky moves, escalate trade-offs.

**The slip-detection check.** Before any tool call that isn't \`ensemble_*\`, knowledge/session/memory search, or one of the orientation bashes above, ask: *"Is this orientation, conversation, implementation, or a tiny direct action?"* If it's implementation, stop and spawn a persona instead. If you reach for "tiny direct action," apply this honesty test: *can I name the category and the user's verbatim direction in one clause?* If you find yourself reasoning ("well, the user *probably* wants...", "this naturally follows from...", "while I'm at it..."), it is not tiny \u2014 it is implementation work rationalized as orientation. Spawn the persona. The most common slip is starting a "quick read" of source files to plan a fix. That is \`inspector\`'s job, not yours \u2014 your "quick read" is rarely as quick as you think and it pollutes your context for the synthesis step that comes after the persona returns.

**Tiny direct actions (explicit-opt-in only).** A narrow set of operations are bounded enough that spawning a persona is friction theatre. You MAY take them yourself *only when all five conditions hold*: (i) the action falls in a named category below; (ii) the action is fully specified by either the user's verbatim direction OR a deterministic rule that follows from existing source the user already authored \u2014 without requiring you to read additional files to compute the change; (iii) the blast radius is one command, one commit, or one mechanical edit \u2014 never a multi-file change; (iv) you declare it before acting (see Declaration below); (v) **At most one tiny direct action per turn.** A second qualifying action in the same turn is the signal that you are doing implementation work, not a one-off \u2014 spawn \`builder\` instead. Categories:

- **Commit-message-only amends.** \`git commit --amend -m "..."\` when no working-tree change is staged. The committed code is unchanged; only prose moves.
- **Mechanical edits the user has dictated verbatim or that follow deterministically from existing source.** Example: bumping a test's expected-value table from \`"filtered"\` to \`"filtered_compact"\` to match a frontmatter value the user already set in \`personas/builder.md\`. The edit has no judgment call \u2014 there is exactly one correct value and the user-authored source names it.
- **Single git-plumbing commands the user explicitly directed,** when the operation does not rewrite landed history: \`git restore --source=<ref> -- <path>\`, \`git stash store\`, \`git stash apply\`, \`git mv\`, \`git tag\`, \`git checkout -- <path>\`. *Excludes* \`rebase\`, \`reset --hard\` on shared refs, \`push --force\`, anything that loses commits.
- **One-line config / version / glob fixes the user has dictated.** Bumping a version string, adding one ignore entry, fixing a typo'd path \u2014 when the user named the file and the exact change.

If the action does not fit a category, or any of (i)\u2013(v) fails, spawn a persona. Doubt resolves toward delegation. (Forensic git plumbing \u2014 \`git reflog\`, \`git fsck --lost-found\`, \`git log <dangling-sha>\`, \`git show --stat\` \u2014 is *not* a tiny-action category; it produces facts, not mutations, and lives on the orientation list above.)

**Declaration.** Before any tiny direct action, your response must contain a single line of the form:

> \`Tiny direct action: <category>. <one-clause justification.>\`

Example: \`Tiny direct action: commit-message amend. Rewriting HEAD's message; no tree change.\` This is non-negotiable. The declaration is what makes the exception honest \u2014 the user sees it and flags drift. If you cannot write a one-clause justification that names a category, the action is not tiny.

**Not tiny, even if they feel tiny:**

- **Editing source files outside the mechanical-edit category.** "Just renaming this variable" is a \`builder\` task \u2014 naming touches readers.
- **Running \`npm test\`, \`brazil-build\`, \`npx tsc\`, formatters, or linters** as a standalone action. These belong inside a persona's loop. The exception: orientation right before a \`git commit --amend\` you've already declared, to avoid committing something broken.
- **Multi-file changes,** even when each file's diff is tiny. Aggregate blast radius is what matters.
- **"While I'm here, let me also..." additions.** Scope creep wearing a tiny-action hat. If it wasn't in the user's directive, it's a separate slice and needs its own brief.
- **Anything that resolves a judgment call the user hasn't made.** "I'll pick a sensible default" is design work \u2014 spawn \`designer\` or ask.
- **Git history rewrites beyond message-only amends:** interactive rebase, squashing across commits, force-pushes. These cross from "tiny" to "irreversible."
- **Chaining two or more tiny direct actions in one turn,** even if each is in-category in isolation. Aggregation is the slip \u2014 at that point you are running an implementation slice and \`builder\` should own it.

If a task is genuinely too small to delegate AND doesn't fit a tiny-action category, say so explicitly and offer to drop conductor mode for the turn (\`/conductor off\`) before doing it yourself. Don't silently violate the rules.

## 2. Personas available

${personaDescriptions || "(no personas resolved \u2014 run `/conductor doctor`)"}

Each persona has its own system prompt (run \`/conductor show <name>\` to read it). Personas inherit your model and thinking level unless their config or settings override.

## 3. Tools

- **\`ensemble_spawn\`** \u2014 start a sub-agent with a persona and a task.
  - \`foreground: true\` (default) \u2014 your tool call blocks; the sub-agent's transcript streams into the ensemble panel; the result is returned to you.
  - \`foreground: false\` \u2014 the sub-agent runs in the background; your turn ends immediately; the completion arrives later as a \`<sub-agent-completed>\` user-role message that wakes you.
- **\`ensemble_send\`** \u2014 continue an existing sub-agent's session with a new user message. Works on finished sub-agents too (resumes their saved session). Pass \`agent_id\` from a previous spawn or from \`ensemble_status\`. Reuse a sub-agent's loaded context instead of re-spawning when you want a follow-up.
- **\`ensemble_pause\`** / **\`ensemble_resume\`** \u2014 SIGSTOP / SIGCONT a sub-agent. Useful for cost control while you read partial output. Paused sub-agents still count against the concurrency cap.
- **\`ensemble_list\`** \u2014 list available personas (most useful when introducing a new task).
- **\`ensemble_status\`** \u2014 current state of running, queued, paused, and recently-finished sub-agents.

## 4. Concurrency cap and queueing

There are at most ${opts.maxConcurrent} concurrent sub-agents. When the cap is hit:
- **Background spawns** are queued FIFO and return \`status: queued\`.
- **Foreground spawns auto-downgrade to background** and return \`status: queued-as-background\`. **Do not spawn again** to retry \u2014 the sub-agent is enqueued and will run when a slot opens. Acknowledge the queueing in your response and continue with other work.
- **\`ensemble_send\` bypasses the cap.** A send is a resume, not a new spawn, so it does not count against \`maxConcurrent\` or get queued. Don't fan out parallel sends to the same sub-agent or use sends as a way around the cap \u2014 send when you actually want a follow-up turn from that sub-agent.

## 5. Sub-agent results

Background completions arrive as user-role messages containing this XML:

\`\`\`xml
<sub-agent-completed>
  <agent-id>...</agent-id>
  <persona>...</persona>
  <status>completed|failed|killed|timeout</status>
  <duration>...</duration>
  <usage><turns>N</turns>...<cost>D</cost></usage>
  <result>
    ...the sub-agent's final assistant text...
  </result>
  <transcript>...path to transcript.jsonl...</transcript>
</sub-agent-completed>
\`\`\`

Distinguish these from real user messages by the \`<sub-agent-completed>\` opening tag. **Never thank the sub-agent and never address it directly** \u2014 the user is your conversation partner, not the persona. Synthesize the findings for the user.

## 6. Writing good persona prompts

Personas don't see your conversation. Every \`task\` argument must be self-contained:
- Include the file paths, line numbers, and constraints the persona needs.
- Cite specific assumptions; the persona will challenge them.
- Restate acceptance criteria when relevant.
- For follow-up work after a persona returns, **synthesize their findings yourself** and write a fresh, complete task. Never write "based on the previous findings" \u2014 that delegates understanding to the next persona instead of doing it yourself.

(This applies when *spawning a new persona* downstream of an earlier one. For revisions inside a \`producer \u21C4 reviewer\` loop \u2014 see \xA711 \u2014 you \`ensemble_send\` the reviewer's findings to the *same* producer, whose loaded context already contains the prior round; no re-synthesis needed.)

## 7. Parallelism

Read-only personas (\`inspector\`, \`analyst\`, \`oracle\`, \`redteam\`, \`profiler\`, \`investigator\`, \`scribe\`) can safely run in parallel \u2014 issue multiple background \`ensemble_spawn\` calls in a single turn when independent.

Write-capable personas (\`builder\`, \`simplifier\`) should run one at a time per set of files to avoid contention. Worktree isolation lands in v2.

## 8. Context inheritance (\`inherit_context\`)

Most personas declare \`inherit_context: filtered\` in their frontmatter, which means the sub-agent boots with a *filtered slice* of YOUR conversation already in its session: user prose, assistant prose, file reads/writes, and branch/compaction summaries. Orchestration noise (other \`ensemble_*\` and \`subagent\` calls, \`<sub-agent-completed>\` cards, \`thinking\` blocks, \`!!\`-prefix bash) is dropped before the sub-agent sees it. So:

- **Don't restate context the sub-agent already has.** If the user just told you "the auth module lives at src/auth/", a filtered sub-agent already saw that line. Don't paste it again into the task prompt \u2014 just refer to it.
- **Snapshots are taken at \`ensemble_spawn\` time and frozen.** When you batch several spawns in one turn, every queued sub-agent shares the SAME parent-context snapshot \u2014 the state before any of them ran. Don't expect later siblings in the same batch to see earlier siblings' work; they won't.
- **\`inherit_context: full\`** passes the entire transcript verbatim. **\`none\`** boots fresh. The persona file decides; the conductor doesn't.
- A sub-agent that sees \`<filtered-history>\` in its context has been told its inherited transcript is incomplete \u2014 dangling references to orchestration are normal there, not bugs.

## 9. When to use which persona

Common shapes:

\`\`\`
Greenfield feature
  clarifier \u2192 (cartographer | inspector) \u2192 designer \u2192 oracle \u2192
    planner \u2192 [builder \u2192 critic]\xD7N \u2192 finalizer

Bugfix
  investigator \u2192 oracle \u2192 builder \u2192 critic \u2192 verifier

Large refactor
  inspector \u2192 analyst \u2192 designer \u2192 oracle \u2192
    planner \u2192 [simplifier \u2192 critic]\xD7N \u2192 finalizer

Review-only
  redteam | critic | oracle  (often in parallel)

Perf work
  profiler \u2192 oracle \u2192 builder \u2192 verifier

Fact-finding for a brief
  inspector  (single, scoped, read-only)

Ambiguous request
  clarifier  (mandatory before designer/planner if user prose is vague)
\`\`\`

You decide the shape; these are starting points. If you're unsure which persona fits, default to \`clarifier\` first \u2014 narrowing the question is cheaper than reworking a wrong build.

For the canonical chain shapes the overseer follows by default \u2014 including oracle gates, loop bounds, and the finalizer closer \u2014 see \xA711.

## 10. Delegation playbook

\xA71 made the rule: you delegate. \xA710 is the playbook for *which* delegation, in *what shape*, *when*. The default is to spawn \u2014 these heuristics tell you which persona and how many.

**Pattern \u2192 persona triggers:**

1. **"Investigate", "trace", "find out why"** \u2192 \`investigator\`. Bug-shaped.
2. **"Survey", "map", "what does this codebase do"** \u2192 \`inspector\`. Orientation-shaped.
3. **"Design", "how should we structure"** \u2192 \`designer\`. Decision-shaped.
4. **"Plan the refactor", "break down the work"** \u2192 \`planner\`. After \`designer\`.
5. **"Implement", "fix", "add"** \u2192 \`builder\` (one slice at a time).
6. **"Review", "second opinion", "sanity check"** \u2192 \`oracle\` / \`redteam\` / \`critic\` (often in parallel as background spawns).
7. **"Is X slow, where", "profile"** \u2192 \`profiler\`.
8. **Vague request, missing acceptance criteria** \u2192 \`clarifier\` *first*, then design.
9. **"Is this all done", whole-task completion check, end-to-end gate** \u2192 \`finalizer\`. Mandatory closer for greenfield/refactor/perf chains (see \xA711).
10. **"Verify the claim", "did the bug fix actually work", post-build verification** \u2192 \`verifier\`. Closer for bug-fix chains (see \xA711).

**When to fan out (parallel background spawns):**

- Reviews benefit from multiple lenses \u2014 spawn \`oracle\` + \`redteam\` + \`critic\` in parallel; synthesize their findings yourself before reporting.
- Fact-finding across unrelated areas \u2014 multiple \`inspector\` spawns, each scoped to one area.
- The conductor system has a concurrency cap (see \xA74); foreground spawns auto-downgrade if you exceed it. Don't retry \u2014 they're queued.

**When to chain serially (foreground):**

- Each phase of a feature needs the previous one's output. \`clarifier\` \u2192 \`designer\` \u2192 \`planner\` \u2192 \`builder\` is a chain, not a fan-out.
- A \`critic\` immediately after a \`builder\` is a synchronous gate.

**The slip antipattern.** "I'll just take a quick look at \`src/foo.ts\` to see what's going on" \u2014 almost always wrong. The "quick look" turns into 10 minutes of reading, costs you context budget, and produces a worse mental model than \`inspector\` would in a fresh session. If you find yourself opening a third file in a turn, stop, write the inspector brief instead. Reading dependency typedefs to "just check the API surface" counts the same way; if you can't write the brief without learning the library yourself, that's an \`inspector\` task, not orientation.

**Steering a running sub-agent (v0.12).** Most personas you spawn run to completion and you talk to them via \`ensemble_send\` after they finish (which resumes their saved session). Some long-running sub-agents \u2014 typically \`builder\` mid-loop, or \`investigator\` deep in a trace \u2014 you may want to *interrupt* or *queue follow-up for* without waiting. That's steering.

- **Opt in at spawn time.** Pass \`steerable: true\` on \`ensemble_spawn\` to launch the sub-agent in pi's RPC mode. Default is OFF \u2014 RPC sub-agents hold an open subprocess between turns, so don't enable it for sub-agents you only need to call once. Once spawned non-steerable, a sub-agent stays non-steerable for its lifetime; you can't promote a running run mid-flight.
- **Send with a behavior.** \`ensemble_send\` takes an optional \`streaming_behavior\` arg with four values:
  - \`auto\` (default) \u2014 for a *running* steerable sub-agent, queues your message as a follow-up at the next turn boundary; for a *terminal* sub-agent, resumes its session in a fresh subprocess (today's behavior).
  - \`follow_up\` \u2014 explicit queue. Same as \`auto\` for a running steerable run.
  - \`steer\` \u2014 *interrupt* the current turn. Use sparingly: only for course corrections ("stop, you're heading down the wrong path"). The agent receives your message immediately and aborts whatever it's doing. Reflexive \`steer\` on every send wastes loaded context.
  - \`resume\` \u2014 force a fresh-subprocess resume (only valid on terminal runs; rejects on running ones with a named error).
- **Default to \`auto\`.** It does the right thing in both states: queue for running, resume for terminal. Reach for explicit \`steer\` only when you genuinely need to interrupt mid-turn.
- **Non-steerable runs reject \`steer\` / \`follow_up\`.** A run spawned without \`steerable: true\` cannot be interrupted; \`ensemble_send\` rejects with a named error pointing you at the spawn-time opt-in. The slash-command equivalent is \`/conductor send <agent-id> [--steer|--follow-up|--resume] <message>\`.
- **Steering doesn't bypass the kill switch.** \`ensemble_kill\` (and the watchdog's hard threshold when \`kill_on_stall: true\`) still SIGTERMs a steerable sub-agent. Steering is for course corrections, not for keeping a doomed run alive.

**At the start of every non-trivial user turn, ask yourself:** *"What persona owns this verb?"* Spawn that one. If you can't name a persona, ask the user a clarifying question \u2014 don't start working.

## 11. Default workflows

\xA79 lists the shapes; this section makes them prescriptive. When conductor mode is ON, every non-trivial user request follows one of these canonical chains by default. Departing from a chain requires an explicit reason, stated in the conversation.

All loops obey the \xA71.5 principle: producers may use code-mutating tools (they're personas, not the overseer); the overseer may use only fact-producing tools while routing findings.

Notation: \`\u2192\` sequential, \`|\` parallel-OR, \`\u21C4\` an \`ensemble_send\` revision loop, \`(loop \u2264N)\` the iteration cap.

\`\`\`
Greenfield feature
  oracle \u2192 (clarifier?) \u2192 designer \u2192 (oracle review)
        \u2192 planner \u21C4 critic_or_oracle (loop \u22643) \u2192 decompose
        \u2192 for each slice: builder \u21C4 critic (loop \u22643) \u2192 commit
        \u2192 finalizer

Bug fix
  oracle \u2192 investigator \u2192 (oracle gate)
        \u2192 builder \u21C4 critic (loop \u22643) \u2192 verifier

Refactor
  oracle \u2192 inspector \u2192 analyst \u2192 designer \u2192 (oracle gate)
        \u2192 planner \u21C4 oracle (loop \u22643) \u2192 decompose
        \u2192 for each slice: simplifier_or_builder \u21C4 critic (loop \u22643) \u2192 commit
        \u2192 finalizer

Perf work
  oracle \u2192 profiler \u2192 designer \u2192 (oracle gate)
        \u2192 planner \u21C4 oracle (loop \u22643) \u2192 decompose
        \u2192 for each slice: builder \u21C4 critic (loop \u22643) \u2192 commit
        \u2192 verifier \u2192 finalizer

Review-only
  oracle | redteam | critic   (parallel background spawns)
        \u2192 overseer synthesizes, no builder phase
\`\`\`

**Oracle is the opener.** Every non-trivial chain starts with \`oracle\` reviewing the goal and inherited context. If the user's prose is too vague for oracle to form a baseline contract, run \`clarifier\` first.

**\`finalizer\` is the closer.** Even small chains need the whole-task gate before declaring the user's request done. The single exception is \`Bug fix\`, where \`verifier\` plays the closer role for single-slice work.

**Loop semantics.** When a producer-reviewer pair is in a loop (\`\u21C4\`):

- **Iterate via \`ensemble_send\`, never re-spawn.** Revisions go to the same sub-agent: \`ensemble_send(producer_id, "<reviewer findings>; revise per these notes")\`. Re-spawning loses loaded context and pays the seeding cost again. \`ensemble_send\` bypasses the concurrency cap (\xA74), so loops never starve other sub-agents.
- **Cap each loop at 3 iterations.** If iteration 3 still has open issues, stop and escalate to the user with a concrete summary: what the reviewer keeps flagging, what the producer keeps producing, what the disagreement is about. Don't ping-pong past iteration 3 \u2014 at iteration 4, *you* are the bottleneck.
- **Reviewer veto trumps producer push-back.** Reviewer rejects \u2192 revision required, by default. You may override the reviewer only by stating an explicit rationale in the conversation (e.g. "redteam concern is out of scope for this slice; deferred"). Silent overrides are not allowed.
- **You do not review.** Inside a loop your job is routing findings, not substituting your own opinion. If you think the reviewer is wrong, spawn a *second* reviewer (\`redteam\` or a different \`oracle\`) for an independent check. Don't arbitrate alone \u2014 that's the slip from \xA71.5 wearing a different hat. When you spawn a second reviewer for an independent check, write its brief from the *first reviewer's findings* (which you already have in the completion envelope), not from re-reading the diff yourself. Re-reading the diff is the slip from \xA71.5 wearing a different hat.

**No parallel write-capable spawns.** Run \`builder\` and \`simplifier\` strictly serially \u2014 even on disjoint files. The git working tree and history are shared, so two write-capable personas can collide on \`git commit --amend\`, pre-commit hook test runs, and tree state. The 4-slot concurrency cap is for parallel *reviews* (oracle/redteam/critic/etc.), not parallel *builds*.

**Verifier briefs MUST be self-contained.** \`verifier\` runs with \`inherit_context: none\` (Q#16 audit, v0.8.1) \u2014 it boots with no parent transcript, no inherited file reads, no diff visibility. A brief like *"verify the previous slice"* or *"verify the claim"* is unrunnable; the verifier will return CANNOT VERIFY. Every verifier brief MUST explicitly include: (1) **the claim** being verified, stated concretely and testably (e.g. *"adds NaN guard to \`add()\`; returns 0 if either operand is NaN"*); (2) **the files changed**, with paths and ideally the commit SHA or inline diff; (3) **the strongest existing check the producer ran** (test command, lint command, build target) so verifier can re-run it; (4) **acceptance criteria** the verifier should weigh the claim against. The same self-containment requirement applies to any \`inherit_context: none\` persona (\`oracle\` is the other one) \u2014 see \xA76 \u2014 but verifier is the recurring closer in \xA711's bug-fix and perf chains, so the rule is pinned here.

**Breaking the chain.** Default chains are not laws. Depart from them \u2014 *with explicit acknowledgment* \u2014 only when:

- **Single-paragraph user question.** No chain; answer from meta-docs and orientation bash.
- **Tiny dictated fix** (see \xA71.5 tiny-direct-action categories). Take the action directly under the \xA71.5 declaration if it qualifies, OR spawn a one-slice mini-chain (\`builder \u2192 critic\` only), OR offer \`/conductor off\` for the turn. State which path you're taking.
- **Research-only task** (compare A vs B, failure modes of X). Use the \`Review-only\` chain.
- **User asks for hands-on collaboration.** Offer \`/conductor off\`. Don't fight the user's preferred mode.
- **Resuming in-flight work** where personas are still alive. Continue via \`ensemble_send\` to existing sub-agents; the "oracle gate first" rule is for *new* requests.
- **Skill-driven workflow with its own playbook** (e.g. \`task-autopilot\`, \`autoresearch\`, \`cr-dashboard\`, \`oncall\`). Defer to the skill's instructions; the canonical chain is the *default* when no skill is active.
- **User explicitly directs a parallel fan-out or specific orchestration shape.** ("Spawn 3 inspectors on X/Y/Z in parallel.") Do what the user asked; the canonical chain doesn't override explicit user direction.

If your reason isn't on this list, default back to the canonical chain. "I think it's faster" is not a valid reason.
`;
}

// src/input-pane.ts
var INPUT_PANE_ROWS = 6;

// src/focused-stream-model.ts
var NO_CLAMP_METRICS = {
  bodyRows: 0,
  transcriptLength: Number.POSITIVE_INFINITY
};
var FocusedStreamModel = class {
  constructor(registry, opts = {}) {
    this.registry = registry;
    this._getMetrics = opts.getMetrics ?? (() => NO_CLAMP_METRICS);
    this.refresh();
  }
  registry;
  _focusedId;
  _collapseToolCalls = true;
  _showThinking = false;
  _scrollPerAgent = /* @__PURE__ */ new Map();
  _stickToTailPerAgent = /* @__PURE__ */ new Map();
  _getMetrics;
  /**
   * Slice 5: per-block fold expansion overrides. Today only mutated
   * by `collapseAll()` (which clears it) and `expandAll()` (which
   * also clears it because the global override below supersedes any
   * per-key entry). Reserved for future per-block toggle UX (design
   * §6 — per-block Enter is explicitly out of scope v1).
   */
  _foldExpanded = /* @__PURE__ */ new Map();
  /**
   * Slice 5: global expand-all override. When true, every
   * `isExpanded(_, default)` returns true regardless of `default` and
   * the per-key map. `expandAll()` sets it true; `collapseAll()`
   * clears it.
   */
  _expandAllMode = false;
  /**
   * Slice 7 (overlay redesign): split-pane input flag. When true, the
   * overlay shrinks its body region by `INPUT_PANE_ROWS` and routes
   * keystrokes to the InputPane. State is global (not per-agent) —
   * cycling agents while open keeps the pane up. Idempotent open /
   * close so the same `s` keystroke can be handled twice without
   * mis-stacking.
   */
  _inputPaneOpen = false;
  /**
   * Slice 8 (overlay redesign): kill-confirmation latch. When non-null,
   * holds the agent id that is awaiting a `y/N` confirmation from the
   * footer-row prompt. The overlay is responsible for rendering the
   * confirm row when this is set, and for routing `y/Y` → fire onKill
   * + clear, `n/N`/`Esc` → clear, Tab → clear-then-cycle, any other
   * key → clear-then-pass-through. Pure state; no I/O. See design §11.
   */
  _pendingKillConfirm = null;
  /**
   * Slice 4: late-bind the metrics source after construction. The
   * overlay component must exist before its `getTranscriptLength()` is
   * reachable, so the factory constructs the overlay first and then
   * wires this closure. Tests that construct the model with a fully
   * formed metrics provider can pass it via `opts.getMetrics` instead.
   */
  setMetricsSource(getMetrics) {
    this._getMetrics = getMetrics;
  }
  /**
   * Re-evaluate focused run against the current registry state. When
   * the focused agent has `stickToTail=true` latched, also re-snap the
   * scroll offset to the new bottom (the transcript may have grown
   * since the previous refresh).
   */
  refresh() {
    const locals = this.activeList();
    if (locals.length === 0) {
      this._focusedId = void 0;
      return;
    }
    if (!this._focusedId || !locals.some((r) => r.id === this._focusedId)) {
      const newest = locals.slice().sort((a, b) => b.startTime - a.startTime)[0];
      this._focusedId = newest.id;
    }
    if (this._focusedId && this._stickToTailPerAgent.get(this._focusedId) === true) {
      this._scrollPerAgent.set(this._focusedId, this.bottom());
    }
  }
  // ── Read-only accessors ────────────────────────────────────────────
  focused() {
    if (!this._focusedId) return void 0;
    const run = this.registry.get(this._focusedId);
    if (!run) return void 0;
    if (!this.isLocal(run)) return void 0;
    return run;
  }
  collapseToolCalls() {
    return this._collapseToolCalls;
  }
  showThinking() {
    return this._showThinking;
  }
  scrollOffset() {
    if (!this._focusedId) return 0;
    return this._scrollPerAgent.get(this._focusedId) ?? 0;
  }
  /**
   * Slice 4: read-only access to the per-agent stickToTail latch. When
   * `id` is omitted, returns the focused agent's flag (or `false` when
   * nothing is focused).
   */
  stickToTail(id) {
    const key = id ?? this._focusedId;
    if (!key) return false;
    return this._stickToTailPerAgent.get(key) === true;
  }
  /** Number of runs the model knows about (visible to cycle). */
  agentCount() {
    return this.activeList().length;
  }
  // ── Mutators ───────────────────────────────────────────────────────
  /** Set focus to a specific run id. Returns true if found. */
  focus(id) {
    const list = this.activeList();
    if (!list.some((r) => r.id === id)) return false;
    this._focusedId = id;
    return true;
  }
  /**
   * Cycle to the next run in the list (wraps).
   *
   * Slice 8: also clears any pending kill-confirmation. If the user
   * cycled mid-decision, the next `y` would otherwise fire onKill
   * against whatever id was latched at `k`-press time — which is
   * almost certainly NOT what they meant after a Tab.
   */
  cycleNext() {
    this.cancelKillConfirm();
    const list = this.activeList();
    if (list.length === 0) return;
    const idx = list.findIndex((r) => r.id === this._focusedId);
    const next = list[(idx + 1) % list.length] ?? list[0];
    this._focusedId = next.id;
  }
  /** Cycle to the previous run in the list (wraps). Slice 8: also clears pendingKillConfirm. */
  cyclePrev() {
    this.cancelKillConfirm();
    const list = this.activeList();
    if (list.length === 0) return;
    const idx = list.findIndex((r) => r.id === this._focusedId);
    const prevIdx = idx <= 0 ? list.length - 1 : idx - 1;
    this._focusedId = list[prevIdx].id;
  }
  scrollDown(n) {
    if (!Number.isFinite(n) || n <= 0) return;
    if (!this._focusedId) return;
    const cur = this._scrollPerAgent.get(this._focusedId) ?? 0;
    const bottom = this.bottom();
    const clampedCur = Math.min(cur, bottom);
    const next = Math.min(clampedCur + Math.floor(n), bottom);
    this._scrollPerAgent.set(this._focusedId, next);
    if (next >= bottom && bottom > 0) {
      this._stickToTailPerAgent.set(this._focusedId, true);
    } else if (next < bottom) {
    }
  }
  scrollUp(n) {
    if (!Number.isFinite(n) || n <= 0) return;
    if (!this._focusedId) return;
    const cur = this._scrollPerAgent.get(this._focusedId) ?? 0;
    this._scrollPerAgent.set(this._focusedId, Math.max(0, cur - Math.floor(n)));
    this._stickToTailPerAgent.set(this._focusedId, false);
  }
  /**
   * Slice 4: snap to the bottom of the focused agent's transcript and
   * latch `stickToTail=true`. Bound to `End`/`G` by the overlay
   * Component.
   */
  jumpToTail() {
    if (!this._focusedId) return;
    this._scrollPerAgent.set(this._focusedId, this.bottom());
    this._stickToTailPerAgent.set(this._focusedId, true);
  }
  /**
   * Slice 4: snap to the top of the focused agent's transcript and
   * un-latch `stickToTail`. Bound to `Home`/`g` by the overlay
   * Component.
   */
  jumpToHome() {
    if (!this._focusedId) return;
    this._scrollPerAgent.set(this._focusedId, 0);
    this._stickToTailPerAgent.set(this._focusedId, false);
  }
  toggleCollapseToolCalls() {
    this._collapseToolCalls = !this._collapseToolCalls;
  }
  toggleShowThinking() {
    this._showThinking = !this._showThinking;
  }
  /**
   * Slice 5: query whether a transcript block is in expanded mode.
   *
   * Resolution order:
   *   1. global `_expandAllMode` (set by `e` / cleared by `E` and
   *      `collapseAll()`) — wins outright
   *   2. per-key `_foldExpanded` entry — currently never written by
   *      any production callsite, but reserved for future per-block
   *      Enter UX (design §6)
   *   3. fallback to caller-supplied `defaultExpanded`
   *
   * Pure: read-only; no mutation, safe to call from `render()`.
   */
  isExpanded(key, defaultExpanded) {
    if (this._expandAllMode) return true;
    const entry = this._foldExpanded.get(key);
    return entry ?? defaultExpanded;
  }
  /**
   * Slice 5: bound to `e` in the overlay. Turns on the global
   * expand-all override so every fold cap is bypassed. The per-key
   * map is cleared because the global override supersedes any
   * lingering per-block entry.
   */
  expandAll() {
    this._expandAllMode = true;
    this._foldExpanded.clear();
  }
  /**
   * Slice 5: bound to `E` in the overlay. Resets fold state to the
   * default (caps re-applied). Drops the global override AND the
   * per-key map.
   */
  collapseAll() {
    this._expandAllMode = false;
    this._foldExpanded.clear();
  }
  // ── Slice 7: split-pane input ─────────────────────────────────────
  inputPaneOpen() {
    return this._inputPaneOpen;
  }
  /**
   * Idempotent open. When the focused agent is currently latched to
   * tail (`stickToTail==true`) the model re-snaps to the new bottom
   * so the live tail remains visible above the input pane. Without
   * this re-anchor, the bottom shifts up by INPUT_PANE_ROWS as soon
   * as the pane opens and the user loses sight of the latest output.
   */
  openInputPane() {
    if (this._inputPaneOpen) return;
    this._inputPaneOpen = true;
    if (this._focusedId && this._stickToTailPerAgent.get(this._focusedId) === true) {
      this._scrollPerAgent.set(this._focusedId, this.bottom());
    }
  }
  /** Idempotent close. */
  closeInputPane() {
    if (!this._inputPaneOpen) return;
    this._inputPaneOpen = false;
  }
  // ── Slice 8: kill-confirmation latch ──────────────────────────────
  /** Returns the agent id awaiting kill confirmation, or null. */
  pendingKillConfirm() {
    return this._pendingKillConfirm;
  }
  /**
   * Begin a kill confirmation against `id`. The overlay calls this
   * from the `k` binding with the focused agent's id. Idempotent —
   * re-arming on the same id (or a new one after a Tab cycle) just
   * overwrites.
   */
  beginKillConfirm(id) {
    this._pendingKillConfirm = id;
  }
  /** Clear any pending kill confirmation. Idempotent. */
  cancelKillConfirm() {
    this._pendingKillConfirm = null;
  }
  // ── Internal ───────────────────────────────────────────────────────
  /**
   * The runs visible for cycling. Today: every LOCAL run in the registry,
   * sorted by startTime ascending so cycle order is stable. "Local" =
   * owned by this conductor host process — see `isLocal`.
   */
  activeList() {
    return this.registry.list().filter((r) => this.isLocal(r)).sort((a, b) => a.startTime - b.startTime);
  }
  /**
   * Defence-in-depth gate against foreign-pid runs. The reconcile-startup
   * ownership filter at `src/reconcile-startup.ts:248` is the primary
   * guard — no foreign record should reach the local RunRegistry once
   * that fix is verified end-to-end. We keep this model-level filter as
   * a belt-and-braces defence: if a foreign run somehow lands in the
   * registry (race, future refactor, manual injection), the focused-
   * stream overlay must not surface it for cycling, sending, or killing.
   *
   * - `parentPid === undefined` → legacy record predating the field;
   *   trust as local for back-compat. New spawns always populate the
   *   field via `src/runs.ts:766`.
   * - `parentPid === process.pid` → owned by this host. Local.
   * - anything else → foreign sibling-session run; filter out.
   */
  isLocal(run) {
    return run.parentPid === void 0 || run.parentPid === process.pid;
  }
  /**
   * Slice 4: compute the renderable bottom for the focused agent based
   * on the injected `getMetrics` closure. `bottom = max(0, transcriptLength - bodyRows)`.
   */
  bottom() {
    const m = this._getMetrics();
    const effectiveBody = Math.max(
      0,
      m.bodyRows - (this._inputPaneOpen ? INPUT_PANE_ROWS : 0)
    );
    return Math.max(0, m.transcriptLength - effectiveBody);
  }
};

// src/focused-stream-overlay.ts
import {
  Container,
  truncateToWidth as truncateToWidth2,
  visibleWidth as visibleWidth3
} from "@earendil-works/pi-tui";
var HEADER_ROWS = 4;
var FOOTER_ROWS = 3;
var BORDER_INSET = 4;
var DEFAULT_VIEWPORT_ROWS = 24;
var PANE_HINT_TEXT = "Esc:cancel \xB7 Enter:send \xB7 Ctrl-Enter:newline";
var TL = "\u256D";
var TR = "\u256E";
var BL = "\u2570";
var BR = "\u256F";
var ML = "\u251C";
var MR = "\u2524";
var HORIZ = "\u2500";
var VERT = "\u2502";
var EMPTY_HEADING = "(no sub-agents running)";
var EMPTY_PROSE = "Spawn one via ensemble_spawn or /conductor spawn.";
function renderEmpty(width, viewportHeight, theme) {
  const heading = theme ? theme.fg("muted", clip(EMPTY_HEADING, width)) : clip(EMPTY_HEADING, width);
  const prose = theme ? theme.fg("dim", clip(EMPTY_PROSE, width)) : clip(EMPTY_PROSE, width);
  const contentRows = 3;
  const extraSlack = Math.max(0, viewportHeight - contentRows);
  const topPad = viewportHeight > 0 ? Math.max(1, Math.floor(extraSlack / 2)) : 1;
  const out = [];
  for (let i = 0; i < topPad; i++) out.push("");
  out.push(heading);
  out.push("");
  out.push(prose);
  return out;
}
var FOOTER_BINDINGS = [
  {
    keyDisplay: "Esc",
    label: "close",
    matches: ["\x1B", "\x1B"],
    action: (o) => o.opts.onClose()
  },
  {
    keyDisplay: "Tab/Sh-Tab",
    label: "cycle",
    matches: ["	", "\x1B[Z"],
    action: (o, data) => {
      if (data === "\x1B[Z") o.opts.model.cyclePrev();
      else o.opts.model.cycleNext();
      o.opts.onChange?.();
    }
  },
  {
    keyDisplay: "\u2191\u2193",
    label: "scroll",
    matches: ["\x1B[B", "\x1B[A", "\x1B[6~", "\x1B[5~"],
    action: (o, data) => {
      if (data === "\x1B[A") o.opts.model.scrollUp(1);
      else if (data === "\x1B[B") o.opts.model.scrollDown(1);
      else if (data === "\x1B[5~") o.opts.model.scrollUp(10);
      else if (data === "\x1B[6~") o.opts.model.scrollDown(10);
      o.opts.onChange?.();
    }
  },
  {
    keyDisplay: "Home/End",
    label: "top/tail",
    matches: ["\x1B[H", "\x1B[F", "g", "G"],
    action: (o, data) => {
      if (data === "\x1B[H" || data === "g") o.opts.model.jumpToHome();
      else o.opts.model.jumpToTail();
      o.opts.onChange?.();
    }
  },
  {
    keyDisplay: "s",
    label: "send",
    matches: ["s"],
    action: (o) => {
      const focused = o.opts.model.focused();
      if (!focused) return;
      if (o.opts.inputPane) {
        o.opts.model.openInputPane();
        o.opts.onChange?.();
        return;
      }
      const onSend = o.opts.onSend;
      if (onSend) onSend(focused.id);
    }
  },
  {
    keyDisplay: "c",
    label: "collapse",
    matches: ["c"],
    action: (o) => {
      o.opts.model.toggleCollapseToolCalls();
      o.opts.onChange?.();
    }
  },
  {
    keyDisplay: "t",
    label: "thinking",
    matches: ["t"],
    action: (o) => {
      o.opts.model.toggleShowThinking();
      o.opts.onChange?.();
    }
  },
  {
    // Slice 5 (overlay redesign): fold expand/collapse for tool-call
    // JSON walls and thinking bodies. Lowercase = additive (expand);
    // uppercase = destructive (collapse). OPPOSITE to vim/less
    // convention; design §11 chose lowercase=expand because the more
    // aggressive action gets the shifted key.
    //
    // Slice 6 fold-in: footer hint label restored to the plan's
    // verbatim wording (`e:expand all  E:collapse all`) so the
    // fold-marker line's `(e expand all · E collapse all)` hint
    // matches the footer hint.
    keyDisplay: "e/E",
    label: "expand all/collapse all",
    matches: ["e", "E"],
    action: (o, data) => {
      if (data === "e") o.opts.model.expandAll();
      else o.opts.model.collapseAll();
      o.opts.onChange?.();
    }
  },
  {
    keyDisplay: "k",
    label: "kill",
    matches: ["k"],
    action: (o) => {
      const focused = o.opts.model.focused();
      if (!focused) return;
      o.opts.model.beginKillConfirm(focused.id);
      o.opts.onChange?.();
    }
  }
];
function renderFooterHintLine(bindings, width, theme) {
  const sep = "  ";
  let plain = "";
  let styled = "";
  for (const b of bindings) {
    const piece = `${b.keyDisplay} ${b.label}`;
    const next = plain ? plain + sep + piece : piece;
    if (visibleWidth3(next) > width) break;
    plain = next;
    if (theme) {
      const stylePiece = `${theme.fg("accent", b.keyDisplay)} ${b.label}`;
      styled = styled ? styled + sep + stylePiece : stylePiece;
    }
  }
  return theme ? styled : plain;
}
function renderScrollHint(scrollOffset, transcriptLineCount, viewportHeight, agentContext) {
  if (viewportHeight <= 0) return null;
  const above = Math.max(0, Math.min(scrollOffset, transcriptLineCount));
  const below = Math.max(0, transcriptLineCount - above - viewportHeight);
  let scrollPart;
  if (above === 0 && below === 0) scrollPart = null;
  else if (above > 0 && below > 0) scrollPart = `\u2191 ${above} hidden  \xB7  \u2193 ${below} hidden`;
  else if (above > 0) scrollPart = `\u2191 ${above} hidden`;
  else scrollPart = `\u2193 ${below} hidden`;
  let agentPart = null;
  if (agentContext && agentContext.agentCount > 1 && transcriptLineCount > 0) {
    const lineNum = Math.min(scrollOffset + 1, transcriptLineCount);
    agentPart = `${agentContext.id} (line ${lineNum}/${transcriptLineCount})`;
  }
  if (scrollPart && agentPart) return `${scrollPart}  \xB7  ${agentPart}`;
  if (scrollPart) return scrollPart;
  if (agentPart) return agentPart;
  return null;
}
function clip(s, width) {
  if (visibleWidth3(s) <= width) return s;
  return truncateToWidth2(s, width, "\u2026", false);
}
function padInner(content, innerWidth) {
  if (innerWidth <= 0) return "";
  const w = visibleWidth3(content);
  if (w >= innerWidth) return content;
  return content + " ".repeat(innerWidth - w);
}
function topBorder(width, theme) {
  if (width < 2) return HORIZ.repeat(width);
  const s = TL + HORIZ.repeat(width - 2) + TR;
  return theme ? theme.fg("border", s) : s;
}
function midBorder(width, theme) {
  if (width < 2) return HORIZ.repeat(width);
  const s = ML + HORIZ.repeat(width - 2) + MR;
  return theme ? theme.fg("border", s) : s;
}
function bottomBorder(width, theme) {
  if (width < 2) return HORIZ.repeat(width);
  const s = BL + HORIZ.repeat(width - 2) + BR;
  return theme ? theme.fg("border", s) : s;
}
function sideRow(inner, width, theme) {
  if (width < BORDER_INSET) {
    return padInner(inner, Math.max(0, width));
  }
  const innerWidth = width - BORDER_INSET;
  const left = theme ? theme.fg("border", `${VERT} `) : `${VERT} `;
  const right = theme ? theme.fg("border", ` ${VERT}`) : ` ${VERT}`;
  return left + padInner(inner, innerWidth) + right;
}
var StaticLinesZone = class {
  _lines = [];
  setLines(lines) {
    this._lines = lines;
  }
  render(_width) {
    return this._lines;
  }
  invalidate() {
    this._lines = [];
  }
};
var FocusedStreamOverlay = class {
  constructor(_opts) {
    this._opts = _opts;
    this._root = new Container();
    this._headerZone = new StaticLinesZone();
    this._bodyZone = new StaticLinesZone();
    this._footerZone = new StaticLinesZone();
    this._root.addChild(this._headerZone);
    this._root.addChild(this._bodyZone);
    this._root.addChild(this._footerZone);
  }
  _opts;
  _root;
  _headerZone;
  _bodyZone;
  _footerZone;
  /**
   * Slice 6 render cache. Single mutation surface: written ONLY
   * inside `render()`, cleared ONLY inside `invalidate()`. Subsumes
   * the slice-4 grandfathered `_lastTranscriptLength` mutation.
   * `getTranscriptLength()` reads from this field; the model's
   * `getMetrics` closure (wired by the factory) calls that getter.
   */
  _renderCache = null;
  /**
   * Public access to the construction options. Used by `FOOTER_BINDINGS`
   * action callbacks so they can dispatch through the same opts the
   * Component was wired with.
   */
  get opts() {
    return this._opts;
  }
  render(width) {
    const { model, theme } = this.opts;
    const focused = model.focused();
    const viewportRaw = this.opts.getViewportHeight?.();
    const viewport = viewportRaw && viewportRaw > 0 ? viewportRaw : DEFAULT_VIEWPORT_ROWS;
    const bodyRows = Math.max(1, viewport - HEADER_ROWS - FOOTER_ROWS);
    const innerWidth = Math.max(0, width - BORDER_INSET);
    const paneOpen = model.inputPaneOpen() && this.opts.inputPane !== void 0;
    const transcriptRows = paneOpen ? Math.max(1, bodyRows - INPUT_PANE_ROWS) : bodyRows;
    let transcriptLength = 0;
    let bodyInnerLines;
    let statusInner = "";
    let status;
    if (!focused) {
      bodyInnerLines = renderEmpty(innerWidth, transcriptRows, theme);
      bodyInnerLines = fitToHeight(bodyInnerLines, transcriptRows);
    } else {
      const hdr = renderHeader(focused, innerWidth);
      statusInner = hdr[1] ?? "";
      const transcript = renderTranscript(focused, {
        width: innerWidth,
        collapseToolCalls: model.collapseToolCalls(),
        showThinking: model.showThinking(),
        isExpanded: (key, def) => model.isExpanded(key, def)
      });
      transcriptLength = transcript.length;
      const offset = Math.min(
        model.scrollOffset(),
        Math.max(0, transcript.length - 1)
      );
      let bodyContent = transcript.slice(offset, offset + transcriptRows);
      const hint = renderScrollHint(offset, transcript.length, transcriptRows, {
        id: focused.id,
        agentCount: model.agentCount()
      });
      bodyContent = fitToHeight(bodyContent, transcriptRows);
      if (hint !== null) {
        bodyContent[bodyContent.length - 1] = hint;
      }
      bodyInnerLines = bodyContent;
      status = focused.status;
    }
    const themedBodyInner = theme ? applyThemeToLines(bodyInnerLines, classifyLine, theme, { status }) : bodyInnerLines;
    let themedStatusInner = statusInner;
    if (focused && theme) {
      const styled = applyThemeToLines([statusInner], classifyLine, theme, { status });
      themedStatusInner = styled[0] ?? statusInner;
    }
    const pendingKill = model.pendingKillConfirm();
    let footerHint;
    if (pendingKill !== null) {
      const killLine = `Kill ${pendingKill}? [y/N]`;
      footerHint = theme ? theme.fg("warning", killLine) : killLine;
    } else if (paneOpen) {
      footerHint = theme ? theme.fg("dim", PANE_HINT_TEXT) : PANE_HINT_TEXT;
    } else {
      footerHint = renderFooterHintLine(FOOTER_BINDINGS, innerWidth, theme);
    }
    const headerLines = [
      topBorder(width, theme),
      sideRow(themedStatusInner, width, theme),
      midBorder(width, theme),
      sideRow("", width, theme)
    ];
    const bodyLines = themedBodyInner.map((l) => sideRow(l, width, theme));
    while (bodyLines.length < transcriptRows) bodyLines.push(sideRow("", width, theme));
    if (bodyLines.length > transcriptRows) bodyLines.length = transcriptRows;
    if (paneOpen && this.opts.inputPane) {
      const paneLines = this.opts.inputPane.render(innerWidth);
      for (let i = 0; i < INPUT_PANE_ROWS; i++) {
        bodyLines.push(sideRow(paneLines[i] ?? "", width, theme));
      }
    }
    const footerLines = [
      midBorder(width, theme),
      sideRow(footerHint, width, theme),
      bottomBorder(width, theme)
    ];
    this._headerZone.setLines(headerLines);
    this._bodyZone.setLines(bodyLines);
    this._footerZone.setLines(footerLines);
    this._renderCache = { transcriptLength };
    return this._root.render(width);
  }
  /**
   * Slice 4 plumbing. Returns the transcript line count from the most
   * recent `render()`. Sourced from the slice-6 `_renderCache`. Pre
   * first render returns 0 — callers (the model's getMetrics closure)
   * treat 0 as "no transcript yet, no scroll needed".
   */
  getTranscriptLength() {
    return this._renderCache?.transcriptLength ?? 0;
  }
  /**
   * Slice 6 contract: invalidate clears the render cache. Must be
   * called from outside `render()` only — render owns the write
   * surface, invalidate owns the clear. The Container.invalidate()
   * cascade also empties each zone's stored lines so a stale frame
   * cannot survive a registry change.
   */
  invalidate() {
    this._root.invalidate();
    this._renderCache = null;
  }
  handleInput(data) {
    this.opts.model.refresh();
    if (this.opts.model.inputPaneOpen() && this.opts.inputPane) {
      this.opts.inputPane.handleInput(data);
      return;
    }
    const pendingKill = this.opts.model.pendingKillConfirm();
    if (pendingKill !== null) {
      if (data === "y" || data === "Y") {
        this.opts.onKill(pendingKill);
        this.opts.model.cancelKillConfirm();
        this.opts.onChange?.();
        return;
      }
      if (data === "n" || data === "N" || data === "\x1B" || data === "\x1B") {
        this.opts.model.cancelKillConfirm();
        this.opts.onChange?.();
        return;
      }
      this.opts.model.cancelKillConfirm();
    }
    for (const binding of FOOTER_BINDINGS) {
      if (binding.matches.includes(data)) {
        binding.action(this, data);
        return;
      }
    }
  }
  /**
   * Slice 7: explicit teardown for resources owned by the overlay.
   * Today only the InputPane needs to be disposed (so its Editor
   * releases focus and any debounce state). Idempotent.
   */
  dispose() {
    this.opts.inputPane?.dispose();
  }
};
function fitToHeight(lines, rows) {
  if (rows <= 0) return [];
  if (lines.length === rows) return lines.slice();
  if (lines.length > rows) return lines.slice(0, rows);
  const out = lines.slice();
  while (out.length < rows) out.push("");
  return out;
}

// src/focused-overlay-factory.ts
function createFocusedOverlayComponent(deps) {
  const overlay = new FocusedStreamOverlay({
    model: deps.model,
    onClose: () => deps.done(void 0),
    onKill: (id) => {
      const run = deps.registry.get(id);
      if (run) deps.forceTerminate(run, "killed", deps.registry);
      deps.model.refresh();
    },
    onSend: (id) => {
      deps.promptAndSendToRun(id);
    },
    theme: deps.theme,
    getViewportHeight: deps.getViewportHeight
  });
  const CHROME_ROWS = HEADER_ROWS + FOOTER_ROWS;
  deps.model.setMetricsSource(() => {
    const viewport = deps.getViewportHeight?.() ?? 0;
    return {
      bodyRows: Math.max(0, viewport - CHROME_ROWS),
      transcriptLength: overlay.getTranscriptLength()
    };
  });
  return overlay;
}

// src/focused-overlay-shortcut.ts
import { Key, matchesKey } from "@earendil-works/pi-tui";

// src/rerender-coalescer.ts
var DEFAULT_DEPS = {
  now: () => Date.now(),
  setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle)
};
var DEFAULT_RERENDER_WINDOW_MS = 50;
var RerenderCoalescer = class {
  cb;
  windowMs;
  deps;
  lastFiredAt = null;
  trailingHandle = null;
  constructor(cb, windowMs = DEFAULT_RERENDER_WINDOW_MS, deps = DEFAULT_DEPS) {
    this.cb = cb;
    this.windowMs = windowMs;
    this.deps = deps;
  }
  /**
   * Record an event. Fires the callback immediately if outside the
   * cooldown window (leading edge), otherwise arms a single trailing
   * fire for when the window quiesces. Repeated calls inside the
   * window collapse into the same trailing fire — at most 2 fires
   * per burst.
   */
  schedule() {
    const now = this.deps.now();
    if (this.lastFiredAt === null || now - this.lastFiredAt >= this.windowMs) {
      this.lastFiredAt = now;
      this.cb();
      return;
    }
    if (this.trailingHandle !== null) return;
    const remaining = this.windowMs - (now - this.lastFiredAt);
    this.trailingHandle = this.deps.setTimeout(() => {
      this.trailingHandle = null;
      this.lastFiredAt = this.deps.now();
      this.cb();
    }, remaining);
  }
  /**
   * Cancel any pending trailing-edge fire. Called from teardown to
   * avoid lingering timers / a post-shutdown stray render. Idempotent.
   */
  cancel() {
    if (this.trailingHandle !== null) {
      this.deps.clearTimeout(this.trailingHandle);
      this.trailingHandle = null;
    }
  }
};

// src/focused-overlay-shortcut.ts
var MIN_COLUMNS = 80;
var MIN_ROWS = 20;
var TOO_SMALL_MESSAGE = `Focused overlay needs \u2265${MIN_COLUMNS}\xD7${MIN_ROWS} terminal`;
function installFocusedOverlayShortcut(ctx, options) {
  if (!ctx.hasUI) {
    return () => {
    };
  }
  const coalescer = options.requestRender ? new RerenderCoalescer(
    options.requestRender,
    options.rerenderWindowMs ?? DEFAULT_RERENDER_WINDOW_MS,
    options.coalescerDeps
  ) : null;
  const scheduleRender = coalescer ? () => coalescer.schedule() : () => {
  };
  let unsubInput = ctx.ui.onTerminalInput((data) => {
    if (options.isOverlayOpen()) return void 0;
    if (matchesKey(data, Key.ctrl("g"))) {
      const size = options.getTerminalSize?.();
      if (size && options.notify && (size.columns < MIN_COLUMNS || size.rows < MIN_ROWS)) {
        options.notify(TOO_SMALL_MESSAGE, "warning");
        return { consume: true };
      }
      options.openFocusedOverlay();
      return { consume: true };
    }
    return void 0;
  });
  let unsubRegistry = options.subscribeToRegistry ? options.subscribeToRegistry(scheduleRender) : null;
  return () => {
    if (unsubInput) {
      unsubInput();
      unsubInput = null;
    }
    if (unsubRegistry) {
      unsubRegistry();
      unsubRegistry = null;
    }
    if (coalescer) coalescer.cancel();
  };
}

// src/conductor-mode.ts
var OFF_TOKENS = /* @__PURE__ */ new Set(["0", "false", "off", "no"]);
var ON_TOKENS = /* @__PURE__ */ new Set(["1", "true", "on", "yes"]);
function resolveInitialConductorMode(env, config) {
  if (config && typeof config.defaultMode === "string") {
    if (config.defaultMode === "on") return true;
    if (config.defaultMode === "off") return false;
  }
  const raw = env.PI_CONDUCTOR_MODE;
  if (raw !== void 0) {
    const v = raw.trim().toLowerCase();
    if (ON_TOKENS.has(v)) return true;
    if (OFF_TOKENS.has(v)) return false;
  }
  return false;
}

// src/sanitizer.ts
var TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
function slugifyForBedrock(originalName) {
  let slug = originalName.replace(/[^a-zA-Z0-9_-]/g, "_");
  slug = slug.replace(/_+/g, "_");
  slug = slug.replace(/^[_-]+|[_-]+$/g, "");
  if (slug.length > 64) slug = slug.slice(0, 64);
  return slug.length > 0 ? `${slug}_INVALID` : "INVALID_TOOL_NAME";
}
function sanitizeToolNames(messages, opts) {
  const isValid = opts?.isValid ?? ((n) => TOOL_NAME_REGEX.test(n));
  const buildPlaceholder = opts?.buildPlaceholder ?? slugifyForBedrock;
  const onSanitize = opts?.onSanitize;
  const badByToolCallId = /* @__PURE__ */ new Map();
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    const content = msg.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "toolCall") continue;
      if (typeof block.id !== "string" || typeof block.name !== "string") continue;
      if (!isValid(block.name)) {
        if (!badByToolCallId.has(block.id)) {
          badByToolCallId.set(block.id, {
            original: block.name,
            placeholder: buildPlaceholder(block.name)
          });
        }
      }
    }
  }
  const reportedIds = /* @__PURE__ */ new Set();
  const reportOnce = (id, original, sanitized) => {
    if (reportedIds.has(id)) return;
    reportedIds.add(id);
    if (onSanitize) {
      onSanitize({ toolCallId: id, originalName: original, sanitizedName: sanitized });
    }
  };
  const out = [];
  for (const msg of messages) {
    const role = msg.role;
    if (role === "assistant") {
      const content = msg.content;
      if (!Array.isArray(content)) {
        out.push(msg);
        continue;
      }
      const hasBad = content.some(
        (b) => b?.type === "toolCall" && typeof b.id === "string" && badByToolCallId.has(b.id)
      );
      if (!hasBad) {
        out.push(msg);
        continue;
      }
      const newContent = content.map((b) => {
        if (b?.type === "toolCall" && typeof b.id === "string") {
          const entry = badByToolCallId.get(b.id);
          if (entry) {
            reportOnce(b.id, entry.original, entry.placeholder);
            return { ...b, name: entry.placeholder };
          }
        }
        return b;
      });
      out.push({ ...msg, content: newContent });
      continue;
    }
    if (role === "toolResult") {
      const callId = msg.toolCallId;
      const entry = typeof callId === "string" ? badByToolCallId.get(callId) : void 0;
      if (entry) {
        reportOnce(callId, entry.original, entry.placeholder);
        out.push(rewriteToolResult(msg, entry.original, entry.placeholder));
        continue;
      }
      const toolName = msg.toolName;
      if (typeof toolName === "string" && !isValid(toolName)) {
        const placeholder = buildPlaceholder(toolName);
        const reportKey = typeof callId === "string" ? callId : "";
        reportOnce(reportKey, toolName, placeholder);
        out.push(rewriteToolResult(msg, toolName, placeholder));
        continue;
      }
      out.push(msg);
      continue;
    }
    out.push(msg);
  }
  return out;
}
function rewriteToolResult(msg, original, placeholder) {
  const m = msg;
  const newContent = Array.isArray(m.content) ? m.content.map((c) => {
    if (c?.type === "text" && typeof c.text === "string" && c.text.includes(original)) {
      return { ...c, text: c.text.split(original).join(placeholder) };
    }
    return c;
  }) : m.content;
  return { ...m, toolName: placeholder, content: newContent };
}

// src/sanitizer-hook.ts
function installSanitizerHook(pi, opts) {
  const warnedToolCallIds = /* @__PURE__ */ new Set();
  const warn = opts.warn ?? ((line) => console.warn(line));
  pi.on("context", async (event) => {
    const reports = [];
    const messages = sanitizeToolNames(event.messages, {
      onSanitize: (r) => reports.push(r)
    });
    for (const r of reports) {
      if (warnedToolCallIds.has(r.toolCallId)) continue;
      warnedToolCallIds.add(r.toolCallId);
      warn(
        `[pi-conductor] sanitized malformed toolUse.name ${JSON.stringify(
          r.originalName
        )} \u2192 ${r.sanitizedName} (id=${r.toolCallId})`
      );
      const ctx = opts.getCtx();
      if (ctx) {
        try {
          ctx.ui.notify(
            `pi-conductor: sanitized malformed tool name \u2192 ${r.sanitizedName}`,
            "warning"
          );
        } catch {
        }
      }
    }
    return { messages };
  });
  return {
    reset: () => warnedToolCallIds.clear()
  };
}

// src/shutdown.ts
function handleSessionShutdown(event, deps) {
  if (event.reason === "reload") return;
  const stillActive = [];
  for (const r of deps.runs) {
    if (r.status === "running" || r.status === "paused") {
      stillActive.push(r);
      try {
        r.proc?.kill("SIGTERM");
      } catch {
      }
    }
  }
  if (stillActive.length > 0 && deps.reconcileRunning) {
    try {
      deps.reconcileRunning(stillActive, event.reason);
    } catch {
    }
  }
  deps.resetSanitizer();
}

// src/prompt-and-send.ts
async function executePromptAndSend(deps, agentId, presuppliedText) {
  const ctx = deps.getCtx();
  if (!ctx) return;
  const run = deps.registry.get(agentId);
  if (!run) {
    ctx.ui.notify(`agent_id "${agentId}" not found.`, "warning");
    return;
  }
  const check = deps.validateSendable(run);
  if (!check.ok) {
    try {
      ctx.ui.notify(check.reason, "warning");
    } catch {
    }
    return;
  }
  let message;
  if (presuppliedText !== void 0) {
    const trimmed = presuppliedText.trim();
    if (trimmed.length === 0) return;
    message = trimmed;
  } else {
    try {
      message = await ctx.ui.input(
        `Send to ${agentId}`,
        "Type a follow-up message; Esc to cancel."
      );
    } catch {
      return;
    }
    if (!message || !message.trim()) return;
    message = message.trim();
  }
  const cfg = deps.loadConfig(deps.cwd);
  const ov = cfg.personaOverrides[run.persona] ?? {};
  const resolved = await deps.resolvePersonas({
    cwd: deps.cwd,
    personaOverrides: cfg.personaOverrides
  });
  const persona = resolved.personas.get(run.persona);
  const timeoutMs = deps.resolveTimeoutMs(persona, ov, cfg);
  const result = deps.sendToRun(run, message, {
    registry: deps.registry,
    timeoutMs,
    onComplete: (r) => deps.pushCompletionNotification(r)
  });
  if (result.kind === "rejected") {
    try {
      ctx.ui.notify(result.reason, "warning");
    } catch {
    }
  }
}

// src/index.ts
function index_default(pi) {
  let cwd = process.cwd();
  let ctxRef = null;
  let widget = null;
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 4, 1);
  const focusModel = new FocusedStreamModel(registry);
  let overlayOpen = false;
  let tuiRef = null;
  let unsubFocusedShortcut = null;
  let lastReconcile;
  let watchdogDispose = null;
  const completionWakeTracker = new CompletionWakeTracker();
  let completionWakeTimer = null;
  const sanitizerHook = installSanitizerHook(pi, {
    getCtx: () => ctxRef
  });
  installCompactionHook(pi);
  function openFocusedOverlay(agentId) {
    if (!ctxRef) return;
    if (overlayOpen) {
      if (agentId) focusModel.focus(agentId);
      return;
    }
    if (agentId) focusModel.focus(agentId);
    overlayOpen = true;
    void ctxRef.ui.custom(
      (tui, theme, _kb, done) => {
        tuiRef = tui;
        return createFocusedOverlayComponent({
          model: focusModel,
          registry,
          forceTerminate,
          promptAndSendToRun: (id) => {
            void promptAndSendToRun(id);
          },
          done,
          theme,
          // Slice 1 (overlay redesign): viewport-height source. `tui`
          // is in scope inside the factory body, so we use its
          // canonical `terminal.rows`. `process.stdout.rows` is the
          // non-TTY fallback. Constant 24 is the last-ditch default
          // matching the historical xterm row count and the design
          // doc §3 fallback chain.
          getViewportHeight: () => tui.terminal.rows ?? process.stdout.rows ?? 24
        });
      },
      {
        overlay: true,
        // Slice 1 (overlay redesign): anchored modal. Without these
        // options pi-tui sizes the overlay to the full terminal, and
        // tmux + small windows produced scroll-off-page renders.
        // 95×90 with a 1-cell margin gives the eye an obvious
        // "overlay" affordance; minWidth 60 prevents pathological
        // collapse if the user resizes mid-render. NO `visible:`
        // predicate — a `visible:false` would open then suppress and
        // swallow the shortcut-side notify; the threshold guard in
        // `installFocusedOverlayShortcut` is the single source of
        // truth for the 80×20 minimum.
        overlayOptions: {
          width: "95%",
          maxHeight: "90%",
          minWidth: 60,
          anchor: "center",
          margin: 1
        }
      }
    ).finally(() => {
      overlayOpen = false;
    });
  }
  async function promptAndSendToRun(agentId, presuppliedText) {
    await executePromptAndSend(
      {
        getCtx: () => ctxRef,
        registry,
        cwd,
        validateSendable,
        loadConfig,
        resolvePersonas: (args) => resolvePersonas(args),
        resolveTimeoutMs: (p, ov, cfg) => resolveTimeoutMs(p, ov, cfg),
        sendToRun: (run, message, sendOpts) => sendToRun(run, message, sendOpts),
        pushCompletionNotification: (r) => opts.pushCompletionNotification(r)
      },
      agentId,
      presuppliedText
    );
  }
  const initialCfg = loadConfig(cwd);
  let conductorModeOn = resolveInitialConductorMode(process.env, {
    defaultMode: initialCfg.defaultMode
  });
  const opts = {
    getCwd: () => cwd,
    getRegistry: () => registry,
    getQueue: () => queue,
    getModel: () => focusModel,
    /**
     * v0.9.x Slice 4: expose the most-recent post-startup reconcile
     * result so /conductor doctor surfaces it under "## Post-startup
     * reconcile". Stays undefined until session_start finishes its
     * reconcile pass.
     */
    getLastReconcile: () => lastReconcile,
    /**
     * Snapshot the parent conductor's conversation for inherit_context.
     * Walks the current session's tree from leaf to root via
     * buildSessionContext (handles compaction + branch summaries) and
     * returns the resolved AgentMessage[] the LLM would see.
     *
     * Defensive: returns [] when there's no live ctx (e.g. between
     * session_start and first turn) or when the sessionManager API
     * throws.
     */
    getParentMessages: () => {
      try {
        const ctx = ctxRef;
        if (!ctx) return [];
        const sm = ctx.sessionManager;
        if (!sm) return [];
        const entries = sm.getEntries();
        const leafId = sm.getLeafId();
        const result = buildSessionContext(entries, leafId);
        return result.messages ?? [];
      } catch {
        return [];
      }
    },
    openFocusedOverlay,
    getConductorMode: () => conductorModeOn,
    setConductorMode: (on) => {
      conductorModeOn = on;
    },
    /**
     * Slice 7: read the host's current Theme so the foreground stream
     * can colour its rendered transcript. Returns undefined in headless
     * contexts and between session_start cycles — the renderer falls
     * back to plain output in that case.
     */
    getTheme: () => ctxRef?.ui.theme,
    /**
     * One-shot detach slot for the active foreground spawn. Listens to
     * raw terminal input via ctx.ui.onTerminalInput (interactive mode
     * only) and intercepts a bare Esc keystroke, resolving the detach
     * signal. Esc is consumed (`{ consume: true }`) so pi's reserved
     * `app.interrupt` action doesn't also fire — i.e. Esc detaches
     * cleanly without killing. Pi tool calls run sequentially within an
     * assistant turn, so a single slot is enough.
     */
    registerForegroundDetach: () => {
      let resolveDetach = () => {
      };
      const detachSignal = new Promise((res) => {
        resolveDetach = res;
      });
      let unsubInput = null;
      const ctx = ctxRef;
      if (ctx && ctx.hasUI) {
        unsubInput = ctx.ui.onTerminalInput((data) => {
          if (overlayOpen) return void 0;
          if (matchesKey2(data, "escape")) {
            resolveDetach();
            return { consume: true };
          }
          return void 0;
        });
      }
      const unregister = () => {
        if (unsubInput) {
          unsubInput();
          unsubInput = null;
        }
        resolveDetach();
      };
      return { detachSignal, unregister };
    },
    pushCompletionNotification: (run) => {
      const text = formatCompletionNotification(run);
      pi.sendMessage(
        {
          customType: "ensemble-notification",
          content: text,
          display: true
        },
        buildCompletionSendMessageOptions(run)
      );
      completionWakeTracker.track(run.id, Date.now());
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    ctxRef = ctx;
    if (widget) widget.dispose();
    widget = mountEnsembleWidget(registry, () => ctxRef, () => {
      const cfg = loadConfig(cwd);
      return {
        softThresholdSeconds: cfg.watchdog.defaultSoftSeconds,
        hardThresholdSeconds: cfg.watchdog.defaultHardSeconds,
        graceSeconds: cfg.watchdog.graceSeconds
      };
    });
    if (unsubFocusedShortcut) unsubFocusedShortcut();
    unsubFocusedShortcut = installFocusedOverlayShortcut(ctx, {
      openFocusedOverlay: () => openFocusedOverlay(),
      isOverlayOpen: () => overlayOpen,
      // Slice 11 + Slice 3: keep the focus model fresh as the registry
      // mutates AND coalesce the resulting render requests through the
      // shortcut-owned RerenderCoalescer. The `scheduleRender` arg is
      // the coalescer's `schedule()`; production calls it after
      // `focusModel.refresh()` so the model is up to date when the
      // (coalesced) `tui.requestRender()` lands. Lives here
      // (session-scoped) rather than in the overlay factory (per-open)
      // so re-opening the overlay does NOT stack listeners.
      subscribeToRegistry: (scheduleRender) => registry.onChange(() => {
        focusModel.refresh();
        scheduleRender();
      }),
      // Slice 3 (overlay redesign): trigger pi-tui's render scheduler
      // when the coalescer's leading/trailing edges fire. Before the
      // overlay has ever opened (and thus before `tuiRef` is captured)
      // this is a no-op, which is correct — nothing is rendered yet.
      requestRender: () => tuiRef?.requestRender(),
      // Slice 1 (overlay redesign): terminal-size source for the
      // too-small guard. `ExtensionUIContext` does not expose a TUI
      // ref outside `custom`/`setWidget` factory bodies, so we read
      // `process.stdout` here. The threshold (80×20) and notify text
      // live inside the helper.
      getTerminalSize: () => ({
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24
      }),
      notify: (message, level) => ctx.ui.notify(message, level)
    });
    setImmediate(() => {
      void reconcileOrphansAtStartup({
        runsRoot: runsRoot(),
        registry,
        isAlive: defaultLivenessProbe,
        now: Date.now()
      }).then((result) => {
        lastReconcile = result;
      }).catch((err) => {
        console.error(
          `reconcile-startup: failed: ${err?.message ?? String(err)}`
        );
      });
    });
    setImmediate(() => {
      const cfg = loadConfig(cwd);
      void maybeAutoRunGc({
        runsRoot: runsRoot(),
        config: cfg.gc,
        registry
      }).catch((err) => {
        console.error(`gc auto: failed: ${err?.message ?? String(err)}`);
      });
    });
    if (watchdogDispose) {
      watchdogDispose();
      watchdogDispose = null;
    }
    {
      const cfg = loadConfig(cwd);
      const wd = new Watchdog({
        registry,
        config: {
          softThresholdSeconds: cfg.watchdog.defaultSoftSeconds,
          hardThresholdSeconds: cfg.watchdog.defaultHardSeconds,
          graceSeconds: cfg.watchdog.graceSeconds
        },
        tickIntervalMs: cfg.watchdog.tickIntervalSeconds * 1e3,
        log: {
          warn: (msg, data) => {
            const meta = data;
            const run = meta?.agentId ? registry.get(meta.agentId) : void 0;
            if (run && meta?.severity && typeof meta.silentSeconds === "number") {
              const thresholdSeconds = meta.severity === "hard" ? cfg.watchdog.defaultHardSeconds : cfg.watchdog.defaultSoftSeconds;
              const text = formatStallNotification(run, {
                severity: meta.severity,
                silentSeconds: meta.silentSeconds,
                thresholdSeconds
              });
              try {
                pi.sendMessage(
                  {
                    customType: "ensemble-notification",
                    content: text,
                    display: true
                  },
                  { triggerTurn: false, deliverAs: "followUp" }
                );
              } catch (err) {
                console.error(`watchdog: ${msg}`);
                void err;
              }
            } else {
              console.error(`watchdog: ${msg}`);
            }
          },
          info: (msg) => {
            console.error(`watchdog: ${msg}`);
          }
        },
        now: () => Date.now(),
        kill: (run, reason) => {
          forceTerminate(run, reason, registry);
        },
        // v0.10 Slice 3: per-run `kill_on_stall` overrides the
        // conductor-wide default. The lambda delegates to
        // `resolveKillOnStall` (exported, witness-pinned by
        // `tests/watchdog-enforcer.test.ts`) so a regression in the
        // formula is caught by the W1 mutation witness.
        isKillOnStall: (run) => resolveKillOnStall(run, cfg.watchdog.defaultKillOnStall),
        isEnabled: () => cfg.watchdog.enabled
      });
      watchdogDispose = wd.start();
    }
    completionWakeTimer = setInterval(() => {
      const result = completionWakeTracker.tick(Date.now());
      for (const runId of result.refire) {
        const run = registry.get(runId);
        if (!run) {
          completionWakeTracker.drop(runId);
          continue;
        }
        pi.sendMessage(
          {
            customType: "ensemble-notification",
            content: formatCompletionNotification(run),
            display: true
          },
          buildCompletionSendMessageOptions(run)
        );
      }
      for (const runId of result.expired) {
        ctxRef?.ui.notify(
          `sub-agent ${runId} completed but the conductor did not wake after multiple attempts. Run /conductor status to inspect; the wake notification is documented at docs/backlog.md item 11.`,
          "warning"
        );
      }
    }, DEFAULT_TICK_INTERVAL_MS2);
  });
  pi.on("session_shutdown", async (event) => {
    if (unsubFocusedShortcut) {
      unsubFocusedShortcut();
      unsubFocusedShortcut = null;
    }
    if (widget) {
      widget.dispose();
      widget = null;
    }
    if (watchdogDispose) {
      watchdogDispose();
      watchdogDispose = null;
    }
    if (completionWakeTimer) {
      clearInterval(completionWakeTimer);
      completionWakeTimer = null;
    }
    completionWakeTracker.clearOnTurnStart();
    handleSessionShutdown(event, {
      runs: registry.list(),
      resetSanitizer: () => sanitizerHook.reset(),
      // A1: close the orphan-creation window. SIGTERM races the runtime
      // teardown; without this the on-disk record stays "running" until
      // the next session_start runs the GC orphan sweep.
      reconcileRunning: (runs, reason) => {
        const now = Date.now();
        for (const r of runs) {
          void reconcileRecord(r, "killed", `shutdown: ${reason}`, now);
        }
      }
    });
    ctxRef = null;
  });
  pi.on("turn_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    ctxRef = ctx;
    if (!widget) widget = mountEnsembleWidget(registry, () => ctxRef);
    completionWakeTracker.clearOnTurnStart();
  });
  pi.on("before_agent_start", async (event) => {
    if (!conductorModeOn) return void 0;
    try {
      const cfg = loadConfig(cwd);
      queue.setMaxConcurrent(cfg.maxConcurrent);
      queue.setMaxConcurrentWriteCapable(cfg.maxConcurrentWriteCapable);
      const resolved = await resolvePersonas({
        cwd,
        personaOverrides: cfg.personaOverrides
      });
      const personas = [...resolved.personas.values()].sort(
        (a, b) => a.name.localeCompare(b.name)
      );
      const addendum = buildConductorSystemPrompt({
        personas,
        maxConcurrent: cfg.maxConcurrent
      });
      const merged = `${event.systemPrompt}

${addendum}`;
      return { systemPrompt: merged };
    } catch {
      return void 0;
    }
  });
  registerTools(pi, opts);
  registerCommands(pi, opts);
}
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
