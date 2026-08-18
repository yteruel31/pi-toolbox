import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/run-manager.js";
import {
  ConcurrencyLimitError,
  InvalidArgumentError,
  UnknownRunError,
} from "../src/shared/errors.js";
import { FakeHarness, ManualClock, flush } from "./helpers/fake-harness.js";

describe("run lifecycle", () => {
  it("assigns stable session-local ids in creation order", () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "task a", harness });
    const b = manager.spawn({ prompt: "task b", harness });
    const c = manager.spawn({ prompt: "task c", harness });
    expect([a.id, b.id, c.id]).toEqual(["run-1", "run-2", "run-3"]);
    expect(manager.list().map((r) => r.id)).toEqual(["run-1", "run-2", "run-3"]);
  });

  it("rejects an empty prompt immediately", () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    expect(() => manager.spawn({ prompt: "", harness })).toThrow(
      InvalidArgumentError,
    );
    expect(() => manager.spawn({ prompt: "   \n ", harness })).toThrow(
      InvalidArgumentError,
    );
    expect(manager.list()).toHaveLength(0);
  });

  it("moves through running to completed with timestamps and settlement order", async () => {
    const clock = new ManualClock();
    const manager = new RunManager({ clock: clock.now });
    const harness = new FakeHarness();
    const snap = manager.spawn({ prompt: "do things", harness });
    expect(snap.status).toBe("running");
    expect(snap.createdAt).toBe(1_000);

    clock.advance(500);
    harness.last.resolve({ finalText: "all done", effectiveModel: "m-1" });
    await flush();

    const after = manager.snapshot(snap.id);
    expect(after.status).toBe("completed");
    expect(after.settledAt).toBe(1_500);
    expect(after.settlementSeq).toBe(1);
    expect(after.effectiveModel).toBe("m-1");
  });

  it("marks a rejecting harness run as failed with bounded diagnostics", async () => {
    const manager = new RunManager({ maxErrorTextChars: 40 });
    const harness = new FakeHarness();
    const snap = manager.spawn({ prompt: "explode", harness });
    harness.last.reject(new Error("x".repeat(500)));
    await flush();

    const inspection = manager.check(snap.id);
    expect(inspection.status).toBe("failed");
    expect(inspection.resultPreview).toContain("failed:");
    const state = manager.snapshotState();
    expect(state.runs[0]!.errorText!.length).toBeLessThanOrEqual(40);
  });

  it("settles a synchronously-throwing harness as failed without crashing", () => {
    const manager = new RunManager();
    const harness = new FakeHarness({ throwOnRun: new Error("boom at start") });
    const snap = manager.spawn({ prompt: "task", harness });
    expect(manager.check(snap.id).status).toBe("failed");
    expect(manager.activeCount()).toBe(0);
  });

  it("never leaks an unhandled rejection from an unobserved background run", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const manager = new RunManager();
      const harness = new FakeHarness();
      manager.spawn({ prompt: "will fail, nobody waits", harness });
      harness.last.reject(new Error("silent failure"));
      await flush();
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("keeps run records after settlement and reports elapsed time from the clock", async () => {
    const clock = new ManualClock();
    const manager = new RunManager({ clock: clock.now });
    const harness = new FakeHarness();
    const snap = manager.spawn({ prompt: "quick", harness });
    clock.advance(250);
    harness.last.resolve();
    await flush();
    clock.advance(10_000);

    const [entry] = manager.list();
    expect(entry!.id).toBe(snap.id);
    expect(entry!.status).toBe("completed");
    // Elapsed freezes at settlement.
    expect(entry!.elapsedMs).toBe(250);
  });

  it("derives a bounded title from the prompt when no name is given", () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const snap = manager.spawn({
      prompt: `first line ${"y".repeat(200)}\nsecond line`,
      harness,
    });
    expect(snap.title.length).toBeLessThanOrEqual(60);
    expect(snap.title.startsWith("first line")).toBe(true);
  });

  it("throws UnknownRunError from check on an unknown id", () => {
    const manager = new RunManager();
    expect(() => manager.check("run-99")).toThrow(UnknownRunError);
  });

  it("shutdown settles every active run as cancelled exactly once, idempotently", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const a = manager.spawn({ prompt: "a", harness });
    const b = manager.spawn({ prompt: "b", harness });
    harness.runs[0]!.resolve({ finalText: "finished before shutdown" });
    await flush();

    manager.shutdown("session reload");
    manager.shutdown("session reload"); // idempotent
    expect(manager.check(a.id).status).toBe("completed");
    const bCheck = manager.check(b.id);
    expect(bCheck.status).toBe("cancelled");
    expect(bCheck.resultPreview).toContain("interrupted");
    expect(harness.runs[1]!.aborted).toBe(true);

    // Late harness rejection after shutdown must not re-settle or throw.
    harness.runs[1]!.reject(new Error("late"));
    await flush();
    expect(manager.check(b.id).status).toBe("cancelled");
  });
});

describe("global concurrency cap", () => {
  it("caps active runs at 4 across harnesses and /btw, failing fast beyond it", async () => {
    const manager = new RunManager();
    const pi = new FakeHarness({ kind: "pi" });
    const claude = new FakeHarness({ kind: "claude" });

    manager.spawn({ prompt: "one", harness: pi });
    manager.spawn({ prompt: "two", harness: claude });
    manager.spawn({ prompt: "three", harness: pi });
    // A /btw-style suppressed run still occupies a slot.
    manager.spawn({ prompt: "side question", harness: pi, autoDeliver: false });

    expect(manager.activeCount()).toBe(4);
    expect(() => manager.spawn({ prompt: "five", harness: pi })).toThrow(
      ConcurrencyLimitError,
    );

    pi.runs[0]!.resolve();
    await flush();
    expect(manager.activeCount()).toBe(3);
    const five = manager.spawn({ prompt: "five", harness: pi });
    expect(five.id).toBe("run-5");
  });

  it("keeps the concurrency error bounded and mentions the limit", () => {
    const manager = new RunManager({ maxActiveRuns: 1 });
    const harness = new FakeHarness();
    manager.spawn({ prompt: "only one", harness });
    let caught: unknown;
    try {
      manager.spawn({ prompt: "too many", harness });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConcurrencyLimitError);
    const message = (caught as Error).message;
    expect(message).toContain("1");
    expect(message.length).toBeLessThanOrEqual(500);
  });

  it("settled runs never count against the cap", async () => {
    const manager = new RunManager({ maxActiveRuns: 2 });
    const harness = new FakeHarness();
    for (let i = 0; i < 5; i++) {
      manager.spawn({ prompt: `task ${i}`, harness });
      harness.last.resolve();
      await flush();
    }
    expect(manager.list()).toHaveLength(5);
    expect(manager.activeCount()).toBe(0);
  });
});
