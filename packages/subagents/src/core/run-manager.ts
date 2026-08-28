/**
 * Core run manager / state machine for background subagent runs.
 *
 * Responsibilities (SPEC.md "Run lifecycle" and "Result delivery"):
 * - enforce a single global concurrency cap (default 4) across all harnesses
 *   and /btw side questions;
 * - assign stable session-local run ids in creation order;
 * - settle each run exactly once, tolerating completion/cancellation races;
 * - never leak an unobserved promise rejection;
 * - retain bounded recent activity for inspection;
 * - preserve deterministic creation and settlement ordering;
 * - queue unconsumed settled results for parent delivery exactly once, with
 *   de-duplication against explicit collection (subagent_wait) and against
 *   session reloads (via the injected persistence hook).
 *
 * The manager depends only on the injected SubagentHarness interface and the
 * injected persistence/delivery hooks. No Pi APIs, no timers, no I/O.
 */

import { BoundedLog } from "../shared/bounded-log.js";
import {
  ConcurrencyLimitError,
  InvalidArgumentError,
  UnknownRunError,
  WaitAbortedError,
  describeError,
} from "../shared/errors.js";
import {
  sanitizeTerminalText,
  truncateText,
  toDisplayTitle,
} from "../shared/truncate.js";
import {
  isSettledStatus,
  type CancelEntry,
  type CancelReport,
  type HarnessKind,
  type PersistedRunRecord,
  type PersistedRunState,
  type ResultConsumption,
  type RunActivityEntry,
  type RunInspection,
  type RunListEntry,
  type RunResult,
  type RunSnapshot,
  type RunStatus,
  type RunTranscriptEntry,
  type RunTranscriptInput,
  type RunUsage,
  type SettledRunStatus,
  type ThinkingLevel,
  type WaitEntry,
  type WaitReport,
} from "../shared/types.js";
import type {
  HarnessActiveControl,
  HarnessRunOutcome,
  SubagentHarness,
} from "./harness.js";

/** Injected side-effect hooks. All optional; all must never throw upward. */
export interface RunManagerHooks {
  /**
   * Called after every lifecycle mutation (spawn, settle, cancel request,
   * consumption change) with the full serializable state. The Pi adapter
   * writes it into a custom session entry so delivery de-duplication
   * survives session reloads. Not called on progress events.
   */
  persist?(state: PersistedRunState): void;
  /**
   * Called when the delivery queue gains items. The adapter schedules an
   * idle-time drain (Pi `agent_settled`) and then calls drainDeliveries().
   * The argument is the current queue size.
   */
  onDeliverableResults?(pendingCount: number): void;
  /** Called after bounded progress/model updates and lifecycle persistence. */
  onChange?(): void;
}

export interface RunManagerOptions {
  /** Global cap on active (unsettled) runs. Default 4. */
  maxActiveRuns?: number;
  /** Max retained activity entries per run. Default 20. */
  maxActivityEntries?: number;
  /** Max characters per activity entry. Default 400. */
  maxActivityTextChars?: number;
  /** Max retained structured transcript entries per run. Default 120. */
  maxTranscriptEntries?: number;
  /** Max characters retained in each transcript text field. Default 4000. */
  maxTranscriptTextChars?: number;
  /** Max user-message characters sent through an active transport. Default 100000. */
  maxActiveMessageChars?: number;
  /** Max characters of retained final text per run. Default 50000. */
  maxResultTextChars?: number;
  /** Max characters of retained error diagnostics per run. Default 2000. */
  maxErrorTextChars?: number;
  /** Max characters of the check() result preview. Default 700. */
  maxResultPreviewChars?: number;
  /** Millisecond clock, injectable for tests. Default Date.now. */
  clock?: () => number;
  hooks?: RunManagerHooks;
  /**
   * Previously persisted state to rehydrate. Settled runs are restored
   * as-is (keeping their consumption state, so already-delivered results
   * are not re-delivered). Runs that were still active become failed
   * records with an explicit interruption explanation, and are queued for
   * delivery unless suppressed.
   */
  restore?: PersistedRunState;
}

