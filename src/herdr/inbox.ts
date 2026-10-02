import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync, renameSync, writeSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord } from "./cli.ts";

export const CONTROL_PREFIX = "__CONDUCTOR_CTL_V1__:";
export const MAX_INBOX_TEXT_BYTES = 8 * 1048576;
const MAX_RECORD_BYTES = 32 * 1048576;
const token = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(v);
const kinds = ["initial", "reply", "steer", "follow_up", "grace"] as const;
export interface InboxRequest {
  v: 1; launchNonce: string; requestId: string; sequence: number;
  kind: typeof kinds[number]; text: string; askId?: string;
}
export interface InboxAck {
  v: 1; launchNonce: string; requestId: string; sequence: number; kind: InboxRequest["kind"];
  accepted: boolean; code?: "busy" | "stale-ask"; at: number;
}
export interface InboxEntry { request: InboxRequest; dispatched: boolean }

function validRequest(v: unknown): v is InboxRequest {
  return isRecord(v) && v.v === 1 && token(v.launchNonce) && token(v.requestId) &&
    Number.isSafeInteger(v.sequence) && Number(v.sequence) > 0 && Number(v.sequence) <= 999999 &&
    kinds.includes(v.kind as InboxRequest["kind"]) && typeof v.text === "string" && !!v.text.trim() &&
    !v.text.includes("\0") && Buffer.byteLength(v.text) <= MAX_INBOX_TEXT_BYTES &&
    (v.kind === "reply" ? typeof v.askId === "string" && v.askId.length > 0 && v.askId.length <= 512 && !/[\0\r\n]/.test(v.askId) : v.askId === undefined);
}
function directory(runDir: string, nonce: string, create = false): string {
  if (!token(nonce) || !isAbsolute(runDir) || resolve(runDir) !== runDir || realpathSync(runDir) !== runDir) throw new Error("invalid inbox identity/path");
  if (create) {
    const record = read(join(runDir, "record.json"));
    if (!isRecord(record) || record.id !== basename(runDir) || record.runtime !== "herdr" || !isRecord(record.herdr) ||
        record.herdr.runId !== record.id || record.herdr.launchNonce !== nonce) throw new Error("inbox invocation mismatch");
  }
  for (const path of [join(runDir, "inbox"), join(runDir, "inbox", nonce)]) {
    if (create) { try { mkdirSync(path, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; } }
    if (!lstatSync(path).isDirectory() || realpathSync(path) !== path) throw new Error("invalid inbox directory");
  }
  return join(runDir, "inbox", nonce);
}
function read(file: string, maxBytes = MAX_RECORD_BYTES): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("invalid inbox record");
    const buffer = Buffer.alloc(stat.size + 1);
    let n = 0, count = 0;
    while (n < buffer.length && (count = readSync(fd, buffer, n, buffer.length - n, n)) > 0) n += count;
    if (n !== stat.size) throw new Error("inbox record changed during read");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, n)));
  } finally { closeSync(fd); }
}
function absent(file: string): void {
  try { lstatSync(file); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  throw new Error("inbox record already exists");
}
function publish(file: string, value: unknown): void {
  const buffer = Buffer.from(JSON.stringify(value) + "\n");
  if (buffer.length > MAX_RECORD_BYTES) throw new Error("inbox record exceeds byte cap");
  absent(file);
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    for (let offset = 0; offset < buffer.length;) {
      const count = writeSync(fd, buffer, offset, buffer.length - offset);
      if (count <= 0) throw new Error("incomplete inbox write");
      offset += count;
    }
  } finally { closeSync(fd); }
  absent(file);
  renameSync(tmp, file); // Retain tmp evidence on failure; never infer non-delivery from a thrown write.
}
const name = (r: InboxRequest) => `${String(r.sequence).padStart(6, "0")}-${r.requestId}`;
const PREPARED = ".prepared.json";

