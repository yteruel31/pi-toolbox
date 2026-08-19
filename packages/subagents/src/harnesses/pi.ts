import {
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

import type {
  HarnessRunOutcome,
  HarnessRunRequest,
  SubagentHarness,
} from "../core/harness.js";
import { SubagentError, describeError } from "../shared/errors.js";
import { truncateText } from "../shared/truncate.js";
import type { RunUsage, ThinkingLevel } from "../shared/types.js";

export const PI_TOOL_WATCHDOG_MS = 3 * 60 * 1_000;

const MAX_PROGRESS_CHARS = 400;
const MAX_TRANSCRIPT_PAYLOAD_CHARS = 4_000;
const MAX_FINAL_TEXT_CHARS = 50_000;
const MAX_MODEL_CHARS = 200;
const MAX_USAGE_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_COST_USD = 1_000_000_000;

/**
 * Names known to create nested agents, orchestrate workflows, or wait for
 * interactive user input. `isExcludedPiChildTool` also rejects their prefixes
 * so newly discovered variants are removed from the initial active tool set.
 */
export const PI_CHILD_EXCLUDED_TOOLS = [
  "subagent",
  "subagent_spawn",
  "subagent_wait",
  "subagent_cancel",
  "subagent_check",
  "subagent_list",
  "subagent_agents",
  "workflow",
  "workflow_run",
  "workflow_start",
  "workflow_spawn",
  "workflow_wait",
  "workflow_cancel",
  "multi_tool_use",
  "multi_tool_use.parallel",
  "ask_user",
  "ask-user",
  "ask_question",
  "question",
  "questionnaire",
  "user_question",
] as const;

const EXCLUDED_TOOL_NAMES = new Set<string>(PI_CHILD_EXCLUDED_TOOLS);
const EXCLUDED_TOOL_PREFIXES = [
  "subagent_",
  "workflow_",
  "ask_user_",
  "ask-user-",
  "ask_question_",
  "question_",
  "questionnaire_",
  "user_question_",
  "multi_tool_use.",
] as const;

export function isExcludedPiChildTool(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return (
    EXCLUDED_TOOL_NAMES.has(normalized) ||
    EXCLUDED_TOOL_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

export interface PiModelLike {
  provider: string;
  id: string;
  /** Runtime values retain any additional concrete Pi Model fields. */
}

export interface PiModelRuntimeLike {
  getModel(provider: string, modelId: string): PiModelLike | undefined;
  getAvailable(
    providerId?: string,
    options?: { signal?: AbortSignal },
  ): Promise<readonly PiModelLike[]>;
}

export type PiSessionEvent = AgentSessionEvent;

export interface PiSessionLike {
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  getActiveToolNames?(): string[];
  getAllTools?(): Array<{ name: string }>;
  setActiveToolsByName?(names: string[]): void;
}

export interface PiResourceContext {
  resourceLoader: unknown;
  sessionManager: unknown;
  settingsManager: unknown;
}

export interface PiResourceFactoryInput {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
  systemPrompt: string | undefined;
}

export type PiResourceFactory = (
  input: PiResourceFactoryInput,
) => Promise<PiResourceContext>;

export interface PiSessionCreateInput extends PiResourceContext {
  cwd: string;
  agentDir: string;
  model: PiModelLike | undefined;
  thinkingLevel: ThinkingLevel | undefined;
  excludeTools: readonly string[];
}

export type PiSessionFactory = (
  input: PiSessionCreateInput,
) => Promise<PiSessionLike>;

export interface PiHarnessOptions {
  /** Shared parent-process model runtime. */
  modelRuntime: PiModelRuntimeLike;
  /** Parent model inherited when a run doesn't request an override. */
  parentModel?: PiModelLike;
  /** Parent thinking level inherited when a run doesn't request an override. */
  parentThinkingLevel?: ThinkingLevel;
  /** Parent cwd used when a request doesn't provide one. */
  defaultWorkingDir: string;
  /** Trust decision for the child cwd. */
  isProjectTrusted: boolean | ((cwd: string) => boolean);
  agentDir?: string;
  /** Session seam for deterministic offline tests. */
  createSession?: PiSessionFactory;
  /** Resource seam for deterministic offline tests. */
  createResources?: PiResourceFactory;
  /** Defaults to exactly three minutes. Tests may inject a shorter interval. */
  toolWatchdogMs?: number;
}

export class PiHarness implements SubagentHarness {
  readonly kind = "pi" as const;
  readonly supportsActiveMessages = true;

  private readonly modelRuntime: PiModelRuntimeLike;
  private readonly parentModel: PiModelLike | undefined;
  private readonly parentThinkingLevel: ThinkingLevel | undefined;
  private readonly defaultWorkingDir: string;
  private readonly projectTrust: boolean | ((cwd: string) => boolean);
  private readonly agentDir: string;
  private readonly createSession: PiSessionFactory;
  private readonly createResources: PiResourceFactory;
  private readonly toolWatchdogMs: number;

  constructor(options: PiHarnessOptions) {
    this.modelRuntime = options.modelRuntime;
    this.parentModel = options.parentModel;
    this.parentThinkingLevel = options.parentThinkingLevel;
    this.defaultWorkingDir = options.defaultWorkingDir;
    this.projectTrust = options.isProjectTrusted;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.createSession = options.createSession ?? createOfficialPiSession;
    this.createResources = options.createResources ?? createOfficialPiResources;
    this.toolWatchdogMs = options.toolWatchdogMs ?? PI_TOOL_WATCHDOG_MS;

    if (!Number.isFinite(this.toolWatchdogMs) || this.toolWatchdogMs <= 0) {
      throw new TypeError("toolWatchdogMs must be a positive finite number.");
    }
  }

  async run(request: HarnessRunRequest): Promise<HarnessRunOutcome> {
    if (request.signal.aborted) {
      throw cancelledError("before it started");
    }

    const cwd = request.workingDir ?? this.defaultWorkingDir;
    const projectTrusted =
      typeof this.projectTrust === "function"
        ? this.projectTrust(cwd)
        : this.projectTrust;
    const model = await this.resolveModel(request.model, request.signal);

    if (request.signal.aborted) {
      throw cancelledError("during setup");
    }

    const resources = await this.createResources({
      cwd,
      agentDir: this.agentDir,
      projectTrusted,
      systemPrompt: request.systemPrompt,
    });

    let session: PiSessionLike | undefined;
    let unsubscribe: (() => void) | undefined;
    let abortListenerInstalled = false;
    let cleaned = false;
    let abortPromise: Promise<void> | undefined;
    let activeControl: { dispose(): void } | undefined;
    const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
    const observations = createObservationState();
    let watchdogError: SubagentError | undefined;
    let rejectWatchdog: ((error: SubagentError) => void) | undefined;
    const watchdogFailure = new Promise<never>((_resolve, reject) => {
      rejectWatchdog = reject;
    });
    let rejectCancellation: ((error: SubagentError) => void) | undefined;
    const cancellationFailure = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });

    const abortOnce = (): Promise<void> => {
      if (abortPromise !== undefined) return abortPromise;
      try {
        abortPromise = session
          ? Promise.resolve(session.abort()).catch(() => undefined)
          : Promise.resolve();
      } catch {
        abortPromise = Promise.resolve();
      }
      return abortPromise;
    };

    const clearWatchdog = (toolCallId: string): void => {
      const timer = watchdogs.get(toolCallId);
      if (timer !== undefined) clearTimeout(timer);
      watchdogs.delete(toolCallId);
    };

    const resetWatchdog = (toolCallId: string, toolName: string): void => {
      clearWatchdog(toolCallId);
      const timer = setTimeout(() => {
        watchdogs.delete(toolCallId);
        if (watchdogError !== undefined) return;
        watchdogError = new SubagentError(
          "pi_tool_timeout",
          `Pi child tool ${JSON.stringify(truncateText(toolName, 100))} (${JSON.stringify(truncateText(toolCallId, 100))}) made no progress for 3 minutes.`,
        );
        void abortOnce();
        rejectWatchdog?.(watchdogError);
      }, this.toolWatchdogMs);
      watchdogs.set(toolCallId, timer);
    };

    const onAbort = (): void => {
      void abortOnce();
      rejectCancellation?.(cancelledError("by request"));
    };

    const cleanup = async (): Promise<void> => {
      if (cleaned) return;
      cleaned = true;
      if (abortListenerInstalled) {
        request.signal.removeEventListener("abort", onAbort);
      }
      unsubscribe?.();
      unsubscribe = undefined;
      activeControl?.dispose();
      activeControl = undefined;
      for (const timer of watchdogs.values()) clearTimeout(timer);
      watchdogs.clear();
      if (request.signal.aborted || watchdogError !== undefined) {
        // Start native cancellation, but don't let a non-cooperative tool keep
        // the run slot forever. dispose() is the final synchronous backstop.
        void abortOnce();
      }
      session?.dispose();
      session = undefined;
    };

    try {
      session = await this.createSession({
        ...resources,
        cwd,
        agentDir: this.agentDir,
        model,
        thinkingLevel: request.thinkingLevel ?? this.parentThinkingLevel,
        excludeTools: PI_CHILD_EXCLUDED_TOOLS,
      });

      removeDiscoveredExcludedTools(session);

      unsubscribe = session.subscribe((event) => {
        observePiEvent(request, observations, event, {
          clearWatchdog,
          resetWatchdog,
        });
      });

      request.signal.addEventListener("abort", onAbort, { once: true });
      abortListenerInstalled = true;
      if (request.signal.aborted) onAbort();

      const ownedSession = session;
      let controlClosed = false;
      activeControl = {
        dispose() {
          controlClosed = true;
        },
      };
      const accepted = request.setActiveControl({
        async sendMessage(text) {
          if (controlClosed || request.signal.aborted || session !== ownedSession) {
            throw cancelledError("after its input channel closed");
          }
          await ownedSession.steer(text);
        },
        dispose: () => activeControl?.dispose(),
      });
      if (!accepted) {
        activeControl.dispose();
        throw cancelledError("before its input channel became active");
      }

      const promptPromise = session.prompt(request.prompt);
      await Promise.race([
        promptPromise,
        watchdogFailure,
        cancellationFailure,
      ]);

      if (watchdogError !== undefined) throw watchdogError;
      if (request.signal.aborted) throw cancelledError("by request");
      if (observations.lastStopReason === "error") {
        throw new SubagentError(
          "pi_child_error",
          observations.lastErrorMessage
            ? `Pi child model failed: ${truncateText(observations.lastErrorMessage, 350)}`
            : "Pi child model failed without diagnostics.",
        );
      }
      if (observations.lastStopReason === "aborted") {
        throw new SubagentError(
          "pi_child_aborted",
          "The Pi child model stopped with an aborted result.",
        );
      }
      if (!observations.sawAssistantMessage) {
        throw new SubagentError(
          "pi_no_result",
          "The Pi child session ended without emitting an assistant message.",
        );
      }

      const outcome: HarnessRunOutcome = {
        finalText: truncateText(
          observations.finalText,
          MAX_FINAL_TEXT_CHARS,
        ),
        usage: observations.usage,
      };
      if (observations.effectiveModel !== undefined) {
        outcome.effectiveModel = observations.effectiveModel;
      }
      return outcome;
    } catch (error) {
      if (watchdogError !== undefined) throw watchdogError;
      if (request.signal.aborted) {
        throw cancelledError(`by request: ${describeError(error)}`);
      }
      if (error instanceof SubagentError) throw error;
      throw new SubagentError(
        "pi_harness_failed",
        `Pi child session failed: ${describeError(error)}`,
      );
    } finally {
      await cleanup();
    }
  }

  private async resolveModel(
    requested: string | undefined,
    signal: AbortSignal,
  ): Promise<PiModelLike | undefined> {
    if (requested === undefined || requested.trim() === "") {
      return this.parentModel;
    }

    const requestedId = truncateText(requested.trim(), MAX_MODEL_CHARS);
    let available: readonly PiModelLike[];
    try {
      available = await this.modelRuntime.getAvailable(undefined, { signal });
    } catch {
      if (signal.aborted) throw cancelledError("during model resolution");
      throw new SubagentError(
        "pi_model_unavailable",
        `Couldn't verify availability of requested Pi model ${JSON.stringify(requestedId)}.`,
      );
    }

    const slash = requestedId.indexOf("/");
    let model: PiModelLike | undefined;
    if (slash > 0 && slash < requestedId.length - 1) {
      const provider = requestedId.slice(0, slash);
      const modelId = requestedId.slice(slash + 1);
      model = this.modelRuntime.getModel(provider, modelId);
    } else {
      const matches = available.filter((candidate) => candidate.id === requestedId);
      if (matches.length === 1) model = matches[0];
    }

    if (
      model === undefined ||
      !available.some(
        (candidate) =>
          candidate.provider === model?.provider && candidate.id === model.id,
      )
    ) {
      throw new SubagentError(
        "pi_model_unavailable",
        `Requested Pi model ${JSON.stringify(requestedId)} isn't available with the current model registry and authentication. Use a provider/model id from Pi's available models.`,
      );
    }
    return model;
  }
}

export async function createOfficialPiResources(
  input: PiResourceFactoryInput,
): Promise<PiResourceContext> {
  const settingsManager = SettingsManager.create(input.cwd, input.agentDir, {
    projectTrusted: input.projectTrusted,
  });
  const resourceLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager,
    // Child sessions must not execute extensions configured for the parent.
    // The inline safety extension below still loads when noExtensions is true.
    noExtensions: true,
    extensionFactories: [
      {
        name: "pi-subagents-child-safety",
        factory: (pi) => {
          pi.on("tool_call", (event) => {
            if (!isExcludedPiChildTool(event.toolName)) return;
            return {
              block: true,
              reason: `Tool ${JSON.stringify(truncateText(event.toolName, 100))} is disabled in Pi child sessions.`,
              terminate: true,
            };
          });
        },
      },
    ],
    appendSystemPromptOverride: (base) => {
      const prompt = input.systemPrompt?.trim();
      return prompt ? [...base, prompt] : base;
    },
  });
  await resourceLoader.reload({
    resolveProjectTrust: async () => input.projectTrusted,
  });
  return {
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(input.cwd),
  };
}

