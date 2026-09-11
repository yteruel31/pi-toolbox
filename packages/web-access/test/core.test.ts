import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import test from "node:test";
import { parseConfig, resolveKey } from "../src/config.js";
import { abortable, publicAddress, remoteUrl, resolvePublic, readBounded } from "../src/network.js";
import { atomicWrite, ContentStore, retrieve, readPrivate } from "../src/store.js";
import { validateAssessment } from "../src/synthesis.js";

async function temporary(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "web-access-test-"));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test("configuration is global, strict and does not guess the search provider", () => {
  const config = parseConfig({}, "/tmp/agent");
  assert.equal(config.search.provider, undefined);
  assert.equal(config.research.outputDir, "/tmp/agent/web-access/reports");
  assert.throws(() => parseConfig({ curator: true }, "/tmp"), /unsupported/);
  assert.throws(() => parseConfig({ fetch: { timeoutMs: 0 } }, "/tmp"), /integer/);
  assert.throws(() => parseConfig({ cache: { directory: "relative" } }, "/tmp"), /absolute/);
  assert.throws(() => parseConfig({ enabled: "true" }, "/tmp"), /boolean/);
});
test("API credentials require explicit key sources and never execute arbitrary commands", async () => {
  const config = parseConfig({}, "/tmp");
  assert.equal(await resolveKey(config, "gemini", { GEMINI_API_KEY: "test-key" }), "test-key");
  await assert.rejects(resolveKey(config, "openai", {}), /subscriptions/);
  config.credentials.openai = "!echo secret";
  await assert.rejects(resolveKey(config, "openai", {}), /Invalid/);
});
test("SSRF rejects private, mapped, reserved and alternate IP representations", () => {
  for (const ip of ["127.0.0.1", "10.0.0.1", "192.168.1.2", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "fc00::1", "fe80::1", "::ffff:8.8.8.8", "2001:db8::1"]) assert.equal(publicAddress(ip), false, ip);
  assert.equal(publicAddress("8.8.8.8"), true);
  for (const url of ["file:///etc/passwd", "http://2130706433", "http://0x7f000001", "http://127.1", "http://localhost.", "http://metadata.internal", "https://user:pass@example.com", "https://example.com:1234", "http://[::ffff:127.0.0.1]"]) {
    assert.throws(() => remoteUrl(url), /Blocked/, url);
  }
});
test("all DNS answers are validated before pinning a connection", async () => {
  const url = remoteUrl("https://example.com"); const signal = AbortSignal.timeout(1000);
  await assert.rejects(resolvePublic(url, signal, async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]), /Blocked/);
  assert.equal((await resolvePublic(url, signal, async () => [{ address: "8.8.8.8", family: 4 }])).address, "8.8.8.8");
});
test("DNS waits and streams obey cancellation and limits", async () => {
  const controller = new AbortController(); controller.abort(new Error("stopped"));
  await assert.rejects(abortable(new Promise(() => {}), controller.signal), /stopped/);
  await assert.rejects(readBounded(Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 15, AbortSignal.timeout(1000)), /exceeds/);
});
test("atomic publication does not overwrite and rejects symlink parents", () => temporary(async (directory) => {
  const path = join(directory, "report.md");
  await atomicWrite(path, "original");
  await assert.rejects(atomicWrite(path, "replacement"));
  assert.equal(await readFile(path, "utf8"), "original");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  await symlink(directory, join(directory, "alias"));
  await assert.rejects(atomicWrite(join(directory, "alias", "escape.md"), "no"), /symlink/);
  await symlink(path, join(directory, "link.md"));
  await assert.rejects(readPrivate(join(directory, "link.md")));
}));
test("cache supports recovery, bounded pagination, eviction and expiration", () => temporary(async (directory) => {
  let time = Date.now();
  const options = { directory, maxEntries: 1, maxBytes: 10000, ttlMs: 1000, inlineChars: 100 };
  const store = new ContentStore(options, () => time);
  const first = await store.put([{ title: "one", content: "abc" }]);
  const next = await store.put([{ title: "two", content: "before Needle after Needle" }]);
  await assert.rejects(store.get(first), /missing/);
  const docs = await new ContentStore(options, () => time).get(next);
  assert.equal(retrieve(docs, { offset: 1, limit: 3 }, 100).content, "efo");
  assert.equal((retrieve(docs, { findText: "needle" }, 100).matches as unknown[]).length, 2);
  assert.throws(() => retrieve(docs, { findText: "needle", offset: 0 }, 100), /cannot/);
  time += 2000;
  await assert.rejects(store.get(next), /expired/);
}));
test("unsafe content IDs cannot read arbitrary files", () => temporary(async (directory) => {
  await writeFile(join(directory, "secret"), "private");
  const store = new ContentStore({ directory, maxEntries: 1, maxBytes: 1000, ttlMs: 1000, inlineChars: 100 });
  await assert.rejects(store.get("../secret"));
}));
test("source check accepts only verbatim evidence and downgrades unsupported verdicts", () => {
  const docs = [{ title: "Source", url: "https://example.com", content: "The supported protocol is HTTPS only." }];
  const valid = validateAssessment(JSON.stringify({ status: "supported", explanation: "Found", evidence: [{ source: 0, quote: "protocol is HTTPS only", relation: "supports" }] }), docs);
  assert.equal(valid.status, "supported"); assert.equal(valid.evidence[0]?.offset, 14);
  const invalid = validateAssessment(JSON.stringify({ status: "supported", explanation: "Found", evidence: [{ source: 0, quote: "HTTP is supported", relation: "supports" }] }), docs);
  assert.equal(invalid.status, "missing-evidence"); assert.equal(invalid.rejectedQuotes, 1);
});