function newRequest(runDir: string, request: InboxRequest): string {
  if (!validRequest(request) || Buffer.byteLength(JSON.stringify(request)) >= MAX_RECORD_BYTES) throw new Error("invalid inbox request");
  const dir = directory(runDir, request.launchNonce, true);
  if (readInbox(runDir, request.launchNonce).some(e => e.request.requestId === request.requestId || e.request.sequence === request.sequence)) throw new Error("duplicate inbox request identity");
  for (const suffix of [".sending.json", PREPARED]) absent(join(dir, `${name(request)}${suffix}`));
  absent(join(dir, `${request.requestId}.ack.json`));
  return dir;
}
/** Parent edge: text is already A5-prepared. Never expand or reread its evidence here. */
export function writeInboxRequest(runDir: string, request: InboxRequest): void {
  publish(join(newRequest(runDir, request), `${name(request)}.json`), request);
}
/** Durable launch intent the pump cannot see: herdr only registers an idle child. */
export function prepareInboxRequest(runDir: string, request: InboxRequest): void {
  publish(join(newRequest(runDir, request), `${name(request)}${PREPARED}`), request);
}
/** Make the exact prepared request visible to the child's pump. Never retried after a throw. */
export function publishPreparedInboxRequest(runDir: string, request: InboxRequest): void {
  if (!validRequest(request)) throw new Error("invalid inbox request");
  const dir = directory(runDir, request.launchNonce), source = join(dir, `${name(request)}${PREPARED}`);
  if (JSON.stringify(read(source)) !== JSON.stringify(request)) throw new Error("prepared inbox request changed before publication");
  for (const suffix of [".json", ".sending.json"]) absent(join(dir, `${name(request)}${suffix}`));
  renameSync(source, join(dir, `${name(request)}.json`));
}
/** A prepared request never published means the child never received its task. */
export function hasPreparedInboxRequest(runDir: string, nonce: string): boolean {
  try { return readdirSync(directory(runDir, nonce)).some(file => file.endsWith(PREPARED)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}

export function readInbox(runDir: string, nonce: string): InboxEntry[] {
  let dir: string;
  try { dir = directory(runDir, nonce); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const files = readdirSync(dir);
  if (files.length > 1024) throw new Error("inbox entry cap exceeded; preserve for inspection");
  const entries: InboxEntry[] = [];
  for (const file of files) {
    if (!/^\d{6}-[A-Za-z0-9][A-Za-z0-9_-]{0,127}(\.sending)?\.json$/.test(file)) continue;
    try {
      const request = read(join(dir, file));
      if (!validRequest(request) || request.launchNonce !== nonce) continue;
      const dispatched = file.endsWith(".sending.json");
      if (file !== `${name(request)}${dispatched ? ".sending" : ""}.json`) continue;
      entries.push({ request, dispatched });
    } catch { /* Corrupt/nonregular records are never scheduled or mutated. */ }
  }
  return entries.filter(e => entries.filter(other => other.request.requestId === e.request.requestId || other.request.sequence === e.request.sequence).length === 1)
    .sort((a, b) => a.request.sequence - b.request.sequence);
}

export function readInboxAck(runDir: string, request: InboxRequest): InboxAck | undefined {
  if (!validRequest(request)) throw new Error("invalid ack request identity");
  let value: unknown;
  try { value = read(join(directory(runDir, request.launchNonce), `${request.requestId}.ack.json`)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  if (!isRecord(value) || value.v !== 1 || value.launchNonce !== request.launchNonce || value.requestId !== request.requestId ||
      value.sequence !== request.sequence || value.kind !== request.kind || typeof value.accepted !== "boolean" ||
      typeof value.at !== "number" || !Number.isFinite(value.at) || value.at < 0 ||
      (value.accepted ? value.code !== undefined : value.code !== "busy" && value.code !== "stale-ask")) throw new Error("invalid inbox ack");
  return value as unknown as InboxAck;
}
export function writeInboxAck(runDir: string, request: InboxRequest, code?: InboxAck["code"]): void {
  if (!validRequest(request)) throw new Error("invalid ack request identity");
  const { v, launchNonce, requestId, sequence, kind } = request;
  publish(join(directory(runDir, launchNonce), `${requestId}.ack.json`), { v, launchNonce, requestId, sequence, kind, accepted: code === undefined, ...(code ? { code } : {}), at: Date.now() });
}
export const inboxMarker = (r: InboxRequest): string => `${CONTROL_PREFIX}${r.launchNonce}:${r.sequence}:${r.requestId}`;

/** Rename the request itself before the void native call: an unacked dispatch is never retried. */
export function dispatchInboxRequest(runDir: string, request: InboxRequest): void {
  if (!validRequest(request)) throw new Error("invalid dispatch request identity");
  const dir = directory(runDir, request.launchNonce);
  const source = join(dir, `${name(request)}.json`), target = join(dir, `${name(request)}.sending.json`);
  if (JSON.stringify(read(source)) !== JSON.stringify(request)) throw new Error("inbox request changed before dispatch");
  absent(target);
  renameSync(source, target);
}

/** Bounded, no-follow JSON reader shared with launch identity records. */
export { read as readControlRecord };
