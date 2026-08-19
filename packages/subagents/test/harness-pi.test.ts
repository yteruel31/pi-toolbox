import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { HarnessRunRequest } from "../src/core/harness.js";
import {
  PI_CHILD_EXCLUDED_TOOLS,
  PI_TOOL_WATCHDOG_MS,
  PiHarness,
  createOfficialPiResources,
  isAllowedPiChildTool,
  isExcludedPiChildTool,
  piChildToolDenial,
  type PiModelLike,
  type PiResourceFactoryInput,
  type PiSessionCreateInput,
  type PiSessionEvent,
  type PiSessionLike,
} from "../src/harnesses/pi.js";
import type { ThinkingLevel } from "../src/shared/types.js";

const MODEL: PiModelLike = {
  provider: "anthropic",
  id: "claude-sonnet-test",
};
const OTHER_MODEL: PiModelLike = {
  provider: "openai",
  id: "gpt-test",
};

interface CapturedRunRequest {
  request: HarnessRunRequest;
  controller: AbortController;
  progress: string[];
  models: string[];
  transcript: Array<Parameters<HarnessRunRequest["reportTranscript"]>[0]>;
  controls: Array<Parameters<HarnessRunRequest["setActiveControl"]>[0]>;
}

function makeRunRequest(
  overrides: Partial<
    Pick<
      HarnessRunRequest,
      "prompt" | "systemPrompt" | "tools" | "workingDir" | "model" | "thinkingLevel"
    >
  > = {},
): CapturedRunRequest {
  const controller = new AbortController();
  const progress: string[] = [];
  const models: string[] = [];
  const transcript: Array<Parameters<HarnessRunRequest["reportTranscript"]>[0]> = [];
  const controls: Array<Parameters<HarnessRunRequest["setActiveControl"]>[0]> = [];
  return {
    controller,
    progress,
    models,
    transcript,
    controls,
    request: {
      runId: "run-1",
      prompt: overrides.prompt ?? "inspect the project",
      systemPrompt: overrides.systemPrompt,
      tools: overrides.tools,
      workingDir: overrides.workingDir,
      model: overrides.model,
      thinkingLevel: overrides.thinkingLevel,
      signal: controller.signal,
      reportProgress: (text) => progress.push(text),
      reportTranscript: (entry) => transcript.push(entry),
      reportEffectiveModel: (model) => models.push(model),
      setActiveControl: (control) => {
        controls.push(control);
        return true;
      },
    },
  };
}

class FakePiSession implements PiSessionLike {
  listener: ((event: PiSessionEvent) => void) | undefined;
  subscribeCount = 0;
  unsubscribeCount = 0;
  promptCount = 0;
  steerCount = 0;
  steered: string[] = [];
  abortCount = 0;
  disposeCount = 0;
  activeTools = ["read", "subagent_spawn", "workflow_custom", "ask_user_more"];
  activeToolUpdates: string[][] = [];
  promptImpl: (text: string) => Promise<void> = async () => undefined;
  abortImpl: () => Promise<void> = async () => undefined;

  subscribe(listener: (event: PiSessionEvent) => void): () => void {
    this.subscribeCount += 1;
    this.listener = listener;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.unsubscribeCount += 1;
      this.listener = undefined;
    };
  }

  prompt(text: string): Promise<void> {
    this.promptCount += 1;
    return this.promptImpl(text);
  }

  async steer(text: string): Promise<void> {
    this.steerCount += 1;
    this.steered.push(text);
  }

  abort(): Promise<void> {
    this.abortCount += 1;
    return this.abortImpl();
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  getActiveToolNames(): string[] {
    return [...this.activeTools];
  }

  setActiveToolsByName(names: string[]): void {
    this.activeTools = [...names];
    this.activeToolUpdates.push([...names]);
  }

  emit(event: PiSessionEvent): void {
    this.listener?.(event);
  }
}

