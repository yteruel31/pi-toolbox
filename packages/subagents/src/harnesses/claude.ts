/**
 * Claude harness: runs one subagent task as a headless Claude Code session
 * through `@anthropic-ai/claude-agent-sdk`.
 *
 * Clean-room note: written only from SPEC.md, ARCHITECTURE.md, and the
 * installed SDK's public type declarations/docs (see reference/claude-sdk.md).
 *
 * Design points, per SPEC "Claude harness":
 * - The SDK is an OPTIONAL peer dependency. It is loaded lazily behind an
 *   injected query factory, so the Pi harness (and this module's import)
 *   works without it; a missing SDK surfaces as a bounded run failure.
 * - Headless execution bypasses permission prompts. That requires BOTH
 *   `permissionMode: "bypassPermissions"` and the SDK's explicit
 *   `allowDangerouslySkipPermissions: true` acknowledgement flag; this is
 *   disclosed prominently in the package description/README.
 * - `settingSources: []` isolates the child from user/project filesystem
 *   settings. Justification: those settings can inject hooks, MCP servers,
 *   and permission rules that block or silently mutate a headless run; the
 *   only intended customization channel is the named agent's system prompt.
 *   Tradeoff (documented): CLAUDE.md does not load either.
 * - `persistSession: false`: child transcripts are throwaway; nothing is
 *   written under ~/.claude/projects.
 * - The run's AbortSignal is bridged to a fresh per-call AbortController
 *   handed to the SDK, and query cleanup (listener removal, controller
 *   abort, input closure, `query.close()`) happens exactly once on every settle path.
 */

import type {
  HarnessRunOutcome,
  HarnessRunRequest,
  SubagentHarness,
} from "../core/harness.js";
import { SubagentError, describeError } from "../shared/errors.js";
import { truncateText } from "../shared/truncate.js";
import type { RunUsage, ThinkingLevel } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Structural types for the slice of the Claude Agent SDK surface we consume.
// Local declarations (not imports) so this module typechecks when the
// optional SDK is absent; shapes follow the SDK's public sdk.d.ts.
// ---------------------------------------------------------------------------

/** SDK `EffortLevel`. */
export type ClaudeEffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** The subset of SDK `Options` this harness sets. */
export interface ClaudeQueryOptions {
  cwd?: string;
  model?: string;
  effort?: ClaudeEffortLevel;
  thinking?: { type: "disabled" };
  systemPrompt: {
    type: "preset";
    preset: "claude_code";
    append?: string;
  };
  permissionMode: "bypassPermissions";
  allowDangerouslySkipPermissions: true;
  settingSources: [];
  persistSession: false;
  abortController: AbortController;
}

interface ClaudeContentBlock {
  type: string;
  text?: string;
  name?: string;
  id?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ClaudeSystemMessage {
  type: "system";
  subtype: string;
  model?: string;
  session_id?: string;
  status?: string | null;
}

export interface ClaudeAssistantMessage {
  type: "assistant";
  message: { content?: ClaudeContentBlock[] };
}

export interface ClaudeToolProgressMessage {
  type: "tool_progress";
  tool_use_id?: string;
  tool_name?: string;
  elapsed_time_seconds?: number;
}

export interface ClaudeUserMessage {
  type: "user";
  message: { role: "user"; content: string | ClaudeContentBlock[] };
  parent_tool_use_id: string | null;
}

export interface ClaudeStreamEventMessage {
  type: "stream_event";
  event?: { type?: string; content_block?: ClaudeContentBlock };
}

/** SDK per-model usage entry (`ModelUsage`). */
export interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
}

export interface ClaudeResultMessage {
  type: "result";
  subtype: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  modelUsage?: Record<string, ClaudeModelUsage>;
}

export type ClaudeSdkMessage =
  | ClaudeSystemMessage
  | ClaudeAssistantMessage
  | ClaudeUserMessage
  | ClaudeToolProgressMessage
  | ClaudeStreamEventMessage
  | ClaudeResultMessage
  | { type: string };

/** Shape of the SDK's `query()`, reduced to what the harness relies on. */
export interface ClaudeQuery extends AsyncIterable<ClaudeSdkMessage> {
  close(): void;
}

