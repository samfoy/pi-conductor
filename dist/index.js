// src/index.ts
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey as matchesKey2 } from "@earendil-works/pi-tui";

// src/commands.ts
import { existsSync as existsSync8, readdirSync as readdirSync2, readFileSync as readFileSync2, statSync as statSync3 } from "node:fs";
import { join as join10 } from "node:path";

// src/status-glyph.ts
var STATUS_GLYPH = {
  queued: "\u25CC",
  running: "\u25CF",
  paused: "\u23F8",
  completed: "\u2713",
  failed: "\u2717",
  killed: "\u25A0",
  timeout: "\u23F1"
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
var CONTEXT_INHERITANCE = ["none", "filtered", "full"];
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
  }
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
    systemPrompt: r.systemPrompt
  };
}
var TERMINAL_STATUSES = ["completed", "failed", "killed", "timeout"];
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
    sourcePath
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
  let cfg = { ...DEFAULT_CONFIG };
  const errors = [];
  const u = safeReadJson(userConfigPath());
  if (u.error) errors.push(u.error);
  cfg = mergeConfig(cfg, u.value);
  const p = safeReadJson(projectConfigPath(cwd));
  if (p.error) errors.push(p.error);
  cfg = mergeConfig(cfg, p.value);
  return { config: cfg, errors };
}
function loadConfig(cwd) {
  return loadConfigWithErrors(cwd).config;
}

// src/runs.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readdirSync, statSync } from "node:fs";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { homedir as homedir3 } from "node:os";
import { dirname as dirname3, join as join3 } from "node:path";

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
  return NONE;
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

