import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import type { PiModelBridgeApi } from "../../runtime/pi-model.js";
import { PRIORITIES, type Observation, type Priority, type Reflection } from "../ledger/types.js";
import { AgentValidationError, memoryId } from "./observer.js";
import { reflectorPrompt } from "./prompts.js";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const output = (m: { content: readonly any[] }) => m.content.filter((x) => x.type === "text").map((x) => x.text).join("");
export function parseReflectorOutput(raw: string, observations: readonly Observation[], timestamp: string): Reflection[] {
  const root: unknown = JSON.parse(raw); const allowed = new Map(observations.map((x) => [x.id, x]));
  if (!object(root) || Object.keys(root).some((k) => k !== "reflections") || !Array.isArray(root.reflections)) throw new Error("invalid reflector output");
  const records = root.reflections.map((item) => {
    if (!object(item) || Object.keys(item).some((k) => !["text", "priority", "supportingObservationIds"].includes(k)) || typeof item.text !== "string" || !item.text || item.text.length > 2_000 || /[\r\n]/.test(item.text) || !PRIORITIES.includes(item.priority as Priority) || !Array.isArray(item.supportingObservationIds) || item.supportingObservationIds.length === 0 || !item.supportingObservationIds.every((id) => typeof id === "string" && allowed.has(id))) throw new Error("invalid reflection record");
    const ids = [...new Set(item.supportingObservationIds as string[])]; const sourceIds = [...new Set(ids.flatMap((id) => allowed.get(id)!.sources.entryIds))];
    return { id: memoryId("reflection", item.text, ids), timestamp, priority: item.priority as Priority, text: item.text, sources: { entryIds: sourceIds, ranges: [] }, supportingObservationIds: ids };
  });
  return records.filter((record, index) => records.findIndex((candidate) => candidate.id === record.id) === index);
}
export const runReflector = Effect.fn("runReflector")(function*(bridge: PiModelBridgeApi, observations: readonly Observation[], reflections: readonly Reflection[], now = new Date().toISOString(), timeoutMs = 45_000) {
  const p = reflectorPrompt(observations, reflections); const context: ModelContext = { systemPrompt: p.systemPrompt, messages: [{ role: "user", content: p.user, timestamp: Date.now() }] };
  const response = yield* bridge.complete("reflector", context, { maxTokens: 4_096 }).pipe(Effect.timeout(timeoutMs));
  return yield* Effect.try({ try: () => parseReflectorOutput(output(response), observations, now), catch: () => new AgentValidationError("reflector output validation failed") });
});
