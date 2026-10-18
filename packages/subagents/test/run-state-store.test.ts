import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/run-manager.js";
import { FileRunStateStore, MAX_BLOB_BYTES, type CompactRunState } from "../src/persistence/run-state-store.js";
import { FakeHarness, flush } from "./helpers/fake-harness.js";
import { temporaryStateDirectory } from "./helpers/temp-state.js";

function fixture(session = "session-a", root = temporaryStateDirectory()) {
  const store = new FileRunStateStore(root, session);
  const entries: CompactRunState[] = [];
  const errors: Error[] = [];
  let appendFails = false;
  const manager = new RunManager({ hooks: {
    persist: (state) => {
      const compact = store.save(state);
      if (appendFails) throw new Error("simulated append failure: private sentinel");
      entries.push(compact);
    },
    onPersistenceError: (error) => errors.push(error),
  } });
  const harness = new FakeHarness();
  return { root, store, entries, manager, harness, errors, failAppend(value: boolean) { appendFails = value; } };
}
function files(root: string, state: CompactRunState) {
  const directory = path.join(root, state.namespace);
  return fs.readdirSync(directory).sort().map((name) => {
    const stat = fs.statSync(path.join(directory, name), { bigint: true });
    return { name, size: Number(stat.size), mtime: stat.mtimeNs };
  });
}
function blobPath(root: string, state: CompactRunState, digest = state.runs[0]!.artifact) {
  return path.join(root, state.namespace, `${digest}.json`);
}

async function settled() {
  const f = fixture();
  const run = f.manager.spawn({ prompt: "payload prompt", harness: f.harness });
  f.harness.last.transcript({ kind: "assistant", text: "retained transcript" });
  f.harness.last.resolve({ finalText: "retained final" });
  await flush();
  return { ...f, id: run.id };
}

