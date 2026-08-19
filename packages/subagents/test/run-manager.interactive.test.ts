import { describe, expect, it } from "vitest";

import type {
  HarnessActiveControl,
  HarnessRunRequest,
  SubagentHarness,
} from "../src/core/harness.js";
import { RunManager } from "../src/core/run-manager.js";
import { FakeHarness, flush } from "./helpers/fake-harness.js";

describe("RunManager active messaging", () => {
  it("sends a non-empty message to a supported active run and records it", async () => {
    const harness = new FakeHarness();
    const manager = new RunManager();
    const run = manager.spawn({ prompt: "start", harness });

    await manager.sendMessage(run.id, "continue with tests");

    expect(harness.last.messages).toEqual(["continue with tests"]);
    expect(manager.check(run.id).transcript.at(-1)).toMatchObject({
      kind: "user",
      text: "continue with tests",
    });
    expect(manager.check(run.id).messaging).toEqual({ supported: true, editable: true });
  });

  it("rejects empty, unknown, settled, and unsupported submissions clearly", async () => {
    const supported = new FakeHarness();
    const manager = new RunManager();
    const active = manager.spawn({ prompt: "start", harness: supported });
    await expect(manager.sendMessage(active.id, "   ")).rejects.toThrow("cannot be empty");
    await expect(manager.sendMessage("run-999", "hello")).rejects.toThrow("Unknown subagent run id");

    supported.last.resolve();
    await flush();
    await expect(manager.sendMessage(active.id, "late")).rejects.toThrow("read-only");

    const startingHarness: SubagentHarness = {
      kind: "pi",
      supportsActiveMessages: true,
      run: () => new Promise(() => undefined),
    };
    const starting = manager.spawn({ prompt: "start", harness: startingHarness });
    await expect(manager.sendMessage(starting.id, "hello")).rejects.toThrow("not ready");

    const unsupported = new FakeHarness({ supportsActiveMessages: false });
    const readOnly = manager.spawn({ prompt: "start", harness: unsupported });
    await expect(manager.sendMessage(readOnly.id, "hello")).rejects.toThrow("does not support");
    expect(manager.check(readOnly.id).messaging).toMatchObject({
      supported: false,
      editable: false,
    });
  });

  it("rejects a settlement race and disposes the control exactly once", async () => {
    let request!: HarnessRunRequest;
    let resolveSend!: () => void;
    let resolveRun!: () => void;
    let disposeCalls = 0;
    const control: HarnessActiveControl = {
      sendMessage: () => new Promise<void>((resolve) => { resolveSend = resolve; }),
      dispose: () => { disposeCalls += 1; },
    };
    const harness: SubagentHarness = {
      kind: "pi",
      supportsActiveMessages: true,
      run: (next) => {
        request = next;
        next.setActiveControl(control);
        return new Promise((resolve) => {
          resolveRun = () => resolve({ finalText: "done" });
        });
      },
    };
    const manager = new RunManager();
    const run = manager.spawn({ prompt: "start", harness });
    const pending = manager.sendMessage(run.id, "racing message");

    resolveRun();
    await flush();
    expect(manager.check(run.id).status).toBe("completed");
    resolveSend();
    await expect(pending).rejects.toThrow("settled before");
    expect(disposeCalls).toBe(1);
    expect(request.signal.aborted).toBe(false);
  });

  it("bounds transcript fields, keeps FIFO accounting, and returns detached snapshots", () => {
    const harness = new FakeHarness();
    const manager = new RunManager({
      maxTranscriptEntries: 3,
      maxTranscriptTextChars: 24,
    });
    const run = manager.spawn({ prompt: "initial prompt", harness });
    harness.last.transcript({
      kind: "tool",
      toolName: "tool-name-that-is-far-too-long",
      phase: "start",
      callId: "call-id-that-is-far-too-long",
      input: `\u001b[31m${"x".repeat(100)}`,
    });
    harness.last.transcript({ kind: "assistant", text: "a".repeat(100) });
    harness.last.transcript({ kind: "status", text: "last" });

    const first = manager.check(run.id);
    expect(first.transcript).toHaveLength(3);
    expect(first.transcriptDropped).toBe(3);
    for (const entry of first.transcript) {
      expect(JSON.stringify(entry)).not.toContain("\u001b");
      for (const value of Object.values(entry)) {
        if (typeof value === "string") expect(value.length).toBeLessThanOrEqual(24);
      }
    }
    expect(() => (first.transcript as unknown[]).push("mutated")).toThrow();
    expect(Object.isFrozen(first.transcript)).toBe(true);
    expect(Object.isFrozen(first.transcript[0])).toBe(true);
    expect(manager.check(run.id).transcript).toHaveLength(3);
  });
});
