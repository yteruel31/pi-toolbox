import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { ResearchManager, type ResearchDeps } from "../src/research.js";
import type { ResearchSnapshot } from "../src/providers.js";

function snapshot(status = "queued", report = ""): ResearchSnapshot { return { upstreamId: "job_123", status, report, citations: [{ title: "Reference", url: "https://example.com" }], usage: { total_tokens: 123 } }; }
async function fixture(run: (directory: string, manager: ResearchManager, counts: { start: number; get: number; cancel: number }, deps: ResearchDeps) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "web-research-test-"));
  const counts = { start: 0, get: 0, cancel: 0 };
  const deps: ResearchDeps = {
    key: () => "test-key", start: async () => { counts.start++; return snapshot(); },
    get: async () => { counts.get++; return snapshot("completed", "# Full report\n\n" + "Research findings. ".repeat(5000)); },
    cancel: async () => { counts.cancel++; return snapshot("cancelled"); },
  };
  const manager = new ResearchManager(parseConfig({}, directory), join(directory, "jobs"), deps);
  try { await run(directory, manager, counts, deps); } finally { await manager.stop(); await rm(directory, { recursive: true, force: true }); }
}
test("start returns promptly while the upstream submission is pending", () => fixture(async (directory, _manager, _counts, deps) => {
  let finish!: (snapshot: ResearchSnapshot) => void;
  const manager = new ResearchManager(parseConfig({}, directory), join(directory, "async-jobs"), { ...deps, start: () => new Promise((resolve) => { finish = resolve; }) });
  const job = await manager.start({ provider: "gemini", subject: "A research subject" }, directory);
  assert.equal(job.status, "submitting");
  await new Promise((resolve) => setTimeout(resolve, 20));
  finish(snapshot()); await manager.idle();
  assert.equal((await manager.read(job.researchId)).upstreamId, "job_123");
  await manager.stop();
}));
test("same request is not submitted twice, including after a restart", () => fixture(async (directory, manager, counts, deps) => {
  const input = { provider: "openai" as const, subject: "Same subject" };
  const first = await manager.start(input, directory); await manager.idle();
  const second = await manager.start(input, directory);
  assert.equal(first.researchId, second.researchId); assert.equal(counts.start, 1);
  await manager.stop();
  const recovered = new ResearchManager(parseConfig({}, directory), join(directory, "jobs"), deps);
  await recovered.recover();
  assert.equal((await recovered.start(input, directory)).researchId, first.researchId);
  assert.equal(counts.start, 1);
  const done = await recovered.result(first.researchId);
  assert.equal(done.status, "completed"); assert.equal(done.outputWritten, true);
  assert.ok((await readFile(done.outputPath, "utf8")).length > 80_000);
  assert.ok(done.preview!.length <= 600);
  await recovered.stop();
}));
test("reports preserve full text, metadata, citations and footer without overwriting", () => fixture(async (directory, manager) => {
  const path = join(directory, "custom", "report.md");
  const job = await manager.start({ provider: "gemini", subject: "Subject\n---\nunsafe: value", outputPath: path }, directory); await manager.idle();
  const done = await manager.result(job.researchId);
  const report = await readFile(path, "utf8");
  assert.ok(report.startsWith('---\nsubject: "Subject\\n---\\nunsafe: value"'));
  assert.match(report, /## Sources/); assert.match(report, /AI generated/);
  assert.deepEqual(done.usage, { total_tokens: 123 });
  assert.equal(await manager.content(job.researchId), report);
  await assert.rejects(manager.start({ provider: "gemini", subject: "Other subject", outputPath: path }, directory), /already exists/);
}));
test("a raced output file remains intact and result can publish to a new path", () => fixture(async (directory, manager) => {
  const path = join(directory, "raced.md");
  const job = await manager.start({ provider: "gemini", subject: "Race subject", outputPath: path }, directory); await manager.idle();
  await writeFile(path, "user file");
  const done = await manager.result(job.researchId);
  assert.equal(done.outputWritten, undefined); assert.match(done.outputError!, /without overwriting/);
  assert.equal(await readFile(path, "utf8"), "user file");
  const retried = await manager.result(job.researchId, join(directory, "recovered.md"));
  assert.equal(retried.outputWritten, true);
}));
test("native cancellation is confirmed by upstream and remains terminal", () => fixture(async (directory, manager, counts) => {
  const job = await manager.start({ provider: "openai", subject: "Cancel me" }, directory); await manager.idle();
  assert.equal((await manager.cancel(job.researchId)).status, "cancelled");
  assert.equal((await manager.cancel(job.researchId)).status, "cancelled");
  assert.equal(counts.cancel, 1); assert.equal(counts.get, 0);
}));
test("ambiguous submission is never automatically retried and supports ID recovery", () => fixture(async (directory, _manager, counts, deps) => {
  const manager = new ResearchManager(parseConfig({}, directory), join(directory, "uncertain"), { ...deps, start: async () => { counts.start++; throw new Error("connection lost"); } });
  const job = await manager.start({ provider: "gemini", subject: "Uncertain" }, directory); await manager.idle();
  assert.equal((await manager.read(job.researchId)).status, "submission_unknown");
  await manager.start({ provider: "gemini", subject: "Uncertain" }, directory);
  assert.equal(counts.start, 1);
  await assert.rejects(manager.cancel(job.researchId), /without a provider ID/);
  assert.equal((await manager.refresh(job.researchId, "job_123")).status, "completed");
  await manager.stop();
}));
test("incomplete research is reported as incomplete, not successful", () => fixture(async (directory, _manager, _counts, deps) => {
  const manager = new ResearchManager(parseConfig({}, directory), join(directory, "incomplete"), { ...deps, get: async () => snapshot("incomplete", "Partial report") });
  const job = await manager.start({ provider: "openai", subject: "Incomplete" }, directory); await manager.idle();
  const result = await manager.result(job.researchId);
  assert.equal(result.status, "incomplete"); assert.equal(result.outputWritten, true);
  assert.match(await readFile(result.outputPath, "utf8"), /status: "incomplete"/);
  await manager.stop();
}));
test("cancellation failure cannot become a successful local cancellation", () => fixture(async (directory, _manager, _counts, deps) => {
  const manager = new ResearchManager(parseConfig({}, directory), join(directory, "cancel-failed"), { ...deps, cancel: async () => { throw new Error("HTTP 409"); } });
  const job = await manager.start({ provider: "openai", subject: "Cancel failure" }, directory); await manager.idle();
  await assert.rejects(manager.cancel(job.researchId), /409/);
  assert.equal((await manager.read(job.researchId)).status, "queued");
  await manager.stop();
}));
