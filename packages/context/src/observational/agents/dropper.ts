import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import type { PiModelBridgeApi } from "../../runtime/pi-model.js";
import type { Observation } from "../ledger/types.js";
import { dropperPrompt } from "./prompts.js";
import { AgentValidationError } from "./observer.js";
export function parseDropperOutput(raw: string, observations: readonly Observation[]): string[] {
  const value: unknown = JSON.parse(raw); const allowed = new Set(observations.map((x) => x.id));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => k !== "ids") || !Array.isArray((value as any).ids) || !(value as any).ids.every((id: unknown) => typeof id === "string" && allowed.has(id))) throw new Error("invalid dropper output");
  return [...new Set((value as { ids: string[] }).ids)];
}
export const runDropper = Effect.fn("runDropper")(function*(bridge: PiModelBridgeApi, observations: readonly Observation[], timeoutMs = 45_000) {
  const p = dropperPrompt(observations); const context: ModelContext = { systemPrompt: p.systemPrompt, messages: [{ role: "user", content: p.user, timestamp: Date.now() }] };
  const response = yield* bridge.complete("dropper", context, { maxTokens: 2_048 }).pipe(Effect.timeout(timeoutMs));
  const raw = response.content.filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
  return yield* Effect.try({ try: () => parseDropperOutput(raw, observations), catch: () => new AgentValidationError("dropper output validation failed") });
});
