import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/run-manager.js";
import { InvalidArgumentError } from "../src/shared/errors.js";
import { FakeHarness, flush } from "./helpers/fake-harness.js";

function result(entry: ReturnType<RunManager["collectReady"]>["entries"][number]) {
  if (entry.kind !== "result") throw new Error(`expected result, got ${entry.kind}`);
  return entry.result;
}

describe("non-blocking result collection", () => {
  it("returns ready, pending, and unknown entries in request order without touching active runs", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const ready = manager.spawn({ prompt: "ready", harness });
    const active = manager.spawn({ prompt: "active", harness });
    harness.runs[0]!.resolve({ finalText: "done" });
    await flush();

    const report = manager.collectReady([active.id, "missing", ready.id, active.id]);
    expect(report.entries).toEqual([
      { kind: "pending", id: active.id, status: "running" },
      { kind: "unknown", id: "missing" },
      expect.objectContaining({ kind: "result", id: ready.id }),
      { kind: "pending", id: active.id, status: "running" },
    ]);
    expect(report.newlyConsumedIds).toEqual([ready.id]);
    expect(manager.check(active.id).status).toBe("running");
    expect(manager.pendingDeliveryCount()).toBe(0);
  });

  it("preserves duplicate result entries but consumes and accounts for a run once", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const run = manager.spawn({ prompt: "one", harness });
    harness.last.resolve({ finalText: "one result" });
    await flush();

    const first = manager.collectReady([run.id, run.id]);
    expect(first.entries.map(result).map((entry) => entry.finalText)).toEqual(["one result", "one result"]);
    expect(first.newlyConsumedIds).toEqual([run.id]);
    expect(manager.collectReady([run.id]).newlyConsumedIds).toEqual([]);
    expect(manager.snapshotState().runs[0]!.consumption).toBe("waited");
  });

  it("collects failures, cancellations, and suppressed side results without auto-delivery", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness({ rejectOnAbort: true });
    const failed = manager.spawn({ prompt: "bad", harness });
    const cancelled = manager.spawn({ prompt: "cancel", harness });
    const suppressed = manager.spawn({ prompt: "private", harness, autoDeliver: false });
    harness.runs[0]!.reject(new Error("bad result"));
    manager.cancel([cancelled.id]);
    harness.runs[2]!.resolve({ finalText: "private result" });
    await flush();

    const report = manager.collectReady([failed.id, cancelled.id, suppressed.id]);
    expect(report.entries.map(result).map((entry) => entry.status)).toEqual(["failed", "cancelled", "completed"]);
    expect(report.newlyConsumedIds).toEqual([failed.id, cancelled.id]);
    expect(manager.check(suppressed.id).consumption).toBe("suppressed");
    expect(manager.pendingDeliveryCount()).toBe(0);
  });

  it("does not steal a terminal result reserved by wait, then permits rereading it", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const run = manager.spawn({ prompt: "reserved", harness });
    const blocker = manager.spawn({ prompt: "still waiting", harness });
    const waiting = manager.wait([run.id, blocker.id]);
    harness.runs[0]!.resolve({ finalText: "owned by wait" });
    await flush();

    expect(manager.collectReady([run.id]).entries).toEqual([
      { kind: "reserved", id: run.id, status: "completed" },
    ]);
    harness.runs[1]!.resolve({ finalText: "wait done" });
    await waiting;
    const reread = manager.collectReady([run.id]);
    expect(result(reread.entries[0]!).finalText).toBe("owned by wait");
    expect(reread.newlyConsumedIds).toEqual([]);
  });

  it("can collect after an aborted wait releases its reservation", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const ready = manager.spawn({ prompt: "ready", harness });
    const blocker = manager.spawn({ prompt: "blocker", harness });
    const abort = new AbortController();
    const waiting = manager.wait([ready.id, blocker.id], { signal: abort.signal });
    harness.runs[0]!.resolve({ finalText: "released" });
    await flush();
    abort.abort();
    await expect(waiting).rejects.toThrow();

    const collected = manager.collectReady([ready.id]);
    expect(result(collected.entries[0]!).finalText).toBe("released");
    expect(collected.newlyConsumedIds).toEqual([ready.id]);
    expect(manager.check(blocker.id).status).toBe("running");
  });

  it("keeps collection semantics after persistence restore and validates ids", async () => {
    let state: ReturnType<RunManager["snapshotState"]> | undefined;
    const manager = new RunManager({ hooks: { persist: (next) => { state = structuredClone(next); } } });
    const harness = new FakeHarness();
    const run = manager.spawn({ prompt: "persist", harness });
    harness.last.resolve({ finalText: "restored" });
    await flush();
    const restored = new RunManager({ restore: state! });

    expect(result(restored.collectReady([run.id]).entries[0]!).finalText).toBe("restored");
    expect(() => manager.collectReady([])).toThrow(InvalidArgumentError);
  });
});
