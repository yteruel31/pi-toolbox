import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { buildJevCandidates, deriveJevConstraints, JEV_MAX_CHOICES, JevRoutingConflictError, routeWithJev } from "../src/agents/jev.js";
import type { AgentDefinition, ResolvedRoute, RouteResolutionInput } from "../src/agents/types.js";

function piModel(id: string, thinkingLevelMap?: Record<string, string | null>): Model<any> {
  return { id, name: id, provider: "openai-codex", api: "openai-responses", baseUrl: "", reasoning: true, thinkingLevelMap, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 } as Model<any>;
}
function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return { harness: "pi", model: "parent/model", thinking: "medium", provenance: { harness: "parent", model: "parent", thinking: "parent" }, ...overrides };
}

function agent(defaults: AgentDefinition["defaults"], tools?: string[]): AgentDefinition {
  return { name: "worker", description: "Work", systemPrompt: "Work", defaults, tools, source: { scope: "package", path: "/agent.md" } };
}
function resolution(overrides: Partial<RouteResolutionInput> = {}): RouteResolutionInput {
  return { explicit: {}, parent: { model: "parent/model", thinking: "medium" }, ...overrides };
}

describe("Jev route selection", () => {
  it("derives every explicit layer before parent and treats generic agent defaults as fixed", () => {
    expect(deriveJevConstraints(route(), resolution({
      explicit: { model: "explicit" }, projectRouting: { thinking: "high" },
      userRouting: { harness: "claude" }, agent: agent({ harness: "pi", model: "agent", thinking: "low" }),
    }))).toMatchObject({ harness: "claude", model: "explicit", thinking: "high" });
    expect(deriveJevConstraints(route({ model: "agent", provenance: { harness: "parent", model: "agent-default", thinking: "parent" } }))).toMatchObject({ model: "agent" });
  });

  it("infers Claude before applying profile effort and preserves higher-priority thinking", () => {
    expect(deriveJevConstraints(route(), resolution({ agent: agent({ model: "claude-sonnet-5", effort: "max", thinking: "low" }) }))).toMatchObject({ harness: "claude", thinking: "max" });
    expect(deriveJevConstraints(route(), resolution({ explicit: { thinking: "off" }, agent: agent({ model: "claude-sonnet-5", effort: "max" }) }))).toMatchObject({ harness: "claude", thinking: "off" });
    expect(deriveJevConstraints(route(), resolution({ agent: agent({ effort: "max" }) })).harness).toBeUndefined();
  });

  it("preserves compatible profile and resolved model inherit without resolving credentials", async () => {
    const fetcher = vi.fn();
    const resolveApiKey = vi.fn(async () => "key");
    const inherited = route({ harness: "claude", model: undefined, provenance: { harness: "agent-default", model: "agent-default", thinking: "parent" } });
    const raw = await routeWithJev({ task: "task", route: inherited, resolutionInput: resolution({ agent: agent({ harness: "claude", model: "inherit" }) }), tools: ["Read"], piModels: [piModel("one")], claudeModels: [{ value: "sonnet", displayName: "Sonnet", description: "", supportsEffort: false }], resolveApiKey }, fetcher);
    const resolved = await routeWithJev({ task: "task", route: inherited, tools: ["Read"], piModels: [piModel("one")], claudeModels: [{ value: "sonnet", displayName: "Sonnet", description: "", supportsEffort: false }], resolveApiKey }, fetcher);
    expect(raw.route).toEqual(inherited);
    expect(resolved.route).toEqual(inherited);
    await expect(routeWithJev({ task: "task", route: inherited, resolutionInput: resolution({ agent: agent({ harness: "claude", model: "inherit" }) }), tools: ["bash"], piModels: [], claudeModels: [], resolveApiKey }, fetcher)).rejects.toBeInstanceOf(JevRoutingConflictError);
    await expect(routeWithJev({ task: "task", route: inherited, tools: ["bash"], piModels: [], claudeModels: [], resolveApiKey }, fetcher)).rejects.toBeInstanceOf(JevRoutingConflictError);
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("infers SDK aliases before applying fixed profile effort and never calls Jev", async () => {
    const fetcher = vi.fn();
    const resolveApiKey = vi.fn(async () => "key");
    const result = await routeWithJev({
      task: "task", route: route(), resolutionInput: resolution({ agent: agent({ model: "sonnet", effort: "max", thinking: "low" }) }),
      piModels: [], claudeModels: [{ value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "", supportsEffort: true, supportedEffortLevels: ["low", "max"] }], resolveApiKey,
    }, fetcher);
    expect(result.route).toMatchObject({ harness: "claude", model: "sonnet", thinking: "max", provenance: { model: "agent-default", thinking: "agent-default" } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(resolveApiKey).not.toHaveBeenCalled();
  });

  it("applies profile effort per candidate backend before requesting Jev", async () => {
    const seen: Array<Array<[string, string | undefined]>> = [];
    const choose = (harness: "pi" | "claude") => vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const keys = Object.keys(JSON.parse(String(init?.body)).questions.route.criteria);
      const decoded = keys.map((key) => JSON.parse(Buffer.from(key, "base64url").toString()) as [string, string, string | null]);
      seen.push(decoded.map(([candidateHarness, , thinking]) => [candidateHarness, thinking ?? undefined]));
      const choice = keys[decoded.findIndex(([candidateHarness]) => candidateHarness === harness)]!;
      return new Response(JSON.stringify({ answers: { route: { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])) } } }));
    });
    const common = { task: "task", route: route(), resolutionInput: resolution({ agent: agent({ effort: "max" }) }), piModels: [piModel("one", { low: "low", max: "max" })], claudeModels: [{ value: "sonnet", displayName: "Sonnet", description: "", supportsEffort: true, supportedEffortLevels: ["low" as const, "max" as const] }], apiKey: "key" };
    const pi = await routeWithJev(common, choose("pi"));
    const claude = await routeWithJev(common, choose("claude"));
    expect(pi.route).toMatchObject({ harness: "pi", provenance: { thinking: "jev" } });
    expect(claude.route).toMatchObject({ harness: "claude", thinking: "max", provenance: { thinking: "agent-default" } });
    expect(seen[0]).toEqual(expect.arrayContaining([["pi", "low"], ["pi", "max"], ["claude", "max"]]));
  });

  it("rejects tool and effort incompatibilities instead of unsafe fallback", async () => {
    const claude = [{ value: "sonnet", displayName: "Sonnet", description: "", supportsEffort: true, supportedEffortLevels: ["low" as const] }];
    await expect(routeWithJev({ task: "task", route: route(), resolutionInput: resolution({ explicit: { harness: "claude", model: "sonnet" } }), tools: ["bash"], piModels: [piModel("one")], claudeModels: claude, apiKey: "key" })).rejects.toBeInstanceOf(JevRoutingConflictError);
    await expect(routeWithJev({ task: "task", route: route(), resolutionInput: resolution({ explicit: { harness: "pi", model: "openai-codex/one" } }), tools: ["Read"], piModels: [piModel("one")], claudeModels: claude, apiKey: "key" })).rejects.toBeInstanceOf(JevRoutingConflictError);
    await expect(routeWithJev({ task: "task", route: route(), resolutionInput: resolution({ explicit: { harness: "claude", model: "sonnet", thinking: "max" } }), piModels: [], claudeModels: claude, apiKey: "key" })).rejects.toBeInstanceOf(JevRoutingConflictError);
  });

  it("keeps a valid original route on service failure", async () => {
    const original = route({ model: "openai-codex/one", thinking: "low" });
    const result = await routeWithJev({ task: "task", route: original, piModels: [piModel("one", { low: "low" }), piModel("two", { low: "low" })], claudeModels: [], apiKey: "key" }, vi.fn(async () => { throw new Error("offline"); }));
    expect(result.route).toEqual(original);
    expect(result.fallback).toContain("failed");
  });

  it.each([
    ["missing credentials", undefined, undefined],
    ["service failure", "key", vi.fn(async () => { throw new Error("offline"); })],
    ["malformed response", "key", vi.fn(async () => new Response("{}"))],
  ])("rejects an invalid actual fallback route on %s", async (_case, apiKey, fetcher) => {
    const original = route({ model: "openai-codex/parent", thinking: "high" });
    const models = [piModel("parent", { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null }), piModel("high-a", { high: "high" }), piModel("high-b", { high: "high" })];
    await expect(routeWithJev({ task: "task", route: original, resolutionInput: resolution({ explicit: { thinking: "high" } }), piModels: models, claudeModels: [], apiKey }, fetcher)).rejects.toBeInstanceOf(JevRoutingConflictError);
  });

  it("validates generic inherited thinking against the exact current fallback model", async () => {
    const original = route({ model: "openai-codex/parent", thinking: "high" });
    await expect(routeWithJev({ task: "task", route: original, piModels: [piModel("parent", { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null }), piModel("other-a", { low: "low", high: "high" }), piModel("other-b", { low: "low", high: "high" })], claudeModels: [], apiKey: "key" }, vi.fn(async () => { throw new Error("offline"); }))).rejects.toBeInstanceOf(JevRoutingConflictError);
  });

  it("throws on backend/model conflicts and never calls Jev", async () => {
    const fetcher = vi.fn();
    await expect(routeWithJev({ task: "task", route: route(), resolutionInput: resolution({ explicit: { harness: "pi", model: "claude-sonnet-5", thinking: "high" } }), piModels: [], claudeModels: [], apiKey: "key" }, fetcher)).rejects.toBeInstanceOf(JevRoutingConflictError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("matches exact Claude aliases and never wrong-provider suffixes", async () => {
    const claudeModels = [{ value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "", supportsEffort: true, supportedEffortLevels: ["high" as const] }];
    const exact = await routeWithJev({ task: "task", route: route(), resolutionInput: resolution({ explicit: { model: "anthropic/claude-sonnet-5", thinking: "high" } }), piModels: [piModel("claude-sonnet-5")], claudeModels, apiKey: "key" }, vi.fn());
    expect(exact.route.harness).toBe("claude");
    expect(exact.route.model).toBe("anthropic/claude-sonnet-5");
    await expect(routeWithJev({ task: "task", route: route(), resolutionInput: resolution({ explicit: { model: "other/sonnet" } }), piModels: [], claudeModels, apiKey: "key" }, vi.fn())).rejects.toBeInstanceOf(JevRoutingConflictError);
  });

  it("uses authoritative Claude effort metadata and conservative tool compatibility", () => {
    const candidates = buildJevCandidates([], [
      { value: "unknown", displayName: "Unknown", description: "Factual", supportsEffort: false },
      { value: "claude-haiku-4-5", displayName: "Haiku", description: "Fast", supportsEffort: false },
      { value: "claude-fable-5-1", displayName: "Fable", description: "Slow", supportsEffort: false },
      { value: "sonnet", displayName: "Sonnet", description: "Balanced", supportsEffort: true, supportedEffortLevels: ["low"] },
    ], "claude");
    expect(candidates.filter((candidate) => candidate.model === "unknown").map((candidate) => candidate.thinking)).toEqual([undefined]);
    expect(candidates.some((candidate) => candidate.model === "claude-haiku-4-5" && candidate.thinking === "off")).toBe(true);
    expect(candidates.some((candidate) => candidate.model === "claude-fable-5-1" && candidate.thinking === "off")).toBe(false);
    expect(candidates.filter((candidate) => candidate.model === "sonnet").map((candidate) => candidate.thinking)).toEqual(["low"]);
  });
  it("adds verified purpose text to catalogue metadata and falls back for unknown models", () => {
    // Pi reports only a display name, so the purpose has to come from the table.
    const [sol] = buildJevCandidates(
      [{ ...piModel("gpt-6-sol"), name: "GPT-6 Sol", contextWindow: 272000, maxTokens: 128000, input: ["text", "image"], cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } } as Model<any>],
      [],
    );
    expect(sol!.description).toBe(
      "GPT-6 Sol Built for complex coding and agentic workflows, including ambiguous everyday tasks, code changes, and research."
      + " Provider openai-codex; context 272000; max output 128000; accepts text and image; input cost 2; output cost 10; reasoning true. Thinking/effort off.",
    );
    const [luna] = buildJevCandidates([{ ...piModel("gpt-6-luna"), name: "GPT-6 Luna" } as Model<any>], []);
    expect(luna!.description).toContain("Most efficient for focused, high-volume summarization, extraction, and focused coding");
    // A gateway path prefix still resolves to the same catalogue id.
    const [gateway] = buildJevCandidates([{ ...piModel("openai/gpt-6-luna"), name: "GPT-6 Luna" } as Model<any>], []);
    expect(gateway!.description).toContain("Most efficient for focused, high-volume summarization");

    // A model no table entry covers keeps only what its harness reported.
    const [unknown] = buildJevCandidates([{ ...piModel("gpt-7-nova"), name: "GPT-7 Nova" } as Model<any>], []);
    expect(unknown!.description).toBe(
      "GPT-7 Nova Provider openai-codex; context 1; max output 1; accepts text; input cost 0; output cost 0; reasoning true. Thinking/effort off.",
    );
  });

  it("prefers the Claude SDK's own description and resolves alias variants for the rest", () => {
    // A Claude row the SDK already describes keeps the SDK's own wording.
    const [described] = buildJevCandidates([], [{
      value: "sonnet",
      resolvedModel: "claude-sonnet-5",
      displayName: "Sonnet",
      description: "Sonnet 5 \u00b7 Efficient for routine tasks",
      supportsEffort: true,
      supportedEffortLevels: ["high"],
      supportsAdaptiveThinking: true,
    }], "claude");
    expect(described!.description).toBe(
      "Sonnet 5 \u00b7 Efficient for routine tasks SDK model claude-sonnet-5; effort support known; adaptive thinking advertised. Thinking/effort high.",
    );
    expect(described!.description).not.toContain("Fast model balancing speed and intelligence");

    // Without an SDK description, the resolved id carries the purpose - including
    // the exact `[1m]` long-context alias.
    const [opus] = buildJevCandidates([], [{
      value: "opus",
      resolvedModel: "claude-opus-5-5[1m]",
      displayName: "Opus",
      description: " ",
      supportsEffort: true,
      supportedEffortLevels: ["medium"],
    }], "claude");
    expect(opus!.description).toBe(
      "Opus Long-running agentic coding and knowledge work at moderate latency, with always-on thinking."
      + " SDK model claude-opus-5-5[1m]; effort support known. Thinking/effort medium.",
    );

    // An unpublished future model still falls back to runtime metadata only.
    const [future] = buildJevCandidates([], [{ value: "claude-opus-9", displayName: "Opus 9", description: "", supportsEffort: false }], "claude");
    expect(future!.description).toBe("Opus 9 SDK model claude-opus-9; effort support not advertised. SDK default thinking/effort.");
  });

  it("uses runtime thinking metadata and Claude SDK effort metadata", () => {
    const candidates = buildJevCandidates(
      [piModel("always", { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null })],
      [{ value: "haiku", displayName: "Haiku", description: "Fast", supportsEffort: false }],
    );
    expect(candidates.map((item) => [item.harness, item.model, item.thinking])).toEqual([
      ["pi", "openai-codex/always", "low"],
      ["pi", "openai-codex/always", "high"],
      ["claude", "haiku", undefined],
    ]);
  });

  it("doesn't call Jev when fixed model and thinking already determine the route", async () => {
    const fetcher = vi.fn();
    const result = await routeWithJev({ task: "task", route: route({ model: "fixed", thinking: "high", provenance: { harness: "parent", model: "saved-user", thinking: "explicit" } }), piModels: [], claudeModels: [], apiKey: "key" }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.used).toBe(false);
  });

  it("preserves explicit fields and validates the exact returned candidate", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const keys = Object.keys(body.questions.route.criteria);
      const choice = keys[1];
      return new Response(JSON.stringify({ model: "jev-latest", answers: { route: { type: "choice", choice, confidence: 0.8, probabilities: Object.fromEntries(keys.map((key: string) => [key, key === choice ? 0.8 : 0.2 / (keys.length - 1)])) } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 });
    });
    const result = await routeWithJev({ task: "hard task", role: "reviewer", route: route({ harness: "claude", model: undefined, thinking: undefined, provenance: { harness: "explicit", model: "parent", thinking: "parent" } }), piModels: [piModel("one")], claudeModels: [{ value: "sonnet", displayName: "Sonnet", description: "Balanced", supportsEffort: true, supportedEffortLevels: ["low", "high"] }], apiKey: "key" }, fetcher);
    expect(result.route.harness).toBe("claude");
    expect(result.route.model).toBe("sonnet");
    expect(result.route.thinking).toBe("high");
    expect(result.route.provenance).toEqual({ harness: "explicit", model: "jev", thinking: "jev" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("falls back without truncating a catalogue above the Choice limit", async () => {
    const models = Array.from({ length: JEV_MAX_CHOICES + 1 }, (_, index) => piModel(`m${index}`, { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null }));
    const fetcher = vi.fn();
    const result = await routeWithJev({ task: "task", route: route(), piModels: models, claudeModels: [], apiKey: "key" }, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.fallback).toContain("above the 255 service limit");
  });

  it("falls back on a malformed or unavailable choice without retrying", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ model: "jev-latest", answers: { route: { type: "choice", choice: "missing", confidence: 1, probabilities: { missing: 1 } } }, usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }));
    const original = route();
    const result = await routeWithJev({ task: "task", route: original, piModels: [piModel("one"), piModel("two")], claudeModels: [], apiKey: "key" }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.route).toEqual(original);
    expect(result.fallback).toContain("invalid response");
  });

  it("accepts low confidence when the probability shape is valid", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const keys = Object.keys(JSON.parse(String(init?.body)).questions.route.criteria);
      return new Response(JSON.stringify({ answers: { route: { type: "choice", choice: keys[0], confidence: 0.01, probabilities: Object.fromEntries(keys.map((key) => [key, 1 / keys.length])) } } }));
    });
    const result = await routeWithJev({ task: "task", route: route(), piModels: [piModel("one"), piModel("two")], claudeModels: [], apiKey: "key" }, fetcher);
    expect(result.used).toBe(true);
  });

  it("does not retry rate limits and redacts transport details", async () => {
    const fetcher = vi.fn(async () => new Response("secret task and key", { status: 429 }));
    const result = await routeWithJev({ task: "secret task", route: route(), piModels: [piModel("one"), piModel("two")], claudeModels: [], apiKey: "secret-key" }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.fallback).not.toContain("secret");
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const pending = routeWithJev({ task: "task", route: route(), piModels: [piModel("one"), piModel("two")], claudeModels: [], apiKey: "key", signal: controller.signal }, fetcher);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