export interface SpawnRunRequest {
  /** Required, non-empty task text. */
  prompt: string;
  /** Resolved harness instance for this run. */
  harness: SubagentHarness;
  /** Short display title; defaults to a bounded first line of the prompt. */
  title?: string;
  /** Selected named-agent profile, separate from the display title. */
  agentProfile?: string;
  /** Optional named-agent system prompt, passed through to the harness. */
  systemPrompt?: string;
  /** Optional exact tool allowlist, passed through to the harness. */
  tools?: readonly string[];
  workingDir?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  /**
   * When false the settled result is never queued for parent delivery
   * (/btw side questions). Defaults to true.
   */
  autoDeliver?: boolean;
}

export interface WaitOptions {
  /** Abort the wait without consuming any result. */
  signal?: AbortSignal;
}

interface InternalRun {
  id: string;
  serial: number;
  title: string;
  agentProfile: string | undefined;
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
  abort: AbortController;
  supportsActiveMessages: boolean;
  activeControl: HarnessActiveControl | undefined;
  controlDisposed: boolean;
  activity: BoundedLog<RunActivityEntry>;
  transcript: BoundedLog<RunTranscriptEntry>;
  /** Wake callbacks of pending wait() calls. Cleared exactly once at settle. */
  waiters: Set<() => void>;
  /** Count of pending wait() calls holding this run out of the queue. */
  reservations: number;
}

const RUN_ID_PREFIX = "run-";

export class RunManager {
  private readonly maxActiveRuns: number;
  private readonly maxActivityEntries: number;
  private readonly maxActivityTextChars: number;
  private readonly maxTranscriptEntries: number;
  private readonly maxTranscriptTextChars: number;
  private readonly maxActiveMessageChars: number;
  private readonly maxResultTextChars: number;
  private readonly maxErrorTextChars: number;
  private readonly maxResultPreviewChars: number;
  private readonly clock: () => number;
  private readonly hooks: RunManagerHooks;

  private readonly runs = new Map<string, InternalRun>();
  /** Run ids in creation order. */
  private readonly creationOrder: string[] = [];
  /** Unconsumed settled runs awaiting parent delivery (drained in settlement order). */
  private readonly deliveryQueue = new Set<string>();
  private nextSerial = 1;
  private nextSettlementSeq = 1;
  private shutdownDone = false;

  constructor(options: RunManagerOptions = {}) {
    this.maxActiveRuns = options.maxActiveRuns ?? 4;
    this.maxActivityEntries = options.maxActivityEntries ?? 20;
    this.maxActivityTextChars = options.maxActivityTextChars ?? 400;
    this.maxTranscriptEntries = options.maxTranscriptEntries ?? 120;
    this.maxTranscriptTextChars = options.maxTranscriptTextChars ?? 4_000;
    this.maxActiveMessageChars = options.maxActiveMessageChars ?? 100_000;
    this.maxResultTextChars = options.maxResultTextChars ?? 50_000;
    this.maxErrorTextChars = options.maxErrorTextChars ?? 2_000;
    this.maxResultPreviewChars = options.maxResultPreviewChars ?? 700;
    this.clock = options.clock ?? Date.now;
    this.hooks = options.hooks ?? {};
    if (options.restore) this.restore(options.restore);
  }

  // ---------------------------------------------------------------- spawn

