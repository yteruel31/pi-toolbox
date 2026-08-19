import type {
  ModelUsage as SdkModelUsage,
  Options as SdkOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";

import {
  ClaudeHarness,
  aggregateClaudeUsage,
  buildClaudeOptions,
  classifyClaudeFailure,
  createDefaultClaudeQueryFactory,
  mapThinkingLevel,
  normalizeClaudeModel,
} from "../src/harnesses/claude.js";
import { SubagentError } from "../src/shared/errors.js";
import {
  assistantText,
  assistantToolUse,
  initMessage,
  makeFakeQuery,
  makeRequest,
  resultError,
  resultSuccess,
  streamToolStart,
  toolProgress,
  toolResult,
} from "./helpers/fake-claude-sdk.js";

const SDK_INSTALLED = await import("@anthropic-ai/claude-agent-sdk").then(
  () => true,
  () => false,
);

describe("claude harness option wiring", () => {
  it("passes prompt and maps every option through the query seam", async () => {
    const fake = makeFakeQuery([initMessage(), resultSuccess()]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest({
      prompt: "review the diff",
      systemPrompt: "You are a strict reviewer.",
      workingDir: "/tmp/project",
      model: "opus",
      thinkingLevel: "high",
    });

    await harness.run(request);

    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(typeof call.prompt).not.toBe("string");
    expect(call.inputMessages[0]?.message.content).toBe("review the diff");
    const options = call.options!;
    expect(options.cwd).toBe("/tmp/project");
    expect(options.model).toBe("opus");
    expect(options.effort).toBe("high");
    expect(options.thinking).toBeUndefined();
    expect(options.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: "You are a strict reviewer.",
    });
    expect(options.permissionMode).toBe("bypassPermissions");
    expect(options.allowDangerouslySkipPermissions).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.persistSession).toBe(false);
    expect(options.abortController).toBeInstanceOf(AbortController);
  });

  it("uses the stock system prompt without append when no agent prompt is set", async () => {
    const fake = makeFakeQuery([resultSuccess()]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest({ systemPrompt: undefined });

    await harness.run(request);

    expect(fake.calls[0]!.options!.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
    expect(fake.calls[0]!.options!.cwd).toBeUndefined();
    expect(fake.calls[0]!.options!.model).toBeUndefined();
    expect(fake.calls[0]!.options!.effort).toBeUndefined();
  });

  it("treats a whitespace-only system prompt as absent", async () => {
    const fake = makeFakeQuery([resultSuccess()]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest({ systemPrompt: "  \n " });

    await harness.run(request);

    expect(fake.calls[0]!.options!.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
    });
  });

  it("disables thinking for the off level instead of picking an effort", async () => {
    const fake = makeFakeQuery([resultSuccess()]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest({ thinkingLevel: "off" });

    await harness.run(request);

    expect(fake.calls[0]!.options!.effort).toBeUndefined();
    expect(fake.calls[0]!.options!.thinking).toEqual({ type: "disabled" });
  });

  it("builds options assignable to the installed SDK 0.3.234 public Options type", () => {
    const { request } = makeRequest({
      systemPrompt: "Review carefully.",
      workingDir: "/tmp/project",
      model: "fable",
      thinkingLevel: "xhigh",
    });
    const options: SdkOptions = buildClaudeOptions(
      request,
      new AbortController(),
    );

    expect(options).toMatchObject({
      cwd: "/tmp/project",
      model: "fable",
      effort: "xhigh",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      persistSession: false,
    });
  });
});

describe("model and thinking mapping", () => {
  it("passes aliases and full ids through, stripping a pi provider prefix", () => {
    expect(normalizeClaudeModel("opus")).toBe("opus");
    expect(normalizeClaudeModel("fable")).toBe("fable");
    expect(normalizeClaudeModel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(normalizeClaudeModel("anthropic/claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(normalizeClaudeModel("anthropic/  claude-sonnet-5  ")).toBe("claude-sonnet-5");
    expect(normalizeClaudeModel("anthropic/   ")).toBeUndefined();
    expect(normalizeClaudeModel("  haiku  ")).toBe("haiku");
    expect(normalizeClaudeModel("   ")).toBeUndefined();
    expect(normalizeClaudeModel(undefined)).toBeUndefined();
  });

  it("maps pi thinking levels onto the SDK effort scale", () => {
    expect(mapThinkingLevel(undefined)).toEqual({});
    expect(mapThinkingLevel("off")).toEqual({ thinking: { type: "disabled" } });
    expect(mapThinkingLevel("minimal")).toEqual({ effort: "low" });
    expect(mapThinkingLevel("low")).toEqual({ effort: "low" });
    expect(mapThinkingLevel("medium")).toEqual({ effort: "medium" });
    expect(mapThinkingLevel("high")).toEqual({ effort: "high" });
    expect(mapThinkingLevel("xhigh")).toEqual({ effort: "xhigh" });
    expect(mapThinkingLevel("max")).toEqual({ effort: "max" });
  });
});

describe("claude harness success path", () => {
  it("returns final text, effective model, and aggregated usage", async () => {
    const fake = makeFakeQuery([
      initMessage("claude-opus-4-8"),
      assistantText("thinking about it"),
      assistantToolUse("Read"),
      toolProgress("Read", 3.4),
      resultSuccess({
        result: "the answer",
        num_turns: 4,
        modelUsage: {
          "claude-opus-4-8": {
            inputTokens: 900,
            outputTokens: 150,
            cacheReadInputTokens: 5_000,
            cacheCreationInputTokens: 300,
            costUSD: 0.2,
          },
          "claude-haiku-4": {
            inputTokens: 100,
            outputTokens: 50,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.01,
          },
        },
      }),
    ]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request, effectiveModels } = makeRequest();

    const outcome = await harness.run(request);

    expect(outcome.finalText).toBe("the answer");
    expect(outcome.effectiveModel).toBe("claude-opus-4-8");
    expect(effectiveModels).toEqual(["claude-opus-4-8"]);
    expect(outcome.usage).toEqual({
      input: 1_000,
      output: 200,
      cacheRead: 5_000,
      cacheWrite: 300,
      costUsd: expect.closeTo(0.21, 10),
      turns: 4,
      // From the main-loop per-turn usage in resultSuccess defaults.
      contextTokens: 100 + 40 + 1_000 + 200,
    });
  });

  it("falls back to the per-turn usage block when modelUsage is absent or empty", async () => {
    for (const modelUsage of [undefined, {}]) {
      const fake = makeFakeQuery([resultSuccess({ modelUsage })]);
      const harness = new ClaudeHarness({ queryFactory: fake.factory });
      const { request } = makeRequest();

      const outcome = await harness.run(request);

      expect(outcome.usage).toMatchObject({
        input: 100,
        output: 40,
        cacheRead: 1_000,
        cacheWrite: 200,
        costUsd: 0.05,
        turns: 2,
      });
    }
  });

  it("uses total_cost_usd rather than a partial per-model cost", () => {
    const usage = aggregateClaudeUsage(
      resultSuccess({
        total_cost_usd: 0.5,
        modelUsage: {
          opus: { inputTokens: 10, costUSD: 0.2 },
          haiku: { outputTokens: 5 },
        },
      }),
    );

    expect(usage).toMatchObject({ input: 10, output: 5, costUsd: 0.5 });
  });

  it("accepts the complete SDK ModelUsage shape and ignores capacities", () => {
    const modelUsage: SdkModelUsage = {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 2,
      webSearchRequests: 1,
      costUSD: 0.03,
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
    };

    const usage = aggregateClaudeUsage(
      resultSuccess({ modelUsage: { "claude-fable-5": modelUsage } }),
    );

    expect(usage).toMatchObject({
      input: 10,
      output: 5,
      cacheRead: 20,
      cacheWrite: 2,
      costUsd: 0.03,
    });
    expect(usage.contextTokens).not.toBe(modelUsage.contextWindow);
  });

  it("clamps malformed usage values to finite non-negative numbers", () => {
    const usage = aggregateClaudeUsage(
      resultSuccess({
        num_turns: Number.POSITIVE_INFINITY,
        total_cost_usd: -1,
        usage: {
          input_tokens: Number.POSITIVE_INFINITY,
          output_tokens: -3,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 5,
        },
        modelUsage: undefined,
      }),
    );

    expect(usage).toEqual({
      input: 0,
      output: 0,
      cacheRead: 4,
      cacheWrite: 5,
      costUsd: 0,
      turns: 0,
      contextTokens: 9,
    });
  });

  it("emits bounded progress from system, assistant, tool_progress, and stream events", async () => {
    const fake = makeFakeQuery([
      initMessage("claude-sonnet-5"),
      { type: "system", subtype: "status", status: "compacting" },
      assistantText("x".repeat(2_000)),
      assistantToolUse("Bash"),
      toolProgress("Bash", 12.6),
      streamToolStart("Edit"),
      resultSuccess(),
    ]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request, progress } = makeRequest();

    await harness.run(request);

    expect(progress[0]).toBe("claude session started (model claude-sonnet-5)");
    expect(progress[1]).toBe("status: compacting");
    expect(progress[2]!.length).toBeLessThanOrEqual(300);
    expect(progress[2]).toContain("truncated");
    expect(progress[3]).toBe("tool: Bash");
    expect(progress[4]).toBe("tool Bash running (13s)");
    expect(progress[5]).toBe("tool: Edit");
  });

  it("streams continuation input through the same active query", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fake = makeFakeQuery([
      initMessage(),
      { waitFor: gate },
      resultSuccess({ result: "first answer" }),
      assistantText("continued answer"),
      resultSuccess({ result: "continued answer" }),
    ]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const captured = makeRequest({ prompt: "initial" });
    const running = harness.run(captured.request);
    while (captured.controls.length === 0) await Promise.resolve();

    await captured.controls[0]!.sendMessage("continue safely");
    release();
    const outcome = await running;

    expect(fake.calls[0]!.inputMessages.map((message) => message.message.content)).toEqual([
      "initial",
      "continue safely",
    ]);
    expect(outcome.finalText).toBe("continued answer");
    expect(fake.calls[0]!.closeCalls).toBe(1);
  });

  it("captures assistant and bounded tool input/output transcript details", async () => {
    const fake = makeFakeQuery([
      assistantToolUse("Read", "tool-7", { path: "/tmp/example" }),
      toolProgress("Read", 3, "tool-7"),
      toolResult("tool-7", { content: "file contents" }),
      assistantText("Finished reading."),
      resultSuccess(),
    ]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const captured = makeRequest();

    await harness.run(captured.request);

    expect(captured.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", phase: "start", callId: "tool-7", input: expect.stringContaining("/tmp/example") }),
      expect.objectContaining({ kind: "tool", phase: "update", output: "Running (3s)" }),
      expect.objectContaining({ kind: "tool", phase: "complete", output: expect.stringContaining("file contents") }),
      { kind: "assistant", text: "Finished reading." },
    ]));
    expect(captured.transcript.every((entry) => JSON.stringify(entry).length < 5_000)).toBe(true);
  });

  it("collapses multiline child progress and bounds the effective model", async () => {
    const fake = makeFakeQuery([
      initMessage(`claude-${"x".repeat(300)}\nunsafe`),
      assistantText("first line\nsecond\tline"),
      assistantToolUse("Read\nfile"),
      resultSuccess(),
    ]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request, progress, effectiveModels } = makeRequest();

    const outcome = await harness.run(request);

    expect(progress.every((line) => !line.includes("\n"))).toBe(true);
    expect(progress).toContain("first line second line");
    expect(progress).toContain("tool: Read file");
    expect(effectiveModels[0]!.length).toBeLessThanOrEqual(200);
    expect(outcome.effectiveModel).toBe(effectiveModels[0]);
  });

  it("returns an empty final text when the child produced none", async () => {
    const fake = makeFakeQuery([resultSuccess({ result: undefined })]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest();

    const outcome = await harness.run(request);
    expect(outcome.finalText).toBe("");
  });
});

describe("claude harness iterator cleanup", () => {
  it("stops at the result message and runs generator cleanup on success", async () => {
    const fake = makeFakeQuery([
      initMessage(),
      resultSuccess(),
      // Trailing frames the harness must not consume.
      assistantText("late frame"),
    ]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request, progress } = makeRequest();

    await harness.run(request);

    const call = fake.calls[0]!;
    expect(call.yielded).toBe(2); // init + result, never the trailing frame
    expect(call.finallyRan).toBe(true);
    expect(call.returnCalls).toBe(0);
    expect(call.closeCalls).toBe(1);
    expect(progress).not.toContain("late frame");
    // The bridged controller is aborted as a teardown backstop even on success.
    expect(call.options!.abortController.signal.aborted).toBe(true);
  });

  it("runs generator cleanup when the run fails", async () => {
    const fake = makeFakeQuery([initMessage(), resultError("error_max_turns")]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest();

    await expect(harness.run(request)).rejects.toThrow(SubagentError);
    expect(fake.calls[0]!.finallyRan).toBe(true);
    expect(fake.calls[0]!.returnCalls).toBe(0);
    expect(fake.calls[0]!.closeCalls).toBe(1);
  });

  it("runs generator cleanup when the run is cancelled", async () => {
    const fake = makeFakeQuery([initMessage(), { hangUntilAbort: true }]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request, controller } = makeRequest();

    const pending = harness.run(request);
    // Let the run reach the hang point, then cancel.
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "claude_run_cancelled",
    });
    const call = fake.calls[0]!;
    expect(call.finallyRan).toBe(true);
    expect(call.returnCalls).toBe(0);
    expect(call.closeCalls).toBe(1);
    expect(call.options!.abortController.signal.aborted).toBe(true);
  });
});

describe("claude harness cancellation", () => {
  it("bridges the run signal to the SDK abort controller", async () => {
    const fake = makeFakeQuery([initMessage(), { hangUntilAbort: true }]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request, controller } = makeRequest();

    const pending = harness.run(request);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.calls[0]!.options!.abortController.signal.aborted).toBe(false);

    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled/);
  });

  it("settles immediately when the signal is already aborted", async () => {
    let factoryInvoked = false;
    const harness = new ClaudeHarness({
      queryFactory: () => {
        factoryInvoked = true;
        return Promise.reject(new Error("must not be called"));
      },
    });
    const { request, controller } = makeRequest();
    controller.abort();

    await expect(harness.run(request)).rejects.toMatchObject({
      code: "claude_run_cancelled",
    });
    expect(factoryInvoked).toBe(false);
  });

  it("settles when cancellation arrives while the SDK factory is pending", async () => {
    const fake = makeFakeQuery([resultSuccess()]);
    let resolveFactory!: (queryFn: Awaited<ReturnType<typeof fake.factory>>) => void;
    const delayedFactory = new Promise<Awaited<ReturnType<typeof fake.factory>>>(
      (resolve) => {
        resolveFactory = resolve;
      },
    );
    const harness = new ClaudeHarness({ queryFactory: () => delayedFactory });
    const { request, controller } = makeRequest();

    const pending = harness.run(request);
    await Promise.resolve();
    controller.abort();

    await expect(pending).rejects.toMatchObject({
      code: "claude_run_cancelled",
    });
    resolveFactory(await fake.factory());
    await Promise.resolve();
    expect(fake.calls).toHaveLength(0);
  });
});

describe("claude harness failure mapping", () => {
  it.each([
    "error_during_execution",
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
  ])("maps the SDK %s result subtype to a failed run", async (subtype) => {
    const fake = makeFakeQuery([resultError(subtype, ["stopped"])]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest();

    await expect(harness.run(request)).rejects.toMatchObject({
      code: "claude_result_error",
      message: expect.stringContaining(subtype),
    });
  });

  it("rejects with the result subtype and bounded error details", async () => {
    const fake = makeFakeQuery([
      initMessage(),
      resultError("error_during_execution", ["boom one", "boom two"]),
    ]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest();

    const err = await harness.run(request).then(
      () => {
        throw new Error("expected rejection");
      },
      (e: unknown) => e as SubagentError,
    );
    expect(err).toBeInstanceOf(SubagentError);
    expect(err.code).toBe("claude_result_error");
    expect(err.message).toContain("error_during_execution");
    expect(err.message).toContain("boom one");
    expect(err.message.length).toBeLessThanOrEqual(500);
  });

  it("rejects a success result flagged is_error", async () => {
    const fake = makeFakeQuery([
      resultSuccess({ is_error: true, result: "something went wrong" }),
    ]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest();

    await expect(harness.run(request)).rejects.toMatchObject({
      code: "claude_result_error",
      message: expect.stringContaining("something went wrong"),
    });
  });

  it("classifies an authentication error surfaced through an error result", async () => {
    const fake = makeFakeQuery([
      resultError("error_during_execution", ["Not logged in: run claude login"]),
    ]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest();

    await expect(harness.run(request)).rejects.toMatchObject({
      code: "claude_auth",
    });
  });

  it("bounds the number and size of error-result details", async () => {
    const fake = makeFakeQuery([
      resultError("error_during_execution", [
        `first ${"x".repeat(2_000)}`,
        "second\nline",
        "third",
        "must not be included",
      ]),
    ]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest();

    const error = await harness.run(request).then(
      () => {
        throw new Error("expected rejection");
      },
      (err: unknown) => err as SubagentError,
    );

    expect(error.message.length).toBeLessThanOrEqual(500);
    expect(error.message).toContain("second line");
    expect(error.message).toContain("third");
    expect(error.message).not.toContain("must not be included");
  });

  it("maps executable and authentication failures thrown by the iterator", async () => {
    const executable = new Error("spawn claude ENOENT");
    (executable as NodeJS.ErrnoException).code = "ENOENT";
    const cases = [
      { failure: executable, code: "claude_executable_missing" },
      { failure: new Error("Authentication failed: invalid API key"), code: "claude_auth" },
    ];

    for (const { failure, code } of cases) {
      const fake = makeFakeQuery([initMessage(), { failWith: failure }]);
      const harness = new ClaudeHarness({ queryFactory: fake.factory });
      const { request } = makeRequest();

      await expect(harness.run(request)).rejects.toMatchObject({ code });
      expect(fake.calls[0]!.finallyRan).toBe(true);
      expect(fake.calls[0]!.returnCalls).toBe(0);
      expect(fake.calls[0]!.closeCalls).toBe(1);
    }
  });

  it("rejects when the stream ends without a result message", async () => {
    const fake = makeFakeQuery([initMessage(), assistantText("partial")]);
    const harness = new ClaudeHarness({ queryFactory: fake.factory });
    const { request } = makeRequest();

    await expect(harness.run(request)).rejects.toMatchObject({
      code: "claude_no_result",
    });
  });

  it("rejects an invalid injected query function as an incompatible SDK", async () => {
    const harness = new ClaudeHarness({
      queryFactory: () => Promise.resolve(undefined as never),
    });
    const { request } = makeRequest();

    await expect(harness.run(request)).rejects.toMatchObject({
      code: "claude_sdk_incompatible",
    });
  });

  it("maps a rejecting query factory to a bounded spawn failure", async () => {
    const missing = new Error(
      "Cannot find package '@anthropic-ai/claude-agent-sdk' imported from x",
    );
    (missing as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
    const harness = new ClaudeHarness({
      queryFactory: () => Promise.reject(missing),
    });
    const { request } = makeRequest();

    await expect(harness.run(request)).rejects.toMatchObject({
      code: "claude_sdk_missing",
      message: expect.stringContaining("@anthropic-ai/claude-agent-sdk"),
    });
  });
});

describe("classifyClaudeFailure", () => {
  it("detects a missing SDK module", () => {
    const err = new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'");
    expect(classifyClaudeFailure(err).code).toBe("claude_sdk_missing");
  });

  it("detects a missing executable or bundled platform package", () => {
    const err = new Error("spawn claude ENOENT");
    (err as NodeJS.ErrnoException).code = "ENOENT";
    expect(classifyClaudeFailure(err).code).toBe("claude_executable_missing");

    const platformPackage = new Error(
      "Cannot find package '@anthropic-ai/claude-agent-sdk-linux-x64'",
    );
    (platformPackage as NodeJS.ErrnoException).code = "ERR_MODULE_NOT_FOUND";
    expect(classifyClaudeFailure(platformPackage).code).toBe(
      "claude_executable_missing",
    );
  });

  it("detects authentication failures without reflecting auth material", () => {
    const apiKeyError = classifyClaudeFailure(
      new Error("Invalid API key sk-ant-secret-value"),
    );
    expect(apiKeyError.code).toBe("claude_auth");
    expect(apiKeyError.message).not.toContain("sk-ant-secret-value");
    expect(
      classifyClaudeFailure(new Error("OAuth token expired, please log in")).code,
    ).toBe("claude_auth");
  });

  it("falls back to a generic bounded harness error", () => {
    const err = classifyClaudeFailure(new Error("z".repeat(5_000)));
    expect(err.code).toBe("claude_harness_failed");
    expect(err.message.length).toBeLessThanOrEqual(500);
  });

  it("passes existing SubagentErrors through unchanged", () => {
    const original = new SubagentError("claude_no_result", "no result");
    expect(classifyClaudeFailure(original)).toBe(original);
  });

  it("handles non-Error thrown values", () => {
    expect(classifyClaudeFailure("string failure").code).toBe(
      "claude_harness_failed",
    );
  });
});

describe("default query factory", () => {
  it.skipIf(SDK_INSTALLED)(
    "reports a bounded missing-SDK error when the optional peer is absent",
    async () => {
      const factory = createDefaultClaudeQueryFactory();
      await expect(factory()).rejects.toMatchObject({
        code: "claude_sdk_missing",
      });
      // Not cached as a permanent failure: an install can fix it later.
      await expect(factory()).rejects.toMatchObject({
        code: "claude_sdk_missing",
      });
    },
  );

  it.skipIf(!SDK_INSTALLED)("resolves and caches query() when the SDK is installed", async () => {
    const factory = createDefaultClaudeQueryFactory();
    const first = factory();
    const second = factory();

    expect(first).toBe(second);
    await expect(first).resolves.toBeTypeOf("function");
  });
});
