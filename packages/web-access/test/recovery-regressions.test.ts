import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createServer, request as nodeRequest, type RequestOptions as NodeOptions, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { ResearchManager, type ResearchDeps } from "../src/research.js";
import { atomicWrite } from "../src/store.js";
import { request, type RequestOptions } from "../src/network.js";

async function fixture(run: (directory: string, manager: ResearchManager, deps: ResearchDeps, counts: { starts: number; gets: number }) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), "web-recovery-regression-"));
  const counts = { starts: 0, gets: 0 };
  const deps: ResearchDeps = {
    key: () => "mock", start: async () => { counts.starts++; return { upstreamId: "job_123", status: "queued", report: "", citations: [] }; },
    get: async () => { counts.gets++; return { upstreamId: "job_123", status: "completed", report: "Full report", citations: [] }; },
    cancel: async () => ({ upstreamId: "job_123", status: "cancelled", report: "", citations: [] }),
  };
  const manager = new ResearchManager(parseConfig({}, directory), join(directory, "jobs"), deps);
  try { await run(directory, manager, deps, counts); } finally { await manager.stop(); await fs.rm(directory, { recursive: true, force: true }); }
}
test("terminal jobs retry retrieval after local report persistence fails", () => fixture(async (directory, manager, deps, counts) => {
  const job = await manager.start({ provider: "gemini", subject: "Persistence failure" }, directory); await manager.idle();
  const rawPath = join(directory, "jobs", job.researchId, "result.json");
  await fs.mkdir(rawPath); // Force a safe-write refusal, without relying on root-sensitive chmod.
  const failed = await manager.refresh(job.researchId);
  assert.equal(failed.status, "completed"); assert.equal(failed.resultStored, undefined);
  await fs.rmdir(rawPath); await manager.stop();
  const restarted = new ResearchManager(parseConfig({}, directory), join(directory, "jobs"), deps);
  try {
    await restarted.recover(); const result = await restarted.result(job.researchId);
    assert.equal(result.outputWritten, true); assert.equal(result.resultStored, true);
    assert.equal(counts.starts, 1); assert.equal(counts.gets, 2);
  } finally { await restarted.stop(); }
}));
test("restart after upstream completion but before snapshot retention retrieves rather than resubmits", () => fixture(async (directory, manager, deps, counts) => {
  const job = await manager.start({ provider: "openai", subject: "Crash window" }, directory); await manager.idle();
  const record = await manager.read(job.researchId); record.status = "completed";
  await atomicWrite(join(directory, "jobs", `${record.researchId}.json`), JSON.stringify(record), true);
  await manager.stop();
  const restarted = new ResearchManager(parseConfig({}, directory), join(directory, "jobs"), deps);
  try { assert.equal((await restarted.result(job.researchId)).outputWritten, true); assert.equal(counts.starts, 1); assert.equal(counts.gets, 1); }
  finally { await restarted.stop(); }
}));
test("deduplication uses resolved destinations and respects working directories", () => fixture(async (directory, manager, _deps, counts) => {
  const input = { provider: "openai" as const, subject: "Paths", outputPath: "report.md" };
  const first = await manager.start(input, directory); await manager.idle();
  const equivalent = await manager.start({ ...input, outputPath: "./report.md" }, directory);
  assert.equal(first.researchId, equivalent.researchId); assert.equal(counts.starts, 1);
  const other = await manager.start(input, join(directory, "other")); await manager.idle();
  assert.notEqual(first.researchId, other.researchId); assert.equal(counts.starts, 2);
  assert.equal(other.outputPath, join(directory, "other", "report.md"));
}));
test("durable record publication syncs its directory before starting a paid submission", () => fixture(async (directory, _manager, deps) => {
  const originalOpen = fs.open, originalLink = fs.link;
  const events: string[] = [];
  fs.open = (async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args); const sync = handle.sync.bind(handle);
    handle.sync = async () => { events.push(`sync:${String(args[0])}`); await sync(); };
    return handle;
  }) as typeof fs.open;
  fs.link = async (from, to) => { events.push(`publish:${String(to)}`); return originalLink(from, to); };
  syncBuiltinESMExports();
  const jobs = join(directory, "durable-jobs");
  let verified = false;
  const manager = new ResearchManager(parseConfig({}, directory), jobs, { ...deps, start: async (...args) => {
    const published = events.findIndex((event) => event.startsWith(`publish:${jobs}/`) && event.endsWith(".json"));
    assert.ok(published >= 0);
    assert.ok(events.slice(0, published).some((event) => event.startsWith(`sync:${jobs}/.`) && event.endsWith(".tmp")));
    assert.ok(events.slice(published + 1).includes(`sync:${jobs}`));
    verified = true;
    return deps.start(...args);
  } });
  try { await manager.start({ provider: "openai", subject: "Durable" }, directory); await manager.idle(); assert.equal(verified, true); }
  finally { await manager.stop(); fs.open = originalOpen; fs.link = originalLink; syncBuiltinESMExports(); }
}));
test("real Node hostname connection setup uses the pinned single-address callback shape", async () => {
  const server = createServer((_req, res) => res.end("offline fixture"));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  let checked = false;
  const localTransport = ((url: URL, options: NodeOptions, callback: (response: IncomingMessage) => void) => {
    assert.equal(options.family, 4);
    return nodeRequest(url, { ...options, port: address.port, lookup(host, lookupOptions, done) {
      assert.equal(lookupOptions.all, undefined);
      options.lookup!(host, lookupOptions, (error, pinned, family) => {
        assert.equal(pinned, "8.8.8.8"); assert.equal(family, 4); checked = true;
        // Only the test transport substitutes loopback after checking the pinned address.
        done(error, "127.0.0.1", family);
      });
    } }, callback);
  }) as NonNullable<RequestOptions["transport"]>;
  try {
    const result = await request("http://fixture.example", { transport: localTransport, lookup: async () => [{ address: "8.8.8.8", family: 4 }] });
    assert.equal(result.body.toString(), "offline fixture"); assert.equal(checked, true);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