  /**
   * Start one run and return its snapshot immediately. Throws
   * ConcurrencyLimitError when the global cap is reached and
   * InvalidArgumentError on an empty prompt.
   */
  spawn(request: SpawnRunRequest): RunSnapshot {
    const prompt = typeof request.prompt === "string" ? request.prompt : "";
    if (prompt.trim() === "") {
      throw new InvalidArgumentError(
        "subagent_spawn requires a non-empty prompt.",
      );
    }
    if (this.activeCount() >= this.maxActiveRuns) {
      throw new ConcurrencyLimitError(this.maxActiveRuns);
    }

    const serial = this.nextSerial++;
    const run: InternalRun = {
      id: `${RUN_ID_PREFIX}${serial}`,
      serial,
      title:
        request.title !== undefined && request.title.trim() !== ""
          ? toDisplayTitle(sanitizeTerminalText(request.title))
          : toDisplayTitle(sanitizeTerminalText(prompt)),
      agentProfile: request.agentProfile === undefined
        ? undefined
        : toDisplayTitle(sanitizeTerminalText(request.agentProfile)),
      harness: request.harness.kind,
      status: "queued",
      createdAt: this.clock(),
      settledAt: undefined,
      settlementSeq: undefined,
      workingDir: request.workingDir,
      requestedModel: request.model,
      effectiveModel: undefined,
      thinkingLevel: request.thinkingLevel,
      cancelRequested: false,
      autoDeliver: request.autoDeliver !== false,
      consumption: request.autoDeliver === false ? "suppressed" : "none",
      finalText: undefined,
      errorText: undefined,
      usage: undefined,
      abort: new AbortController(),
      supportsActiveMessages: request.harness.supportsActiveMessages,
      activeControl: undefined,
      controlDisposed: false,
      activity: new BoundedLog(this.maxActivityEntries),
      transcript: new BoundedLog(this.maxTranscriptEntries),
      waiters: new Set(),
      reservations: 0,
    };
    run.transcript.push(this.normalizeTranscriptEntry({
      kind: "user",
      at: run.createdAt,
      text: prompt,
    }));
    run.transcript.push(this.normalizeTranscriptEntry({
      kind: "status",
      at: run.createdAt,
      status: "queued",
      text: "Run queued",
    }));
    this.runs.set(run.id, run);
    this.creationOrder.push(run.id);

    this.startRun(run, request);
    this.persist();
    return this.toSnapshot(run);
  }

  private startRun(run: InternalRun, request: SpawnRunRequest): void {
    run.status = "running";
    run.transcript.push(this.normalizeTranscriptEntry({
      kind: "status",
      at: this.clock(),
      status: "running",
      text: "Run started",
    }));
    let promise: Promise<HarnessRunOutcome>;
    try {
      promise = Promise.resolve(
        request.harness.run({
          runId: run.id,
          prompt: request.prompt,
          systemPrompt: request.systemPrompt,
          tools: request.tools,
          workingDir: request.workingDir,
          model: request.model,
          thinkingLevel: request.thinkingLevel,
          signal: run.abort.signal,
          reportProgress: (text) => this.recordProgress(run, text),
          reportTranscript: (entry) => this.recordTranscript(run, entry),
          reportEffectiveModel: (model) => {
            if (!this.isSettled(run)) {
              run.effectiveModel = truncateText(sanitizeTerminalText(String(model)), 200);
              this.hooks.onChange?.();
            }
          },
          setActiveControl: (control) => this.attachActiveControl(run, control),
        }),
      );
    } catch (err) {
      // Synchronous harness throw: settle failed without leaking.
      this.settleFromError(run, err);
      return;
    }
    // Both branches observed: an internal rejection can never go unhandled.
    promise.then(
      (outcome) => this.settleFromOutcome(run, outcome),
      (err) => this.settleFromError(run, err),
    );
  }

  private recordProgress(run: InternalRun, text: string): void {
    if (this.isSettled(run)) return;
    run.activity.push({
      at: this.clock(),
      text: truncateText(
        sanitizeTerminalText(String(text)),
        this.maxActivityTextChars,
      ),
    });
    this.hooks.onChange?.();
  }

  private recordTranscript(
    run: InternalRun,
    entry: RunTranscriptInput,
  ): void {
    if (this.isSettled(run)) return;
    run.transcript.push(this.normalizeTranscriptEntry({
      ...entry,
      at: this.clock(),
    } as RunTranscriptEntry));
    this.hooks.onChange?.();
  }

  private normalizeTranscriptEntry(entry: RunTranscriptEntry): RunTranscriptEntry {
    const bound = (value: string) => truncateText(
      sanitizeTerminalText(String(value)),
      this.maxTranscriptTextChars,
    );
    switch (entry.kind) {
      case "status":
        return {
          kind: "status",
          at: entry.at,
          text: bound(entry.text),
          ...(entry.status ? { status: entry.status } : {}),
        };
      case "user":
      case "assistant":
        return { kind: entry.kind, at: entry.at, text: bound(entry.text) };
      case "tool":
        return {
          kind: "tool",
          at: entry.at,
          toolName: bound(entry.toolName),
          phase: entry.phase,
          ...(entry.callId ? { callId: bound(entry.callId) } : {}),
          ...(entry.input !== undefined ? { input: bound(entry.input) } : {}),
          ...(entry.output !== undefined ? { output: bound(entry.output) } : {}),
        };
    }
  }