function assistantMessage(
  text: string,
  overrides: {
    provider?: string;
    model?: string;
    stopReason?: "stop" | "toolUse" | "error" | "aborted";
    errorMessage?: string;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: number;
  } = {},
): PiSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "anthropic-messages",
      provider: overrides.provider ?? "anthropic",
      model: overrides.model ?? "claude-sonnet-test",
      usage: {
        input: overrides.input ?? 10,
        output: overrides.output ?? 5,
        cacheRead: overrides.cacheRead ?? 20,
        cacheWrite: overrides.cacheWrite ?? 3,
        totalTokens: overrides.totalTokens ?? 38,
        cost: {
          input: 0.01,
          output: 0.01,
          cacheRead: 0,
          cacheWrite: 0,
          total: overrides.cost ?? 0.02,
        },
      },
      stopReason: overrides.stopReason ?? "stop",
      errorMessage: overrides.errorMessage,
      timestamp: 1,
    },
  };
}

function toolEvent(
  type:
    | "tool_execution_start"
    | "tool_execution_update"
    | "tool_execution_end",
  toolCallId: string,
  toolName = "bash",
): PiSessionEvent {
  if (type === "tool_execution_start") {
    return { type, toolCallId, toolName, args: {} };
  }
  if (type === "tool_execution_update") {
    return { type, toolCallId, toolName, args: {}, partialResult: {} };
  }
  return {
    type,
    toolCallId,
    toolName,
    result: { content: [], details: {} },
    isError: false,
  };
}

interface HarnessFixture {
  harness: PiHarness;
  session: FakePiSession;
  sessionInputs: PiSessionCreateInput[];
  resourceInputs: PiResourceFactoryInput[];
}

