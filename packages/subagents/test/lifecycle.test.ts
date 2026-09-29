import { describe, expect, it } from "vitest";
import { RunManager } from "../src/core/run-manager.js";
import type { SubagentHarness } from "../src/core/harness.js";
import { LifecyclePublisher, type SubagentsLifecycleEvent } from "../src/shared/lifecycle.js";

const hanging: SubagentHarness = { kind: "pi", supportsActiveMessages: false, run: () => new Promise(() => {}) };

function setup() {
  const events: SubagentsLifecycleEvent[] = [];
  const publisher = new LifecyclePublisher("session", "source", (event) => events.push(event));
  const manager = new RunManager({ hooks: { persist: (state) => publisher.update(state) } });
  return { events, publisher, manager };
}

const statuses = (events: SubagentsLifecycleEvent[]) => events.flatMap((event) => event.kind === "upsert" ? [event.run.status] : []);

describe("host lifecycle projection", () => {
  it("projects explicit profiles and thinking without changing labels or filling absent fields", () => {
    const { manager, publisher, events } = setup();
    manager.spawn({ prompt: "private", harness: hanging, agentProfile: "reviewer", model: "fake/requested", thinkingLevel: "off",
      origin: { toolCallId: "call-1", label: "Check types" } });
    manager.spawn({ prompt: "private", harness: hanging, title: "Custom agent" });
    publisher.snapshot();
    const event = events.at(-1)!;
    expect(event).toMatchObject({ v: 1, kind: "snapshot", runs: [
      { label: "Check types", agent: "reviewer", model: "fake/requested", thinking: "off" },
      { label: "Subagent run-2" },
    ] });
    if (event.kind !== "snapshot") throw new Error("Expected snapshot");
    for (const field of ["agent", "model", "thinking"]) expect(event.runs[1]).not.toHaveProperty(field);
    const restored = new RunManager({ restore: manager.snapshotState() });
    publisher.update(restored.snapshotState());
    publisher.snapshot();
    expect(events.at(-1)).toMatchObject({ runs: [
      { agent: "reviewer", model: "fake/requested", thinking: "off", status: "failed" },
      { status: "failed" },
    ] });
    expect(JSON.stringify(events)).not.toContain("private");
  });

  it("sanitizes and bounds optional profile and model display fields, including persisted values", () => {
    const { manager, publisher, events } = setup();
    manager.spawn({ prompt: "private", harness: hanging });
    const state = manager.snapshotState();
    state.runs[0]!.agentProfile = `\u001b\u0007\n${"a".repeat(140)}`;
    state.runs[0]!.requestedModel = `\u001b\u0007\t${"m".repeat(240)}`;
    publisher.update(state);
    const event = events.at(-1)!;
    if (event.kind !== "upsert") throw new Error("Expected upsert");
    expect(event.run.agent!.length).toBeLessThanOrEqual(100);
    expect(event.run.model!.length).toBeLessThanOrEqual(200);
    expect(event.run.agent).not.toMatch(/[\u0000-\u001f]/);
    expect(event.run.model).not.toMatch(/[\u0000-\u001f]/);
    const count = events.length;
    publisher.update(state);
    expect(events).toHaveLength(count);
  });

  it("reports synchronous errors without a phantom running state or diagnostics", () => {
    const { manager, events } = setup();
    manager.spawn({ prompt: "secret", harness: { ...hanging, run: () => { throw new Error("secret error"); } } });
    expect(statuses(events)).toEqual(["queued", "failed"]);
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("does not publish a phantom run for rejected spawns", () => {
    const { manager, events } = setup();
    expect(() => manager.spawn({ prompt: "", harness: hanging })).toThrow();
    expect(events).toEqual([]);
    for (let index = 0; index < 4; index++) manager.spawn({ prompt: "task", harness: hanging });
    expect(() => manager.spawn({ prompt: "over limit", harness: hanging })).toThrow();
    expect(events).toHaveLength(8);
    manager.shutdown();
  });

  it("reports rejected runs and cancellation exactly once", async () => {
    const { manager, events } = setup();
    manager.spawn({ prompt: "secret", harness: { ...hanging, run: async () => { throw new Error("secret"); } } });
    await Promise.resolve();
    expect(statuses(events)).toEqual(["queued", "running", "failed"]);
    const run = manager.spawn({ prompt: "secret", harness: hanging });
    manager.cancel([run.id]);
    manager.cancel([run.id]);
    manager.shutdown();
    expect(statuses(events).slice(3)).toEqual(["queued", "running", "cancelled"]);
  });

  it("restores origin and marks interrupted runs failed; legacy titles never escape", () => {
    const { manager } = setup();
    manager.spawn({ prompt: "private", harness: hanging, origin: { toolCallId: "call-42", label: "Review" } });
    manager.spawn({ prompt: "private legacy title", harness: hanging });
    const persisted = manager.snapshotState();
    const restored = new RunManager({ restore: persisted });
    const events: SubagentsLifecycleEvent[] = [];
    const publisher = new LifecyclePublisher("session", "new-source", (event) => events.push(event));
    publisher.update(restored.snapshotState());
    publisher.snapshot();
    expect(events.at(-1)).toMatchObject({ kind: "snapshot", sourceId: "new-source", runs: [
      { id: "run-1", toolCallId: "call-42", label: "Review", status: "failed" },
      { id: "run-2", label: "Subagent run-2", status: "failed" },
    ] });
    expect(JSON.stringify(events)).not.toContain("private");
    persisted.runs[0]!.origin!.label = "mutated";
    expect(manager.snapshotState().runs[0]!.origin!.label).toBe("Review");
  });

  it("isolates observer failures and supports detached replay without duplicate updates", () => {
    const { manager, publisher, events } = setup();
    manager.spawn({ prompt: "secret", harness: hanging });
    publisher.update(manager.snapshotState());
    expect(events).toHaveLength(2);
    publisher.snapshot();
    const snapshot = events.at(-1)!;
    if (snapshot.kind === "snapshot") snapshot.runs[0]!.label = "mutated";
    publisher.snapshot();
    expect(events.at(-1)).toMatchObject({ runs: [{ label: "Subagent run-1" }] });
    manager.shutdown();
    publisher.clear();
    expect(() => manager.spawn({ prompt: "late spawn", harness: hanging })).toThrow("shutdown");
    const count = events.length;
    publisher.update(manager.snapshotState());
    publisher.snapshot();
    publisher.clear();
    expect(events).toHaveLength(count);
    const broken = new LifecyclePublisher("s", "s", () => { throw new Error("closed pipe"); });
    expect(() => { broken.update(manager.snapshotState()); broken.snapshot(); broken.clear(); }).not.toThrow();
  });
});