export type ClaudeSdkUserInput = {
  type: "user";
  message: { role: "user"; content: string };
  parent_tool_use_id: null;
};

export type ClaudeQueryFunction = (params: {
  prompt: string | AsyncIterable<ClaudeSdkUserInput>;
  options?: ClaudeQueryOptions;
}) => ClaudeQuery;

/**
 * Injected seam: resolves the SDK's `query` on first use. The default
 * factory dynamically imports the optional peer; tests inject fakes.
 */
export type ClaudeQueryFactory = () => Promise<ClaudeQueryFunction>;

// ---------------------------------------------------------------------------
// Bounded error mapping
// ---------------------------------------------------------------------------

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const MAX_PROGRESS_LINE_CHARS = 300;
const MAX_TRANSCRIPT_PAYLOAD_CHARS = 4_000;
const MAX_EFFECTIVE_MODEL_CHARS = 200;
const MAX_RESULT_ERROR_ITEMS = 3;
const MAX_RESULT_ERROR_ITEM_CHARS = 120;
const MAX_SAFE_USAGE_VALUE = Number.MAX_SAFE_INTEGER;

function toSingleLine(text: string, maxChars: number): string {
  return truncateText(text.replace(/\s+/g, " ").trim(), maxChars);
}

/**
 * Map an arbitrary failure from SDK loading or iteration into a typed,
 * size-bounded error safe to reflect into model-visible output. Never
 * includes environment values or raw child stderr.
 */
export function classifyClaudeFailure(err: unknown): SubagentError {
  if (err instanceof SubagentError) return err;
  const message =
    toSingleLine(describeError(err), 500) || "Unknown Claude harness failure.";
  let code: string | undefined;
  try {
    code =
      typeof err === "object" && err !== null && "code" in err
        ? String((err as { code?: unknown }).code)
        : undefined;
  } catch {
    code = undefined;
  }

  // A missing platform package is a missing bundled executable, not a
  // missing main SDK package. Check it before the general module case.
  if (
    code === "ENOENT" ||
    /@anthropic-ai\/claude-agent-sdk-(?:darwin|linux|win32)-/i.test(message) ||
    /\bENOENT\b|executable.{0,40}(?:not found|missing|could not be (?:found|started)|failed to start)|(?:could not|cannot|can't) find.{0,40}executable|failed to (?:spawn|start|launch).*claude|spawn .*failed/i.test(
      message,
    )
  ) {
    return new SubagentError(
      "claude_executable_missing",
      `The Claude Code executable could not be started. Reinstall ${SDK_PACKAGE} with optional dependencies and check that this platform is supported.`,
    );
  }
  if (
    code === "ERR_MODULE_NOT_FOUND" ||
    code === "MODULE_NOT_FOUND" ||
    /cannot find (module|package)/i.test(message)
  ) {
    return new SubagentError(
      "claude_sdk_missing",
      `The Claude harness requires the optional ${SDK_PACKAGE} package, which is not installed. Install it next to this extension (npm i ${SDK_PACKAGE}) or route the agent to the pi harness.`,
    );
  }
  if (/api key|apikey|authentication|unauthorized|not logged in|log ?in|oauth|credential/i.test(message)) {
    return new SubagentError(
      "claude_auth",
      "Claude Code authentication failed. Log in with the claude CLI or set ANTHROPIC_API_KEY, then retry the run.",
    );
  }
  return new SubagentError("claude_harness_failed", message);
}

// ---------------------------------------------------------------------------
// Option mapping helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Normalize a requested model into what the SDK accepts: an alias
 * (`fable`, `sonnet`, `opus`, `haiku`) or a full Claude model id. A
 * Pi-style `anthropic/<id>` value has its provider prefix stripped so
 * saved routing can share ids across harnesses.
 */
export function normalizeClaudeModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const trimmed = model.trim();
  const normalized = trimmed.startsWith("anthropic/")
    ? trimmed.slice("anthropic/".length).trim()
    : trimmed;
  return normalized === "" ? undefined : normalized;
}

/**
 * Map a Pi thinking level onto the SDK's effort scale. Pi has two levels
 * below the SDK's floor: `off` disables extended thinking outright and
 * `minimal` clamps to `low`. The rest map one-to-one. Undefined inherits
 * the CLI's own default.
 */