function makeHarness(
  options: {
    available?: readonly PiModelLike[];
    parentModel?: PiModelLike;
    parentThinkingLevel?: ThinkingLevel;
    trusted?: boolean | ((cwd: string) => boolean);
    watchdogMs?: number;
    session?: FakePiSession;
  } = {},
): HarnessFixture {
  const session = options.session ?? new FakePiSession();
  const sessionInputs: PiSessionCreateInput[] = [];
  const resourceInputs: PiResourceFactoryInput[] = [];
  const available = options.available ?? [MODEL, OTHER_MODEL];
  const harness = new PiHarness({
    modelRuntime: {
      getModel(provider, id) {
        return available.find(
          (candidate) => candidate.provider === provider && candidate.id === id,
        );
      },
      async getAvailable() {
        return available;
      },
    },
    parentModel: options.parentModel ?? MODEL,
    parentThinkingLevel: options.parentThinkingLevel ?? "high",
    defaultWorkingDir: "/parent/project",
    isProjectTrusted: options.trusted ?? false,
    agentDir: "/home/test/.pi/agent",
    toolWatchdogMs: options.watchdogMs,
    async createResources(input) {
      resourceInputs.push(input);
      return {
        resourceLoader: { kind: "loader" },
        sessionManager: { kind: "in-memory" },
        settingsManager: { kind: "settings" },
      };
    },
    async createSession(input) {
      sessionInputs.push(input);
      return session;
    },
  });
  return { harness, session, sessionInputs, resourceInputs };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Pi child session wiring", () => {
  it("inherits parent model/thinking, uses the selected cwd, and passes all exclusions", async () => {
    const fixture = makeHarness({
      trusted: (cwd) => cwd === "/trusted/project",
    });
    fixture.session.promptImpl = async (prompt) => {
      expect(prompt).toBe("inspect the project");
      fixture.session.emit(assistantMessage("done"));
    };
    const { request } = makeRunRequest({
      workingDir: "/trusted/project",
      systemPrompt: "You are a reviewer.",
    });

    await fixture.harness.run(request);

    expect(fixture.resourceInputs).toEqual([
      {
        cwd: "/trusted/project",
        agentDir: "/home/test/.pi/agent",
        projectTrusted: true,
        systemPrompt: "You are a reviewer.",
        tools: undefined,
      },
    ]);
    expect(fixture.sessionInputs).toHaveLength(1);
    expect(fixture.sessionInputs[0]).toMatchObject({
      cwd: "/trusted/project",
      model: MODEL,
      thinkingLevel: "high",
      sessionManager: { kind: "in-memory" },
    });
    expect(fixture.sessionInputs[0]!.excludeTools).toEqual(
      PI_CHILD_EXCLUDED_TOOLS,
    );
  });

  it("intersects named-agent tools with active tools and safety exclusions", async () => {
    const fixture = makeHarness();
    fixture.session.activeTools = ["read", "bash", "subagent_spawn", "ask_user"];
    fixture.session.promptImpl = async () => {
      fixture.session.emit(assistantMessage("done"));
    };
    const { request } = makeRunRequest({
      tools: ["read", "subagent_spawn", "missing"],
    });

    await fixture.harness.run(request);

    expect(fixture.session.activeTools).toEqual(["read"]);
    expect(fixture.session.activeToolUpdates).toEqual([["read"]]);
  });

  it("fails closed when a named-agent tool allowlist cannot be enforced", async () => {
    const fixture = makeHarness();
    Object.defineProperty(fixture.session, "getActiveToolNames", { value: undefined });
    Object.defineProperty(fixture.session, "setActiveToolsByName", { value: undefined });
    const { request } = makeRunRequest({ tools: ["read"] });

    await expect(fixture.harness.run(request)).rejects.toMatchObject({
      code: "pi_tool_restriction_unavailable",
    });
  });

  it("steers the existing active AgentSession through the public API", async () => {
    const fixture = makeHarness();
    let finishPrompt!: () => void;
    fixture.session.promptImpl = () => new Promise<void>((resolve) => {
      finishPrompt = () => {
        fixture.session.emit(assistantMessage("done"));
        resolve();
      };
    });
    const captured = makeRunRequest();
    const running = fixture.harness.run(captured.request);
    await flushAsync();

    expect(captured.controls).toHaveLength(1);
    await captured.controls[0]!.sendMessage("focus on the tests");
    expect(fixture.session.steered).toEqual(["focus on the tests"]);

    finishPrompt();
    await running;
    await expect(captured.controls[0]!.sendMessage("late")).rejects.toThrow("closed");
  });

  it("resolves an authenticated provider/model override before creating resources", async () => {
    const fixture = makeHarness();
    fixture.session.promptImpl = async () => {
      fixture.session.emit(
        assistantMessage("done", { provider: "openai", model: "gpt-test" }),
      );
    };
    const { request } = makeRunRequest({
      model: "openai/gpt-test",
      thinkingLevel: "low",
    });

    await fixture.harness.run(request);

    expect(fixture.sessionInputs[0]!.model).toBe(OTHER_MODEL);
    expect(fixture.sessionInputs[0]!.thinkingLevel).toBe("low");
  });

  it("accepts an unambiguous bare model id", async () => {
    const fixture = makeHarness();
    fixture.session.promptImpl = async () => {
      fixture.session.emit(assistantMessage("done"));
    };
    const { request } = makeRunRequest({ model: "gpt-test" });

    await fixture.harness.run(request);

    expect(fixture.sessionInputs[0]!.model).toBe(OTHER_MODEL);
  });

  it("fails before resource/session creation when a requested model is unavailable", async () => {
    const fixture = makeHarness({ available: [MODEL] });
    const { request } = makeRunRequest({ model: "openai/missing" });

    await expect(fixture.harness.run(request)).rejects.toMatchObject({
      code: "pi_model_unavailable",
    });
    expect(fixture.resourceInputs).toEqual([]);
    expect(fixture.sessionInputs).toEqual([]);
  });

  it("removes discovered excluded tool variants from the active child set", async () => {
    const fixture = makeHarness();
    fixture.session.promptImpl = async () => {
      fixture.session.emit(assistantMessage("done"));
    };

    await fixture.harness.run(makeRunRequest().request);

    expect(fixture.session.activeToolUpdates).toEqual([["read"]]);
  });
});

