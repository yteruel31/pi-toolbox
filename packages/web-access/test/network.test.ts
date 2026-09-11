import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage, RequestOptions as NodeRequestOptions } from "node:http";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { request, type RequestOptions } from "../src/network.js";

function transport(replies: Array<{ status?: number; headers?: Record<string, string>; body?: Buffer }>) {
  const calls: Array<{ url: URL; options: NodeRequestOptions }> = [];
  const fn = ((url: URL, options: NodeRequestOptions, callback: (response: IncomingMessage) => void) => {
    calls.push({ url, options });
    const reply = replies.shift(); assert.ok(reply, "unexpected network request");
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      const response = new PassThrough() as unknown as IncomingMessage;
      response.statusCode = reply.status ?? 200; response.headers = reply.headers ?? {};
      queueMicrotask(() => { callback(response); queueMicrotask(() => { (response as unknown as PassThrough).end(reply.body ?? Buffer.from("ok")); }); });
      return req;
    }) as ClientRequest["end"];
    return req;
  }) as NonNullable<RequestOptions["transport"]>;
  return { fn, calls };
}
const lookup = async () => [{ address: "8.8.8.8", family: 4 }];
test("redirects revalidate before connecting and strip cross-origin credentials", async () => {
  const t = transport([{ status: 302, headers: { location: "https://other.example/" } }, { body: Buffer.from("final") }]);
  const result = await request("https://example.com", { transport: t.fn, lookup, headers: { Authorization: "secret" } });
  assert.equal(result.body.toString(), "final");
  assert.equal((t.calls[1]!.options.headers as Record<string, string>).Authorization, undefined);
  assert.equal(t.calls[1]!.url.hostname, "other.example");
  assert.equal(t.calls[0]!.options.family, 4);
  const resolver = t.calls[0]!.options.lookup!;
  await new Promise<void>((resolve, reject) => resolver("example.com", {}, (error, address, family) => { try { assert.equal(error, null); assert.equal(address, "8.8.8.8"); assert.equal(family, 4); resolve(); } catch (error) { reject(error); } }));
});
test("private redirects and HTTPS downgrade never make a second connection", async () => {
  for (const location of ["http://example.com", "https://127.0.0.1", "https://private.example"]) {
    const t = transport([{ status: 302, headers: { location } }]);
    await assert.rejects(request("https://example.com", { transport: t.fn, lookup: async (host) => [{ address: host === "private.example" ? "10.0.0.1" : "8.8.8.8", family: 4 }] }));
    assert.equal(t.calls.length, 1);
  }
});
test("API redirects and redirect loops fail with bounded connection counts", async () => {
  const api = transport([{ status: 307, headers: { location: "https://other.example" } }]);
  await assert.rejects(request("https://example.com", { method: "POST", redirects: 0, body: Buffer.from("{}"), transport: api.fn, lookup }), /Redirect/);
  const loop = transport(Array.from({ length: 3 }, () => ({ status: 302, headers: { location: "https://example.com" } })));
  await assert.rejects(request("https://example.com", { redirects: 2, transport: loop.fn, lookup }), /limit/);
  assert.equal(loop.calls.length, 3);
});
test("compressed bodies are bounded after decompression and cookies are discarded", async () => {
  const compressed = gzipSync(Buffer.alloc(10000, "x"));
  const t = transport([{ headers: { "content-encoding": "gzip" }, body: compressed }]);
  await assert.rejects(request("https://example.com", { maxBytes: 500, transport: t.fn, lookup }), /exceeds/);
  const plain = transport([{ headers: { "set-cookie": "private=secret", "content-type": "text/plain" } }]);
  const result = await request("https://example.com", { transport: plain.fn, lookup });
  assert.equal(result.headers["set-cookie"], undefined);
});