  private attachActiveControl(
    run: InternalRun,
    control: HarnessActiveControl,
  ): boolean {
    if (this.isSettled(run) || run.controlDisposed || run.activeControl) {
      this.disposeControlSafely(control);
      return false;
    }
    run.activeControl = control;
    this.hooks.onChange?.();
    return true;
  }

  private disposeActiveControl(run: InternalRun): void {
    if (run.controlDisposed) return;
    run.controlDisposed = true;
    const control = run.activeControl;
    run.activeControl = undefined;
    if (control) this.disposeControlSafely(control);
  }

  private disposeControlSafely(control: HarnessActiveControl): void {
    try {
      void Promise.resolve(control.dispose()).catch(() => undefined);
    } catch {
      // A broken transport cleanup must not block lifecycle settlement.
    }
  }

  // ------------------------------------------------------------ settlement

  private isSettled(run: InternalRun): boolean {
    return isSettledStatus(run.status);
  }

  private settleFromOutcome(run: InternalRun, outcome: HarnessRunOutcome): void {
    if (this.isSettled(run)) return;
    const finalText = truncateText(
      sanitizeTerminalText(
        typeof outcome?.finalText === "string" ? outcome.finalText : "",
      ),
      this.maxResultTextChars,
    );
    if (outcome?.effectiveModel !== undefined) {
      run.effectiveModel = truncateText(
        sanitizeTerminalText(outcome.effectiveModel),
        200,
      );
    }
    run.usage = outcome?.usage;
    if (run.cancelRequested) {
      // Completion/cancellation race: cancellation was requested first, so
      // the terminal state is cancelled; produced output is preserved as
      // partial diagnostics.
      this.settle(run, "cancelled", finalText, "cancelled by request");
    } else {
      this.settle(run, "completed", finalText, undefined);
    }
  }

  private settleFromError(run: InternalRun, err: unknown): void {
    if (this.isSettled(run)) return;
    const diagnostics = truncateText(
      sanitizeTerminalText(describeError(err)),
      this.maxErrorTextChars,
    );
    if (run.cancelRequested || this.isAbortLike(err, run)) {
      this.settle(run, "cancelled", "", diagnostics);
    } else {
      this.settle(run, "failed", "", diagnostics);
    }
  }

  private isAbortLike(err: unknown, run: InternalRun): boolean {
    if (!run.abort.signal.aborted) return false;
    return err instanceof Error && err.name === "AbortError";
  }

  /** The single settlement point. Runs exactly once per run. */
  private settle(
    run: InternalRun,
    status: SettledRunStatus,
    finalText: string,
    errorText: string | undefined,
  ): void {
    if (this.isSettled(run)) return;
    const settledAt = this.clock();
    run.transcript.push(this.normalizeTranscriptEntry({
      kind: "status",
      at: settledAt,
      status,
      text: `Run ${status}`,
    }));
    run.status = status;
    run.settledAt = settledAt;
    run.settlementSeq = this.nextSettlementSeq++;
    run.finalText = finalText;
    run.errorText =
      errorText === undefined
        ? undefined
        : truncateText(sanitizeTerminalText(errorText), this.maxErrorTextChars);

    // Cleanup exactly once: wake and drop waiters; the abort controller is
    // left as-is (aborting a settled run is a no-op for the harness).
    const waiters = [...run.waiters];
    run.waiters.clear();
    this.disposeActiveControl(run);

    // Delivery: queue unless suppressed or reserved by a pending wait().
    let queued = false;
    if (run.autoDeliver && run.consumption === "none" && run.reservations === 0) {
      this.deliveryQueue.add(run.id);
      queued = true;
    }

    this.persist();
    for (const wake of waiters) wake();
    if (queued) this.hooks.onDeliverableResults?.(this.deliveryQueue.size);
  }

  // ------------------------------------------------------------------ wait

