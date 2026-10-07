// Test-only, private to tests/native-startup-race.test.ts: bundled BEFORE a native faux child, it
// forces Pi 0.87.1's startup race in that child process only (no installed SDK file changes).
// A registerNativeProvider refresh (R1) is queued after the awaited startup refresh (R2), so R2's
// availability result is discarded and R1's lands 50 ms after R2 returned. Records whether R2
// was superseded (the forcing really happened). NATIVE_FAUX_AUTH=none makes faux auth resolve to
// nothing, to prove a real auth failure still fails and names the provider.
import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const als = new AsyncLocalStorage<string>();
const P = ModelRuntime.prototype as any;
const trace = { r1: undefined as string | undefined, r2: undefined as string | undefined, r2Superseded: undefined as boolean | undefined, r1Settled: false };
process.on("exit", () => writeFileSync(join(process.env.NATIVE_STARTUP_TRACE_DIR!, `race-${process.pid}.json`), JSON.stringify(trace)));
let inRegister = false, n = 0;
const latch = () => { let open!: () => void; const p = new Promise<void>(r => (open = r)); return { p, open }; };
const r2Queued = latch(), r1Queued = latch(), r2Settled = latch();
const reg = P.registerNativeProvider;
P.registerNativeProvider = function (provider: any) {
  const p = process.env.NATIVE_FAUX_AUTH === "none" && provider.id === "faux" ? { ...provider, auth: { apiKey: { name: "Faux", resolve: async () => undefined } } } : provider;
  inRegister = true; try { return reg.call(this, p); } finally { inRegister = false; }
};
const refresh = P.refresh;
P.refresh = function (o: unknown) {
  const tag = `r${++n}`;
  if (inRegister) trace.r1 = tag; else if (trace.r1 && !trace.r2) trace.r2 = tag;
  return als.run(tag, () => refresh.call(this, o));
};
const queue = P.queueAvailabilityRefresh;
P.queueAvailabilityRefresh = function (s: unknown) {
  const tag = als.getStore();
  const go = () => { const p = queue.call(this, s); if (tag === trace.r1) r1Queued.open(); if (tag === trace.r2) r2Queued.open(); return p; };
  return tag && tag === trace.r1 ? r2Queued.p.then(go) : go();
};
const run = P.runAvailabilityRefresh;
P.runAvailabilityRefresh = function (seq: number, e: number, s: unknown) {
  const tag = als.getStore();
  const go = () => run.call(this, seq, e, s).then((v: unknown) => {
    if (tag === trace.r2) { trace.r2Superseded = seq !== this.availabilityRefreshSeq; r2Settled.open(); }
    if (tag === trace.r1) trace.r1Settled = true;
    return v;
  });
  if (tag && tag === trace.r2) return r1Queued.p.then(go);
  if (tag && tag === trace.r1) return r2Settled.p.then(() => new Promise(r => setTimeout(r, 50))).then(go);
  return go();
};