describe("compact durable subagent state", () => {
  it("bounds 175 large runs independently of payload size and never rewrites consumed artifacts", async () => {
    const f = fixture();
    const ids: string[] = [];
    for (let index = 0; index < 175; index++) {
      const run = f.manager.spawn({ prompt: `task ${index}`, harness: f.harness });
      ids.push(run.id);
      for (let entry = 0; entry < 20; entry++) {
        f.harness.last.transcript({ kind: "assistant", text: `${index}:${entry}:` + "é".repeat(3990) });
      }
      f.harness.last.resolve({ finalText: `result ${index}:` + "r".repeat(44_980) });
      await flush();
      if (index % 2 === 0) f.manager.collectReady([run.id]);
      else f.manager.drainDeliveries();
    }
    const last = f.entries.at(-1)!;
    for (const entry of f.entries) {
      const text = JSON.stringify(entry);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 + 160 * entry.runs.length);
      expect(text).not.toMatch(/retained|é|rrrr|transcript|finalText|activity/);
    }
    const before = files(f.root, last);
    for (let i = 0; i < 20; i++) f.manager.checkpoint();
    expect(files(f.root, last)).toEqual(before);
    const legacyBytes = Buffer.byteLength(JSON.stringify(f.manager.snapshotState()));
    const compactBytes = Buffer.byteLength(JSON.stringify(last));
    const artifactBytes = before.reduce((sum, file) => sum + file.size, 0);
    console.log(`snapshot-volume: runs=175 legacy=${legacyBytes} compact=${compactBytes} artifacts=${artifactBytes}; 20 unchanged checkpoints: legacy=${20 * legacyBytes} new=${20 * compactBytes} artifactWrites=0`);
    expect(compactBytes).toBeLessThan(legacyBytes / 500);
    const reloadStore = new FileRunStateStore(f.root, "session-a");
    const restored = new RunManager({ restore: reloadStore.restore(last), hooks: { persist: (state) => { reloadStore.save(state); } } });
    restored.checkpoint();
    expect(files(f.root, last)).toEqual(before);
    expect(restored.pendingDeliveryCount()).toBe(0);
    expect(restored.check(ids[174]!).transcript.some((entry) => entry.kind === "assistant" && entry.text.startsWith("174:19:"))).toBe(true);
    const report = await restored.wait([ids[0]!]);
    expect(report.newlyConsumedIds).toEqual([]);
    expect(report.entries[0]).toMatchObject({ kind: "result", result: { finalText: expect.stringContaining("result 0:") } });
  }, 30_000);

  it("writes active transcript chunks only once, not a new accumulated transcript on each lifecycle transition", async () => {
    const f = fixture();
    const run = f.manager.spawn({ prompt: "growing", harness: f.harness });
    for (let index = 0; index < 24; index++) {
      f.harness.last.transcript({ kind: "assistant", text: `${index}:` + "x".repeat(3900) });
      f.manager.checkpoint();
    }
    const blobs = files(f.root, f.entries.at(-1)!);
    const payloadChunks = blobs.filter((file) => {
      const value = JSON.parse(fs.readFileSync(path.join(f.root, f.entries.at(-1)!.namespace, file.name), "utf8"));
      return value.kind === "assistant";
    });
    expect(payloadChunks).toHaveLength(24);
    // Includes the small run descriptors for every revision, not just live data.
    expect(blobs.reduce((sum, file) => sum + file.size, 0)).toBeLessThan(160_000);
    expect(f.manager.check(run.id).transcript).toHaveLength(27);
    f.manager.shutdown();
    await flush();
  });

  it("reloads owed, waited, delivered, suppressed and interrupted runs without double consumption", async () => {
    const f = fixture();
    for (let index = 0; index < 5; index++) {
      f.manager.spawn({ prompt: `task ${index}`, harness: f.harness, autoDeliver: index !== 3 });
      if (index !== 4) { f.harness.last.resolve({ finalText: `result ${index}` }); await flush(); }
      if (index === 0) f.manager.collectReady(["run-1"]);
      if (index === 1) f.manager.drainDeliveries();
    }
    const store = new FileRunStateStore(f.root, "session-a");
    let latest: CompactRunState | undefined;
    const restored = new RunManager({ restore: store.restore(f.entries.at(-1)), hooks: { persist(state) { latest = store.save(state); } } });
    expect(restored.check("run-5").status).toBe("failed");
    expect(restored.check("run-5").resultPreview).toContain("restarted");
    expect(restored.check("run-1").consumption).toBe("waited");
    expect(restored.check("run-2").consumption).toBe("delivered");
    expect(restored.collectReady(["run-4"]).entries[0]?.kind).toBe("suppressed");
    expect((await restored.wait(["run-3"])).newlyConsumedIds).toEqual(["run-3"]);
    expect(restored.drainDeliveries().map((run) => run.id)).toEqual(["run-5"]);
    expect(restored.drainDeliveries()).toEqual([]);
    const again = new RunManager({ restore: new FileRunStateStore(f.root, "session-a").restore(latest) });
    expect(again.drainDeliveries()).toEqual([]);
    expect(again.collectReady(["run-3"]).newlyConsumedIds).toEqual([]);
    expect(again.check("run-3").resultPreview).toBe("result 2");
    f.manager.shutdown();
    await flush();
  });

  it("keeps cached terminal usage detached from harness outcomes and public snapshots", async () => {
    const f = fixture();
    const id = f.manager.spawn({ prompt: "usage", harness: f.harness }).id;
    const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 1, contextTokens: 3 };
    f.harness.last.resolve({ finalText: "done", usage });
    await flush();
    usage.input = 999;
    f.manager.snapshot(id).usage!.input = 888;
    f.manager.snapshotState().runs[0]!.usage!.input = 777;
    const result = f.manager.collectReady([id]).entries[0];
    if (result?.kind === "result") result.result.usage!.input = 666;
    expect(f.manager.snapshot(id).usage!.input).toBe(1);
    expect(f.store.restore(f.entries.at(-1)).runs[0]!.usage!.input).toBe(1);
  });

  it("migrates v1 immediately without ever putting legacy payloads back into a checkpoint", async () => {
    const f = await settled();
    const legacy = f.manager.snapshotState();
    legacy.runs[0]!.transcript = undefined; // Earlier v1 records only had activity.
    legacy.runs[0]!.activity = [{ at: 1, text: "old activity" }];
    legacy.runs[0]!.finalText = "legacy-result-".repeat(3000);
    let latest: CompactRunState | undefined;
    const store = new FileRunStateStore(f.root, "legacy-session");
    const restored = new RunManager({ restore: store.restore(legacy), hooks: { persist: (state) => { latest = store.save(state); } } });
    restored.checkpoint();
    expect(JSON.stringify(latest)).not.toContain("legacy-result-");
    expect(restored.check(f.id).transcript).toEqual([{ kind: "status", at: 1, text: "old activity" }]);
    const again = new RunManager({ restore: new FileRunStateStore(f.root, "legacy-session").restore(latest) });
    expect((await again.wait([f.id])).entries[0]).toMatchObject({ kind: "result", result: { finalText: legacy.runs[0]!.finalText } });
  });

  it.each(["missing-descriptor", "corrupt-descriptor", "missing-chunk", "corrupt-chunk", "invalid-json", "invalid-schema"])("rejects %s explicitly instead of inventing a successful result", async (mode) => {
    const f = await settled();
    const state = structuredClone(f.entries.at(-1)!);
    const descriptorPath = blobPath(f.root, state);
    const descriptor = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
    if (mode === "missing-descriptor") fs.unlinkSync(descriptorPath);
    if (mode === "corrupt-descriptor") fs.writeFileSync(descriptorPath, "{}");
    if (mode === "missing-chunk") fs.unlinkSync(blobPath(f.root, state, descriptor.finalText));
    if (mode === "corrupt-chunk") fs.writeFileSync(blobPath(f.root, state, descriptor.finalText), '"wrong"');
    if (mode === "invalid-json" || mode === "invalid-schema") {
      const text = mode === "invalid-json" ? "{" : JSON.stringify({ ...descriptor, activity: ["../../escape"] });
      const digest = createHash("sha256").update(text).digest("hex");
      fs.writeFileSync(blobPath(f.root, state, digest), text, { mode: 0o600 });
      state.runs[0]!.artifact = digest;
    }
    expect(() => new FileRunStateStore(f.root, "session-a").restore(state)).toThrow(/Subagent state .* failed/);
  });

  it("isolates same run ids across sessions, supports inherited fork references, and preserves old branch checkpoints", async () => {
    const f = await settled();
    const old = structuredClone(f.entries.at(-1)!);
    f.manager.collectReady([f.id]);
    expect(new RunManager({ restore: f.store.restore(old) }).pendingDeliveryCount()).toBe(1);
    const other = fixture("session-b", f.root);
    other.manager.spawn({ prompt: "different", harness: other.harness });
    other.harness.last.resolve({ finalText: "other result" });
    await flush();
    expect(other.entries.at(-1)!.namespace).not.toBe(old.namespace);
    expect(new RunManager({ restore: other.store.restore(other.entries.at(-1)) }).check("run-1").resultPreview).toBe("other result");
    expect(new RunManager({ restore: f.store.restore(old) }).check("run-1").resultPreview).toBe("retained final");
    // Forks read only the explicit source namespace, then write privately.
    const forkState = other.store.save(other.store.restore(old));
    expect(forkState.namespace).toBe(other.entries.at(-1)!.namespace);
    expect(new RunManager({ restore: other.store.restore(forkState) }).check("run-1").resultPreview).toBe("retained final");
  });

  it("rejects traversal, mismatched ids, duplicate records and symlinked files/directories", async () => {
    const f = await settled();
    const state = f.entries.at(-1)!;
    for (const invalid of [
      { ...state, namespace: "../../outside" },
      { ...state, runs: [{ ...state.runs[0], artifact: "../outside" }] },
      { ...state, runs: [{ ...state.runs[0], id: "run-2" }] },
      { ...state, runs: [state.runs[0], state.runs[0]] },
    ]) expect(() => f.store.restore(invalid)).toThrow(/failed/);
    const target = blobPath(f.root, state);
    const saved = `${target}.saved`;
    fs.renameSync(target, saved);
    fs.symlinkSync(saved, target);
    expect(() => f.store.restore(state)).toThrow(/failed/);
    fs.unlinkSync(target);
    fs.renameSync(saved, target);
    const alias = path.join(temporaryStateDirectory(), "alias");
    fs.symlinkSync(f.root, alias, "dir");
    expect(() => new FileRunStateStore(alias, "session-a").restore(state)).toThrow(/failed/);
    expect(() => new FileRunStateStore(alias, "other").save(f.manager.snapshotState())).toThrow(/failed/);
    expect(fs.statSync(target).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(target)).mode & 0o777).toBe(0o700);
  });

  it("does not start a child on initial artifact write failure", () => {
    const root = temporaryStateDirectory();
    const blocked = path.join(root, "file-not-directory");
    fs.writeFileSync(blocked, "blocked");
    const f = fixture("blocked-session", blocked);
    expect(() => f.manager.spawn({ prompt: "must not start", harness: f.harness })).toThrow("persistence failed");
    expect(f.harness.runs).toHaveLength(0);
    expect(f.entries).toEqual([]);
    expect(f.manager.list()).toEqual([]);
    expect(f.errors).toHaveLength(1);
  });

  it.each(["collect", "wait", "delivery"])("rolls back failed %s commits, retries once, and retains results after reload", async (method) => {
    const f = await settled();
    f.failAppend(true);
    const consume = () => method === "collect" ? f.manager.collectReady([f.id]) : method === "wait" ? f.manager.wait([f.id]) : f.manager.drainDeliveries();
    await expect(Promise.resolve().then(consume)).rejects.toThrow("persistence failed");
    expect(f.manager.check(f.id).consumption).toBe("none");
    expect(f.manager.pendingDeliveryCount()).toBe(1);
    expect(f.errors.at(-1)!.message).not.toContain("sentinel");
    expect(new RunManager({ restore: f.store.restore(f.entries.at(-1)) }).pendingDeliveryCount()).toBe(1);
    f.failAppend(false);
    await consume();
    const again = new RunManager({ restore: f.store.restore(f.entries.at(-1)) });
    expect(again.pendingDeliveryCount()).toBe(0);
    expect((await again.wait([f.id])).newlyConsumedIds).toEqual([]);
    expect(again.check(f.id).transcript.some((entry) => entry.kind === "assistant" && entry.text === "retained transcript")).toBe(true);
  });

  it("rejects oversized chunks on both read and write without silently dropping legacy data", async () => {
    const f = await settled();
    const state = f.entries.at(-1)!;
    fs.truncateSync(blobPath(f.root, state), MAX_BLOB_BYTES + 1);
    expect(() => f.store.restore(state)).toThrow("state read failed");
    const legacy = f.manager.snapshotState();
    legacy.runs[0]!.finalText = "x".repeat(MAX_BLOB_BYTES);
    expect(() => new FileRunStateStore(f.root, "oversized-legacy").save(legacy)).toThrow("state write failed");
    expect(legacy.runs[0]!.finalText).toHaveLength(MAX_BLOB_BYTES);
  });

  it("does not start a child when the initial checkpoint append fails", () => {
    const f = fixture();
    f.failAppend(true);
    expect(() => f.manager.spawn({ prompt: "not started", harness: f.harness })).toThrow("persistence failed");
    expect(f.harness.runs).toHaveLength(0);
    expect(f.entries).toHaveLength(0);
    expect(f.manager.list()).toEqual([]);
    // Chunks written before append failure are preserved, not deleted blindly.
    expect(fs.readdirSync(f.root)).toHaveLength(1);
  });

  it("keeps concurrent waits retryable when the first consumption commit fails", async () => {
    const f = await settled();
    const id = f.id;
    let failures = 1;
    const commitStore = new FileRunStateStore(f.root, "session-a");
    const racing = new RunManager({ restore: commitStore.restore(f.entries.at(-1)), hooks: {
      persist: (state) => {
        const checkpoint = commitStore.save(state);
        if (state.runs[0]?.consumption === "waited" && failures-- > 0) throw new Error("append failed");
        f.entries.push(checkpoint);
      },
    } });
    // Two registered waits compete to consume the same restored result.
    const results = await Promise.allSettled([racing.wait([id]), racing.wait([id])]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]).toMatchObject({ status: "fulfilled", value: { newlyConsumedIds: [id] } });
    expect(racing.drainDeliveries()).toEqual([]);
    expect(new RunManager({ restore: commitStore.restore(f.entries.at(-1)) }).pendingDeliveryCount()).toBe(0);
  });

  it("does not report successful private wait results after failed settlement persistence", async () => {
    const f = fixture();
    const id = f.manager.spawn({ prompt: "private", harness: f.harness, autoDeliver: false }).id;
    f.failAppend(true);
    f.harness.last.resolve({ finalText: "private retained answer" });
    await flush();
    await expect(f.manager.wait([id])).rejects.toThrow("persistence failed");
    expect(f.manager.check(id).consumption).toBe("suppressed");
    f.failAppend(false);
    const report = await f.manager.wait([id]);
    expect(report.entries[0]).toMatchObject({ kind: "result", result: { finalText: "private retained answer" } });
    expect(report.newlyConsumedIds).toEqual([]);
    expect(f.store.restore(f.entries.at(-1)).runs[0]!.finalText).toBe("private retained answer");
  });

  it("reports background artifact write failures without unhandled rejection or successful consumption", async () => {
    const f = fixture();
    const run = f.manager.spawn({ prompt: "settlement write failure", harness: f.harness });
    const directory = path.join(f.root, f.entries.at(-1)!.namespace);
    fs.renameSync(directory, `${directory}.saved`);
    fs.writeFileSync(directory, "block writes");
    f.harness.last.resolve({ finalText: "still needed" });
    await flush();
    expect(f.errors).toHaveLength(1);
    expect(f.manager.check(run.id).status).toBe("completed");
    expect(() => f.manager.collectReady([run.id])).toThrow("persistence failed");
    expect(f.manager.check(run.id).consumption).toBe("none");
    fs.unlinkSync(directory);
    fs.renameSync(`${directory}.saved`, directory);
    expect(f.manager.collectReady([run.id]).newlyConsumedIds).toEqual([run.id]);
    expect(f.manager.drainDeliveries()).toEqual([]);
    expect(new RunManager({ restore: f.store.restore(f.entries.at(-1)) }).check(run.id).resultPreview).toBe("still needed");
  });
});