describe("Pi event-derived result", () => {
  it("derives final text, effective model, bounded progress, and aggregated usage from events", async () => {
    const fixture = makeHarness();
    fixture.session.promptImpl = async () => {
      fixture.session.emit({ type: "agent_start" });
      fixture.session.emit(assistantMessage("first turn", { totalTokens: 38 }));
      fixture.session.emit(
        assistantMessage("x".repeat(60_000), {
          input: 7,
          output: 4,
          cacheRead: 2,
          cacheWrite: 1,
          totalTokens: 14,
          cost: 0.03,
        }),
      );
    };
    const captured = makeRunRequest();

    const outcome = await fixture.harness.run(captured.request);

    expect(outcome.finalText.length).toBeLessThanOrEqual(50_000);
    expect(outcome.finalText).toContain("truncated");
    expect(outcome.effectiveModel).toBe("anthropic/claude-sonnet-test");
    expect(captured.models).toEqual([
      "anthropic/claude-sonnet-test",
      "anthropic/claude-sonnet-test",
    ]);
    expect(outcome.usage).toEqual({
      input: 17,
      output: 9,
      cacheRead: 22,
      cacheWrite: 4,
      costUsd: 0.05,
      turns: 2,
      contextTokens: 14,
    });
    expect(captured.progress.every((line) => line.length <= 400)).toBe(true);
  });

  it("captures bounded assistant and detailed tool transcript events", async () => {
    const fixture = makeHarness();
    fixture.session.promptImpl = async () => {
      fixture.session.emit({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "/tmp/example" },
      });
      fixture.session.emit({
        type: "tool_execution_update",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "/tmp/example" },
        partialResult: { content: "partial" },
      });
      fixture.session.emit({
        type: "tool_execution_end",
        toolCallId: "tool-1",
        toolName: "read",
        result: { content: "result" },
        isError: false,
      });
      fixture.session.emit(assistantMessage("assistant answer"));
    };
    const captured = makeRunRequest();

    await fixture.harness.run(captured.request);

    expect(captured.transcript).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "tool", phase: "start", callId: "tool-1", input: expect.stringContaining("/tmp/example") }),
      expect.objectContaining({ kind: "tool", phase: "update", output: expect.stringContaining("partial") }),
      expect.objectContaining({ kind: "tool", phase: "complete", output: expect.stringContaining("result") }),
      { kind: "assistant", text: "assistant answer" },
    ]));
    expect(captured.transcript.every((entry) => JSON.stringify(entry).length < 5_000)).toBe(true);
  });

  it("bounds hostile numeric usage values", async () => {
    const fixture = makeHarness();
    fixture.session.promptImpl = async () => {
      fixture.session.emit(
        assistantMessage("done", {
          input: Number.POSITIVE_INFINITY,
          output: -10,
          totalTokens: Number.POSITIVE_INFINITY,
          cost: Number.NaN,
        }),
      );
    };

    const outcome = await fixture.harness.run(makeRunRequest().request);

    expect(outcome.usage).toMatchObject({
      input: 0,
      output: 0,
      costUsd: 0,
      contextTokens: 0,
      turns: 1,
    });
  });

  it("rejects an event-derived child error and still cleans up exactly once", async () => {
    const fixture = makeHarness();
    fixture.session.promptImpl = async () => {
      fixture.session.emit(
        assistantMessage("partial", {
          stopReason: "error",
          errorMessage: "provider failed",
        }),
      );
    };

    await expect(fixture.harness.run(makeRunRequest().request)).rejects.toMatchObject({
      code: "pi_child_error",
    });
    expect(fixture.session.unsubscribeCount).toBe(1);
    expect(fixture.session.disposeCount).toBe(1);
  });

  it("rejects when no assistant message was emitted", async () => {
    const fixture = makeHarness();

    await expect(fixture.harness.run(makeRunRequest().request)).rejects.toMatchObject({
      code: "pi_no_result",
    });
  });
});

