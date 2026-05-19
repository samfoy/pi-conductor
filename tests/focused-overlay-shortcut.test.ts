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

// ── Slice 11: registry-listener subscription ─────────────────────────
//
// The shortcut owns the lifetime of the registry-change subscription
// that keeps `model.refresh()` firing as runs change. This replaces
// `FocusedStreamOverlay.render()`'s side-effect refresh — render is
// now pure. The subscription lives in the *shortcut* (session-scoped,
// idempotent unsub), not in the *factory* (which gets re-built on
// every overlay open and would leak one listener per open). See
// docs/v0.8.3-item3-plan.md §A8 + design row O6.

test(
  "installFocusedOverlayShortcut: subscribeToRegistry is invoked exactly once on install",
  () => {
    const fake = makeFakeCtx({ hasUI: true });
    let installs = 0;
    let unsubs = 0;
    installFocusedOverlayShortcut(fake.ctx, {
      openFocusedOverlay: () => {},
      isOverlayOpen: () => false,
      subscribeToRegistry: () => {
        installs += 1;
        return () => {
          unsubs += 1;
        };
      },
    });
    assert.equal(installs, 1, "subscribeToRegistry called exactly once on install");
    assert.equal(unsubs, 0, "registry unsub not yet fired");
  },
);

test(
  "installFocusedOverlayShortcut: returned unsub fires the registry unsub exactly once",
  () => {
    const fake = makeFakeCtx({ hasUI: true });
    let unsubs = 0;
    const unsub = installFocusedOverlayShortcut(fake.ctx, {
      openFocusedOverlay: () => {},
      isOverlayOpen: () => false,
      subscribeToRegistry: () => () => {
        unsubs += 1;
      },
    });
    assert.equal(unsubs, 0);
    unsub();
    assert.equal(unsubs, 1, "registry unsub fires once");
    unsub();
    assert.equal(unsubs, 1, "idempotent — second unsub does not double-fire");
  },
);

test(
  "installFocusedOverlayShortcut: 5 install/uninstall cycles do NOT stack registry listeners (load-bearing)",
  async () => {
    // Use a real RunRegistry so we measure real listener count, not a
    // fake. This is the load-bearing leak invariant pinned in plan §A8
    // + oracle review §"Slice 11 listener-leak invariant". Five cycles
    // is arbitrary but matches the suggested probe in the slice spec.
    const { RunRegistry } = await import("../src/runs.ts");
    const registry = new RunRegistry();
    const baseline = (registry as any).listeners.size;

    for (let i = 0; i < 5; i++) {
      const fake = makeFakeCtx({ hasUI: true });
      const unsub = installFocusedOverlayShortcut(fake.ctx, {
        openFocusedOverlay: () => {},
        isOverlayOpen: () => false,
        subscribeToRegistry: () => registry.onChange(() => {}),
      });
      // While installed, exactly one listener should be registered.
      assert.equal(
        (registry as any).listeners.size,
        baseline + 1,
        `cycle ${i}: while installed, exactly +1 listener over baseline; got ${(registry as any).listeners.size - baseline}`,
      );
      unsub();
      assert.equal(
        (registry as any).listeners.size,
        baseline,
        `cycle ${i}: after unsub, listener count returns to baseline`,
      );
    }
    assert.equal(
      (registry as any).listeners.size,
      baseline,
      "after 5 cycles, listener count is bounded — no leak",
    );
  },
);

test(
  "installFocusedOverlayShortcut: subscribeToRegistry omitted → no registry wiring, unsub still works",
  () => {
    const fake = makeFakeCtx({ hasUI: true });
    // No subscribeToRegistry — should not crash, should still unsub the
    // input handler cleanly.
    const unsub = installFocusedOverlayShortcut(fake.ctx, {
      openFocusedOverlay: () => {},
      isOverlayOpen: () => false,
    });
    assert.doesNotThrow(() => unsub());
  },
);

test(
  "installFocusedOverlayShortcut: headless ctx ignores subscribeToRegistry (no listener registered)",
  () => {
    const fake = makeFakeCtx({ hasUI: false });
    let installs = 0;
    const unsub = installFocusedOverlayShortcut(fake.ctx, {
      openFocusedOverlay: () => {},
      isOverlayOpen: () => false,
      subscribeToRegistry: () => {
        installs += 1;
        return () => {};
      },
    });
    // Headless: no input handler, and we also skip the registry
    // subscription — there's nothing to keep fresh because there's no
    // overlay to render.
    assert.equal(installs, 0, "headless context skips registry subscription");
    assert.doesNotThrow(() => unsub());
  },
);
