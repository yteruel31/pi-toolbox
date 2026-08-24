import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { DEFAULT_CONTEXT_CONFIG, type ContextConfig } from "../src/config/schema.js";
import { makePiModelBridge } from "../src/runtime/pi-model.js";

const active = { provider: "active", id: "main", api: "fake" };
const configured = { provider: "configured", id: "worker", api: "fake" };
function context(find = vi.fn(), complete = vi.fn()) {
  return { model: active, thinkingLevel: "low", modelRegistry: { find, complete } } as any;
}

describe("Pi model bridge", () => {
  it("falls back to the active model", async () => {
    const bridge = makePiModelBridge(context(), DEFAULT_CONTEXT_CONFIG);
    await expect(Effect.runPromise(bridge.resolve("observer"))).resolves.toMatchObject({ model: active, thinkingLevel: "low" });
  });

  it("resolves the exact configured provider/model and rejects a missing one", async () => {
    const config = { version: 1, models: { observer: { provider: "configured", model: "worker" } } } as ContextConfig;
    const find = vi.fn().mockReturnValueOnce(configured).mockReturnValueOnce(undefined);
    const bridge = makePiModelBridge(context(find), config);
    await expect(Effect.runPromise(bridge.resolve("observer"))).resolves.toMatchObject({ model: configured });
    await expect(Effect.runPromise(bridge.resolve("observer"))).rejects.toMatchObject({ _tag: "ModelResolutionError" });
    expect(find).toHaveBeenCalledWith("configured", "worker");
  });

  it("omits reasoning when a configured route is off", async () => {
    const complete = vi.fn().mockResolvedValue({ role: "assistant", content: [] });
    const config = { version: 1, models: { observer: { provider: "configured", model: "worker", thinkingLevel: "off" } } } as ContextConfig;
    const bridge = makePiModelBridge(context(vi.fn(() => configured), complete), config);
    await Effect.runPromise(bridge.complete("observer", { systemPrompt: "x", messages: [] }));
    expect(complete).toHaveBeenCalledWith(configured, expect.anything(), undefined);
  });

  it("completes only through the registry", async () => {
    const response = { role: "assistant", content: [] };
    const complete = vi.fn().mockResolvedValue(response);
    const ctx = context(vi.fn(), complete);
    const bridge = makePiModelBridge(ctx, DEFAULT_CONTEXT_CONFIG);
    await expect(Effect.runPromise(bridge.complete("reflector", { systemPrompt: "x", messages: [] }))).resolves.toBe(response);
    expect(complete).toHaveBeenCalledWith(active, expect.anything(), expect.objectContaining({ reasoning: "low" }));
  });
});
