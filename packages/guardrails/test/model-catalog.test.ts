import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";
import { judgeCatalog, judgeChoices, judgeThinking, selectedJudge } from "../src/model-catalog.js";
import { piBridge } from "../src/judge.js";
import { config } from "./helpers.js";
const active = { provider: "configured", id: "active", reasoning: true } as Model<any>;
const other = { provider: "configured", id: "other", reasoning: false } as Model<any>;
const unauthenticated = { provider: "no-auth", id: "hidden" } as Model<any>;
test("catalog intersects configured-auth availability and scope, with no refresh or credential resolution", () => {
  let available = 0;
  const ctx = { model: active, scopedModels: [{ model: active }, { model: unauthenticated }], modelRegistry: {
    getAvailable: () => { available++; return [active, other]; },
    getApiKeyAndHeaders: () => { throw Error("must not resolve credentials"); }, refresh: () => { throw Error("must not probe providers"); },
  } } as unknown as ExtensionContext;
  const catalog = judgeCatalog(ctx);
  assert.equal(available, 1); assert.deepEqual(catalog.models, [active]);
  assert.equal(selectedJudge(catalog, ""), active);
  assert.equal(judgeChoices(catalog, "")[0].value, "");
  assert.match(judgeChoices(catalog, "")[0].description!, /configured\/active/);
  const choices = judgeChoices(catalog, "missing/saved");
  assert.equal(choices[1].value, "missing/saved"); assert.equal(choices[1].unavailable, true);
  assert.equal(choices.some((c) => c.value === "no-auth/hidden"), false);
  assert.deepEqual(judgeCatalog({ ...ctx, scopedModels: [] }).models, [active, other]);
});
test("thinking follows native capabilities, including holes; configuration is not clamped", () => {
  const mapped = { ...active, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: null, max: "max" } };
  const catalog = { models: [mapped, other], activeRoute: "configured/active" };
  const saved = config({ thinking: "xhigh" });
  assert.deepEqual(judgeThinking(catalog, saved), ["high", "max"]);
  assert.equal(saved.thinking, "xhigh");
  assert.deepEqual(judgeThinking(catalog, { model: "configured/other" }), ["off"]);
  assert.deepEqual(judgeThinking(catalog, { model: "missing/model" }), []);
  const ctx = { model: mapped, scopedModels: [] } as unknown as ExtensionContext;
  assert.throws(() => piBridge(() => ctx).resolve(saved), /compatible judge thinking/);
  assert.equal(piBridge(() => ctx).resolve({ ...saved, thinking: "high" }).route, "configured/active");
  assert.throws(() => piBridge(() => { throw Error("context accessed"); }).resolve(config({ judgeEnabled: false })), /Judge model is off/);
});
