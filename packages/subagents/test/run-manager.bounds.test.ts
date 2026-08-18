import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/run-manager.js";
import { FakeHarness, flush } from "./helpers/fake-harness.js";

describe("bounded activity and outputs", () => {
  it("keeps only the most recent activity entries and counts drops", () => {
    const manager = new RunManager({ maxActivityEntries: 3 });
    const harness = new FakeHarness();
    const snap = manager.spawn({ prompt: "busy", harness });
    for (let i = 1; i <= 10; i++) harness.last.progress(`step ${i}`);

    const check = manager.check(snap.id);
    expect(check.activity.map((a) => a.text)).toEqual([
      "step 8",
      "step 9",
      "step 10",
    ]);
    expect(check.activityDropped).toBe(7);
  });

  it("bounds each activity entry's text", () => {
    const manager = new RunManager({ maxActivityTextChars: 50 });
    const harness = new FakeHarness();
    const snap = manager.spawn({ prompt: "busy", harness });
    harness.last.progress("z".repeat(5_000));

    const [entry] = manager.check(snap.id).activity;
    expect(entry!.text.length).toBeLessThanOrEqual(50);
    expect(entry!.text).toContain("truncated");
  });

  it("ignores progress reported after settlement", async () => {
    const manager = new RunManager();
    const harness = new FakeHarness();
    const snap = manager.spawn({ prompt: "task", harness });
    harness.last.progress("before");
    harness.last.resolve();
    await flush();
    harness.last.progress("after settle");

    expect(manager.check(snap.id).activity.map((a) => a.text)).toEqual([
      "before",
    ]);
  });

  it("bounds retained final text", async () => {
    const manager = new RunManager({ maxResultTextChars: 100 });
    const harness = new FakeHarness();
    const snap = manager.spawn({ prompt: "verbose", harness });
    harness.last.resolve({ finalText: "x".repeat(10_000) });
    await flush();

    const [result] = manager.drainDeliveries();
    expect(result!.id).toBe(snap.id);
    expect(result!.finalText.length).toBeLessThanOrEqual(100);
    expect(result!.finalText).toContain("truncated");
  });

  it("bounds the check() result preview independently of retained text", async () => {
    const manager = new RunManager({ maxResultPreviewChars: 80 });
    const harness = new FakeHarness();
    const snap = manager.spawn({ prompt: "verbose", harness });
    harness.last.resolve({ finalText: "y".repeat(3_000) });
    await flush();

    const check = manager.check(snap.id);
    expect(check.resultPreview!.length).toBeLessThanOrEqual(80);
    // check never consumes: still deliverable afterwards.
    expect(manager.pendingDeliveryCount()).toBe(1);
  });

  it("bounds error diagnostics and the effective model string", async () => {
    const manager = new RunManager({ maxErrorTextChars: 60 });
    const harness = new FakeHarness();
    const snap = manager.spawn({ prompt: "task", harness });
    harness.last.request.reportEffectiveModel("m/".repeat(500));
    harness.last.reject(new Error("e".repeat(5_000)));
    await flush();

    const record = manager.snapshotState().runs[0]!;
    expect(record.id).toBe(snap.id);
    expect(record.errorText!.length).toBeLessThanOrEqual(60);
    expect(record.effectiveModel!.length).toBeLessThanOrEqual(200);
  });
});
