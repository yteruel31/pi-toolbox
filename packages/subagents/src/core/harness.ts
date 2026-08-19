/**
 * The harness contract the core depends on. Concrete harnesses (in-process
 * Pi session and headless Claude Code session) implement this contract;
 * the core never imports Pi or Claude SDK APIs.
 */

import type {
  HarnessKind,
  RunTranscriptInput,
  RunUsage,
  ThinkingLevel,
} from "../shared/types.js";

export interface HarnessActiveControl {
  /** Send one non-empty user message through the existing child transport. */
  sendMessage(text: string): Promise<void>;
  /** Release the live input channel. Must be idempotent. */
  dispose(): void | Promise<void>;
}

/** Everything a harness receives to execute one run. */
export interface HarnessRunRequest {
  /** Stable session-local run id, for logging/diagnostics only. */
  runId: string;
  /** The task text. Non-empty; validated by the manager. */
  prompt: string;
  /** Optional named-agent system prompt, delivered before the task. */
  systemPrompt: string | undefined;
  /** Directory the child runs in; validated by the spawn tool layer. */
  workingDir: string | undefined;
  /** Requested model id/alias; undefined means inherit the parent default. */
  model: string | undefined;
  /** Requested thinking level; undefined means inherit the parent default. */
  thinkingLevel: ThinkingLevel | undefined;
  /**
   * Cancellation signal. Contract: once this aborts, the returned promise
   * MUST settle (resolve with partial output or reject). The manager never
   * force-settles a run on its own, so a harness that ignores abort leaks
   * the run slot. Harness-level watchdogs enforce this in practice.
   */
  signal: AbortSignal;
  /**
   * Report one line of progress. The manager bounds and buffers it; calls
   * after settlement are ignored. Never throws.
   */
  reportProgress(text: string): void;
  /** Report a structured event. The manager sanitizes and bounds every field. */
  reportTranscript(entry: RunTranscriptInput): void;
  /** Report the effective model once known. Calls after settlement ignored. */
  reportEffectiveModel(model: string): void;
  /**
   * Hand ownership of a live input channel to the manager. Returns false when
   * the run already settled; the harness must then dispose the control.
   */
  setActiveControl(control: HarnessActiveControl): boolean;
}

/** What a harness returns when a run finishes on its own. */
export interface HarnessRunOutcome {
  /** Final assistant text; empty string when the child produced none. */
  finalText: string;
  /** Effective model, when known. */
  effectiveModel?: string;
  /** Combined usage of the child's LLM calls, when available. */
  usage?: RunUsage;
}

/**
 * One execution backend. `run` is called at most once per run; resource
 * cleanup for a given call (sessions, timers, listeners) is the harness's
 * job and must happen exactly once, on both settle paths.
 */
export interface SubagentHarness {
  readonly kind: HarnessKind;
  /** Explicit capability flag; false means active details are read-only. */
  readonly supportsActiveMessages: boolean;
  run(request: HarnessRunRequest): Promise<HarnessRunOutcome>;
}

/**
 * Resolves a harness kind to a usable instance. An adapter throws a bounded
 * error when a harness is
 * unavailable (e.g. Claude SDK not installed or not authenticated).
 */
export interface HarnessResolver {
  resolve(kind: HarnessKind): SubagentHarness;
}
