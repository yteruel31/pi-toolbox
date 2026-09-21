import { describe, expect, it, vi } from "vitest";
import { createJevBackgroundHarness } from "../src/agents/jev-background.js";
import type { HarnessActiveControl, SubagentHarness } from "../src/core/harness.js";
import { RunManager } from "../src/core/run-manager.js";

const route = { harness: "pi" as const, model: undefined, thinking: undefined, provenance: { harness: "parent" as const, model: "parent" as const, thinking: "parent" as const } };
const resolutionInput = { explicit: {}, parent: { model: undefined, thinking: undefined } };
const outcome = { finalText: "done" };

function backend(kind: "pi" | "claude", started: string[]): SubagentHarness {
  return { kind, supportsActiveMessages: true, async run() { started.push(kind); return outcome; } };
}
function request(signal: AbortSignal): Parameters<SubagentHarness["run"]>[0] {
  return {
    runId: "run-1", prompt: "task", systemPrompt: "private", tools: ["read"], workingDir: "/tmp",
    model: undefined, thinkingLevel: undefined, signal, reportProgress() {}, reportTranscript() {},
    reportEffectiveModel() {}, reportRouting: () => true, setActiveControl: () => true,
  };
}

describe("Jev background harness", () => {
  it("defers routing and forwards only task, role, tools, and raw resolution input", async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const routeJev = vi.fn(async (input) => { await gate; return { route: { ...route, model: "openai/model", provenance: { ...route.provenance, model: "jev" as const } }, used: true }; });
    const harness = createJevBackgroundHarness({ task: "task", route, resolutionInput, piModels: [], loadClaudeModels: async () => [], resolveApiKey: async () => "secret", routeJev, harnesses: { pi: backend("pi", started), claude: backend("claude", started) } });
    const controller = new AbortController();
    const pending = harness.run(request(controller.signal));
    expect(routeJev).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(routeJev).toHaveBeenCalledWith(expect.objectContaining({ task: "task", resolutionInput, tools: undefined }));
    expect(routeJev.mock.calls[0]![0]).not.toHaveProperty("systemPrompt");
    release();
    await expect(pending).resolves.toEqual(outcome);
    expect(started).toEqual(["pi"]);
  });

  it("never starts a backend after cancellation during routing, including late success", async () => {
    const started: string[] = [];
    let release!: () => void;
    const routeJev = vi.fn(() => new Promise<any>((resolve) => { release = () => resolve({ route, used: false }); }));
    const harness = createJevBackgroundHarness({ task: "task", route, resolutionInput, piModels: [], loadClaudeModels: async () => [], resolveApiKey: async () => "secret", routeJev, harnesses: { pi: backend("pi", started), claude: backend("claude", started) } });
    const controller = new AbortController();
    const pending = harness.run(request(controller.signal));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toEqual([]);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(started).toEqual([]);
  });

  it("skips Claude discovery for a fixed Pi route and resolves credentials lazily", async () => {
    const started: string[] = [];
    const loadClaudeModels = vi.fn(async () => { throw new Error("should not run"); });
    const resolveApiKey = vi.fn(async () => "secret");
    const fixed = { ...route, model: "openai/model", thinking: "low" as const, provenance: { harness: "explicit" as const, model: "explicit" as const, thinking: "explicit" as const } };
    const routeJev = vi.fn(async (input) => ({ route: fixed, used: false }));
    const harness = createJevBackgroundHarness({ task: "task", route: fixed, resolutionInput: { explicit: { harness: "pi", model: "openai/model", thinking: "low" }, parent: { model: undefined, thinking: undefined } }, piModels: [], loadClaudeModels, resolveApiKey, routeJev, harnesses: { pi: backend("pi", started), claude: backend("claude", started) } });
    await expect(harness.run(request(new AbortController().signal))).resolves.toEqual(outcome);
    expect(loadClaudeModels).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
    expect(started).toEqual(["pi"]);
  });

  it("keeps messaging read-only while routing and forwards active control after resolution", async () => {
    let release!: () => void;
    let resolveRun!: () => void;
    let disposeCalls = 0;
    const messages: string[] = [];
    const control: HarnessActiveControl = {
      async sendMessage(text) { messages.push(text); },
      dispose() { disposeCalls += 1; },
    };
    const actual: SubagentHarness = {
      kind: "pi", supportsActiveMessages: true,
      run(request) {
        request.setActiveControl(control);
        return new Promise((resolve) => { resolveRun = () => resolve(outcome); });
      },
    };
    const harness = createJevBackgroundHarness({
      task: "task", route, resolutionInput, piModels: [], loadClaudeModels: async () => [], resolveApiKey: async () => "secret",
      routeJev: () => new Promise((resolve) => { release = () => resolve({ route, used: false }); }),
      harnesses: { pi: actual, claude: backend("claude", []) },
    });
    const manager = new RunManager();
    const run = manager.spawn({ prompt: "task", harness, routing: { state: "pending" } });
    expect(manager.check(run.id).messaging).toMatchObject({ supported: true, editable: false });
    await new Promise((resolve) => setImmediate(resolve));
    release(); await new Promise((resolve) => setImmediate(resolve));
    expect(manager.check(run.id).messaging).toEqual({ supported: true, editable: true });
    await manager.sendMessage(run.id, "continue");
    expect(messages).toEqual(["continue"]);
    manager.cancel([run.id]); resolveRun(); await new Promise((resolve) => setImmediate(resolve));
    expect(disposeCalls).toBe(1);
  });

  it("records pending and complete resolved diagnostics without leaking fallback errors", async () => {
    const transcript: string[] = [];
    const resolved = { harness: "pi" as const, model: "openai/model", thinking: "high" as const, provenance: { harness: "explicit" as const, model: "jev" as const, thinking: "saved-user" as const } };
    const harness = createJevBackgroundHarness({ task: "task", route, resolutionInput, piModels: [], loadClaudeModels: async () => [], resolveApiKey: async () => "secret", routeJev: async () => ({ route: resolved, used: true }), harnesses: { pi: backend("pi", []), claude: backend("claude", []) } });
    const req = request(new AbortController().signal);
    req.reportTranscript = (entry) => { if (entry.kind === "status") transcript.push(entry.text); };
    await harness.run(req);
    expect(transcript[0]).toBe("Routing pending.");
    expect(transcript.join(" ")).toContain("backend=pi (explicit)");
    expect(transcript.join(" ")).toContain("model=openai/model (jev)");
    expect(transcript.join(" ")).toContain("thinking=high (saved-user)");
  });

  it("uses categorical warnings without leaking catalogue or routing errors", async () => {
    const progress: string[] = [];
    const harness = createJevBackgroundHarness({ task: "task", route, resolutionInput, piModels: [], loadClaudeModels: async () => { throw new Error("SECRET catalog payload"); }, resolveApiKey: async () => "secret", routeJev: async () => { throw new Error("SECRET SDK payload"); }, harnesses: { pi: backend("pi", []), claude: backend("claude", []) } });
    const req = request(new AbortController().signal);
    req.reportProgress = (text: string) => { progress.push(text); };
    await harness.run(req);
    expect(progress.join(" ")).not.toContain("SECRET");
    expect(progress.join(" ")).toContain("Routing warning");
  });

  it("observes a supplied late rejection when already aborted", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      const controller = new AbortController(); controller.abort();
      const harness = createJevBackgroundHarness({ task: "task", route, resolutionInput, piModels: [], loadClaudeModels: async () => [], resolveApiKey: async () => "secret", routeJev: async () => ({ route, used: false }), harnesses: { pi: backend("pi", []), claude: backend("claude", []) } });
      await expect(harness.run(request(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally { process.off("unhandledRejection", listener); }
  });
});
