import test from "node:test";
import assert from "node:assert/strict";

import { shortenMiddle, summarizeToolArgs } from "../src/tool-summary.ts";
import { visibleWidth } from "@earendil-works/pi-tui";

// summarizeToolArgs is the *core* helper — no `$ ` prefix, no shortenPath.
// Mirrors the prior `summarizeArgs` semantics from src/transcript.ts so the
// transcript renderer behavior is preserved byte-for-byte across the dedup.

test("summarizeToolArgs: bash returns the command literal", () => {
  assert.equal(summarizeToolArgs("bash", { command: "echo hi" }), "echo hi");
});

test("summarizeToolArgs: bash truncates long commands at 50 visible chars with middle ellipsis", () => {
  // Switched from head-truncate to shortenMiddle (v0.8.1 sub-issue #1) so the
  // argument tail stays visible. Total width budget unchanged at 50.
  const long = "a".repeat(80);
  const out = summarizeToolArgs("bash", { command: long });
  assert.equal(visibleWidth(out), 50);
  assert.ok(out.includes("…"));
});

test("summarizeToolArgs: bash long command surfaces both head and tail of the command", () => {
  const cmd = "aws sts get-caller-identity --profile tickety 2>/dev/null";
  const out = summarizeToolArgs("bash", { command: cmd });
  assert.equal(visibleWidth(out), 50);
  // Head context (the verb + flag) survives.
  assert.ok(out.startsWith("aws sts "), `expected head 'aws sts ' in ${JSON.stringify(out)}`);
  // Tail context survives — the trailing redirect lands beyond the head budget,
  // so a head-truncate would lose it.
  assert.ok(out.endsWith("/dev/null"), `expected tail '/dev/null' in ${JSON.stringify(out)}`);
  assert.ok(out.includes("…"));
});

test("summarizeToolArgs: bash long command surfaces $DEV_ACCOUNT_ID-style tail too", () => {
  const cmd = "ada credentials update --account=$DEV_ACCOUNT_ID --provider=conduit --role=Admin --once";
  const out = summarizeToolArgs("bash", { command: cmd });
  assert.equal(visibleWidth(out), 50);
  assert.ok(out.startsWith("ada "));
  // The interesting suffix survives middle-truncation.
  assert.ok(/--once$/.test(out), `expected tail '--once' in ${JSON.stringify(out)}`);
});

test("summarizeToolArgs: bash with missing command returns empty string", () => {
  assert.equal(summarizeToolArgs("bash", {}), "");
});

test("summarizeToolArgs: read returns the file_path", () => {
  assert.equal(summarizeToolArgs("read", { file_path: "x.ts" }), "x.ts");
});

test("summarizeToolArgs: read falls back to args.path", () => {
  assert.equal(summarizeToolArgs("read", { path: "y.ts" }), "y.ts");
});

test("summarizeToolArgs: write returns the file_path", () => {
  assert.equal(summarizeToolArgs("write", { file_path: "out.txt" }), "out.txt");
});

test("summarizeToolArgs: edit returns the file_path", () => {
  assert.equal(summarizeToolArgs("edit", { file_path: "src/foo.ts" }), "src/foo.ts");
});

test("summarizeToolArgs: grep returns the pattern", () => {
  assert.equal(summarizeToolArgs("grep", { pattern: "TODO" }), "TODO");
});

test("summarizeToolArgs: unknown tools render compact key=value pairs", () => {
  const out = summarizeToolArgs("custom_tool", { foo: "bar", n: 7 });
  assert.equal(out, "foo=bar n=7");
});

test("summarizeToolArgs: unknown tools shorten each value at 30 chars", () => {
  // Each value is shortened to 30 chars (with ellipsis) before pair-joining.
  const out = summarizeToolArgs("custom_tool", { x: "a".repeat(80) });
  assert.equal(out, "x=" + "a".repeat(29) + "…");
});

test("summarizeToolArgs: unknown tools truncate the joined pair list at 50 chars", () => {
  // Many short values whose joined form exceeds 50 chars get a final outer trim.
  const args: Record<string, any> = {};
  for (let i = 0; i < 20; i++) args[`k${i}`] = `v${i}`;
  const out = summarizeToolArgs("custom_tool", args);
  assert.equal(out.length, 50);
  assert.ok(out.endsWith("…"));
});

test("summarizeToolArgs: empty args render as empty string", () => {
  assert.equal(summarizeToolArgs("custom_tool", {}), "");
});

// ── shortenMiddle: head + ellipsis + tail ─────────────────────────────

test("shortenMiddle: returns text unchanged when visibleWidth <= max", () => {
  assert.equal(shortenMiddle("hello", 10), "hello");
  assert.equal(shortenMiddle("hello", 5), "hello");
  assert.equal(shortenMiddle("", 10), "");
});

test("shortenMiddle: long string at max=50 returns head+…+tail with visibleWidth 50", () => {
  const long = "a".repeat(30) + "b".repeat(30) + "c".repeat(30);
  const out = shortenMiddle(long, 50);
  assert.equal(visibleWidth(out), 50);
  assert.ok(out.includes("…"));
  // Head (a's) and tail (c's) both survive; mid (b's) collapses.
  assert.ok(out.startsWith("a"));
  assert.ok(out.endsWith("c"));
});

test("shortenMiddle: head:tail allocation is roughly 60:40 of the post-ellipsis budget", () => {
  // budget = max - 1 (ellipsis); 49 → head ≈ 29, tail ≈ 20.
  const head = "H".repeat(40);
  const tail = "T".repeat(40);
  const text = head + "_".repeat(20) + tail;
  const out = shortenMiddle(text, 50);
  assert.equal(visibleWidth(out), 50);
  const idx = out.indexOf("…");
  assert.ok(idx > 0, "ellipsis present");
  const headPart = out.slice(0, idx);
  const tailPart = out.slice(idx + 1);
  assert.ok(headPart.length >= tailPart.length, `head ${headPart.length} >= tail ${tailPart.length}`);
  assert.ok(headPart.length - tailPart.length <= 12, "ratio not too skewed");
  assert.ok(headPart.length >= 25 && tailPart.length >= 15, "both halves substantial");
});

test("shortenMiddle: max<3 degrades gracefully without crashing", () => {
  // We do not require a specific output shape here, only that the result fits
  // within the requested width and the call does not throw.
  for (const max of [0, 2]) {
    const out = shortenMiddle("abcdefghij", max);
    assert.ok(visibleWidth(out) <= max, `max=${max} produced ${JSON.stringify(out)}`);
  }
});

test("shortenMiddle: max equal to ellipsis width returns just the ellipsis", () => {
  // visibleWidth("…") === 1; at max=1 the only sensible output is the ellipsis.
  assert.equal(shortenMiddle("abcdefghij", 1), "…");
});

test("shortenMiddle: exact-width input is returned unchanged (no ellipsis injected)", () => {
  const text = "x".repeat(50);
  assert.equal(shortenMiddle(text, 50), text);
});

test("shortenMiddle: deterministic / pure across repeated calls", () => {
  const text = "the quick brown fox jumps over the lazy dog";
  assert.equal(shortenMiddle(text, 25), shortenMiddle(text, 25));
});
