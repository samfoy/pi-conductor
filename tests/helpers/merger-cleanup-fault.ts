// Child of the M6a crash-cleanup regression in tests/effort-merger-recovery-smoke.test.ts. Runs one
// crash whose fault (M6A_CLEANUP_FAULT) leaves state its cleanup cannot prove quiescent; "none"
// proves everything. The parent inspects M6A_CRASH_FIXTURE after this process has exited.
import "./no-live-scope.ts";
import test, { after } from "node:test";
import { stop } from "esbuild";
import { crash, nativeCrashRoot } from "./merger-crash.ts";

const root = nativeCrashRoot();
after(() => stop());
const fault = process.env.M6A_CLEANUP_FAULT;
test(`M6a injected crash-cleanup fault: ${fault}`, { timeout: 60000 }, async t => {
  if (fault === "none") await crash(t, root, "after-proposal", "commit-hold");
  // In memory only: the session-leadership proof of the live hold fails.
  else if (fault === "leader") await crash(t, root, "after-proposal", "commit-hold", { leader: () => false });
  // The probe never parks; the test fails while a launched merger and its hold run.
  else if (fault === "no-barrier") await crash(t, root, "no-barrier", "commit-hold", { failBeforeBarrier: true });
  else throw new Error(`unknown fault ${fault}`);
});
