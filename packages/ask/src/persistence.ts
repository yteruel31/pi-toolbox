import type { AskSource } from "./contracts.ts";

export const PAYLOAD_ENTRY = "yteruel31-pi-ask:payload";
export const DISMISSED_ENTRY = "yteruel31-pi-ask:pending-dismissed";

export interface StoredAskPayload {
  version: 1;
  source: AskSource;
  toolCallId?: string;
  params: unknown;
  createdAt: number;
}

interface EntryLike {
  type?: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

const ASK_SOURCES = new Set<AskSource>(["tool", "answer", "answer:again", "ask:replay", "ask:resume"]);

export function payloadFromEntry(entry: EntryLike): StoredAskPayload | undefined {
  if (entry.type !== "custom" || entry.customType !== PAYLOAD_ENTRY) return undefined;
  const data = record(entry.data);
  if (data?.version !== 1 || typeof data.source !== "string" || !ASK_SOURCES.has(data.source as AskSource)
    || !("params" in data) || typeof data.createdAt !== "number" || !Number.isFinite(data.createdAt)
    || (data.toolCallId !== undefined && typeof data.toolCallId !== "string")) return undefined;
  return data as unknown as StoredAskPayload;
}

export function latestPayload(branch: readonly EntryLike[], sources: AskSource[]): StoredAskPayload | undefined {
  const allowed = new Set(sources);
  for (let index = branch.length - 1; index >= 0; index--) {
    const payload = payloadFromEntry(branch[index]!);
    if (payload && allowed.has(payload.source)) return payload;
  }
  return undefined;
}

export interface PendingAsk {
  toolCallId: string;
  arguments: unknown;
  payload?: StoredAskPayload;
}

export function findPendingAsk(branch: readonly EntryLike[]): PendingAsk | undefined {
  const resolved = new Set<string>();
  const dismissed = new Set<string>();
  const payloads = new Map<string, StoredAskPayload>();
  for (const entry of branch) {
    if (entry.type === "message") {
      const message = record(entry.message);
      if (message?.role === "toolResult" && typeof message.toolCallId === "string") resolved.add(message.toolCallId);
    }
    if (entry.type === "custom" && entry.customType === DISMISSED_ENTRY) {
      const data = record(entry.data);
      if (typeof data?.toolCallId === "string") dismissed.add(data.toolCallId);
    }
    const payload = payloadFromEntry(entry);
    if (payload?.toolCallId) payloads.set(payload.toolCallId, payload);
  }
  for (let entryIndex = branch.length - 1; entryIndex >= 0; entryIndex--) {
    const entry = branch[entryIndex]!;
    if (entry.type !== "message") continue;
    const message = record(entry.message);
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let contentIndex = message.content.length - 1; contentIndex >= 0; contentIndex--) {
      const block = record(message.content[contentIndex]);
      if (block?.type !== "toolCall" || block.name !== "ask_user" || typeof block.id !== "string") continue;
      if (resolved.has(block.id) || dismissed.has(block.id)) continue;
      return { toolCallId: block.id, arguments: block.arguments, ...(payloads.get(block.id) ? { payload: payloads.get(block.id) } : {}) };
    }
  }
  return undefined;
}

export function makePayload(source: AskSource, params: unknown, toolCallId?: string): StoredAskPayload {
  return { version: 1, source, ...(toolCallId ? { toolCallId } : {}), params: structuredClone(params), createdAt: Date.now() };
}