// src/runs.ts
function runsRoot() {
  return join3(homedir3(), ".pi", "agent", "conductor", "runs");
}
function runDir(id) {
  return join3(runsRoot(), id);
}
function collectInheritedSkillPaths(opts) {
  const home = opts.homeDir ?? homedir3();
  const exists = opts.existsFn ?? existsSync3;
  const candidates = [
    join3(home, ".pi", "agent", "skills"),
    join3(opts.cwd, ".pi", "skills")
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
    const full = join3(sessionDir, name);
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
  const args = ["--mode", "json", "-p"];
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
  args.push(opts.prompt);
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
    systemPrompt: run.systemPrompt
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
    content: '<filtered-history>\nYou are reading a FILTERED slice of a parent conductor\'s conversation. Two things to know before you act:\n\n1. **Your brief is the LAST user-role message in this transcript.** Earlier user-role messages were the parent conductor talking to itself or to its user; they are framing, not your task. Treat them as background context.\n\n2. **Some assistant prose may discuss YOU in the third person** \u2014 sentences like "spawning critic-X to gate Y" or "holding the turn while inspector runs". That prose is leftover orchestration narration from the parent. It is NOT a quote of your brief, NOT instructions to you, and NOT a conversation you are part of. Ignore it; do not meta-comment on it.\n\nThe following entry types were dropped before you saw this transcript:\n  - Orchestration tool calls (ensemble_*, subagent) and their results\n  - Sub-agent completion notifications (`<sub-agent-completed>` cards)\n  - The conductor\'s internal reasoning (`thinking` blocks)\n  - Bash commands marked with the `!!` excludeFromContext flag\n\nIf you see a dangling reference to prior orchestration ("the inspector said X", "as oracle noted") and you do not see a matching tool result above, that reference is from a dropped turn \u2014 treat the claim with skepticism.\n\nNow: read your brief (the last user message), do the work, return your result.\n</filtered-history>',
    timestamp: 0
  };
}
function planSpawnPiArgs(opts) {
  const { persona, parentMessages = [], sessionDir, systemPrompt, prompt, cwd, model, thinking, skillPaths } = opts;
  let seedMessages = null;
  let dropped = false;
  if (persona.inheritContext === "filtered" && parentMessages.length > 0) {
    const filtered = filterParentContext(parentMessages);
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
  } else if (persona.inheritContext === "full" && parentMessages.length > 0) {
    const trimmed = trimLeadingNonUser(parentMessages);
    if (trimmed.length > 0) seedMessages = trimmed;
  }
  if (seedMessages && dropped) {
    seedMessages = [filteredHistorySentinel(), ...seedMessages];
  }
  if (seedMessages) {
    const seededSessionPath = join3(sessionDir, "seeded.jsonl");
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
        skillPaths
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
      skillPaths
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
function spawnRun(opts) {
  const id = opts.preAllocatedId ?? allocateRunId(opts.persona.name, mapFromRegistry(opts.registry));
  const dir = runDir(id);
  mkdirSync2(dir, { recursive: true });
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
    recordPath: join3(dir, "record.json"),
    transcriptPath: join3(dir, "transcript.jsonl"),
    finalPath: join3(dir, "final.md"),
    sessionPath: void 0,
    // Capture the persona body now so future ensemble_send calls can
    // re-pass it on resume. Pi doesn't persist system prompts to disk.
    systemPrompt: opts.persona.systemPrompt
  };
  opts.registry.register(run);
  void writeRecord(run);
  const prompt = buildSubAgentPrompt(opts.persona, opts.task);
  const sessionDir = join3(dir, "session");
  mkdirSync2(sessionDir, { recursive: true });
  const plan = planSpawnPiArgs({
    persona: opts.persona,
    parentMessages: opts.parentMessages,
    sessionDir,
    systemPrompt: opts.persona.systemPrompt,
    prompt,
    cwd: opts.cwd,
    model: opts.model,
    thinking: opts.thinking,
    // PRD #15: when `inherit_skills: true`, pass the parent's user +
    // project skill dirs to the sub-agent via `--skill <path>`. The
    // flag is consumed at spawn time and not propagated into the
    // sub-agent's env, so a sub-agent spawning a further sub-agent
    // does NOT re-inherit (we discourage that pattern anyway).
    skillPaths: opts.persona.inheritSkills ? collectInheritedSkillPaths({ cwd: opts.cwd }) : void 0
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
    sessionDir: plan.seededSessionPath ? void 0 : sessionDir
  });
  return { run, done };
}
function runPiSubprocess(run, piArgs, opts) {
  const invocation = getPiInvocation(piArgs);
  let proc;
  try {
    proc = spawn(invocation.command, invocation.args, {
      cwd: opts.cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
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
  run.proc = proc;
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
  const finalize = (terminal, exitCode) => {
    if (finalized) return;
    finalized = true;
    if (run.timeoutTimer) {
      clearTimeout(run.timeoutTimer);
      run.timeoutTimer = void 0;
    }
    if (buffer.trim()) processLine(buffer);
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
      finalize(effect.status, effect.exitCode);
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
    if ((code ?? 0) === 0) finalize("completed", 0);
    else finalize("failed", code ?? 0);
  });
  proc.on("error", () => {
    run.errorMessage = "failed to spawn pi process";
    finalize("failed", 1);
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
  if (run.status === "running") {
    return {
      ok: false,
      reason: `sub-agent ${run.id} is currently running; wait for it to finish before sending.`
    };
  }
  if (run.status === "paused") {
    return {
      ok: false,
      reason: `sub-agent ${run.id} is paused; resume it first via /conductor resume ${run.id}.`
    };
  }
  if (run.status === "queued") {
    return {
      ok: false,
      reason: `sub-agent ${run.id} is queued and has not started yet; wait for it to start before sending.`
    };
  }
  if (!run.sessionPath) {
    return {
      ok: false,
      reason: `sub-agent ${run.id} has no resumable session on disk (sessionPath unset).`
    };
  }
  if (!existsSync3(run.sessionPath)) {
    return {
      ok: false,
      reason: `sub-agent ${run.id} session file is missing on disk: ${run.sessionPath}`
    };
  }
  return { ok: true };
}
function sendToRun(run, message, opts) {
  const check = validateSendable(run);
  if (!check.ok) {
    return { kind: "rejected", reason: check.reason };
  }
  const trimmed = message.trim();
  if (!trimmed) {
    return {
      kind: "rejected",
      reason: `cannot send an empty message to sub-agent ${run.id}.`
    };
  }
  run.status = "running";
  run.finishedAt = void 0;
  run.exitCode = void 0;
  run.errorMessage = void 0;
  run.stopReason = void 0;
  run.lastToolCall = void 0;
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
    sessionDir: dirname3(sessionPath)
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
function forceTerminate(run, reason, registry, onComplete) {
  if (isTerminal(run.status)) return;
  if (run.timeoutTimer) {
    clearTimeout(run.timeoutTimer);
    run.timeoutTimer = void 0;
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
var defaultSignaler = (pid, signal) => {
  process.kill(pid, signal);
};
function pauseRun(run, registry, signaler = defaultSignaler) {
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
function resumeRun(run, registry, signaler = defaultSignaler) {
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
    await mkdir(dirname3(run.recordPath), { recursive: true });
    await writeFile(run.recordPath, JSON.stringify(toRunRecord(run), null, 2));
  } catch {
  }
}
async function writeFinal(run) {
  try {
    await mkdir(dirname3(run.finalPath), { recursive: true });
    await writeFile(run.finalPath, getFinalText(run.messages) || "(no output)");
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
import { join as join6 } from "node:path";

// src/gc/last-gc.ts
import { existsSync as existsSync4, statSync as statSync2, utimesSync, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname4, join as join4 } from "node:path";
function lastGcMarkerPath(runsRoot2) {
  return join4(dirname4(runsRoot2), ".last-gc");
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
import { readdir as readdir2, readFile as readFile2, stat as stat2 } from "node:fs/promises";
import { existsSync as existsSync5 } from "node:fs";
import { join as join5 } from "node:path";
async function safeStat(path) {
  try {
    const s = await stat2(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}
async function readRecord(runDir2) {
  try {
    const text = await readFile2(join5(runDir2, "record.json"), "utf-8");
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
  const sessionDir = join5(runDir2, "session");
  if (!existsSync5(sessionDir)) return false;
  try {
    const entries = await readdir2(sessionDir);
    return entries.some((e) => e.endsWith(".jsonl"));
  } catch {
    return false;
  }
}
async function walkInventory(runsRoot2, registry) {
  if (!existsSync5(runsRoot2)) return [];
  let entries;
  try {
    entries = await readdir2(runsRoot2);
  } catch {
    return [];
  }
  const out = [];
  for (const id of entries) {
    const runDir2 = join5(runsRoot2, id);
    let isDir = false;
    try {
      isDir = (await stat2(runDir2)).isDirectory();
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
  const transcriptStat = await safeStat(join5(runDir2, "transcript.jsonl"));
  const recordStat = await safeStat(join5(runDir2, "record.json"));
  const finalStat = await safeStat(join5(runDir2, "final.md"));
  const archivedStat = await safeStat(join5(runDir2, ".archived"));
  const pinned = existsSync5(join5(runDir2, ".pinned"));
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
  const legacyDir = join6(home, ".pi", "agent", "extensions", "conductor");
  const legacyJs = join6(legacyDir, "index.js");
  const legacyTs = join6(legacyDir, "index.ts");
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
  {
    const root = opts.runsRoot ?? join6(opts.homeDir ?? homedir4(), ".pi", "agent", "conductor", "runs");
    const lastMs = readLastGcMtime(root);
    const lastStr = lastMs === null ? "never" : new Date(lastMs).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    lines.push(`  gc last run:           ${lastStr} (${lastGcMarkerPath(root)})`);
  }
  {
    const runsRoot2 = opts.runsRoot ?? join6(opts.homeDir ?? homedir4(), ".pi", "agent", "conductor", "runs");
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
  lines.push("## Runtime");
  lines.push(`  active:        ${opts.registry.countActive()}`);
  lines.push(`  queued:        ${opts.queue.size()}`);
  lines.push(`  total tracked: ${opts.registry.list().length}`);
  return lines.join("\n");
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
      const excerpt = truncate(collapseWhitespace(r.errorMessage), EXCERPT_MAX_CHARS);
      lines.push(`      \u2192 ${excerpt}`);
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
import { stat as stat3, unlink, writeFile as writeFile2 } from "node:fs/promises";
import { join as join7 } from "node:path";
var SIDECAR = ".pinned";
async function pinRun(runsRoot2, agentId) {
  const dir = join7(runsRoot2, agentId);
  let st;
  try {
    st = await stat3(dir);
  } catch {
    throw new Error(`no such run directory: ${dir}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`not a directory: ${dir}`);
  }
  await writeFile2(join7(dir, SIDECAR), "");
}
async function unpinRun(runsRoot2, agentId) {
  const path = join7(runsRoot2, agentId, SIDECAR);
  try {
    await unlink(path);
  } catch (e) {
    const err = e;
    if (err && err.code === "ENOENT") return;
    throw e;
  }
}
function isPinned(runsRoot2, agentId) {
  return existsSync7(join7(runsRoot2, agentId, SIDECAR));
}

// src/gc/reconcile.ts
import { readFile as readFile3, writeFile as writeFile3 } from "node:fs/promises";
import { join as join8 } from "node:path";
async function reconcileOrphans(actions, runsRoot2, now) {
  const reconciled = [];
  const failed = [];
  for (const action of actions) {
    if (action.kind !== "reconcile-orphan") continue;
    const agentId = action.id;
    const recordPath = join8(runsRoot2, agentId, "record.json");
    let raw;
    try {
      raw = await readFile3(recordPath, "utf-8");
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
      await writeFile3(recordPath, JSON.stringify(updated, null, 2));
      reconciled.push(agentId);
    } catch (e) {
      failed.push({ agentId, error: String(e?.message ?? e) });
    }
  }
  return { reconciled, failed };
}

// src/gc/executor.ts
import { readFile as readFile4, rm, stat as stat4, unlink as unlink2, utimes, writeFile as writeFile4, readdir as readdir3 } from "node:fs/promises";
import { join as join9 } from "node:path";
async function executeReclaim(actions, runsRoot2, registryActive, now) {
  const archived = [];
  const deleted = [];
  const failed = [];
  for (const action of actions) {
    if (action.kind !== "cold-archive" && action.kind !== "delete") continue;
    const agentId = action.id;
    const runDir2 = join9(runsRoot2, agentId);
    const actionKind = action.kind;
    if (registryActive.has(agentId)) {
      failed.push({
        agentId,
        action: actionKind,
        error: "active during reclaim (registry has live proc)"
      });
      continue;
    }
    const recordPath = join9(runDir2, "record.json");
    let record;
    try {
      const raw = await readFile4(recordPath, "utf-8");
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
  const transcriptPath = join9(runDir2, "transcript.jsonl");
  let bytes = 0;
  try {
    const s = await stat4(transcriptPath);
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
  const sidecarPath = join9(runDir2, ".archived");
  await writeFile4(sidecarPath, "");
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
  const entries = await readdir3(path, { withFileTypes: true });
  for (const entry of entries) {
    const child = join9(path, entry.name);
    if (entry.isDirectory()) {
      total += await walkSize(child);
    } else if (entry.isFile()) {
      try {
        const s = await stat4(child);
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
  "gc"
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
    conductorMode: opts.getConductorMode()
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
function formatRunRow(r) {
  const u = formatUsage(r.usage);
  const usagePart = u ? `[${u}]` : "";
  const hint = r.lastToolCall ? ` \u2192 ${r.lastToolCall}` : "";
  return `  ${STATUS_GLYPH[r.status] ?? "\xB7"} ${r.id.padEnd(20)} ${r.persona.padEnd(14)} ${r.status.padEnd(9)} ${elapsedStr(r.startTime, r.finishedAt).padEnd(6)} ${usagePart}${hint}`;
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
        const p = join10(runDir(id), "record.json");
        try {
          return JSON.parse(readFileSync2(p, "utf8"));
        } catch {
          return void 0;
        }
      },
      readFinalText: (id) => {
        const p = join10(runDir(id), "final.md");
        try {
          return readFileSync2(p, "utf8");
        } catch {
          return void 0;
        }
      },
      statMtime: (id) => {
        try {
          return statSync3(join10(runDir(id), "record.json")).mtimeMs;
        } catch {
          try {
            return statSync3(runDir(id)).mtimeMs;
          } catch {
            return 0;
          }
        }
      },
      isPinned: (id) => existsSync8(join10(runDir(id), ".pinned")),
      isArchived: (id) => existsSync8(join10(runDir(id), ".archived"))
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
  if (!existsSync8(join10(root, id))) {
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
  if (!existsSync8(join10(root, id))) {
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

// src/tools.ts
import { Type } from "@sinclair/typebox";

// src/transcript.ts
import { truncateToWidth, visibleWidth as visibleWidth2, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
      for (const part of content) {
        switch (part?.type) {
          case "text":
            for (const line of wrap(String(part.text ?? ""), opts.width)) {
              out.push(line);
            }
            break;
          case "thinking":
            if (opts.showThinking) {
              out.push(...renderThinking(String(part.thinking ?? ""), opts.width));
            } else {
              out.push(renderThinkingSummary(String(part.thinking ?? "")));
            }
            break;
          case "toolCall":
            out.push(...renderToolCall(part, resultsByCallId, opts));
            break;
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
var HEADER_GLYPHS = /* @__PURE__ */ new Set(["\u25CC", "\u25CF", "\u23F8", "\u2713", "\u2717", "\u25A0", "\u23F1"]);
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
  const elapsed = elapsedStr(run.startTime, run.finishedAt);
  const usage = formatUsage(run.usage);
  const usagePart = usage ? ` [${usage}]` : "";
  const lines = [];
  lines.push(`${glyph} ${run.persona}:${run.id} ${verb} in ${elapsed}${usagePart}`);
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
      "Pass timeout_minutes to override the per-persona / global default for a single risky run; default applies if omitted."
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
      )
    }),
    async execute(_id, params, signal, onUpdate) {
      const tmRange = validateTimeoutMinutes(params.timeout_minutes);
      if (tmRange) return errorResult(tmRange);
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
      )
    }),
    async execute(_id, params, signal, onUpdate) {
      const tmRange = validateTimeoutMinutes(params.timeout_minutes);
      if (tmRange) return errorResult(tmRange);
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
        onComplete: foreground ? void 0 : (r) => opts.pushCompletionNotification(r)
      });
      if (result.kind === "rejected") {
        return errorResult(result.reason);
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
      if (run.status === "completed" || run.status === "failed" || run.status === "killed" || run.status === "timeout") {
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
    timeout: []
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
  const finished = g.completed.length + g.failed.length + g.killed.length + g.timeout.length;
  if (finished) counts.push(`${finished} finished`);
  lines.push(counts.length === 0 ? "No sub-agents." : `Sub-agents: ${counts.join(", ")}.`);
  const groupOrder = [
    ["Running", g.running],
    ["Paused", g.paused],
    ["Queued", g.queued],
    ["Completed", g.completed],
    ["Failed", g.failed],
    ["Killed", g.killed],
    ["Timeout", g.timeout]
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
function isTerminalStatus(s) {
  return s === "completed" || s === "failed" || s === "killed" || s === "timeout";
}

// src/queue.ts
import { mkdirSync as mkdirSync3 } from "node:fs";
import { join as join11 } from "node:path";
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
    mkdirSync3(dir, { recursive: true });
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
      recordPath: join11(dir, "record.json"),
      transcriptPath: join11(dir, "transcript.jsonl"),
      finalPath: join11(dir, "final.md")
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
      onComplete: opts.onComplete
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
        onComplete: next.onComplete
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
function mountEnsembleWidget(registry, getCtx) {
  const recentlyFinished = [];
  let lingerTimer;
  const render = () => {
    const ctx = getCtx();
    if (!ctx) return;
    const now = Date.now();
    for (let i = recentlyFinished.length - 1; i >= 0; i--) {
      if (recentlyFinished[i].expiresAt <= now) recentlyFinished.splice(i, 1);
    }
    const active = registry.list().filter((r) => r.status !== "completed" && r.status !== "failed" && r.status !== "killed" && r.status !== "timeout");
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
        for (const r of active) lines.push(formatRow(r, theme));
        for (const r of linger) lines.push(formatRow(r, theme));
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
    if (run.status === "completed" || run.status === "failed" || run.status === "killed" || run.status === "timeout") {
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
function formatRow(r, theme) {
  const glyph = statusGlyph(r.status, theme);
  const name = theme.fg("accent", r.persona) + theme.fg("dim", `:${r.id.split("-").pop() ?? r.id}`);
  const elapsed = theme.fg("dim", elapsedStr(r.startTime, r.finishedAt));
  const activity = r.status === "queued" ? theme.fg("dim", " (queued)") : r.status === "paused" ? theme.fg("warning", " (paused)") : r.lastToolCall ? theme.fg("dim", ` \u2192 ${r.lastToolCall}`) : r.status === "running" ? theme.fg("dim", " starting\u2026") : "";
  const usage = r.usage.turns > 0 ? theme.fg("muted", ` [${formatUsage(r.usage)}]`) : "";
  return `${glyph} ${name} ${elapsed}${activity}${usage}`;
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
function formatCompletionNotification(run) {
  const finalText = getFinalText(run.messages);
  const usageStr = formatUsage(run.usage);
  const elapsed = elapsedStr(run.startTime, run.finishedAt);
  const lines = [];
  lines.push("```xml");
  lines.push("<sub-agent-completed>");
  lines.push(`  <agent-id>${run.id}</agent-id>`);
  lines.push(`  <persona>${run.persona}</persona>`);
  lines.push(`  <status>${run.status}</status>`);
  lines.push(`  <duration>${elapsed}</duration>`);
  lines.push(
    `  <usage><turns>${run.usage.turns}</turns><input>${run.usage.input}</input><output>${run.usage.output}</output><cost>${run.usage.cost.toFixed(4)}</cost></usage>`
  );
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
  const header = headerLine(run, elapsed, usageStr);
  return [header, "", ...lines].join("\n");
}
function headerLine(run, elapsed, usageStr) {
  const glyph = run.status === "completed" ? "\u2713" : run.status === "killed" ? "\u25A0" : run.status === "timeout" ? "\u23F1" : "\u2717";
  const verb = run.status === "completed" ? "completed" : run.status === "killed" ? "killed" : run.status === "timeout" ? "timed out" : "failed";
  const usagePart = usageStr ? `, ${usageStr}` : "";
  return `## ${glyph} \`${run.persona}\` ${verb} (${elapsed}${usagePart}) \u2014 id \`${run.id}\``;
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

**You are not the implementer.** Code edits, refactors, test-writing, fact-finding sweeps across the codebase, design decisions, and planning are all *delegated work*. You orchestrate.

## 1.5 Hands-off rules

While conductor mode is ON, every turn you take must obey:

**You MUST NOT:**

- Call \`edit\`, \`write\`, or \`lsp_code_actions\` on any file. Use a \`builder\` or \`simplifier\`.
- Use \`bash\` for tests, builds, formatters, linters, package installs, \`git diff\` patch bodies, \`find\`/\`grep\` sweeps, or anything that touches the codebase substantively. Use \`inspector\`, \`builder\`, or \`verifier\`.
- Read more than ~3 source files in one turn to "look something up." That's an \`inspector\` task.
- Run autoresearch experiments (\`run_experiment\`/\`log_experiment\`) directly \u2014 that's \`profiler\` or \`builder\` work.
- Do TDD red-green-refactor in your own head. The \`builder\` persona has TDD baked in.
- Apply quick fixes from the LSP. That's editing in disguise.

**Principle.** If a tool *produces or mutates code* (\`edit\`, \`write\`, \`code_rewrite\`, \`lsp_code_actions\`, \`run_experiment\`, \`bash\` running tests/builds/installs), it's banned in conductor mode. If a tool *produces facts about code* (\`read\`, \`cat\`, \`lsp_diagnostics\`/\`hover\`/\`definition\`/\`references\`, \`code_overview\`, \`ast_search\`, orientation \`bash\`), it's orientation \u2014 subject to the \u22643-files-per-turn cap. When in doubt, default to orientation only if the call is short, scoped, and produces facts, not code.

**You MAY (these don't count as implementation):**

- Read project meta-docs (\`PRD.md\`, \`AGENTS.md\`, \`CONTRIBUTING.md\`, \`README.md\`, and any \`design.md\` / \`plan.md\` / \`context.md\` in the working tree) \u2014 they're written *for you*.
- Run orientation bash: \`git status\`, \`git log --oneline -N\`, \`git diff --stat\`, \`ls\`, \`pwd\`, \`wc -l\`, narrowly-scoped \`find\` (max-depth 2). No long output, no patch bodies.
- **Read up to ~3 files in a turn** to confirm a fact for a brief \u2014 *and that includes dependency typedefs, vendored code, and anything under \`node_modules/\` / \`vendor/\`*. They all count toward the same budget. If you're reaching file four (or your second \`node_modules/\` lookup), that's the signal to spawn \`inspector\`.
- **Read sub-agent outputs and transcripts** as needed for synthesis: \`<sub-agent-completed>\` envelopes, the \`<transcript>\` and \`<result>\` fields, and per-run \`final.md\` / \`record.json\` files. These are *orientation for the conversation thread*, not implementation \u2014 they don't count toward the \u22643-source-files cap.
- Use all \`ensemble_*\` tools and \`/conductor\` slash commands. That's the job.
- Use \`knowledge_search\`, \`session_search\`, \`kb_read\`, and \`memory_*\` \u2014 conversational lookup, not code edits.
- Talk to the user: clarify, summarize, ask for permission on risky moves, escalate trade-offs.

**The slip-detection check.** Before any tool call that isn't \`ensemble_*\`, knowledge/session/memory search, or one of the orientation bashes above, ask: *"Is this orientation, conversation, or implementation?"* If it's implementation, stop and spawn a persona instead. The most common slip is starting a "quick read" of source files to plan a fix. That is \`inspector\`'s job, not yours \u2014 your "quick read" is rarely as quick as you think and it pollutes your context for the synthesis step that comes after the persona returns.

If a task is genuinely too small to delegate (a one-line typo fix the user dictated, or a config tweak the user is watching you make), say so explicitly and offer to drop conductor mode for the turn (\`/conductor off\`) before doing it yourself. Don't silently violate the rules.

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
- **Tiny dictated fix** (typo, single rename). Offer \`/conductor off\` for the turn, OR spawn a one-slice mini-chain (\`builder \u2192 critic\` only). State which path you're taking.
- **Research-only task** (compare A vs B, failure modes of X). Use the \`Review-only\` chain.
- **User asks for hands-on collaboration.** Offer \`/conductor off\`. Don't fight the user's preferred mode.
- **Resuming in-flight work** where personas are still alive. Continue via \`ensemble_send\` to existing sub-agents; the "oracle gate first" rule is for *new* requests.
- **Skill-driven workflow with its own playbook** (e.g. \`task-autopilot\`, \`autoresearch\`, \`cr-dashboard\`, \`oncall\`). Defer to the skill's instructions; the canonical chain is the *default* when no skill is active.
- **User explicitly directs a parallel fan-out or specific orchestration shape.** ("Spawn 3 inspectors on X/Y/Z in parallel.") Do what the user asked; the canonical chain doesn't override explicit user direction.

If your reason isn't on this list, default back to the canonical chain. "I think it's faster" is not a valid reason.
`;
}

// src/focused-stream-model.ts
var FocusedStreamModel = class {
  constructor(registry) {
    this.registry = registry;
    this.refresh();
  }
  registry;
  _focusedId;
  _collapseToolCalls = true;
  _showThinking = false;
  _scrollPerAgent = /* @__PURE__ */ new Map();
  /** Re-evaluate focused run against the current registry state. */
  refresh() {
    const all = this.registry.list();
    if (all.length === 0) {
      this._focusedId = void 0;
      return;
    }
    if (this._focusedId && all.some((r) => r.id === this._focusedId)) return;
    const newest = all.slice().sort((a, b) => b.startTime - a.startTime)[0];
    this._focusedId = newest.id;
  }
  // ── Read-only accessors ────────────────────────────────────────────
  focused() {
    if (!this._focusedId) return void 0;
    return this.registry.get(this._focusedId);
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
  /** Cycle to the next run in the list (wraps). */
  cycleNext() {
    const list = this.activeList();
    if (list.length === 0) return;
    const idx = list.findIndex((r) => r.id === this._focusedId);
    const next = list[(idx + 1) % list.length] ?? list[0];
    this._focusedId = next.id;
  }
  /** Cycle to the previous run in the list (wraps). */
  cyclePrev() {
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
    this._scrollPerAgent.set(this._focusedId, cur + Math.floor(n));
  }
  scrollUp(n) {
    if (!Number.isFinite(n) || n <= 0) return;
    if (!this._focusedId) return;
    const cur = this._scrollPerAgent.get(this._focusedId) ?? 0;
    this._scrollPerAgent.set(this._focusedId, Math.max(0, cur - Math.floor(n)));
  }
  toggleCollapseToolCalls() {
    this._collapseToolCalls = !this._collapseToolCalls;
  }
  toggleShowThinking() {
    this._showThinking = !this._showThinking;
  }
  // ── Internal ───────────────────────────────────────────────────────
  /**
   * The runs visible for cycling. Today: every run in the registry, sorted
   * by startTime ascending so cycle order is stable. Future: filter to
   * non-terminal-only when a setting calls for it.
   */
  activeList() {
    return this.registry.list().slice().sort((a, b) => a.startTime - b.startTime);
  }
};

// src/focused-stream-overlay.ts
import { truncateToWidth as truncateToWidth2, visibleWidth as visibleWidth3 } from "@earendil-works/pi-tui";
var EMPTY_HEADING = "(no sub-agents running)";
var EMPTY_PROSE = "Spawn one via ensemble_spawn or /conductor spawn.";
function renderEmpty(width, viewportHeight, theme) {
  const slack = Math.max(0, viewportHeight - 5);
  const topPad = Math.max(1, Math.floor(slack / 2));
  const indent = "  ";
  const headingLine = theme ? indent + theme.fg("muted", EMPTY_HEADING) : indent + EMPTY_HEADING;
  const proseLine = theme ? indent + theme.fg("dim", clip(EMPTY_PROSE, Math.max(0, width - visibleWidth3(indent)))) : indent + clip(EMPTY_PROSE, Math.max(0, width - visibleWidth3(indent)));
  const top = Array(topPad).fill("");
  return [...top, headingLine, "", proseLine];
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
    // Order matters for tests that dispatch the *first* match — down
    // arrow is observable from a fresh (offset=0) model, where up
    // would clamp to a no-op.
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
    keyDisplay: "s",
    label: "send",
    matches: ["s"],
    action: (o) => {
      const onSend = o.opts.onSend;
      if (!onSend) return;
      const focused = o.opts.model.focused();
      if (focused) onSend(focused.id);
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
    keyDisplay: "k",
    label: "kill",
    matches: ["k"],
    action: (o) => {
      const focused = o.opts.model.focused();
      if (focused) o.opts.onKill(focused.id);
    }
  }
];
function renderFooterLine(bindings, width, theme) {
  const ruler = "\u2500".repeat(Math.max(0, width));
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
  const hintLine = theme ? styled : plain;
  return [ruler, hintLine];
}
var FocusedStreamOverlay = class {
  constructor(_opts) {
    this._opts = _opts;
  }
  _opts;
  render(width) {
    const { model, theme } = this.opts;
    const focused = model.focused();
    const footerLines = renderFooterLine(FOOTER_BINDINGS, width, theme);
    let bodyLines;
    let status;
    if (!focused) {
      const viewportHeight = this.opts.getViewportHeight?.() ?? 0;
      const empty = renderEmpty(width, viewportHeight, theme);
      return [...empty, ...footerLines];
    } else {
      const header = renderHeader(focused, width);
      const transcript = renderTranscript(focused, {
        width,
        collapseToolCalls: model.collapseToolCalls(),
        showThinking: model.showThinking()
      });
      const offset = Math.min(model.scrollOffset(), Math.max(0, transcript.length - 1));
      const visibleTranscript = transcript.slice(offset);
      const viewportHeight = this.opts.getViewportHeight?.() ?? 0;
      const hint = renderScrollHint(offset, transcript.length, viewportHeight, {
        id: focused.id,
        agentCount: model.agentCount()
      });
      const hintLines = hint === null ? [] : [hint];
      bodyLines = [...header, ...visibleTranscript, ...hintLines];
      status = focused.status;
    }
    if (!theme) return [...bodyLines, ...footerLines];
    const themedBody = applyThemeToLines(bodyLines, classifyLine, theme, { status });
    return [...themedBody, ...footerLines];
  }
  invalidate() {
  }
  /**
   * Public access to the construction options. Used by `FOOTER_BINDINGS`
   * action callbacks so they can dispatch through the same opts the
   * Component was wired with.
   */
  get opts() {
    return this._opts;
  }
  handleInput(data) {
    this.opts.model.refresh();
    for (const binding of FOOTER_BINDINGS) {
      if (binding.matches.includes(data)) {
        binding.action(this, data);
        return;
      }
    }
  }
};
function clip(s, width) {
  if (visibleWidth3(s) <= width) return s;
  return truncateToWidth2(s, width, "\u2026", false);
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

// src/focused-overlay-factory.ts
function createFocusedOverlayComponent(deps) {
  return new FocusedStreamOverlay({
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
    theme: deps.theme
  });
}

// src/focused-overlay-shortcut.ts
import { Key, matchesKey } from "@earendil-works/pi-tui";
function installFocusedOverlayShortcut(ctx, options) {
  if (!ctx.hasUI) {
    return () => {
    };
  }
  let unsubInput = ctx.ui.onTerminalInput((data) => {
    if (options.isOverlayOpen()) return void 0;
    if (matchesKey(data, Key.ctrl("g"))) {
      options.openFocusedOverlay();
      return { consume: true };
    }
    return void 0;
  });
  let unsubRegistry = options.subscribeToRegistry ? options.subscribeToRegistry() : null;
  return () => {
    if (unsubInput) {
      unsubInput();
      unsubInput = null;
    }
    if (unsubRegistry) {
      unsubRegistry();
      unsubRegistry = null;
    }
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

// src/watchdog.ts
function evaluateRun(run, state, config, now) {
  const current = state ?? { kind: "fresh" };
  if (run.status !== "running") {
    return { transition: { kind: "none" }, nextState: current };
  }
  if (run.pausedAt !== void 0) {
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
      const { transition, nextState } = evaluateRun(run, prev, this.deps.config, now);
      this.states.set(run.id, nextState);
      if (run.status !== "running") {
        this.states.delete(run.id);
      }
      this.dispatch(run, transition);
    }
  }
  /**
   * Side-effect dispatcher for one transition. Soft/recovered are pure
   * advisories. Hard either kills (`kill_on_stall` true) or warns and
   * leaves the run alive. The kill path performs the **A2 pre-kill
   * recheck**: re-read `now() - run.lastEventAt` and abort the kill if
   * the run recovered between the detector verdict and the dispatch.
   */
  dispatch(run, transition) {
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
        if (stillStaleMs < this.deps.config.hardThresholdSeconds * 1e3) {
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

// src/index.ts
function index_default(pi) {
  let cwd = process.cwd();
  let ctxRef = null;
  let widget = null;
  const registry = new RunRegistry();
  const queue = new SpawnQueue(registry, 4, 1);
  const focusModel = new FocusedStreamModel(registry);
  let overlayOpen = false;
  let unsubFocusedShortcut = null;
  let watchdogDispose = null;
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
      (_tui, theme, _kb, done) => createFocusedOverlayComponent({
        model: focusModel,
        registry,
        forceTerminate,
        promptAndSendToRun: (id) => {
          void promptAndSendToRun(id);
        },
        done,
        theme
      }),
      { overlay: true }
    ).finally(() => {
      overlayOpen = false;
    });
  }
  async function promptAndSendToRun(agentId) {
    const ctx = ctxRef;
    if (!ctx) return;
    const run = registry.get(agentId);
    if (!run) {
      ctx.ui.notify(`agent_id "${agentId}" not found.`, "warning");
      return;
    }
    const check = validateSendable(run);
    if (!check.ok) {
      try {
        ctx.ui.notify(check.reason, "warning");
      } catch {
      }
      return;
    }
    let message;
    try {
      message = await ctx.ui.input(
        `Send to ${agentId}`,
        "Type a follow-up message; Esc to cancel."
      );
    } catch {
      return;
    }
    if (!message || !message.trim()) return;
    const cfg = loadConfig(cwd);
    const ov = cfg.personaOverrides[run.persona] ?? {};
    const resolved = await resolvePersonas({ cwd, personaOverrides: cfg.personaOverrides });
    const persona = resolved.personas.get(run.persona);
    const timeoutMs = resolveTimeoutMs(persona, ov, cfg);
    const result = sendToRun(run, message, {
      registry,
      timeoutMs,
      onComplete: (r) => opts.pushCompletionNotification(r)
    });
    if (result.kind === "rejected") {
      try {
        ctx.ui.notify(result.reason, "warning");
      } catch {
      }
    }
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
        { triggerTurn: true, deliverAs: "followUp" }
      );
    }
  };
  pi.on("session_start", async (_event, ctx) => {
    cwd = ctx.cwd;
    ctxRef = ctx;
    if (widget) widget.dispose();
    widget = mountEnsembleWidget(registry, () => ctxRef);
    if (unsubFocusedShortcut) unsubFocusedShortcut();
    unsubFocusedShortcut = installFocusedOverlayShortcut(ctx, {
      openFocusedOverlay: () => openFocusedOverlay(),
      isOverlayOpen: () => overlayOpen,
      // Slice 11: keep the focus model fresh as the registry mutates.
      // Lives here (session-scoped) rather than in the overlay factory
      // (per-open) so re-opening the overlay does NOT stack listeners.
      subscribeToRegistry: () => registry.onChange(() => focusModel.refresh())
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
        isKillOnStall: () => cfg.watchdog.defaultKillOnStall,
        isEnabled: () => cfg.watchdog.enabled
      });
      watchdogDispose = wd.start();
    }
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