  /**
   * Wait until every referenced run settles, then consume and return the
   * results in request order. Unknown ids are reported alongside valid
   * results. Consumed results are removed from the delivery queue and never
   * auto-delivered afterwards. An aborted wait consumes nothing.
   */
  async wait(ids: readonly string[], options: WaitOptions = {}): Promise<WaitReport> {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new InvalidArgumentError(
        "subagent_wait requires a non-empty array of run ids.",
      );
    }
    const signal = options.signal;
    if (signal?.aborted) throw new WaitAbortedError();

    const known: InternalRun[] = [];
    for (const id of new Set(ids)) {
      const run = this.runs.get(id);
      if (run) known.push(run);
    }

    // Reserve: pull already-settled results out of the delivery queue and
    // keep future settlements from entering it while this wait is pending.
    for (const run of known) {
      run.reservations++;
      this.deliveryQueue.delete(run.id);
    }

    try {
      await this.allSettled(known, signal);
    } catch (err) {
      // Aborted: release reservations and re-queue any settled, unconsumed
      // results so they are still auto-delivered (in settlement order).
      let requeued = false;
      for (const run of known) {
        run.reservations--;
        if (
          this.isSettled(run) &&
          run.autoDeliver &&
          run.consumption === "none" &&
          run.reservations === 0
        ) {
          this.deliveryQueue.add(run.id);
          requeued = true;
        }
      }
      if (requeued) {
        this.persist();
        this.hooks.onDeliverableResults?.(this.deliveryQueue.size);
      }
      throw err;
    }

    // Success: consume exactly once (first consumer wins, later waits still
    // read the retained record).
    let mutated = false;
    for (const run of known) {
      run.reservations--;
      this.deliveryQueue.delete(run.id);
      if (run.consumption === "none") {
        run.consumption = "waited";
        mutated = true;
      }
    }
    if (mutated) this.persist();

