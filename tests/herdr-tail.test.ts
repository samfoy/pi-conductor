import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpDir } from "./helpers/tmp.ts";

async function fixture() {
  assert.ok(existsSync(new URL("../src/herdr/tail.ts", import.meta.url)), "H7 read-only tail exists");
  const { HerdrTail } = await import("../src/herdr/tail.ts");
  const path = join(tmpDir("h7-tail-"), "transcript.jsonl");
  const old = JSON.stringify({ type: "agent_settled", _c: { n: "old" } }) + "\n";
  writeFileSync(path, old);
  const seen: string[] = [], errors: Error[] = [];
  const tail = new HerdrTail({ path, offset: Buffer.byteLength(old), nonce: "current", line: line => seen.push(line), error: e => errors.push(e) });
  return { path, seen, errors, tail };
}
test("H7 tail keeps Unicode across writes/chunks, LF carry, nonce and exactly-once read-only delivery", async t => {
  const h = await fixture(); t.after(() => h.tail.close());
  const event = { type: "message_end", text: "x".repeat(65500) + "漢🙂\u2028\u2029", _c: { n: "current" } };
  const bytes = Buffer.from(JSON.stringify(event) + "\n");
  const split = bytes.indexOf(Buffer.from("🙂")) + 2;
  appendFileSync(h.path, bytes.subarray(0, split)); h.tail.drain();
  assert.equal(h.seen.length, 0);
  appendFileSync(h.path, bytes.subarray(split));
  appendFileSync(h.path, '{"type":"agent_settled"}\n{"_c":{"n":"foreign"}}\n');
  h.tail.drain(); h.tail.drain();
  assert.deepEqual(h.seen.map(line => JSON.parse(line)), [event]); assert.deepEqual(h.errors, []);
});
test("H7 tail never treats valid but unterminated JSON at death as an event", async t => {
  const h = await fixture(); t.after(() => h.tail.close());
  appendFileSync(h.path, '{"type":"agent_settled","_c":{"n":"current"}}');
  h.tail.drain(); h.tail.close(); h.tail.drain();
  assert.deepEqual(h.seen, []);
});
test("H7 tail bounds malformed partial-line memory and closes after a read failure", async t => {
  const h = await fixture(); t.after(() => h.tail.close());
  appendFileSync(h.path, "x".repeat(33 * 1048576)); h.tail.drain(); h.tail.drain();
  assert.equal(h.errors.length, 1); assert.match(h.errors[0].message, /limit/); assert.deepEqual(h.seen, []);
});
