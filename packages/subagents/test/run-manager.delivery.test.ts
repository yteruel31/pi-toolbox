import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/run-manager.js";
import type { PersistedRunState } from "../src/shared/types.js";
import { FakeHarness, flush } from "./helpers/fake-harness.js";

describe("result delivery and de-duplication", () => {
  it("queues settled unconsumed results and signals the delivery hook", async () => {
    const signals: number[] = [];
    const manager = new RunManager({
      hooks: { onDeliverableResults: (n) => signals.push(n) },
    });
    const harness = new FakeHarness();
    manager.spawn({ prompt: "a", harness });
    harness.last.resolve({ finalText: "A" });
    await flush();

    expect(signals).toEqual([1]);
    expect(manager.pendingDeliveryCount()).toBe(1);
  });

  it("drains in settlement order, not creation order, and delivers exactly once", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });
    const b = manager.spawn({ prompt: "b", harness });
    const c = manager.spawn({ prompt: "c", harness });

    // Settle out of creation order: b, c, a.
    harness.runs[1]!.resolve({ finalText: "B" });
    await flush();
    harness.runs[2]!.resolve({ finalText: "C" });
    await flush();
    harness.runs[0]!.resolve({ finalText: "A" });
    await flush();

    const delivered = manager.drainDeliveries();
    expect(delivered.map((r) => r.id)).toEqual([b.id, c.id, a.id]);
    expect(delivered.map((r) => r.settlementSeq)).toEqual([1, 2, 3]);

    // Exactly once: nothing left, consumption recorded.
    expect(manager.drainDeliveries()).toEqual([]);
    expect(
      manager.snapshotState().runs.map((r) => r.consumption),
    ).toEqual(["delivered", "delivered", "delivered"]);
  });

  it("delivers failed and cancelled runs with concise diagnostics instead of dropping them", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness({ rejectOnAbort: true });
    const bad = manager.spawn({ prompt: "bad", harness });
    const dropped = manager.spawn({ prompt: "dropped", harness });
    harness.runs[0]!.reject(new Error("dependency exploded"));
    manager.cancel([dropped.id]);
    await flush();

    const delivered = manager.drainDeliveries();
    expect(delivered.map((r) => r.id)).toEqual([bad.id, dropped.id]);
    expect(delivered[0]!.status).toBe("failed");
    expect(delivered[0]!.errorText).toContain("dependency exploded");
    expect(delivered[1]!.status).toBe("cancelled");
    expect(delivered[1]!.errorText).toBeTruthy();
  });

  it("a result collected by wait while queued is removed from the queue", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });
    const b = manager.spawn({ prompt: "b", harness });
    harness.runs[0]!.resolve({ finalText: "A" });
    harness.runs[1]!.resolve({ finalText: "B" });
    await flush();
    expect(manager.pendingDeliveryCount()).toBe(2);

    await manager.wait([a.id]);

    const delivered = manager.drainDeliveries();
    expect(delivered.map((r) => r.id)).toEqual([b.id]);
  });

  it("suppressed runs (/btw) never enter the delivery queue", async () => {
    const signals: number[] = [];
    const manager = new RunManager({
      hooks: { onDeliverableResults: (n) => signals.push(n) },
    });
    const harness = new FakeHarness();
    const side = manager.spawn({
      prompt: "side question",
      harness,
      autoDeliver: false,
    });
    harness.last.resolve({ finalText: "side answer" });
    await flush();

    expect(signals).toEqual([]);
    expect(manager.pendingDeliveryCount()).toBe(0);
    expect(manager.check(side.id).consumption).toBe("suppressed");
    // The answer is still readable through wait/check for the human surface.
    const report = await manager.wait([side.id]);
    expect(report.entries[0]!.kind).toBe("result");
  });

  it("calls the persistence hook on lifecycle mutations with serializable state", async () => {
    const states: PersistedRunState[] = [];
    const manager = new RunManager({
      hooks: { persist: (s) => states.push(structuredClone(s)) },
    });
    const harness = new FakeHarness();
    manager.spawn({
      prompt: "a",
      title: "Custom review title",
      agentProfile: "unit-implementer",
      harness,
    });
    harness.last.resolve({ finalText: "A" });
    await flush();
    manager.drainDeliveries();

    expect(states.length).toBeGreaterThanOrEqual(3); // spawn, settle, drain
    const last = states[states.length - 1]!;
    expect(last.version).toBe(1);
    expect(last.runs[0]!.consumption).toBe("delivered");
    expect(last.runs[0]!.title).toBe("Custom review title");
    expect(last.runs[0]!.agentProfile).toBe("unit-implementer");
    // Must round-trip through JSON for custom session entries.
    expect(() => JSON.stringify(last)).not.toThrow();
  });
});

