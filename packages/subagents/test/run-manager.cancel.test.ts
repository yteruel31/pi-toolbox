import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/run-manager.js";
import { InvalidArgumentError } from "../src/shared/errors.js";
import { FakeHarness, flush } from "./helpers/fake-harness.js";

describe("cancellation", () => {
  it("requires a non-empty ids array", () => {
    const manager = new RunManager();
    expect(() => manager.cancel([])).toThrow(InvalidArgumentError);
  });

  it("aborts an active run and settles it cancelled when the harness rejects on abort", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness({ rejectOnAbort: true });
    const snap = manager.spawn({ prompt: "long task", harness });

    const report = manager.cancel([snap.id]);
    expect(report.entries).toEqual([
      { id: snap.id, outcome: "cancel-requested" },
    ]);
    expect(harness.last.aborted).toBe(true);
    await flush();

    const check = manager.check(snap.id);
    expect(check.status).toBe("cancelled");
    expect(check.cancelRequested).toBe(true);
  });

  it("settles cancelled with partial output preserved when the harness resolves after cancel", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness(); // does not auto-reject on abort
    const snap = manager.spawn({ prompt: "racy", harness });

    manager.cancel([snap.id]);
    // Race: the harness finishes anyway and hands back what it produced.
    harness.last.resolve({ finalText: "partial results so far" });
    await flush();

    const check = manager.check(snap.id);
    expect(check.status).toBe("cancelled");
    const state = manager.snapshotState();
    expect(state.runs[0]!.finalText).toBe("partial results so far");
    expect(state.runs[0]!.errorText).toContain("cancelled");
  });

  it("wins the completion/cancellation race in settlement order: first settle sticks", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const snap = manager.spawn({ prompt: "fast", harness });

    harness.last.resolve({ finalText: "completed first" });
    await flush();
    // Cancel arrives after completion: idempotent no-op.
    const report = manager.cancel([snap.id]);
    expect(report.entries[0]).toEqual({
      id: snap.id,
      outcome: "already-settled",
      status: "completed",
    });
    expect(manager.check(snap.id).status).toBe("completed");
  });

  it("is idempotent for repeated cancels of the same active run", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness({ rejectOnAbort: true });
    const snap = manager.spawn({ prompt: "task", harness });

    manager.cancel([snap.id]);
    const second = manager.cancel([snap.id]);
    await flush();
    // Second call while settling is still shaped as a request or settled;
    // either way it must not throw and the run settles exactly once.
    expect(second.entries).toHaveLength(1);
    expect(manager.check(snap.id).status).toBe("cancelled");
    expect(manager.check(snap.id).settledAt).toBeDefined();
  });

  it("reports unknown ids without hiding valid ones and preserves records", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness({ rejectOnAbort: true });
    const snap = manager.spawn({ prompt: "task", harness });

    const report = manager.cancel(["nope", snap.id]);
    expect(report.entries[0]).toEqual({ id: "nope", outcome: "unknown" });
    expect(report.entries[1]).toEqual({
      id: snap.id,
      outcome: "cancel-requested",
    });
    await flush();
    // Cancel never deletes run records.
    expect(manager.list().map((r) => r.id)).toEqual([snap.id]);
  });

  it("preserves partial diagnostics captured before cancellation", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness({ rejectOnAbort: true });
    const snap = manager.spawn({ prompt: "task", harness });
    harness.last.progress("step 1: scanned files");
    harness.last.progress("step 2: found candidates");

    manager.cancel([snap.id]);
    await flush();

    const check = manager.check(snap.id);
    expect(check.status).toBe("cancelled");
    expect(check.activity.map((a) => a.text)).toEqual([
      "step 1: scanned files",
      "step 2: found candidates",
    ]);
  });
});
