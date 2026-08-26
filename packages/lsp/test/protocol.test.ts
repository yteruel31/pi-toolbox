import assert from "node:assert/strict";
import test from "node:test";

import { encodeMessage, MessageFramer } from "../src/protocol.js";

test("frames split and coalesced JSON-RPC messages", () => {
  const first = encodeMessage({ jsonrpc: "2.0", id: 1, result: { ok: true } });
  const second = encodeMessage({ jsonrpc: "2.0", method: "ready", params: { value: "é" } });
  const combined = Buffer.concat([first, second]);
  const framer = new MessageFramer();

  assert.deepEqual(framer.push(combined.subarray(0, 7)), []);
  assert.deepEqual(framer.push(combined.subarray(7, first.length + 3)), [{ jsonrpc: "2.0", id: 1, result: { ok: true } }]);
  assert.deepEqual(framer.push(combined.subarray(first.length + 3)), [{ jsonrpc: "2.0", method: "ready", params: { value: "é" } }]);
});

test("resynchronizes after a header without Content-Length", () => {
  const framer = new MessageFramer();
  const valid = encodeMessage({ jsonrpc: "2.0", id: 2, result: null });
  const messages = framer.push(Buffer.concat([Buffer.from("noise\r\n\r\n"), valid]));
  assert.deepEqual(messages, [{ jsonrpc: "2.0", id: 2, result: null }]);
});

test("rejects unbounded headers and bodies", () => {
  assert.throws(() => new MessageFramer().push(Buffer.alloc(8 * 1024 + 1, "x")), /header exceeds/);
  assert.throws(
    () => new MessageFramer().push(Buffer.from("Content-Length: 10485761\r\n\r\n")),
    /body exceeds/,
  );
});