export async function createOfficialPiSession(
  input: PiSessionCreateInput,
): Promise<PiSessionLike> {
  const options: CreateAgentSessionOptions = {
    cwd: input.cwd,
    agentDir: input.agentDir,
    resourceLoader:
      input.resourceLoader as CreateAgentSessionOptions["resourceLoader"],
    sessionManager:
      input.sessionManager as CreateAgentSessionOptions["sessionManager"],
    settingsManager:
      input.settingsManager as CreateAgentSessionOptions["settingsManager"],
    excludeTools: [...input.excludeTools],
  };
  if (input.model !== undefined) {
    options.model = input.model as NonNullable<CreateAgentSessionOptions["model"]>;
  }
  if (input.thinkingLevel !== undefined) {
    options.thinkingLevel = input.thinkingLevel;
  }
  const { session } = await createAgentSession(options);
  return session as PiSessionLike;
}

function removeDiscoveredExcludedTools(session: PiSessionLike): void {
  if (
    session.getActiveToolNames === undefined ||
    session.setActiveToolsByName === undefined
  ) {
    return;
  }
  const active = session.getActiveToolNames();
  const filtered = active.filter((name) => !isExcludedPiChildTool(name));
  if (filtered.length !== active.length) {
    session.setActiveToolsByName(filtered);
  }
}

