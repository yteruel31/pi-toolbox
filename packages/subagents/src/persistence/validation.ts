import type { PersistedRunState } from "../shared/types.js";

const MAX_AGENT_PROFILE_CHARS = 100;

export function isPersistedState(value: unknown): value is PersistedRunState {
  if (!isRecord(value)) return false;
  if (
    value.version !== 1 ||
    !isPositiveInteger(value.nextSerial) ||
    !isPositiveInteger(value.nextSettlementSeq) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 10_000
  ) {
    return false;
  }
  const ids = new Set<string>();
  return value.runs.every((record) => {
    if (!isRecord(record) || typeof record.id !== "string" || ids.has(record.id)) return false;
    ids.add(record.id);
    return (
      /^run-[1-9][0-9]{0,15}$/.test(record.id) &&
      isPositiveInteger(record.serial) && record.id === `run-${record.serial}` &&
      typeof record.title === "string" &&
      (record.agentProfile === undefined || (
        typeof record.agentProfile === "string" &&
        record.agentProfile.length <= MAX_AGENT_PROFILE_CHARS
      )) &&
      (record.harness === "pi" || record.harness === "claude") &&
      ["queued", "running", "completed", "failed", "cancelled"].includes(String(record.status)) &&
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt) &&
      typeof record.cancelRequested === "boolean" && typeof record.autoDeliver === "boolean" &&
      (record.origin === undefined || isRecord(record.origin) &&
        typeof record.origin.toolCallId === "string" && typeof record.origin.label === "string") &&
      (record.routing === undefined || isRouting(record.routing)) &&
      (record.usage === undefined || isUsage(record.usage)) &&
      (record.finalText === undefined || typeof record.finalText === "string") &&
      (record.errorText === undefined || typeof record.errorText === "string") &&
      (record.workingDir === undefined || typeof record.workingDir === "string") &&
      (record.requestedModel === undefined || typeof record.requestedModel === "string") &&
      (record.effectiveModel === undefined || typeof record.effectiveModel === "string") &&
      (record.thinkingLevel === undefined || ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(record.thinkingLevel))) &&
      (record.settledAt === undefined || typeof record.settledAt === "number" && Number.isFinite(record.settledAt)) &&
      (record.settlementSeq === undefined || isPositiveInteger(record.settlementSeq)) &&
      (!["completed", "failed", "cancelled"].includes(String(record.status)) ||
        typeof record.settledAt === "number" && isPositiveInteger(record.settlementSeq)) &&
      Array.isArray(record.activity) && record.activity.length <= 1_000 &&
      record.activity.every((entry) =>
        isRecord(entry) && typeof entry.at === "number" && Number.isFinite(entry.at) && typeof entry.text === "string"
      ) &&
      (record.transcript === undefined || (
        Array.isArray(record.transcript) &&
        record.transcript.length <= 1_000 &&
        record.transcript.every(isPersistedTranscriptEntry)
      )) &&
      (record.transcriptDropped === undefined || (
        typeof record.transcriptDropped === "number" &&
        Number.isSafeInteger(record.transcriptDropped) &&
        record.transcriptDropped >= 0
      )) &&
      typeof record.activityDropped === "number" && Number.isSafeInteger(record.activityDropped) && record.activityDropped >= 0 &&
      ["none", "waited", "delivered", "suppressed"].includes(String(record.consumption))
    );
  });
}

function isPersistedTranscriptEntry(value: unknown): boolean {
  if (!isRecord(value) || typeof value.at !== "number" || !Number.isFinite(value.at)) {
    return false;
  }
  if (value.kind === "status") {
    return typeof value.text === "string" &&
      (value.status === undefined || ["queued", "running", "completed", "failed", "cancelled"].includes(String(value.status)));
  }
  if (value.kind === "user" || value.kind === "assistant") {
    return typeof value.text === "string";
  }
  if (value.kind === "tool") {
    return typeof value.toolName === "string" &&
      ["start", "update", "complete", "error"].includes(String(value.phase)) &&
      (value.callId === undefined || typeof value.callId === "string") &&
      (value.input === undefined || typeof value.input === "string") &&
      (value.output === undefined || typeof value.output === "string");
  }
  return false;
}

function isUsage(value: unknown): boolean {
  return isRecord(value) && ["input", "output", "cacheRead", "cacheWrite", "costUsd", "turns", "contextTokens"].every((key) =>
    typeof value[key] === "number" && Number.isFinite(value[key]));
}

function isRouting(value: unknown): boolean {
  return isRecord(value) && ["pending", "resolved", "fallback", "failed"].includes(String(value.state)) &&
    (value.fallback === undefined || typeof value.fallback === "string") &&
    (value.provenance === undefined || isRecord(value.provenance) &&
      Object.entries(value.provenance).every(([key, entry]) =>
        ["harness", "model", "thinking"].includes(key) && typeof entry === "string"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
