/**
 * Light hook-integration test for the v0.8.2 (B-4) sanitizer wiring.
 *
 * Tests the small `installSanitizerHook` factory in
 * `src/sanitizer-hook.ts` — the same wiring `src/index.ts` invokes for
 * the live extension. We use a stub `pi` that captures `on("context",
 * …)` registrations so we can drive the handler with the byte-exact
 * `samfp/Rosie` wedge fixture and assert sanitization, warn-dedup, and
 * teardown behavior.
 *
 * This is the "light" integration the design specifies — we do not
 * boot the full extension default factory (which transitively imports
 * `@earendil-works/pi-coding-agent`'s TUI surface that is not loadable
 * from a `node:test` process). The factory's wiring is itself tested by
 * `installSanitizerHook` here; `src/index.ts` is the thin caller.
 *
 * Spec: ./design.md §"Hook integration test (light)".
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { installSanitizerHook } from "../src/sanitizer-hook.ts";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function makeFakePi(): {
  pi: { on: (event: "context", handler: Handler) => void };
  contextHandlers: Handler[];
} {
  const contextHandlers: Handler[] = [];
  const pi = {
    on(event: "context", handler: Handler) {
      contextHandlers.push(handler);
    },
  };
  return { pi, contextHandlers };
}

const BAD = 'ensemble_kill" >\n</invoke>';
const GOOD = "ensemble_kill_invoke_INVALID";

function wedgeFixture(): AgentMessage[] {
  return [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "tooluse_PPo6RdUryeEr1TS4iXjQRW", name: BAD, arguments: {} },
      ] as any,
      api: "bedrock-converse-stream" as any,
      provider: "amazon-claude-code" as any,
      model: "us.anthropic.claude-opus-4-7",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: "tooluse_PPo6RdUryeEr1TS4iXjQRW",
      toolName: BAD,
      content: [{ type: "text", text: `Tool ${BAD} not found` }],
      isError: true,
      timestamp: 0,
    } as AgentMessage,
  ];
}

test("installSanitizerHook: registers exactly one pi.on(\"context\") handler", () => {
  const { pi, contextHandlers } = makeFakePi();
  installSanitizerHook(pi, { getCtx: () => null });
  assert.equal(
    contextHandlers.length,
    1,
    `expected exactly 1 context handler, got ${contextHandlers.length}`,
  );
});

test("installSanitizerHook: handler returns sanitized messages on the wedge fixture", async () => {
  const { pi, contextHandlers } = makeFakePi();
  installSanitizerHook(pi, { getCtx: () => null, warn: () => {} });
  const out = await contextHandlers[0]({ messages: wedgeFixture() });
  assert.ok(out && Array.isArray(out.messages), "handler returns { messages }");
  const tc = (out.messages[0] as any).content.find((b: any) => b.type === "toolCall");
  assert.equal(tc.name, GOOD, "toolCall.name sanitized to placeholder");
  assert.equal((out.messages[1] as any).toolName, GOOD, "toolResult.toolName mirror");
});

test("installSanitizerHook: same toolCallId warns at most once across turns (dedup)", async () => {
  const { pi, contextHandlers } = makeFakePi();
  const warnings: string[] = [];
  installSanitizerHook(pi, { getCtx: () => null, warn: (s) => warnings.push(s) });
  const handler = contextHandlers[0];
  await handler({ messages: wedgeFixture() });
  assert.equal(warnings.length, 1, "first invocation warns once");
  await handler({ messages: wedgeFixture() });
  assert.equal(
    warnings.length,
    1,
    `second invocation must not warn again (dedup); got ${warnings.length} total`,
  );
});

test("installSanitizerHook: reset() clears the dedup set so the next invocation re-warns", async () => {
  const { pi, contextHandlers } = makeFakePi();
  const warnings: string[] = [];
  const hook = installSanitizerHook(pi, {
    getCtx: () => null,
    warn: (s) => warnings.push(s),
  });
  const handler = contextHandlers[0];
  await handler({ messages: wedgeFixture() });
  assert.equal(warnings.length, 1, "first warn before reset");
  hook.reset();
  await handler({ messages: wedgeFixture() });
  assert.equal(
    warnings.length,
    2,
    "post-reset invocation must warn again (dedup set was cleared)",
  );
});

test("installSanitizerHook: clean messages produce zero warnings and pass through", async () => {
  const { pi, contextHandlers } = makeFakePi();
  const warnings: string[] = [];
  installSanitizerHook(pi, { getCtx: () => null, warn: (s) => warnings.push(s) });
  const handler = contextHandlers[0];
  const clean: AgentMessage[] = [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] as any,
      api: "anthropic-messages" as any,
      provider: "anthropic" as any,
      model: "claude-sonnet-4-5",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: 0,
    } as AgentMessage,
  ];
  const out = await handler({ messages: clean });
  assert.equal(warnings.length, 0, "no warnings on clean input");
  const tc = (out.messages[0] as any).content[0];
  assert.equal(tc.name, "read", "name unchanged");
});

test("installSanitizerHook: notify-throws are swallowed (stale ctx is non-fatal)", async () => {
  const { pi, contextHandlers } = makeFakePi();
  const warnings: string[] = [];
  installSanitizerHook(pi, {
    getCtx: () => ({
      ui: {
        notify: () => {
          throw new Error("ctx is stale");
        },
      },
    }),
    warn: (s) => warnings.push(s),
  });
  // Should not throw despite ctx.ui.notify throwing.
  const out = await contextHandlers[0]({ messages: wedgeFixture() });
  assert.ok(out && Array.isArray(out.messages), "handler still returned a result");
  assert.equal(warnings.length, 1, "warn was still emitted");
});

test("installSanitizerHook: ctx.ui.notify is called once per fresh sanitization", async () => {
  const { pi, contextHandlers } = makeFakePi();
  const notifies: Array<{ msg: string; level: string }> = [];
  installSanitizerHook(pi, {
    getCtx: () => ({
      ui: {
        notify: (msg: string, level: "warning") => notifies.push({ msg, level }),
      },
    }),
    warn: () => {},
  });
  const handler = contextHandlers[0];
  await handler({ messages: wedgeFixture() });
  assert.equal(notifies.length, 1, "first invocation notifies once");
  await handler({ messages: wedgeFixture() });
  assert.equal(
    notifies.length,
    1,
    "second invocation does not notify again (same dedup set governs both)",
  );
  assert.equal(notifies[0].level, "warning");
  assert.ok(
    notifies[0].msg.includes(GOOD),
    `notify message should mention placeholder, got ${notifies[0].msg}`,
  );
});
