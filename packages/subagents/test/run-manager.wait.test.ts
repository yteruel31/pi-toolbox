import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/run-manager.js";
import {
  InvalidArgumentError,
  WaitAbortedError,
} from "../src/shared/errors.js";
import type { WaitEntry } from "../src/shared/types.js";
import { FakeHarness, flush } from "./helpers/fake-harness.js";

function resultOf(entry: WaitEntry | undefined) {
  if (!entry || entry.kind !== "result") {
    throw new Error(`expected a result entry, got ${JSON.stringify(entry)}`);
  }
  return entry.result;
}

describe("wait semantics", () => {
  it("requires a non-empty ids array", async () => {
    const manager = new RunManager();
    await expect(manager.wait([])).rejects.toThrow(InvalidArgumentError);
  });

  it("waits until every referenced run settles and returns results in request order", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });
    const b = manager.spawn({ prompt: "b", harness });

    let resolved = false;
    const waiting = manager
      .wait([b.id, a.id])
      .then((report) => {
        resolved = true;
        return report;
      });

    harness.runs[0]!.resolve({ finalText: "A done" });
    await flush();
    expect(resolved).toBe(false); // b still running

    harness.runs[1]!.resolve({ finalText: "B done" });
    const report = await waiting;

    // Request order, not settlement order.
    expect(report.entries.map((e) => e.id)).toEqual([b.id, a.id]);
    expect(resultOf(report.entries[0]).finalText).toBe("B done");
    expect(resultOf(report.entries[1]).finalText).toBe("A done");
    // Settlement order is still recorded deterministically.
    expect(resultOf(report.entries[1]).settlementSeq).toBeLessThan(
      resultOf(report.entries[0]).settlementSeq,
    );
  });

  it("reports unknown ids without hiding valid results", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });
    harness.last.resolve({ finalText: "ok" });
    await flush();

    const report = await manager.wait(["ghost", a.id, "run-42"]);
    expect(report.entries[0]).toEqual({ kind: "unknown", id: "ghost" });
    expect(resultOf(report.entries[1]).finalText).toBe("ok");
    expect(report.entries[2]).toEqual({ kind: "unknown", id: "run-42" });
  });

  it("resolves immediately for already-settled runs and consumes their delivery", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });
    harness.last.resolve({ finalText: "early" });
    await flush();
    expect(manager.pendingDeliveryCount()).toBe(1);

    const report = await manager.wait([a.id]);
    expect(resultOf(report.entries[0]).finalText).toBe("early");
    // Explicitly collected: removed from the delivery queue, never auto-delivered.
    expect(manager.pendingDeliveryCount()).toBe(0);
    expect(manager.drainDeliveries()).toEqual([]);
  });

  it("handles duplicate ids in one request", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });
    harness.last.resolve({ finalText: "once" });
    await flush();

    const report = await manager.wait([a.id, a.id]);
    expect(report.entries).toHaveLength(2);
    expect(resultOf(report.entries[0]).finalText).toBe("once");
    expect(resultOf(report.entries[1]).finalText).toBe("once");
    expect(manager.pendingDeliveryCount()).toBe(0);
  });

  it("returns failed and cancelled runs as results with diagnostics", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness({ rejectOnAbort: true });
    const ok = manager.spawn({ prompt: "ok", harness });
    const bad = manager.spawn({ prompt: "bad", harness });
    const dropped = manager.spawn({ prompt: "dropped", harness });

    harness.runs[0]!.resolve({ finalText: "fine" });
    harness.runs[1]!.reject(new Error("it broke"));
    manager.cancel([dropped.id]);

    const report = await manager.wait([ok.id, bad.id, dropped.id]);
    expect(resultOf(report.entries[0]).status).toBe("completed");
    const failed = resultOf(report.entries[1]);
    expect(failed.status).toBe("failed");
    expect(failed.errorText).toContain("it broke");
    expect(resultOf(report.entries[2]).status).toBe("cancelled");
  });

  it("a second wait on an already-collected run still returns the result", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });
    harness.last.resolve({ finalText: "kept" });
    await flush();

    await manager.wait([a.id]);
    const again = await manager.wait([a.id]);
    expect(resultOf(again.entries[0]).finalText).toBe("kept");
  });

  it("an aborted wait consumes nothing and re-queues settled results for delivery", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });
    const b = manager.spawn({ prompt: "b", harness });

    const abort = new AbortController();
    const waiting = manager.wait([a.id, b.id], { signal: abort.signal });

    // a settles while the wait is pending: reserved, so not queued yet.
    harness.runs[0]!.resolve({ finalText: "A partial world" });
    await flush();
    expect(manager.pendingDeliveryCount()).toBe(0);

    abort.abort();
    await expect(waiting).rejects.toThrow(WaitAbortedError);

    // a's result was not consumed: it goes back to auto-delivery.
    expect(manager.pendingDeliveryCount()).toBe(1);
    const delivered = manager.drainDeliveries();
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.id).toBe(a.id);

    // b is untouched and still running.
    expect(manager.check(b.id).status).toBe("running");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });
    const abort = new AbortController();
    abort.abort();
    await expect(
      manager.wait([a.id], { signal: abort.signal }),
    ).rejects.toThrow(WaitAbortedError);
  });

  it("two concurrent waits on the same run both resolve; consumption happens once", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });

    const w1 = manager.wait([a.id]);
    const w2 = manager.wait([a.id]);
    harness.last.resolve({ finalText: "shared" });

    const [r1, r2] = await Promise.all([w1, w2]);
    expect(resultOf(r1.entries[0]).finalText).toBe("shared");
    expect(resultOf(r2.entries[0]).finalText).toBe("shared");
    expect(manager.pendingDeliveryCount()).toBe(0);
    expect(manager.snapshotState().runs[0]!.consumption).toBe("waited");
  });
});