interface PiObservationState {
  sawAssistantMessage: boolean;
  finalText: string;
  effectiveModel: string | undefined;
  lastStopReason: string | undefined;
  lastErrorMessage: string | undefined;
  usage: RunUsage;
}

function createObservationState(): PiObservationState {
  return {
    sawAssistantMessage: false,
    finalText: "",
    effectiveModel: undefined,
    lastStopReason: undefined,
    lastErrorMessage: undefined,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
      turns: 0,
      contextTokens: 0,
    },
  };
}

interface WatchdogEvents {
  clearWatchdog(toolCallId: string): void;
  resetWatchdog(toolCallId: string, toolName: string): void;
}

function observePiEvent(
  request: HarnessRunRequest,
  state: PiObservationState,
  event: PiSessionEvent,
  watchdog: WatchdogEvents,
): void {
  switch (event.type) {
    case "agent_start":
      report(request, "pi child session started");
      request.reportTranscript({ kind: "status", text: "Pi child session started" });
      return;
    case "tool_execution_start":
      watchdog.resetWatchdog(event.toolCallId, event.toolName);
      report(request, `tool ${event.toolName} started`);
      request.reportTranscript({
        kind: "tool",
        toolName: event.toolName,
        phase: "start",
        callId: event.toolCallId,
        input: boundedPayload(event.args),
      });
      return;
    case "tool_execution_update":
      watchdog.resetWatchdog(event.toolCallId, event.toolName);
      report(request, `tool ${event.toolName} made progress`);
      request.reportTranscript({
        kind: "tool",
        toolName: event.toolName,
        phase: "update",
        callId: event.toolCallId,
        input: boundedPayload(event.args),
        output: boundedPayload(event.partialResult),
      });
      return;
    case "tool_execution_end":
      watchdog.clearWatchdog(event.toolCallId);
      report(
        request,
        `tool ${event.toolName} ${event.isError ? "failed" : "finished"}`,
      );
      request.reportTranscript({
        kind: "tool",
        toolName: event.toolName,
        phase: event.isError ? "error" : "complete",
        callId: event.toolCallId,
        output: boundedPayload(event.result),
      });
      return;
    case "message_end": {
      const message = event.message;
      if (message.role !== "assistant") return;
      state.sawAssistantMessage = true;
      state.finalText = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
      state.lastStopReason = message.stopReason;
      state.lastErrorMessage = message.errorMessage;
      const effectiveModel = truncateText(
        `${message.provider}/${message.model}`,
        MAX_MODEL_CHARS,
      );
      state.effectiveModel = effectiveModel;
      request.reportEffectiveModel(effectiveModel);
      addUsage(state.usage, message.usage);
      if (state.finalText.trim() !== "") {
        report(request, state.finalText);
        request.reportTranscript({ kind: "assistant", text: state.finalText });
      }
      return;
    }
    case "auto_retry_start":
      report(
        request,
        `pi child retry ${event.attempt}/${event.maxAttempts} scheduled`,
      );
      request.reportTranscript({
        kind: "status",
        text: `Pi retry ${event.attempt}/${event.maxAttempts} scheduled`,
      });
      return;
    case "compaction_start":
      report(request, `pi child compaction started (${event.reason})`);
      request.reportTranscript({
        kind: "status",
        text: `Pi compaction started (${event.reason})`,
      });
      return;
    case "compaction_end":
      report(
        request,
        `pi child compaction ${event.aborted ? "aborted" : "finished"}`,
      );
      request.reportTranscript({
        kind: "status",
        text: `Pi compaction ${event.aborted ? "aborted" : "finished"}`,
      });
      return;
    default:
      return;
  }
}

