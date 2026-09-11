import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { synthesize } from "../src/synthesis.js";

function context(stopReason = "stop") {
  const calls: unknown[][] = [];
  const current = { provider: "example", id: "current" };
  const dedicated = { provider: "example", id: "dedicated" };
  const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const ctx = {
    model: current, scopedModels: [],
    modelRegistry: {
      find: (provider: string, model: string) => provider === "example" && model === "dedicated" ? dedicated : undefined,
      complete: async (...args: unknown[]) => { calls.push(args); return { stopReason, content: [{ type: "text", text: "Answer with https://example.com" }], usage }; },
    },
  } as unknown as ExtensionContext;
  return { ctx, current, dedicated, calls, usage };
}
test("synthesis uses the active Pi model and accounts for nested usage", async () => {
  const h = context(); const result = await synthesize(h.ctx, "Answer from this page", { page: "untrusted text" });
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0]![0], h.current);
  assert.equal(result.usage, h.usage); assert.equal(result.model, "example/current");
  assert.match(result.text, /AI generated/);
  const sent = h.calls[0]![1] as { systemPrompt: string; tools?: unknown };
  assert.match(sent.systemPrompt, /untrusted evidence/); assert.equal(sent.tools, undefined);
});
test("per-call model override is explicit and must be in the scoped allowlist", async () => {
  const h = context();
  await synthesize(h.ctx, "Answer", {}, "example/dedicated");
  assert.equal(h.calls[0]![0], h.dedicated);
  Object.assign(h.ctx, { scopedModels: [{ model: h.current }] });
  await assert.rejects(synthesize(h.ctx, "Answer", {}, "example/dedicated"), /allowlist/);
  assert.equal(h.calls.length, 1);
});
test("invalid model, oversized input and cancellation fail without another model call", async () => {
  const h = context();
  await assert.rejects(synthesize(h.ctx, "Answer", {}, "unknown/model"), /No synthesis model/);
  await assert.rejects(synthesize(h.ctx, "Answer", { text: "x".repeat(81000) }), /exceeds/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(synthesize(h.ctx, "Answer", {}, undefined, controller.signal));
  assert.equal(h.calls.length, 0);
});
test("model errors are not retried with a fallback provider", async () => {
  const h = context("error");
  await assert.rejects(synthesize(h.ctx, "Answer", {}), /no fallback/);
  assert.equal(h.calls.length, 1);
});
