export type Action = "Allow" | "Ask" | "Deny";
export type Tool = "bash" | "read" | "write" | "edit";
export type Actor = { kind: "main" } | { kind: "subagent"; runId: string; profile?: string; childSessionId?: string };
export interface Candidate {
  tool: Tool;
  args: Record<string, unknown>;
  cwd: string;
  actor: Actor;
  callId: string;
  sessionId: string;
  project: string;
  leafId?: string;
}
export interface Decision {
  action: Action;
  origin: "policy" | "model" | "error";
  reason: string;
  policyIds: string[];
  historyIds: string[];
  model?: { route: string; thinking: string; durationMs: number };
}
export interface HistoryEntry extends Decision {
  id: string;
  at: number;
  updatedAt: number;
  sessionId: string;
  project: string;
  cwd: string;
  actor: Actor;
  callId: string;
  leafId?: string;
  tool: Tool;
  summary: string;
  target: string;
  operation: string;
  choice?: "allow-once" | "deny" | "deny-stop";
  state: "assessing" | "review" | "allowed" | "denied";
  execution: "not-observed" | "blocked" | "reported-success" | "reported-error";
}
export interface Block { block: true; reason: string; terminate?: boolean }
export function isTool(value: string): value is Tool { return ["bash", "read", "write", "edit"].includes(value); }
