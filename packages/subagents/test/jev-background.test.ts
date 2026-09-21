import { describe, expect, it, vi } from "vitest";
import { createJevBackgroundHarness } from "../src/agents/jev-background.js";
import type { SubagentHarness } from "../src/core/harness.js";

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

  it("uses categorical warnings without leaking catalogue or routing errors", async () => {
    const progress: string[] = [];
    const harness = createJevBackgroundHarness({ task: "task", route, resolutionInput, piModels: [], loadClaudeModels: async () => { throw new Error("SECRET catalog payload"); }, resolveApiKey: async () => "secret", routeJev: async () => { throw new Error("SECRET SDK payload"); }, harnesses: { pi: backend("pi", []), claude: backend("claude", []) } });
    const req = request(new AbortController().signal);
    req.reportProgress = (text: string) => { progress.push(text); };
    await harness.run(req);
    expect(progress.join(" ")).not.toContain("SECRET");
    expect(progress.join(" ")).toContain("Routing warning");
  });
});
