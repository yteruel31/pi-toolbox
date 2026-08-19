/**
 * Shared value types for @yteruel31/pi-subagents.
 *
 * Everything in this file is plain data. No Pi APIs, no Node APIs, no
 * side effects. Both the core run manager and the (future) Pi extension
 * adapter depend on these; nothing here depends on anything else.
 */

/** Which execution harness a run uses. */
export type HarnessKind = "pi" | "claude";

/** Thinking / reasoning effort levels, matching Pi's thinking-level scale. */
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Lifecycle states of a run. */
export type RunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/** Terminal states. */
export type SettledRunStatus = Extract<
  RunStatus,
  "completed" | "failed" | "cancelled"
>;

export function isSettledStatus(status: RunStatus): status is SettledRunStatus {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

/**
 * How a settled result has been handed to the parent, exactly once:
 * - "none": settled but not yet collected or delivered
 * - "waited": explicitly collected through subagent_wait
 * - "delivered": auto-delivered to the parent conversation
 * - "suppressed": never delivered by design (/btw side questions)
 */
export type ResultConsumption = "none" | "waited" | "delivered" | "suppressed";

/** Aggregated usage of a run's nested LLM calls, when the harness reports it. */
export interface RunUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  turns: number;
  /** Current context size of the child, not additive across runs. */
  contextTokens: number;
}

/** One bounded progress record retained for backwards-compatible inspection. */
export interface RunActivityEntry {
  /** Milliseconds timestamp from the injected clock. */
  at: number;
  /** Bounded, sanitized display text. */
  text: string;
}

export type RunTranscriptEntry =
  | {
      kind: "status";
      at: number;
      text: string;
      status?: RunStatus;
    }
  | {
      kind: "user";
      at: number;
      text: string;
    }
  | {
      kind: "assistant";
      at: number;
      text: string;
    }
  | {
      kind: "tool";
      at: number;
      toolName: string;
      phase: "start" | "update" | "complete" | "error";
      callId?: string;
      input?: string;
      output?: string;
    };

export type RunTranscriptInput = RunTranscriptEntry extends infer Entry
  ? Entry extends RunTranscriptEntry
    ? Omit<Entry, "at">
    : never
  : never;

export interface RunMessagingState {
  /** Whether this harness can accept input while a run is active. */
  supported: boolean;
  /** Whether a live transport currently owns an input channel. */
  editable: boolean;
  /** Bounded explanation when input is unavailable. */
  reason?: string;
}

/** Immutable public view of a tracked run. */
export interface RunSnapshot {
  id: string;
  title: string;
  harness: HarnessKind;
  status: RunStatus;
  createdAt: number;
  settledAt: number | undefined;
  /** Deterministic settlement order, assigned exactly once at settle time. */
  settlementSeq: number | undefined;
  workingDir: string | undefined;
  requestedModel: string | undefined;
  effectiveModel: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  cancelRequested: boolean;
  autoDeliver: boolean;
  consumption: ResultConsumption;
  usage: RunUsage | undefined;
}

/** Final, consumable result of a settled run. */
export interface RunResult {
  id: string;
  title: string;
  harness: HarnessKind;
  status: SettledRunStatus;
  /** Bounded final text; empty string when the run produced no output. */
  finalText: string;
  /** Bounded concise diagnostics for failed/cancelled runs. */
  errorText: string | undefined;
  effectiveModel: string | undefined;
  usage: RunUsage | undefined;
  createdAt: number;
  settledAt: number;
  durationMs: number;
  settlementSeq: number;
}

/** One row of subagent_list output. */
export interface RunListEntry {
  id: string;
  title: string;
  harness: HarnessKind;
  status: RunStatus;
  elapsedMs: number;
  model: string | undefined;
}

/** subagent_check output: status plus bounded recent activity, non-consuming. */
export interface RunInspection {
  id: string;
  title: string;
  harness: HarnessKind;
  status: RunStatus;
  createdAt: number;
  settledAt: number | undefined;
  elapsedMs: number;
  cancelRequested: boolean;
  model: string | undefined;
  usage: RunUsage | undefined;
  activity: readonly RunActivityEntry[];
  /** How many activity entries were dropped by the bounded buffer. */
  activityDropped: number;
  /** Detached bounded structured transcript in chronological order. */
  transcript: readonly RunTranscriptEntry[];
  /** How many older transcript entries were evicted from the bounded FIFO. */
  transcriptDropped: number;
  messaging: RunMessagingState;
  /** Bounded preview of the final text/diagnostics once settled. */
  resultPreview: string | undefined;
  consumption: ResultConsumption;
}

/** Per-id outcome of subagent_wait; unknown ids never hide valid results. */
export type WaitEntry =
  | { kind: "result"; id: string; result: RunResult }
  | { kind: "unknown"; id: string };

export interface WaitReport {
  /** One entry per requested id, in request order. */
  entries: WaitEntry[];
}

/** Per-id outcome of subagent_cancel. */
export type CancelEntry =
  | { id: string; outcome: "cancel-requested" }
  | { id: string; outcome: "already-settled"; status: SettledRunStatus }
  | { id: string; outcome: "unknown" };

export interface CancelReport {
  /** One entry per requested id, in request order. */
  entries: CancelEntry[];
}

/** Serialized run record for session persistence (duplicate-delivery guard). */
export interface PersistedRunRecord {
  id: string;
  serial: number;
  title: string;
  harness: HarnessKind;
  status: RunStatus;
  createdAt: number;
  settledAt: number | undefined;
  settlementSeq: number | undefined;
  workingDir: string | undefined;
  requestedModel: string | undefined;
  effectiveModel: string | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  cancelRequested: boolean;
  autoDeliver: boolean;
  consumption: ResultConsumption;
  finalText: string | undefined;
  errorText: string | undefined;
  usage: RunUsage | undefined;
  activity: RunActivityEntry[];
  activityDropped: number;
  /** Optional for backwards-compatible restore of version-1 snapshots. */
  transcript?: RunTranscriptEntry[];
  transcriptDropped?: number;
}

/** Whole serialized manager state, written through the persistence hook. */
export interface PersistedRunState {
  version: 1;
  nextSerial: number;
  nextSettlementSeq: number;
  runs: PersistedRunRecord[];
}