export function mapThinkingLevel(level: ThinkingLevel | undefined): {
  effort?: ClaudeEffortLevel;
  thinking?: { type: "disabled" };
} {
  switch (level) {
    case undefined:
      return {};
    case "off":
      return { thinking: { type: "disabled" } };
    case "minimal":
      return { effort: "low" };
    default:
      return { effort: level };
  }
}

/** Aggregate the SDK's per-model usage into the package's RunUsage shape. */
export function aggregateClaudeUsage(result: ClaudeResultMessage): RunUsage {
  const usage: RunUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: safeUsageNumber(result.total_cost_usd),
    turns: safeUsageNumber(result.num_turns),
    contextTokens: 0,
  };

  const perModel = result.modelUsage ? Object.values(result.modelUsage) : [];
  if (perModel.length > 0) {
    // SDK docs: prefer modelUsage for accounting; it covers the main loop,
    // subagents, sidechains, and internal calls.
    let modelCost = 0;
    let hasCompleteModelCost = true;
    for (const model of perModel) {
      usage.input = addUsage(usage.input, model.inputTokens);
      usage.output = addUsage(usage.output, model.outputTokens);
      usage.cacheRead = addUsage(usage.cacheRead, model.cacheReadInputTokens);
      usage.cacheWrite = addUsage(
        usage.cacheWrite,
        model.cacheCreationInputTokens,
      );
      if (model.costUSD === undefined || !Number.isFinite(model.costUSD) || model.costUSD < 0) {
        hasCompleteModelCost = false;
      } else {
        modelCost = addUsage(modelCost, model.costUSD);
      }
    }
    // Public 0.3.234 ModelUsage always has costUSD. The fallback keeps the
    // adapter honest with older or malformed producers instead of returning
    // a misleading partial per-model total.
    if (hasCompleteModelCost) usage.costUsd = modelCost;
  } else if (result.usage) {
    usage.input = safeUsageNumber(result.usage.input_tokens);
    usage.output = safeUsageNumber(result.usage.output_tokens);
    usage.cacheRead = safeUsageNumber(result.usage.cache_read_input_tokens);
    usage.cacheWrite = safeUsageNumber(result.usage.cache_creation_input_tokens);
  }

  // Approximate the child's final context from the main loop's last turn:
  // everything the model saw plus what it produced. modelUsage.contextWindow
  // is a capacity, not the current context size, so it must not be summed.
  const turn = result.usage;
  if (turn) {
    usage.contextTokens = addUsage(
      addUsage(
        addUsage(turn.input_tokens, turn.cache_read_input_tokens),
        turn.cache_creation_input_tokens,
      ),
      turn.output_tokens,
    );
  }
  return usage;
}

function safeUsageNumber(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(value, MAX_SAFE_USAGE_VALUE);
}

function addUsage(left: number | undefined, right: number | undefined): number {
  return Math.min(
    safeUsageNumber(left) + safeUsageNumber(right),
    MAX_SAFE_USAGE_VALUE,
  );
}

/** Build the SDK options for one run. Exported for contract tests. */
export function buildClaudeOptions(
  request: Pick<HarnessRunRequest, "systemPrompt" | "workingDir" | "model" | "thinkingLevel">,
  abortController: AbortController,
): ClaudeQueryOptions {
  const { effort, thinking } = mapThinkingLevel(request.thinkingLevel);
  const options: ClaudeQueryOptions = {
    // Stock Claude Code system prompt; the named agent's prompt is appended
    // rather than replacing it, so built-in tool behavior stays intact.
    systemPrompt:
      request.systemPrompt !== undefined && request.systemPrompt.trim() !== ""
        ? { type: "preset", preset: "claude_code", append: request.systemPrompt }
        : { type: "preset", preset: "claude_code" },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    persistSession: false,
    abortController,
  };
  if (request.workingDir !== undefined) options.cwd = request.workingDir;
  const model = normalizeClaudeModel(request.model);
  if (model !== undefined) options.model = model;
  if (effort !== undefined) options.effort = effort;
  if (thinking !== undefined) options.thinking = thinking;
  return options;
}

