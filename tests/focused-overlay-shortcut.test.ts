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
import { makeFakeClock } from "./helpers/fake-clock.ts";

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

// ── Slice 1: too-small terminal guard ─────────────────────────────
//
// Pi-tui can clip an oversized overlay, but tmux + small terminals
// were producing scroll-off-page renders. Slice 1 declines to open
// the overlay below 80×20 and notifies the user instead. The
// threshold lives inside the helper so callers cannot drift.

test(
  "installFocusedOverlayShortcut: declines to open when terminal columns<80",
  () => {
    const fake = makeFakeCtx({ hasUI: true });
    let opens = 0;
    const notifies: { msg: string; level: string }[] = [];
    installFocusedOverlayShortcut(fake.ctx, {
      openFocusedOverlay: () => {
        opens += 1;
      },
      isOverlayOpen: () => false,
      getTerminalSize: () => ({ columns: 79, rows: 50 }),
      notify: (msg, level) => {
        notifies.push({ msg, level });
      },
    });
    const handler = fake.getHandler();
    assert.ok(handler);
    const result = handler!("\x07");
    assert.equal(opens, 0, "must not open when columns < 80");
    assert.deepEqual(
      result,
      { consume: true },
      "Ctrl+G is still consumed when declined (don't fall through to pi's reserved binding)",
    );
    assert.equal(notifies.length, 1, "must notify exactly once when declining");
  },
);

test(
  "installFocusedOverlayShortcut: declines to open when rows<20",
  () => {
    const fake = makeFakeCtx({ hasUI: true });
    let opens = 0;
    const notifies: { msg: string; level: string }[] = [];
    installFocusedOverlayShortcut(fake.ctx, {
      openFocusedOverlay: () => {
        opens += 1;
      },
      isOverlayOpen: () => false,
      getTerminalSize: () => ({ columns: 200, rows: 19 }),
      notify: (msg, level) => {
        notifies.push({ msg, level });
      },
    });
    const handler = fake.getHandler();
    assert.ok(handler);
    handler!("\x07");
    assert.equal(opens, 0, "must not open when rows < 20");
    assert.equal(notifies.length, 1);
  },
);

test(
  "installFocusedOverlayShortcut: notify called with warning level when below threshold",
  () => {
    const fake = makeFakeCtx({ hasUI: true });
    const notifies: { msg: string; level: string }[] = [];
    installFocusedOverlayShortcut(fake.ctx, {
      openFocusedOverlay: () => {},
      isOverlayOpen: () => false,
      getTerminalSize: () => ({ columns: 50, rows: 10 }),
      notify: (msg, level) => {
        notifies.push({ msg, level });
      },
    });
    fake.getHandler()!("\x07");
    assert.equal(notifies.length, 1);
    assert.equal(notifies[0].level, "warning");
    assert.match(
      notifies[0].msg,
      /80.*20/,
      `notify message should mention the 80×20 threshold; got: ${notifies[0].msg}`,
    );
  },
);

test(
  "installFocusedOverlayShortcut: opens normally at 80×20",
  () => {
    const fake = makeFakeCtx({ hasUI: true });
    let opens = 0;
    const notifies: { msg: string; level: string }[] = [];
    installFocusedOverlayShortcut(fake.ctx, {
      openFocusedOverlay: () => {
        opens += 1;
      },
      isOverlayOpen: () => false,
      getTerminalSize: () => ({ columns: 80, rows: 20 }),
      notify: (msg, level) => {
        notifies.push({ msg, level });
      },
    });
    const handler = fake.getHandler();
    assert.ok(handler);
    const result = handler!("\x07");
    assert.equal(opens, 1, "must open at exactly 80×20 (boundary inclusive)");
    assert.equal(notifies.length, 0, "no warning at the boundary");
    assert.deepEqual(result, { consume: true });
  },
);

// ── Slice 3 (overlay redesign): registry → coalescer → tui.requestRender ──

test(
  "installFocusedOverlayShortcut: registry onChange triggers tui.requestRender exactly once on leading edge",
  () => {
    const fake = makeFakeCtx({ hasUI: true });
    const holder: { fn: (() => void) | null } = { fn: null };
    let renderCalls = 0;
    installFocusedOverlayShortcut(fake.ctx, {
      openFocusedOverlay: () => {},
      isOverlayOpen: () => false,
      requestRender: () => {
        renderCalls += 1;
      },
      // Production passes (scheduleRender) => registry.onChange(() => {
      //   focusModel.refresh(); scheduleRender();
      // }). The shortcut owns the coalescer and exposes scheduleRender.
      subscribeToRegistry: (scheduleRender) => {
        holder.fn = () => scheduleRender();
        return () => {};
      },
    });
    const listener = holder.fn;
    assert.ok(listener, "subscribeToRegistry was called and captured a listener");
    listener();
    assert.equal(
      renderCalls,
      1,
      "first registry event must trigger tui.requestRender synchronously (leading edge)",
    );
  },
);

test(
  "installFocusedOverlayShortcut: multiple onChange in 50ms window produce one trailing tui.requestRender",
  () => {
    const fake = makeFakeCtx({ hasUI: true });
    const holder: { fn: (() => void) | null } = { fn: null };
    let renderCalls = 0;
    // Slice 4 fold-in: shared fake-clock harness from
    // `tests/helpers/fake-clock.ts`.
    const clock = makeFakeClock(5000);
    installFocusedOverlayShortcut(fake.ctx, {
      openFocusedOverlay: () => {},
      isOverlayOpen: () => false,
      requestRender: () => {
        renderCalls += 1;
      },
      rerenderWindowMs: 50,
      coalescerDeps: clock.deps,
      subscribeToRegistry: (scheduleRender) => {
        holder.fn = () => scheduleRender();
        return () => {};
      },
    });
    const listener = holder.fn;
    assert.ok(listener);
    // Burst of 5 events 1ms apart.
    for (let i = 0; i < 5; i++) {
      listener();
      clock.advance(1);
    }
    assert.equal(
      renderCalls,
      1,
      "only the leading edge fired during the burst",
    );
    // Advance past the 50ms window — trailing should fire automatically.
    clock.advance(100);
    assert.equal(
      renderCalls,
      2,
      "trailing-edge produced exactly one additional tui.requestRender (total = 2)",
    );
  },
);