describe("restore across session reloads", () => {
  async function buildPersistedState(): Promise<PersistedRunState> {
    let latest: PersistedRunState | undefined;
    const manager = new RunManager({
      hooks: { persist: (s) => (latest = structuredClone(s)) },
    });
    const harness = new FakeHarness();
    // run-1: settled and already delivered before the reload.
    manager.spawn({ prompt: "delivered before reload", harness });
    // run-2: settled but not yet delivered.
    manager.spawn({ prompt: "settled, pending delivery", harness });
    // run-3: still running when the session dies.
    manager.spawn({ prompt: "in flight", harness });
    harness.runs[0]!.resolve({ finalText: "one" });
    harness.runs[1]!.resolve({ finalText: "two" });
    await flush();
    // Only run-1 gets delivered: simulate by consuming it via wait.
    await manager.wait(["run-1"]);
    return latest!;
  }

  it("normalizes restored profile metadata and accepts legacy records without it", async () => {
    const state = await buildPersistedState();
    state.runs[0]!.agentProfile = "  unit\u001b[31m\n implementer  ";
    state.runs[1]!.agentProfile = " \n\t ";
    state.runs[2]!.agentProfile = "p".repeat(500);
    const legacyRecord = state.runs[1]!;
    delete legacyRecord.agentProfile;

    const legacyRestored = new RunManager({ restore: state });
    expect(legacyRestored.snapshot("run-2").agentProfile).toBeUndefined();

    state.runs[1]!.agentProfile = " \n\t ";
    const restored = new RunManager({ restore: state });
    expect(restored.snapshot("run-1").agentProfile).toBe("unit[31m implementer");
    expect(restored.list()[0]!.agentProfile).toBe("unit[31m implementer");
    expect(restored.check("run-1").agentProfile).toBe("unit[31m implementer");
    expect(restored.snapshot("run-2").agentProfile).toBeUndefined();
    expect(restored.snapshot("run-3").agentProfile!.length).toBeLessThanOrEqual(60);
  });

  it("does not re-deliver consumed results, re-queues owed ones, fails interrupted ones", async () => {
    const state = await buildPersistedState();
    const restored = new RunManager({ restore: state });

    // Interrupted active run becomes an explicit failed record.
    const check3 = restored.check("run-3");
    expect(check3.status).toBe("failed");
    expect(check3.resultPreview).toContain("restarted");

    // Delivery queue: run-2 (owed) + run-3 (interrupted), never run-1.
    const delivered = restored.drainDeliveries();
    expect(delivered.map((r) => r.id)).toEqual(["run-2", "run-3"]);

    // Records and creation order survive.
    expect(restored.list().map((r) => r.id)).toEqual([
      "run-1",
      "run-2",
      "run-3",
    ]);
  });

  it("keeps ids stable: new spawns continue the serial sequence", async () => {
    const state = await buildPersistedState();
    const restored = new RunManager({ restore: state });
    const harness = new FakeHarness();
    const fresh = restored.spawn({ prompt: "post-reload", harness });
    expect(fresh.id).toBe("run-4");
  });

  it("keeps settlement ordering deterministic across the reload boundary", async () => {
    const state = await buildPersistedState();
    const restored = new RunManager({ restore: state });
    const harness = new FakeHarness();
    const fresh = restored.spawn({ prompt: "post-reload", harness });
    harness.last.resolve({ finalText: "new" });
    await flush();
    const seqs = restored
      .snapshotState()
      .runs.map((r) => r.settlementSeq);
    // All defined and strictly increasing in settlement order; the fresh run
    // settled last.
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(restored.snapshot(fresh.id).settlementSeq).toBe(
      Math.max(...(seqs as number[])),
    );
  });
});