// ---------------------------------------------------------------------------
// Default lazy SDK loader
// ---------------------------------------------------------------------------

/**
 * Default factory: lazily import the optional SDK package. The specifier is
 * held in a variable so TypeScript does not require the package's types to
 * be installed for this module to typecheck.
 */
export function createDefaultClaudeQueryFactory(): ClaudeQueryFactory {
  let cached: Promise<ClaudeQueryFunction> | undefined;
  return () => {
    cached ??= (async () => {
      const specifier: string = SDK_PACKAGE;
      let mod: { query?: unknown };
      try {
        mod = (await import(specifier)) as { query?: unknown };
      } catch (err) {
        // Reset the cache: an install can fix this without a Pi restart.
        cached = undefined;
        throw classifyClaudeFailure(err);
      }
      if (typeof mod.query !== "function") {
        cached = undefined;
        throw new SubagentError(
          "claude_sdk_incompatible",
          `${SDK_PACKAGE} is installed but does not export query(); install a compatible 0.3.x version.`,
        );
      }
      return mod.query as ClaudeQueryFunction;
    })();
    return cached;
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function resolveQueryFactory(
  factory: ClaudeQueryFactory,
  signal: AbortSignal,
): Promise<ClaudeQueryFunction> {
  // Promise.resolve().then() observes both a synchronous factory throw and a
  // late rejection after cancellation, so neither can leak as unhandled.
  const pending = Promise.resolve().then(factory);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () =>
      finish(() =>
        reject(
          new SubagentError(
            "claude_run_cancelled",
            "Claude run cancelled before it started.",
          ),
        ),
      );

    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (queryFn) => finish(() => resolve(queryFn)),
      (err: unknown) => finish(() => reject(err)),
    );
    // Abort events are not replayed to listeners attached after the fact.
    if (signal.aborted) onAbort();
  });
}

export interface ClaudeHarnessOptions {
  /** Injected SDK seam; defaults to the lazy dynamic-import factory. */
  queryFactory?: ClaudeQueryFactory;
}

class ClaudeInputStream implements AsyncIterable<ClaudeSdkUserInput> {
  private readonly queued: ClaudeSdkUserInput[] = [];
  private readonly waiters: Array<(result: IteratorResult<ClaudeSdkUserInput>) => void> = [];
  private closed = false;

