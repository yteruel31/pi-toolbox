import { describe, expect, it, vi } from "vitest";
import type { Model } from "@earendil-works/pi-ai";
import { buildJevCandidates, JEV_MAX_CHOICES, routeWithJev } from "../src/agents/jev.js";
import type { ResolvedRoute } from "../src/agents/types.js";

function piModel(id: string, thinkingLevelMap?: Record<string, string | null>): Model<any> {
  return { id, name: id, provider: "openai-codex", api: "openai-responses", baseUrl: "", reasoning: true, thinkingLevelMap, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 } as Model<any>;
}
function route(overrides: Partial<ResolvedRoute> = {}): ResolvedRoute {
  return { harness: "pi", model: "parent/model", thinking: "medium", provenance: { harness: "parent", model: "parent", thinking: "parent" }, ...overrides };
}

describe("Jev route selection", () => {
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
      const choice = Object.keys(body.questions.route.criteria)[1];
      return new Response(JSON.stringify({ answers: { route: { type: "choice", choice } } }), { status: 200 });
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
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ answers: { route: { type: "choice", choice: "missing" } } }), { status: 200 }));
    const original = route();
    const result = await routeWithJev({ task: "task", route: original, piModels: [piModel("one"), piModel("two")], claudeModels: [], apiKey: "key" }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.route).toEqual(original);
    expect(result.fallback).toContain("unavailable");
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
