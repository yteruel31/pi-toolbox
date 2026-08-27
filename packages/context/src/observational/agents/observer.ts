import { createHash } from "node:crypto";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { Effect } from "effect";
import type { PiModelBridgeApi } from "../../runtime/pi-model.js";
import { PRIORITIES, type Observation, type Priority } from "../ledger/types.js";
import { observerPrompt } from "./prompts.js";

export interface ObserverSource { id: string; role: "user" | "assistant"; text: string }
export class AgentValidationError extends Error { readonly category = "validation"; }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).every((k) => keys.includes(k));
const textOutput = (message: { content: readonly any[] }) => message.content.filter((x) => x.type === "text").map((x) => x.text).join("");
export const memoryId = (kind: string, text: string, ids: readonly string[]) => createHash("sha256").update(JSON.stringify([kind, text, [...ids]])).digest("hex").slice(0, 12);
export function parseObserverOutput(raw: string, sources: readonly ObserverSource[], timestamp: string): Observation[] {
  const root: unknown = JSON.parse(raw);
  if (!object(root) || !exact(root, ["observations"]) || !Array.isArray(root.observations)) throw new Error("invalid observer output");
  const allowed = new Set(sources.map((x) => x.id));
  const records = root.observations.map((item) => {
    if (!object(item) || !exact(item, ["text", "priority", "sourceEntryIds", "supersedesIds"]) || typeof item.text !== "string" || !item.text || item.text.length > 2_000 || /[\r\n]/.test(item.text) || !PRIORITIES.includes(item.priority as Priority) || !Array.isArray(item.sourceEntryIds) || item.sourceEntryIds.length === 0 || !item.sourceEntryIds.every((id) => typeof id === "string" && allowed.has(id)) || (item.supersedesIds !== undefined && (!Array.isArray(item.supersedesIds) || !item.supersedesIds.every((id) => typeof id === "string" && /^[a-f0-9]{12}$/.test(id))))) throw new Error("invalid observer record");
    const ids = [...new Set(item.sourceEntryIds as string[])];
    return { id: memoryId("observation", item.text, ids), timestamp, priority: item.priority as Priority, text: item.text, sources: { entryIds: ids, ranges: [] }, ...(item.supersedesIds === undefined ? {} : { supersedesIds: [...new Set(item.supersedesIds as string[])] }) };
  });
  return records.filter((record, index) => records.findIndex((candidate) => candidate.id === record.id) === index);
}
export const runObserver = Effect.fn("runObserver")(function*(bridge: PiModelBridgeApi, sources: readonly ObserverSource[], now = new Date().toISOString(), timeoutMs = 45_000) {
  const prompt = observerPrompt(sources);
  const context: ModelContext = { systemPrompt: prompt.systemPrompt, messages: [{ role: "user", content: prompt.user, timestamp: Date.now() }] };
  const response = yield* bridge.complete("observer", context, { maxTokens: 4_096 }).pipe(Effect.timeout(timeoutMs));
  return yield* Effect.try({ try: () => parseObserverOutput(textOutput(response), sources, now), catch: () => new AgentValidationError("observer output validation failed") });
});
