export const MCP_STATUS_CHANNEL = "pi-toolbox:mcp:status";
export const SUBAGENTS_STATUS_CHANNEL = "pi-toolbox:subagents:status";

export interface McpStatusCounts {
  connected: number;
  enabled: number;
  authRequired: number;
  errors: number;
  disabled: number;
}

export interface SubagentStatusCounts {
  running: number;
  completed: number;
  error: number;
}

export interface ToolboxStatusEvent<T> {
  v: 1;
  counts: T | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

export function readMcpStatusEvent(value: unknown): McpStatusCounts | null | undefined {
  if (!isRecord(value) || value.v !== 1) return undefined;
  if (value.counts === null) return null;
  if (!isRecord(value.counts)) return undefined;
  const { connected, enabled, authRequired, errors, disabled } = value.counts;
  if (!isCount(connected) || !isCount(enabled) || !isCount(authRequired) || !isCount(errors) || !isCount(disabled)) {
    return undefined;
  }
  return { connected, enabled, authRequired, errors, disabled };
}

export function readSubagentStatusEvent(value: unknown): SubagentStatusCounts | null | undefined {
  if (!isRecord(value) || value.v !== 1) return undefined;
  if (value.counts === null) return null;
  if (!isRecord(value.counts)) return undefined;
  const { running, completed, error } = value.counts;
  if (!isCount(running) || !isCount(completed) || !isCount(error)) return undefined;
  return { running, completed, error };
}
