/**
 * Tests for installFocusedOverlayShortcut — the small helper that
 * routes Ctrl+G to openFocusedOverlay via ctx.ui.onTerminalInput
 * instead of pi.registerShortcut, because pi reserves Ctrl+G as a
 * built-in shortcut and silently drops the conflicting extension
 * binding at load.
 *
 * Mirrors the Esc-detach pattern in src/index.ts:registerForegroundDetach
 * and the test shape in tests/post-detach-listener.test.ts.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  installFocusedOverlayShortcut,
  type FocusedOverlayShortcutCtx,
} from "../src/focused-overlay-shortcut.ts";

type Handler = (data: string) => { consume?: boolean; data?: string } | undefined;

function makeFakeCtx(opts: { hasUI: boolean }) {
  let captured: Handler | null = null;
  let unsubCalls = 0;
  const ctx: FocusedOverlayShortcutCtx = {
    hasUI: opts.hasUI,
    ui: {
      onTerminalInput(h: Handler): () => void {
        captured = h;
        return () => {
          unsubCalls += 1;
        };
      },
    },
  };
  return {
    ctx,
    getHandler: () => captured,
    getUnsubCalls: () => unsubCalls,
  };
}

test("installFocusedOverlayShortcut: headless ctx (hasUI=false) returns a no-op unsub and never subscribes", () => {
  const fake = makeFakeCtx({ hasUI: false });
  let opens = 0;
  const unsub = installFocusedOverlayShortcut(fake.ctx, {
    openFocusedOverlay: () => {
      opens += 1;
    },
    isOverlayOpen: () => false,
  });
  assert.equal(fake.getHandler(), null, "must not subscribe to onTerminalInput when headless");
  assert.equal(typeof unsub, "function");
  // Calling the no-op unsub should not throw.
  unsub();
  assert.equal(opens, 0, "openFocusedOverlay must not have been called");
  assert.equal(fake.getUnsubCalls(), 0, "no underlying unsub was registered");
});

test("installFocusedOverlayShortcut: Ctrl+G with overlay closed → calls openFocusedOverlay and returns { consume: true }", () => {
  const fake = makeFakeCtx({ hasUI: true });
  let opens = 0;
  installFocusedOverlayShortcut(fake.ctx, {
    openFocusedOverlay: () => {
      opens += 1;
    },
    isOverlayOpen: () => false,
  });
  const handler = fake.getHandler();
  assert.ok(handler, "handler must be registered when hasUI=true");
  // Ctrl+G is byte 0x07 (BEL) when kitty protocol is inactive — same
  // sequence Pi's built-in matchesKey(data, Key.ctrl("g")) returns true for.
  const result = handler!("\x07");
  assert.equal(opens, 1, "openFocusedOverlay must have been called exactly once");
  assert.deepEqual(
    result,
    { consume: true },
    "Ctrl+G must be consumed so pi's reserved binding doesn't also fire",
  );
});

test("installFocusedOverlayShortcut: Ctrl+G with overlay already open → does NOT call openFocusedOverlay and returns undefined", () => {
  const fake = makeFakeCtx({ hasUI: true });
  let opens = 0;
  installFocusedOverlayShortcut(fake.ctx, {
    openFocusedOverlay: () => {
      opens += 1;
    },
    isOverlayOpen: () => true,
  });
  const handler = fake.getHandler();
  assert.ok(handler, "handler must be registered");
  const result = handler!("\x07");
  assert.equal(opens, 0, "must not re-open the overlay when one is already open");
  assert.equal(result, undefined, "must not consume; let the overlay's own bindings see the input");
});

test("installFocusedOverlayShortcut: non-matching input returns undefined and does not call openFocusedOverlay", () => {
  const fake = makeFakeCtx({ hasUI: true });
  let opens = 0;
  installFocusedOverlayShortcut(fake.ctx, {
    openFocusedOverlay: () => {
      opens += 1;
    },
    isOverlayOpen: () => false,
  });
  const handler = fake.getHandler();
  assert.ok(handler);
  for (const data of ["a", "\x1b" /* Esc */, "", "ctrl-h-but-not", "\t"]) {
    const result = handler!(data);
    assert.equal(result, undefined, `must not consume input ${JSON.stringify(data)}`);
  }
  assert.equal(opens, 0, "openFocusedOverlay must not be called for non-Ctrl+G input");
});

test("installFocusedOverlayShortcut: returned unsub calls the underlying onTerminalInput unsub exactly once", () => {
  const fake = makeFakeCtx({ hasUI: true });
  const unsub = installFocusedOverlayShortcut(fake.ctx, {
    openFocusedOverlay: () => {},
    isOverlayOpen: () => false,
  });
  assert.equal(fake.getUnsubCalls(), 0);
  unsub();
  assert.equal(fake.getUnsubCalls(), 1, "underlying unsub fires once");
  // Calling unsub again should not double-tear-down.
  unsub();
  assert.equal(
    fake.getUnsubCalls(),
    1,
    "subsequent unsub calls must be idempotent (no double-fire)",
  );
});