  push(text: string): void {
    if (this.closed) throw new Error("Claude input stream is closed.");
    const message: ClaudeSdkUserInput = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.queued.push(message);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<ClaudeSdkUserInput> {
    return {
      next: () => {
        const value = this.queued.shift();
        if (value) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

export class ClaudeHarness implements SubagentHarness {
  readonly kind = "claude" as const;
  readonly supportsActiveMessages = true;
  private readonly queryFactory: ClaudeQueryFactory;

  constructor(options: ClaudeHarnessOptions = {}) {
    this.queryFactory = options.queryFactory ?? createDefaultClaudeQueryFactory();
  }

  async run(request: HarnessRunRequest): Promise<HarnessRunOutcome> {
    const { signal } = request;
    if (signal.aborted) {
      throw new SubagentError(
        "claude_run_cancelled",
        "Claude run cancelled before it started.",
      );
    }

    // Loading is also abortable. Dynamic import normally settles quickly,
    // but an injected or blocked loader must not retain the global run slot.
    let queryFn: ClaudeQueryFunction;
    try {
      queryFn = await resolveQueryFactory(this.queryFactory, signal);
    } catch (err) {
      if (signal.aborted) {
        throw new SubagentError(
          "claude_run_cancelled",
          "Claude run cancelled before it started.",
        );
      }
      throw classifyClaudeFailure(err);
    }
    if (typeof queryFn !== "function") {
      throw new SubagentError(
        "claude_sdk_incompatible",
        `${SDK_PACKAGE} did not provide a callable query(); install a compatible 0.3.x version.`,
      );
    }

    // Bridge the run signal to a per-call controller owned by this call.
    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    // Close the race where cancellation happened after factory resolution but
    // immediately before the listener was attached.
    if (signal.aborted) onAbort();

    const options = buildClaudeOptions(request, abortController);
    const input = new ClaudeInputStream();
    input.push(request.prompt);

    let query: ClaudeQuery | undefined;
    let iterator: AsyncIterator<ClaudeSdkMessage> | undefined;
    let cleaned = false;
    let acceptingInput = true;
    let expectedResults = 1;
    const cleanup = async () => {
      if (cleaned) return;
      cleaned = true;
      acceptingInput = false;
      signal.removeEventListener("abort", onAbort);
      input.close();
      abortController.abort();
      try {
        query?.close();
      } catch {
        // Cleanup must never mask the run's real outcome.
      }
    };

    // Per-run mutable state; a single harness instance serves concurrent runs.
    const state: RunObservationState = {
      effectiveModel: undefined,
      tools: new Map(),
      assistantSinceResult: false,
    };

    try {
      if (signal.aborted) {
        throw new SubagentError(
          "claude_run_cancelled",
          "Claude run cancelled before the session started.",
        );
      }
      query = queryFn({ prompt: input, options });
      iterator = query[Symbol.asyncIterator]();
      const controlAccepted = request.setActiveControl({
        async sendMessage(text) {
          if (!acceptingInput || signal.aborted) {
            throw new Error("Claude input channel is closed.");
          }
          expectedResults += 1;
          try {
            input.push(text);
          } catch (error) {
            expectedResults -= 1;
            throw error;
          }
        },
        dispose: cleanup,
      });
      if (!controlAccepted) {
        await cleanup();
        throw new SubagentError(
          "claude_run_cancelled",
          "Claude run settled before its input channel became active.",
        );
      }

      let result: ClaudeResultMessage | undefined;
      while (true) {
        const next = await iterator.next();
        if (next.done) break;
        const observed = observeMessage(request, state, next.value);
        if (!observed) continue;
        if (observed.subtype !== "success" || observed.is_error) {
          acceptingInput = false;
          input.close();
          throw resultToError(observed);
        }
        result = observed;
        expectedResults = Math.max(0, expectedResults - 1);
        if (expectedResults === 0) {
          // No accepted continuation remains. Close the producer before
          // settling so a racing late submission is rejected synchronously.
          acceptingInput = false;
          input.close();
          break;
        }
      }

      if (result === undefined) {
        throw new SubagentError(
          "claude_no_result",
          "The Claude session ended without emitting a result message.",
        );
      }
      const outcome: HarnessRunOutcome = {
        finalText: typeof result.result === "string" ? result.result : "",
        usage: aggregateClaudeUsage(result),
      };
      if (state.effectiveModel !== undefined) {
        outcome.effectiveModel = state.effectiveModel;
      }
      return outcome;
    } catch (err) {
      if (signal.aborted) {
        throw new SubagentError(
          "claude_run_cancelled",
          `Claude run cancelled: ${toSingleLine(describeError(err), 300)}`,
        );
      }
      throw classifyClaudeFailure(err);
    } finally {
      await cleanup();
    }
  }
}

interface RunObservationState {
  effectiveModel: string | undefined;
  tools: Map<string, string>;
  assistantSinceResult: boolean;
}

/**
 * Feed one SDK message into bounded progress; returns the message when it
 * is the turn's result. Progress text is pre-bounded per line here and
 * further bounded by the manager's activity buffer.
 */
function observeMessage(
  request: HarnessRunRequest,
  state: RunObservationState,
  message: ClaudeSdkMessage,
): ClaudeResultMessage | undefined {
  switch (message.type) {
    case "system": {
      const system = message as ClaudeSystemMessage;
      if (system.subtype === "init") {
        if (typeof system.model === "string" && system.model.trim() !== "") {
          const model = toSingleLine(system.model, MAX_EFFECTIVE_MODEL_CHARS);
          state.effectiveModel = model;
          request.reportEffectiveModel(model);
        }
        report(request, `claude session started (model ${system.model ?? "unknown"})`);
        request.reportTranscript({
          kind: "status",
          text: `Claude session started (model ${system.model ?? "unknown"})`,
        });
      } else if (system.subtype === "status" && typeof system.status === "string") {
        report(request, `status: ${system.status}`);
        request.reportTranscript({ kind: "status", text: system.status });
      }
      return undefined;
    }
    case "assistant": {
      const content = (message as ClaudeAssistantMessage).message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
            report(request, block.text);
            state.assistantSinceResult = true;
            request.reportTranscript({ kind: "assistant", text: block.text });
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            const callId = typeof block.id === "string" ? block.id : undefined;
            if (callId) state.tools.set(callId, block.name);
            report(request, `tool: ${block.name}`);
            request.reportTranscript({
              kind: "tool",
              toolName: block.name,
              phase: "start",
              ...(callId ? { callId } : {}),
              input: boundedPayload(block.input),
            });
          }
        }
      }
      return undefined;
    }
    case "user": {
      const user = message as ClaudeUserMessage;
      if (!Array.isArray(user.message?.content)) return undefined;
      for (const block of user.message.content) {
        if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        const toolName = state.tools.get(block.tool_use_id) ?? "unknown";
        request.reportTranscript({
          kind: "tool",
          toolName,
          phase: block.is_error ? "error" : "complete",
          callId: block.tool_use_id,
          output: boundedPayload(block.content),
        });
        state.tools.delete(block.tool_use_id);
      }
      return undefined;
    }
    case "tool_progress": {
      const progress = message as ClaudeToolProgressMessage;
      const elapsed =
        typeof progress.elapsed_time_seconds === "number" &&
        Number.isFinite(progress.elapsed_time_seconds) &&
        progress.elapsed_time_seconds >= 0
          ? ` (${Math.round(progress.elapsed_time_seconds)}s)`
          : "";
      const toolName = progress.tool_name ?? "unknown";
      if (progress.tool_use_id) state.tools.set(progress.tool_use_id, toolName);
      report(request, `tool ${toolName} running${elapsed}`);
      request.reportTranscript({
        kind: "tool",
        toolName,
        phase: "update",
        ...(progress.tool_use_id ? { callId: progress.tool_use_id } : {}),
        output: `Running${elapsed}`,
      });
      return undefined;
    }
    case "stream_event": {
      // Only present when partial messages are enabled; surface tool
      // starts, drop token deltas (too chatty for a bounded buffer).
      const block = (message as ClaudeStreamEventMessage).event?.content_block;
      if (block?.type === "tool_use" && typeof block.name === "string") {
        const callId = typeof block.id === "string" ? block.id : undefined;
        if (!callId || !state.tools.has(callId)) {
          if (callId) state.tools.set(callId, block.name);
          report(request, `tool: ${block.name}`);
          request.reportTranscript({
            kind: "tool",
            toolName: block.name,
            phase: "start",
            ...(callId ? { callId } : {}),
            input: boundedPayload(block.input),
          });
        }
      }
      return undefined;
    }
    case "result": {
      const result = message as ClaudeResultMessage;
      if (
        !state.assistantSinceResult &&
        typeof result.result === "string" &&
        result.result.trim() !== ""
      ) {
        request.reportTranscript({ kind: "assistant", text: result.result });
      }
      state.assistantSinceResult = false;
      return result;
    }
    default:
      return undefined;
  }
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
  const line = toSingleLine(text, MAX_PROGRESS_LINE_CHARS);
  if (line !== "") request.reportProgress(line);
}

function resultToError(result: ClaudeResultMessage): SubagentError {
  const parts: string[] = [];
  if (result.subtype !== "success") parts.push(result.subtype);
  if (result.is_error && typeof result.result === "string" && result.result !== "") {
    parts.push(toSingleLine(result.result, MAX_RESULT_ERROR_ITEM_CHARS));
  }
  if (Array.isArray(result.errors) && result.errors.length > 0) {
    parts.push(
      result.errors
        .slice(0, MAX_RESULT_ERROR_ITEMS)
        .map((error) => toSingleLine(String(error), MAX_RESULT_ERROR_ITEM_CHARS))
        .filter((error) => error !== "")
        .join("; "),
    );
  }
  const detail = parts.filter((part) => part !== "").join(": ") || "unknown error";
  // Route the text through classification so auth/executable failures that
  // the CLI reports via an error result keep their specific codes.
  const classified = classifyClaudeFailure(new Error(`Claude run failed: ${detail}`));
  return classified.code === "claude_harness_failed"
    ? new SubagentError("claude_result_error", classified.message)
    : classified;
}
