import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { judge, piBridge } from "../src/judge.js";
import { candidate, config, response } from "./helpers.js";

function registryFixture(delta: string) {
  let supplied: any;
  const reply = response({ action: "Allow", reason: "Routine", policyIds: [], historyIds: [] });
  const ctx = { model: { provider: "fake", id: "model", reasoning: true }, scopedModels: [], modelRegistry: {
    getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "credential-from-registry", headers: { "x-test": "registry" }, baseUrl: "https://example.invalid", env: { PROVIDER_ENV: "value" } }),
    getProvider: () => ({ streamSimple: (_model: unknown, context: unknown, options: unknown) => {
      supplied = { context, options };
      const iterator = (async function* () { yield { type: "text_delta", delta }; })();
      return Object.assign(iterator, { result: async () => reply });
    } }),
  } } as unknown as ExtensionContext;
  return { ctx, supplied: () => supplied };
}
test("native simple streaming uses registry auth and independent thinking options for every API", async () => {
  for (const thinking of ["off", "high"] as const) {
    const f = registryFixture("small response");
    const decision = await judge(piBridge(() => f.ctx), config({ thinking }), candidate(), [], [], "/project", "git status");
    assert.equal(decision.action, "Allow");
    assert.equal(f.supplied().options.reasoning, thinking === "off" ? undefined : "high");
    assert.equal(f.supplied().options.apiKey, "credential-from-registry");
    assert.doesNotMatch(JSON.stringify(f.supplied().context), /credential-from-registry/);
    assert.equal(f.supplied().options.maxTokens, 1024);
  }
});
test("stream output has an independent character bound and aborts before accepting oversized output", async () => {
  const f = registryFixture("x".repeat(32001));
  const decision = await judge(piBridge(() => f.ctx), config(), candidate(), [], [], "/project", "git status");
  assert.equal(decision.origin, "error"); assert.equal(decision.action, "Ask");
  assert.equal(f.supplied().options.signal.aborted, true);
});