describe("Pi cancellation and cleanup", () => {
  it("settles without creating resources when already cancelled", async () => {
    const fixture = makeHarness();
    const captured = makeRunRequest();
    captured.controller.abort();

    await expect(fixture.harness.run(captured.request)).rejects.toMatchObject({
      code: "pi_run_cancelled",
    });
    expect(fixture.resourceInputs).toEqual([]);
  });

  it("propagates cancellation through session.abort and disposes once", async () => {
    const fixture = makeHarness();
    let rejectPrompt: ((error: Error) => void) | undefined;
    fixture.session.promptImpl = () =>
      new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
      });
    fixture.session.abortImpl = async () => {
      rejectPrompt?.(new Error("aborted"));
    };
    const captured = makeRunRequest();

    const pending = fixture.harness.run(captured.request);
    await flushAsync();
    captured.controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "pi_run_cancelled" });
    expect(fixture.session.abortCount).toBe(1);
    expect(fixture.session.unsubscribeCount).toBe(1);
    expect(fixture.session.disposeCount).toBe(1);
  });

  it("settles cancellation even when native abort never resolves", async () => {
    const fixture = makeHarness();
    fixture.session.promptImpl = () => new Promise<void>(() => undefined);
    fixture.session.abortImpl = () => new Promise<void>(() => undefined);
    const captured = makeRunRequest();

    const pending = fixture.harness.run(captured.request);
    await flushAsync();
    captured.controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "pi_run_cancelled" });
    expect(fixture.session.abortCount).toBe(1);
    expect(fixture.session.disposeCount).toBe(1);
  });

  it("cleans up exactly once when prompt throws", async () => {
    const fixture = makeHarness();
    fixture.session.promptImpl = async () => {
      throw new Error("prompt exploded");
    };

    await expect(fixture.harness.run(makeRunRequest().request)).rejects.toMatchObject({
      code: "pi_harness_failed",
    });
    expect(fixture.session.unsubscribeCount).toBe(1);
    expect(fixture.session.disposeCount).toBe(1);
    expect(fixture.session.abortCount).toBe(0);
  });
});

