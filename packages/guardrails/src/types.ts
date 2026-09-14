export type Action = "Allow" | "Ask" | "Deny";
export type NativeTool = "bash" | "read" | "write" | "edit";
export type Tool = NativeTool | "mcp" | "web-access";
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
  origin: "policy" | "model" | "error" | "rule-only-no-match" | "bypass";
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
/** Native interception must not mistake operation families for Pi tool names. */
export function isTool(value: string): value is NativeTool { return ["bash", "read", "write", "edit"].includes(value); }
export function isSupportedTool(value: string): value is Tool { return isTool(value) || value === "mcp" || value === "web-access"; }
