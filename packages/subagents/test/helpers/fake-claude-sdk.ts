/**
 * Fake Claude Agent SDK `query()` for offline contract tests. Derived only
 * from the public SDK message shapes documented in reference/claude-sdk.md
 * and the local structural types in src/harnesses/claude.ts.
 */

import type { HarnessRunRequest } from "../../src/core/harness.js";
import type {
  ClaudeQueryFactory,
  ClaudeQueryOptions,
  ClaudeSdkUserInput,
  ClaudeResultMessage,
  ClaudeSdkMessage,
} from "../../src/harnesses/claude.js";
import type { ThinkingLevel } from "../../src/shared/types.js";

/** A scripted message, abortable hang, or iterator failure. */
export type FakeStep =
  | ClaudeSdkMessage
  | { hangUntilAbort: true }
  | { waitFor: Promise<void> }
  | { failWith: unknown };

export interface FakeQueryCall {
  prompt: string | AsyncIterable<ClaudeSdkUserInput>;
  inputMessages: ClaudeSdkUserInput[];
  options: ClaudeQueryOptions | undefined;
  /** How many scripted messages were actually consumed. */
  yielded: number;
  /** Whether the generator's finally block ran (iterator cleanup proof). */
  finallyRan: boolean;
  /** Number of explicit iterator.return() calls made by the harness. */
  returnCalls: number;
  closeCalls: number;
}

export interface FakeQuery {
  factory: ClaudeQueryFactory;
  calls: FakeQueryCall[];
}

/** Build a fake query whose generator plays back `steps` in order. */
export function makeFakeQuery(steps: FakeStep[]): FakeQuery {
  const calls: FakeQueryCall[] = [];
  const queryFn = (params: {
    prompt: string | AsyncIterable<ClaudeSdkUserInput>;
    options?: ClaudeQueryOptions;
  }) => {
    const call: FakeQueryCall = {
      prompt: params.prompt,
      options: params.options,
      inputMessages: [],
      yielded: 0,
      finallyRan: false,
      returnCalls: 0,
      closeCalls: 0,
    };
    calls.push(call);
    async function* generate(): AsyncGenerator<ClaudeSdkMessage, void> {
      try {
        for (const step of steps) {
          if (typeof step === "object" && "hangUntilAbort" in step) {
            await rejectOnAbort(params.options?.abortController.signal);
            continue;
          }
          if (typeof step === "object" && "waitFor" in step) {
            await step.waitFor;
            continue;
          }
          if (typeof step === "object" && "failWith" in step) {
            throw step.failWith;
          }
          call.yielded += 1;
          yield step;
        }
      } finally {
        call.finallyRan = true;
      }
    }
    if (typeof params.prompt !== "string") {
      void (async () => {
        for await (const message of params.prompt as AsyncIterable<ClaudeSdkUserInput>) {
          call.inputMessages.push(message);
        }
      })();
    }
    const generator = generate();
    const originalReturn = generator.return.bind(generator);
    generator.return = (value?: void | PromiseLike<void>) => {
      call.returnCalls += 1;
      return originalReturn(value);
    };
    return Object.assign(generator, {
      close() {
        call.closeCalls += 1;
        void originalReturn(undefined);
      },
    });
  };
  return { factory: () => Promise.resolve(queryFn), calls };
}

function rejectOnAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () => {
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (!signal) return; // no controller wired: hang forever (test would time out)
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail, { once: true });
  });
}

// ---------------------------------------------------------------------------
// Message builders
// ---------------------------------------------------------------------------

export function initMessage(model = "claude-opus-4-8"): ClaudeSdkMessage {
  return { type: "system", subtype: "init", model, session_id: "sess-1" };
}

export function assistantText(text: string): ClaudeSdkMessage {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}

export function assistantToolUse(
  name: string,
  id = "tool-1",
  input: unknown = { path: "/tmp/example" },
): ClaudeSdkMessage {
  return {
    type: "assistant",
    message: { content: [{ type: "tool_use", name, id, input }] },
  };
}

export function toolProgress(name: string, seconds: number, id = "tool-1"): ClaudeSdkMessage {
  return {
    type: "tool_progress",
    tool_use_id: id,
    tool_name: name,
    elapsed_time_seconds: seconds,
  };
}

export function toolResult(
  id = "tool-1",
  content: unknown = "tool output",
  isError = false,
): ClaudeSdkMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }],
    },
    parent_tool_use_id: null,
  };
}

export function streamToolStart(name: string): ClaudeSdkMessage {
  return {
    type: "stream_event",
    event: { type: "content_block_start", content_block: { type: "tool_use", name } },
  };
}

export function resultSuccess(
  overrides: Partial<ClaudeResultMessage> = {},
): ClaudeResultMessage {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "final answer",
    num_turns: 2,
    total_cost_usd: 0.05,
    usage: {
      input_tokens: 100,
      output_tokens: 40,
      cache_read_input_tokens: 1_000,
      cache_creation_input_tokens: 200,
    },
    ...overrides,
  };
}

export function resultError(
  subtype: string,
  errors: string[] = [],
): ClaudeResultMessage {
  return { type: "result", subtype, is_error: true, result: "", errors };
}

// ---------------------------------------------------------------------------
// Harness request builder
// ---------------------------------------------------------------------------

export interface CapturedRequest {
  request: HarnessRunRequest;
  controller: AbortController;
  progress: string[];
  effectiveModels: string[];
  transcript: Array<Parameters<HarnessRunRequest["reportTranscript"]>[0]>;
  controls: Array<Parameters<HarnessRunRequest["setActiveControl"]>[0]>;
}

export function makeRequest(
  overrides: Partial<
    Pick<
      HarnessRunRequest,
      "prompt" | "systemPrompt" | "tools" | "workingDir" | "model"
    > & { thinkingLevel: ThinkingLevel }
  > = {},
): CapturedRequest {
  const controller = new AbortController();
  const progress: string[] = [];
  const effectiveModels: string[] = [];
  const transcript: Array<Parameters<HarnessRunRequest["reportTranscript"]>[0]> = [];
  const controls: Array<Parameters<HarnessRunRequest["setActiveControl"]>[0]> = [];
  const request: HarnessRunRequest = {
    runId: "run-1",
    prompt: overrides.prompt ?? "do the task",
    systemPrompt: overrides.systemPrompt,
    tools: overrides.tools,
    workingDir: overrides.workingDir,
    model: overrides.model,
    thinkingLevel: overrides.thinkingLevel,
    signal: controller.signal,
    reportProgress: (text) => progress.push(text),
    reportTranscript: (entry) => transcript.push(entry),
    reportEffectiveModel: (model) => effectiveModels.push(model),
    setActiveControl: (control) => {
      controls.push(control);
      return true;
    },
  };
  return {
    request,
    controller,
    progress,
    effectiveModels,
    transcript,
    controls,
  };
}
