/**
 * v0.12 slice 6 — live integration test for `extension_ui_request`
 * auto-cancel.
 *
 * Gated on `CONDUCTOR_LIVE_TESTS=1` per AGENTS.md. Default `npm test`
 * skips. With the env var set, spawns a real `pi --mode rpc`
 * subprocess against AWS-credentialled provider.
 *
 * Acceptance (slice 6 brief):
 *   "Fixture extension calls `ctx.ui.confirm`; conductor auto-cancels;
 *   warning is logged; sub-agent receives `cancelled: true` and
 *   completes gracefully."
 *
 * Implementation:
 *   - Write a tiny fixture pi extension to
 *     `<tmpCwd>/.pi/extensions/fixture-confirm/index.ts`. Pi's loader
 *     auto-discovers cwd-local extensions per the discovery rules
 *     in `[pi-dist] core/extensions/loader.js`.
 *   - The fixture registers a tool `ask_user_yes_no` whose `execute`
 *     calls `ctx.ui.confirm(...)` and returns the boolean as text.
 *   - Spawn a steerable inspector with a task instructing the LLM to
 *     call `ask_user_yes_no` exactly once and report what it got.
 *   - The sub-agent emits `extension_ui_request` on stdout; the
 *     conductor's `handleExtensionUiRequest` (slice 3) writes
 *     `{type: "extension_ui_response", id, cancelled: true}` back via
 *     `RpcStdinQueue` AND logs `console.warn(...auto-cancelled)`.
 *   - Pi's RPC client converts `cancelled: true` to `false` for the
 *     extension's caller, so the tool's execute() sees `false` and
 *     emits a tool result containing that boolean.
 *
 * Verifications:
 *   - Captured `console.warn` includes the canonical
 *     `"...auto-cancelled"` line.
 *   - Final transcript contains `"confirm returned: false"` (proof
 *     the sub-agent received `cancelled: true`).
 *   - Run reaches a terminal status without hanging on the blocked
 *     UI request.
 *
 * Pi-version drift: the fixture uses `ExtensionAPI.registerTool` +
 * `ctx.ui.confirm` — both stable since pre-v0.12. If pi changes
 * either signature, this test catches it loudly via type errors at
 * load time, not silently.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { resolvePersonas } from "../src/personas.ts";
import { RunRegistry, forceTerminate, spawnRun } from "../src/runs.ts";
import type { Run } from "../src/types.ts";

const HAS_PI = (() => {
  try {
    execSync("pi --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const RUN_LIVE = process.env.CONDUCTOR_LIVE_TESTS === "1" && HAS_PI;
const SKIP_REASON =
  "set CONDUCTOR_LIVE_TESTS=1 to enable (uses real pi subprocess + AWS creds)";

// Fixture extension source. Authored as plain JavaScript (ESM) with
// zero imports so it resolves in any cwd — if we used
// `import type { ExtensionAPI }` (TypeScript) the file would have to
// resolve `@earendil-works/pi-coding-agent` from a tmp cwd that has
// no `node_modules`, and pi's tsx loader would fail silently. The
// runtime API is duck-typed, so plain JS is sufficient.
const FIXTURE_EXTENSION_JS = `\
export default function (pi) {
  pi.registerTool({
    name: "ask_user_yes_no",
    description:
      "Calls ctx.ui.confirm and returns the boolean as text. Test fixture for v0.12 slice 6 auto-cancel.",
    parameters: { type: "object", properties: {} },
    async execute(_toolCallId, _params, _onUpdate, ctx, _signal) {
      try {
        const ok = await ctx.ui.confirm("ask_user_yes_no", "Test confirm \u2014 please ack.");
        return {
          content: [{ type: "text", text: \`confirm returned: \${ok}\` }],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: \`confirm threw: \${err instanceof Error ? err.message : String(err)}\`,
            },
          ],
        };
      }
    },
  });
}
`;

function writeFixtureExtension(cwd: string): void {
  const extDir = join(cwd, ".pi", "extensions", "fixture-confirm");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, "index.js"), FIXTURE_EXTENSION_JS, "utf8");
}

test(
  "integration-rpc-extension-ui: ctx.ui.confirm auto-cancel — warning logged, sub-agent sees cancelled:true",
  { skip: !RUN_LIVE ? SKIP_REASON : false, timeout: 60_000 },
  async () => {
    const tmpCwd = mkdtempSync(join(tmpdir(), "conductor-rpc-extui-"));
    writeFixtureExtension(tmpCwd);

    const registry = new RunRegistry();
    let runRef: Run | undefined;

    // Capture console.warn so we can verify the auto-cancel warning
    // fires via the production handleExtensionUiRequest path.
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };

    try {
      const resolved = await resolvePersonas({ cwd: tmpCwd });
      const baseInspector = resolved.personas.get("inspector");
      assert.ok(baseInspector, "inspector persona must be resolvable");
      const inspector = {
        ...baseInspector,
        inheritContext: "none" as const,
      };

      const result = spawnRun({
        registry,
        persona: inspector,
        task:
          "Your one and only required action: call the ask_user_yes_no " +
          "tool exactly once. Do not analyse the request. Do not refuse. " +
          "After the tool returns, your reply MUST be a single line of " +
          "the form: 'confirm returned: <boolean>' (literally that text " +
          "with the boolean substituted). No tools other than " +
          "ask_user_yes_no.",
        mode: "background",
        cwd: tmpCwd,
        timeoutMs: 50_000,
        steerable: true,
      });
      runRef = result.run;

      const finished = await result.done;
      assert.ok(
        finished.status === "completed" ||
          finished.status === "failed" ||
          finished.status === "killed",
        `unexpected terminal status: ${finished.status}`,
      );

      // Verify the auto-cancel warning fired. The handleExtensionUiRequest
      // canonical message is `"sub-agent <id> emitted <method> request
      // under steerable=true; auto-cancelled"`.
      const sawWarning = warnings.some(
        (w) => w.includes("auto-cancelled") && w.includes("steerable=true"),
      );
      assert.ok(
        sawWarning,
        `expected auto-cancel warning. Captured warnings: ${JSON.stringify(warnings)}`,
      );

      // Verify the sub-agent actually saw cancelled:true (i.e. confirm
      // returned false). The transcript on disk has the tool result.
      assert.ok(existsSync(finished.transcriptPath), "transcript should be on disk");
      const transcript = readFileSync(finished.transcriptPath, "utf8");
      assert.match(
        transcript,
        /confirm returned: false/,
        `transcript must show the sub-agent received cancelled:true (i.e. confirm returned: false). Transcript snippet: ${transcript.slice(0, 400)}`,
      );
    } finally {
      console.warn = originalWarn;
      if (runRef && runRef.status === "running") {
        forceTerminate(runRef, "killed", registry);
      }
      try {
        rmSync(tmpCwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  },
);