    return {
      entries: ids.map((id): WaitEntry => {
        const run = this.runs.get(id);
        return run
          ? { kind: "result", id, result: this.toResult(run) }
          : { kind: "unknown", id };
      }),
    };
  }

  private allSettled(
    runs: readonly InternalRun[],
    signal: AbortSignal | undefined,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const pending = runs.filter((run) => !this.isSettled(run));
      if (pending.length === 0) {
        resolve();
        return;
      }
      let remaining = pending.length;
      const registrations: Array<{ run: InternalRun; wake: () => void }> = [];
      const cleanup = () => {
        signal?.removeEventListener("abort", onAbort);
        for (const { run, wake } of registrations) run.waiters.delete(wake);
      };
      const onAbort = () => {
        cleanup();
        reject(new WaitAbortedError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      for (const run of pending) {
        const wake = () => {
          remaining--;
          if (remaining === 0) {
            cleanup();
            resolve();
          }
        };
        registrations.push({ run, wake });
        run.waiters.add(wake);
      }
    });
  }

  // ---------------------------------------------------------- active input

  /** Send one user message through the existing active child transport. */
  async sendMessage(id: string, text: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run) throw new UnknownRunError(id);
    const message = truncateText(
      sanitizeTerminalText(typeof text === "string" ? text : ""),
      this.maxActiveMessageChars,
    );
    if (message.trim() === "") {
      throw new InvalidArgumentError("Subagent messages cannot be empty.");
    }
    if (this.isSettled(run)) {
      throw new InvalidArgumentError(
        `Run ${id} is already ${run.status}; its transcript is read-only.`,
      );
    }
    if (!run.supportsActiveMessages) {
      throw new InvalidArgumentError(
        `Run ${id} uses a harness that does not support active messages.`,
      );
    }
    const control = run.activeControl;
    if (!control || run.controlDisposed) {
      throw new InvalidArgumentError(
        `Run ${id} is active but its messaging transport is not ready.`,
      );
    }
    try {
      await control.sendMessage(message);
    } catch (error) {
      throw new InvalidArgumentError(
        truncateText(
          `Could not send a message to ${id}: ${describeError(error)}`,
          this.maxErrorTextChars,
        ),
      );
    }
    if (this.isSettled(run) || run.controlDisposed || run.activeControl !== control) {
      throw new InvalidArgumentError(
        `Run ${id} settled before the message could be accepted.`,
      );
    }
    run.transcript.push(this.normalizeTranscriptEntry({
      kind: "user",
      at: this.clock(),
      text: message,
    }));
    this.hooks.onChange?.();
  }

  // ---------------------------------------------------------------- cancel

  /**
   * Request cancellation. Idempotent for settled runs, tolerant of unknown
   * ids, never deletes run records. Active runs settle when their harness
   * observes the abort signal; the settle path preserves partial output.
   */
  cancel(ids: readonly string[]): CancelReport {
    if (!Array.isArray(ids) || ids.length === 0) {
      throw new InvalidArgumentError(
        "subagent_cancel requires a non-empty array of run ids.",
      );
    }
    let mutated = false;
    const entries = ids.map((id): CancelEntry => {
      const run = this.runs.get(id);
      if (!run) return { id, outcome: "unknown" };
      if (this.isSettled(run)) {
        return {
          id,
          outcome: "already-settled",
          status: run.status as SettledRunStatus,
        };
      }
      if (!run.cancelRequested) {
        run.cancelRequested = true;
        mutated = true;
        run.transcript.push(this.normalizeTranscriptEntry({
          kind: "status",
          at: this.clock(),
          text: "Cancellation requested",
        }));
        run.abort.abort(new Error("cancelled by subagent_cancel"));
      }
      if (run.status === "queued") {
        // Defensive: with synchronous start this state is unreachable, but a
        // queued run must never wait on a harness that was never invoked.
        this.settle(run, "cancelled", "", "cancelled before start");
      }
      return { id, outcome: "cancel-requested" };
    });
    if (mutated) this.persist();
    return { entries };
  }

  // ----------------------------------------------------------- inspection

  /** One run's status plus bounded recent activity. Non-consuming. */
  check(id: string): RunInspection {
    const run = this.runs.get(id);
    if (!run) throw new UnknownRunError(id);
    const settled = this.isSettled(run);
    const previewSource = settled
      ? run.errorText !== undefined && run.errorText !== ""
        ? `${run.status}: ${run.errorText}`
        : run.finalText ?? ""
      : undefined;
    const activity = Object.freeze(
      run.activity.entries().map((entry) => Object.freeze({ ...entry })),
    );
    const transcript = Object.freeze(
      run.transcript.entries().map((entry) => Object.freeze({ ...entry })),
    );
    const messaging = Object.freeze(this.messagingState(run));
    const usage = run.usage ? Object.freeze({ ...run.usage }) : undefined;
    return Object.freeze({
      id: run.id,
      title: run.title,
      agentProfile: run.agentProfile,
      harness: run.harness,
      status: run.status,
      createdAt: run.createdAt,
      settledAt: run.settledAt,
      elapsedMs: this.elapsedMs(run),
      cancelRequested: run.cancelRequested,
      model: run.effectiveModel ?? run.requestedModel,
      usage,
      activity,
      activityDropped: run.activity.dropped,
      transcript,
      transcriptDropped: run.transcript.dropped,
      messaging,
      resultPreview:
        previewSource === undefined
          ? undefined
          : truncateText(previewSource, this.maxResultPreviewChars),
      consumption: run.consumption,
    });
  }

  private messagingState(run: InternalRun): RunInspection["messaging"] {
    if (this.isSettled(run)) {
      return {
        supported: run.supportsActiveMessages,
        editable: false,
        reason: `Run ${run.status}; transcript is read-only.`,
      };
    }
    if (!run.supportsActiveMessages) {
      return {
        supported: false,
        editable: false,
        reason: "This harness does not support active messages.",
      };
    }
    if (!run.activeControl || run.controlDisposed) {
      return {
        supported: true,
        editable: false,
        reason: "Messaging transport is starting.",
      };
    }
    return { supported: true, editable: true };
  }

  /** All tracked runs in creation order. */
  list(): RunListEntry[] {
    return this.creationOrder.map((id) => {
      const run = this.runs.get(id)!;
      return {
        id: run.id,
        title: run.title,
        agentProfile: run.agentProfile,
        harness: run.harness,
        status: run.status,
        elapsedMs: this.elapsedMs(run),
        model: run.effectiveModel ?? run.requestedModel,
      };
    });
  }

  /** Snapshot of a single run. Throws UnknownRunError. */
  snapshot(id: string): RunSnapshot {
    const run = this.runs.get(id);
    if (!run) throw new UnknownRunError(id);
    return this.toSnapshot(run);
  }

  /** Number of unsettled runs, the quantity the global cap applies to. */
  activeCount(): number {
    let count = 0;
    for (const run of this.runs.values()) {
      if (!this.isSettled(run)) count++;
    }
    return count;
  }

  // ------------------------------------------------------------- delivery

  /** Current number of settled results awaiting parent delivery. */
  pendingDeliveryCount(): number {
    return this.deliveryQueue.size;
  }

  /**
   * Atomically remove every queued result, mark each as delivered, and
   * return them in settlement order. The adapter calls this once the parent
   * is idle; a second call returns nothing until new results settle.
   */
  drainDeliveries(): RunResult[] {
    if (this.deliveryQueue.size === 0) return [];
    const drained = [...this.deliveryQueue]
      .map((id) => this.runs.get(id)!)
      .sort((a, b) => (a.settlementSeq ?? 0) - (b.settlementSeq ?? 0));
    this.deliveryQueue.clear();
    for (const run of drained) run.consumption = "delivered";
    this.persist();
    return drained.map((run) => this.toResult(run));
  }

  // ------------------------------------------------------------- shutdown

  /**
   * Abort and settle every active run as cancelled with an explicit
   * interruption explanation. Idempotent; safe to call from a Pi
   * session_shutdown handler.
   */
  shutdown(reason = "parent session shutdown"): void {
    if (this.shutdownDone) return;
    this.shutdownDone = true;
    const boundedReason = truncateText(reason, 200);
    for (const id of this.creationOrder) {
      const run = this.runs.get(id)!;
      if (this.isSettled(run)) continue;
      run.cancelRequested = true;
      run.abort.abort(new Error(boundedReason));
      this.settle(
        run,
        "cancelled",
        "",
        `interrupted by ${boundedReason}; background runs are not resumed`,
      );
    }
  }

  // ---------------------------------------------------------- persistence

  /** Full serializable state, also passed to the persist hook. */
  snapshotState(): PersistedRunState {
    return {
      version: 1,
      nextSerial: this.nextSerial,
      nextSettlementSeq: this.nextSettlementSeq,
      runs: this.creationOrder.map((id) => {
        const run = this.runs.get(id)!;
        return {
          id: run.id,
          serial: run.serial,
          title: run.title,
          agentProfile: run.agentProfile,
          harness: run.harness,
          status: run.status,
          createdAt: run.createdAt,
          settledAt: run.settledAt,
          settlementSeq: run.settlementSeq,
          workingDir: run.workingDir,
          requestedModel: run.requestedModel,
          effectiveModel: run.effectiveModel,
          thinkingLevel: run.thinkingLevel,
          cancelRequested: run.cancelRequested,
          autoDeliver: run.autoDeliver,
          consumption: run.consumption,
          finalText: run.finalText,
          errorText: run.errorText,
          usage: run.usage,
          activity: run.activity.entries().map((entry) => ({ ...entry })),
          activityDropped: run.activity.dropped,
          transcript: run.transcript.entries().map((entry) => ({ ...entry })),
          transcriptDropped: run.transcript.dropped,
        } satisfies PersistedRunRecord;
      }),
    };
  }

  private persist(): void {
    this.hooks.persist?.(this.snapshotState());
    this.hooks.onChange?.();
  }

  private restore(state: PersistedRunState): void {
    let maxSerial = 0;
    let maxSeq = 0;
    for (const record of state.runs) {
      maxSerial = Math.max(maxSerial, record.serial);
      const run: InternalRun = {
        id: record.id,
        serial: record.serial,
        title: record.title,
        agentProfile: record.agentProfile,
        harness: record.harness,
        status: record.status,
        createdAt: record.createdAt,
        settledAt: record.settledAt,
        settlementSeq: record.settlementSeq,
        workingDir: record.workingDir,
        requestedModel: record.requestedModel,
        effectiveModel: record.effectiveModel,
        thinkingLevel: record.thinkingLevel,
        cancelRequested: record.cancelRequested,
        autoDeliver: record.autoDeliver,
        consumption: record.consumption,
        finalText: record.finalText,
        errorText: record.errorText,
        usage: record.usage,
        abort: new AbortController(),
        supportsActiveMessages: false,
        activeControl: undefined,
        controlDisposed: true,
        activity: BoundedLog.from(
          this.maxActivityEntries,
          record.activity.map((entry) => ({
            at: entry.at,
            text: truncateText(
              sanitizeTerminalText(entry.text),
              this.maxActivityTextChars,
            ),
          })),
          record.activityDropped,
        ),
        transcript: BoundedLog.from(
          this.maxTranscriptEntries,
          (record.transcript ?? record.activity.map((entry) => ({
            kind: "status" as const,
            at: entry.at,
            text: entry.text,
          }))).map((entry) => this.normalizeTranscriptEntry(entry)),
          record.transcriptDropped ?? record.activityDropped,
        ),
        waiters: new Set(),
        reservations: 0,
      };
      this.runs.set(run.id, run);
      this.creationOrder.push(run.id);
      if (run.settlementSeq !== undefined) {
        maxSeq = Math.max(maxSeq, run.settlementSeq);
      }
    }
    this.nextSerial = Math.max(state.nextSerial, maxSerial + 1);
    this.nextSettlementSeq = Math.max(state.nextSettlementSeq, maxSeq + 1);

    // Interrupted runs: processes are not resumed across reloads; they
    // become explicit failed records (settled now, in creation order).
    for (const id of this.creationOrder) {
      const run = this.runs.get(id)!;
      if (!this.isSettled(run)) {
        run.cancelRequested = true;
        run.abort.abort(new Error("session reload"));
        this.settleInterrupted(run);
      } else if (run.autoDeliver && run.consumption === "none") {
        // Settled before the reload but never delivered nor collected:
        // still owed to the parent, exactly once.
        this.deliveryQueue.add(run.id);
      }
    }
  }

  private settleInterrupted(run: InternalRun): void {
    // Same invariants as settle(), but bypasses the shutdown guard and uses
    // "failed" per SPEC restart semantics.
    const settledAt = this.clock();
    run.transcript.push(this.normalizeTranscriptEntry({
      kind: "status",
      at: settledAt,
      status: "failed",
      text: "Run interrupted by session reload",
    }));
    run.status = "failed";
    run.settledAt = settledAt;
    run.settlementSeq = this.nextSettlementSeq++;
    run.finalText = "";
    run.errorText =
      "interrupted: the parent Pi session was restarted before this run finished; background runs are not resumed";
    this.disposeActiveControl(run);
    if (run.autoDeliver && run.consumption === "none") {
      this.deliveryQueue.add(run.id);
    }
  }

  // -------------------------------------------------------------- mapping

  private elapsedMs(run: InternalRun): number {
    const end = run.settledAt ?? this.clock();
    return Math.max(0, end - run.createdAt);
  }

  private toSnapshot(run: InternalRun): RunSnapshot {
    return {
      id: run.id,
      title: run.title,
      agentProfile: run.agentProfile,
      harness: run.harness,
      status: run.status,
      createdAt: run.createdAt,
      settledAt: run.settledAt,
      settlementSeq: run.settlementSeq,
      workingDir: run.workingDir,
      requestedModel: run.requestedModel,
      effectiveModel: run.effectiveModel,
      thinkingLevel: run.thinkingLevel,
      cancelRequested: run.cancelRequested,
      autoDeliver: run.autoDeliver,
      consumption: run.consumption,
      usage: run.usage,
    };
  }

  private toResult(run: InternalRun): RunResult {
    if (!this.isSettled(run) || run.settledAt === undefined || run.settlementSeq === undefined) {
      throw new InvalidArgumentError(
        `internal: run ${run.id} is not settled and has no result`,
      );
    }
    return {
      id: run.id,
      title: run.title,
      agentProfile: run.agentProfile,
      harness: run.harness,
      status: run.status as SettledRunStatus,
      finalText: run.finalText ?? "",
      errorText: run.errorText,
      effectiveModel: run.effectiveModel,
      usage: run.usage,
      createdAt: run.createdAt,
      settledAt: run.settledAt,
      durationMs: Math.max(0, run.settledAt - run.createdAt),
      settlementSeq: run.settlementSeq,
    };
  }
}