function addUsage(
  target: RunUsage,
  source: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { total: number };
  },
): void {
  target.input = boundedAdd(target.input, source.input, MAX_USAGE_COUNT);
  target.output = boundedAdd(target.output, source.output, MAX_USAGE_COUNT);
  target.cacheRead = boundedAdd(
    target.cacheRead,
    source.cacheRead,
    MAX_USAGE_COUNT,
  );
  target.cacheWrite = boundedAdd(
    target.cacheWrite,
    source.cacheWrite,
    MAX_USAGE_COUNT,
  );
  target.costUsd = boundedAdd(target.costUsd, source.cost.total, MAX_COST_USD);
  target.turns = boundedAdd(target.turns, 1, MAX_USAGE_COUNT);
  target.contextTokens = boundedNumber(source.totalTokens, MAX_USAGE_COUNT);
}

function boundedAdd(current: number, value: number, maximum: number): number {
  return Math.min(maximum, current + boundedNumber(value, maximum));
}

function boundedNumber(value: number, maximum: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(maximum, value);
}

function boundedPayload(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value === "string") return truncateText(value, MAX_TRANSCRIPT_PAYLOAD_CHARS);
  try {
    return truncateText(JSON.stringify(value, null, 2), MAX_TRANSCRIPT_PAYLOAD_CHARS);
  } catch {
    return "[unserializable tool payload]";
  }
}

function report(request: HarnessRunRequest, text: string): void {
  request.reportProgress(truncateText(text, MAX_PROGRESS_CHARS));
}

function cancelledError(detail: string): SubagentError {
  return new SubagentError(
    "pi_run_cancelled",
    `Pi child run cancelled ${detail}.`,
  );
}
