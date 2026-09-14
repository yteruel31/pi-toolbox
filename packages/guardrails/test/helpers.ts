import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { randomUUID } from "node:crypto";
import { defaultConfig, type Config, type Policy } from "../src/config.js";
import type { CompletionBridge } from "../src/judge.js";
import type { Candidate, HistoryEntry } from "../src/types.js";

export const candidate = (overrides: Partial<Candidate> = {}): Candidate => ({ tool: "bash", args: { command: "git status" }, cwd: "/project", project: "/project", actor: { kind: "main" }, callId: randomUUID(), sessionId: "parent-1", ...overrides });
export const policy = (overrides: Partial<Policy> = {}): Policy => ({ id: "test", name: "Test policy", enabled: true, scope: "both", tools: ["bash", "read", "write", "edit"], conditions: {}, action: "Ask", kind: "structured", ...overrides });
export const config = (overrides: Partial<Config> = {}): Config => ({ ...defaultConfig(), enabled: true, ...overrides });
export function response(value: unknown, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }], api: "openai-responses", provider: "fake", model: "judge", stopReason, timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
export function bridge(value: unknown = { action: "Allow", reason: "Routine inspection", policyIds: [], historyIds: [] }): CompletionBridge {
  return { resolve: () => ({ model: { provider: "fake", id: "judge" } as Model<any>, route: "fake/judge" }), complete: async () => response(value) };
}
export function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return { id: randomUUID(), at: Date.now(), updatedAt: Date.now(), sessionId: "parent-1", project: "/project", cwd: "/project", actor: { kind: "main" }, callId: randomUUID(), tool: "bash", summary: "git status", target: "/project", operation: "git status", action: "Allow", origin: "model", reason: "Routine", policyIds: [], historyIds: [], state: "allowed", execution: "not-observed", ...overrides };
}
