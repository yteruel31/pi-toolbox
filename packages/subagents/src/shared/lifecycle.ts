import type { HarnessKind, PersistedRunState, RunStatus } from "./types.js";

export const SUBAGENTS_LIFECYCLE_CHANNEL = "pi-toolbox:subagents:lifecycle";
export const SUBAGENTS_LIFECYCLE_REQUEST_CHANNEL = "pi-toolbox:subagents:lifecycle:request";

/** Deliberately excludes prompts, transcripts, paths, output, and diagnostics. */
export interface SubagentLifecycleRun {
  id: string;
  label: string;
  toolCallId?: string;
  harness: HarnessKind;
  status: RunStatus;
  createdAt: number;
  settledAt?: number;
}

interface LifecycleEnvelope {
  v: 1;
  sessionId: string;
  /** Unique publisher lifetime, including reloads of the same session. */
  sourceId: string;
  sequence: number;
}

export type SubagentsLifecycleEvent = LifecycleEnvelope & (
  | { kind: "snapshot"; runs: SubagentLifecycleRun[] }
  | { kind: "upsert"; run: SubagentLifecycleRun }
  | { kind: "clear" }
);

/** A small projection, not a second run registry or a transport. */
export class LifecyclePublisher {
  private runs = new Map<string, SubagentLifecycleRun>();
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly sessionId: string,
    private readonly sourceId: string,
    private readonly emit: (event: SubagentsLifecycleEvent) => void,
  ) {}

  update(state: PersistedRunState): void {
    if (this.closed) return;
    for (const record of state.runs) {
      const run: SubagentLifecycleRun = {
        id: record.id,
        label: record.origin?.label ?? `Subagent ${record.id}`,
        ...(record.origin ? { toolCallId: record.origin.toolCallId } : {}),
        harness: record.harness,
        status: record.status,
        createdAt: record.createdAt,
        ...(record.settledAt === undefined ? {} : { settledAt: record.settledAt }),
      };
      if (JSON.stringify(this.runs.get(run.id)) === JSON.stringify(run)) continue;
      this.runs.set(run.id, run);
      this.send({ kind: "upsert", run: { ...run } });
    }
  }

  snapshot(): void {
    if (!this.closed) this.send({ kind: "snapshot", runs: [...this.runs.values()].map((run) => ({ ...run })) });
  }

  clear(): void {
    if (this.closed) return;
    this.closed = true;
    this.runs.clear();
    this.send({ kind: "clear" });
  }

  private send(payload: { kind: "snapshot"; runs: SubagentLifecycleRun[] } | { kind: "upsert"; run: SubagentLifecycleRun } | { kind: "clear" }): void {
    try {
      this.emit({ v: 1, sessionId: this.sessionId, sourceId: this.sourceId, sequence: ++this.sequence, ...payload });
    } catch {
      // A host observer must never affect execution or result delivery.
    }
  }
}