describe("Pi per-tool-call watchdog", () => {
  it("uses an exact three-minute production default", () => {
    expect(PI_TOOL_WATCHDOG_MS).toBe(180_000);
  });

  it("times out one quiet call even while another call keeps resetting", async () => {
    vi.useFakeTimers();
    const fixture = makeHarness();
    let rejectPrompt: ((error: Error) => void) | undefined;
    fixture.session.promptImpl = () =>
      new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
      });
    fixture.session.abortImpl = async () => {
      rejectPrompt?.(new Error("aborted by watchdog"));
    };

    const pending = fixture.harness.run(makeRunRequest().request);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "pi_tool_timeout",
    });
    await flushAsync();
    fixture.session.emit(toolEvent("tool_execution_start", "call-a", "read"));
    fixture.session.emit(toolEvent("tool_execution_start", "call-b", "bash"));

    await vi.advanceTimersByTimeAsync(120_000);
    fixture.session.emit(toolEvent("tool_execution_update", "call-a", "read"));
    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
    expect(fixture.session.abortCount).toBe(1);
    expect(fixture.session.disposeCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles a watchdog timeout even when native abort never resolves", async () => {
    vi.useFakeTimers();
    const fixture = makeHarness();
    fixture.session.promptImpl = () => new Promise<void>(() => undefined);
    fixture.session.abortImpl = () => new Promise<void>(() => undefined);

    const pending = fixture.harness.run(makeRunRequest().request);
    const rejection = expect(pending).rejects.toMatchObject({
      code: "pi_tool_timeout",
    });
    await flushAsync();
    fixture.session.emit(toolEvent("tool_execution_start", "call-a", "bash"));
    await vi.advanceTimersByTimeAsync(180_000);

    await rejection;
    expect(fixture.session.abortCount).toBe(1);
    expect(fixture.session.disposeCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resets only the matching call and clears the timer when that call ends", async () => {
    vi.useFakeTimers();
    const fixture = makeHarness();
    let finishPrompt: (() => void) | undefined;
    fixture.session.promptImpl = () =>
      new Promise<void>((resolve) => {
        finishPrompt = resolve;
      });

    const pending = fixture.harness.run(makeRunRequest().request);
    await flushAsync();
    fixture.session.emit(toolEvent("tool_execution_start", "call-a", "read"));
    await vi.advanceTimersByTimeAsync(179_999);
    fixture.session.emit(toolEvent("tool_execution_update", "call-a", "read"));
    await vi.advanceTimersByTimeAsync(179_999);
    fixture.session.emit(toolEvent("tool_execution_end", "call-a", "read"));
    await vi.advanceTimersByTimeAsync(300_000);
    fixture.session.emit(assistantMessage("done"));
    finishPrompt?.();

    await expect(pending).resolves.toMatchObject({ finalText: "done" });
    expect(fixture.session.abortCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears every outstanding timer on cancellation", async () => {
    vi.useFakeTimers();
    const fixture = makeHarness();
    let rejectPrompt: ((error: Error) => void) | undefined;
    fixture.session.promptImpl = () =>
      new Promise<void>((_resolve, reject) => {
        rejectPrompt = reject;
      });
    fixture.session.abortImpl = async () => {
      rejectPrompt?.(new Error("cancelled"));
    };
    const captured = makeRunRequest();

    const pending = fixture.harness.run(captured.request);
    await flushAsync();
    fixture.session.emit(toolEvent("tool_execution_start", "call-a"));
    fixture.session.emit(toolEvent("tool_execution_start", "call-b"));
    captured.controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "pi_run_cancelled" });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("Pi child tool exclusion", () => {
  it("covers exact and discovered subagent/workflow/question variants", () => {
    expect(isExcludedPiChildTool("subagent_spawn")).toBe(true);
    expect(isExcludedPiChildTool("subagent_custom")).toBe(true);
    expect(isExcludedPiChildTool("workflow_deploy")).toBe(true);
    expect(isExcludedPiChildTool("ask_user_followup")).toBe(true);
    expect(isExcludedPiChildTool("questionnaire")).toBe(true);
    expect(isExcludedPiChildTool("multi_tool_use.parallel")).toBe(true);
    expect(isExcludedPiChildTool("read")).toBe(false);
  });

  it("uses the same fail-closed policy for runtime tool-call enforcement", () => {
    expect(isAllowedPiChildTool("read", ["read", "grep"])).toBe(true);
    expect(isAllowedPiChildTool("bash", ["read", "grep"])).toBe(false);
    expect(isAllowedPiChildTool("subagent_spawn", ["subagent_spawn"])).toBe(false);
    expect(isAllowedPiChildTool("bash", undefined)).toBe(true);
    expect(isAllowedPiChildTool("ask_user", undefined)).toBe(false);

    expect(piChildToolDenial("read", ["read", "grep"])).toBeUndefined();
    expect(piChildToolDenial("bash", ["read", "grep"])).toEqual({
      block: true,
      reason: 'Tool "bash" is not allowed by this named agent.',
      terminate: true,
    });
    expect(piChildToolDenial("subagent_spawn", ["subagent_spawn"])).toEqual({
      block: true,
      reason: 'Tool "subagent_spawn" is disabled in Pi child sessions.',
      terminate: true,
    });
  });
});

describe("official Pi resource construction", () => {
  it("uses an in-memory session manager and isolates parent extensions", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-harness-resources-"));
    const cwd = join(root, "project");
    const agentDir = join(root, "agent");
    await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
    await mkdir(join(agentDir, "extensions"), { recursive: true });
    await writeFile(
      join(cwd, ".pi", "extensions", "project.ts"),
      "export default function () {}\n",
    );
    await writeFile(
      join(agentDir, "extensions", "user.ts"),
      "export default function () {}\n",
    );

    try {
      const untrusted = await createOfficialPiResources({
        cwd,
        agentDir,
        projectTrusted: false,
        systemPrompt: "Named agent prompt",
        tools: undefined,
      });
      const trusted = await createOfficialPiResources({
        cwd,
        agentDir,
        projectTrusted: true,
        systemPrompt: undefined,
        tools: undefined,
      });
      const untrustedSession = untrusted.sessionManager as {
        isPersisted(): boolean;
        getCwd(): string;
      };
      const untrustedLoader = untrusted.resourceLoader as {
        getExtensions(): { extensions: Array<{ path: string }> };
        getAppendSystemPrompt(): string[];
      };
      const trustedLoader = trusted.resourceLoader as {
        getExtensions(): { extensions: Array<{ path: string }> };
      };

      expect(untrustedSession.isPersisted()).toBe(false);
      expect(untrustedSession.getCwd()).toBe(cwd);
      expect(untrustedLoader.getAppendSystemPrompt()).toContain(
        "Named agent prompt",
      );
      const untrustedExtensions = untrustedLoader.getExtensions().extensions;
      const trustedExtensions = trustedLoader.getExtensions().extensions;
      for (const extensions of [untrustedExtensions, trustedExtensions]) {
        expect(
          extensions.some((extension) => extension.path.includes("project.ts")),
        ).toBe(false);
        expect(
          extensions.some((extension) => extension.path.includes("user.ts")),
        ).toBe(false);
        expect(
          extensions.some((extension) =>
            extension.path.includes("pi-subagents-child-safety")
          ),
        ).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
