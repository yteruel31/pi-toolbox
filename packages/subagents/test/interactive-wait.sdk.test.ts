import { expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import * as path from "node:path";
import { Type } from "typebox";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiSubagentsExtension } from "../src/extension.js";
import type { HarnessRunOutcome, HarnessRunRequest, SubagentHarness } from "../src/core/harness.js";
class ControlledHarness implements SubagentHarness {
  readonly kind = "pi" as const;
  readonly supportsActiveMessages = false;
  request?: HarnessRunRequest;
  finish!: (result: HarnessRunOutcome) => void;
  run(request: HarnessRunRequest) {
    this.request = request;
    return new Promise<HarnessRunOutcome>((resolve) => { this.finish = resolve; });
  }
}

// The repository SDK predates codemode's ctx.executeTool support. This bounded
// real-session regression still covers direct waits on that compatibility baseline.
it("actual SDK processes steering before child completion and delivers once", async () => {
  const cwd = process.cwd();
  const settings = SettingsManager.inMemory({ retry: { enabled: false } });
  const harness = new ControlledHarness();
  let waiting!: () => void;
  const started = new Promise<void>((resolve) => { waiting = resolve; });
  let calls = 0;
  let finishSibling!: () => void;
  let siblingSignal: AbortSignal | undefined;
  const siblingDone = new Promise<void>((resolve) => { finishSibling = resolve; });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd,
    settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "wait-test", factory(pi) {
      createPiSubagentsExtension({ readJevConfig: async () => undefined, createPiHarness: () => harness, createClaudeHarness: () => harness })(pi);
      pi.registerTool({ name: "sibling", label: "Sibling", description: "Controlled sibling", parameters: Type.Object({}), async execute(_id, _params, signal) {
        siblingSignal = signal;
        await siblingDone;
        return { content: [{ type: "text", text: "sibling finished" }], details: {} };
      } });
      pi.on("tool_execution_start", (event) => { if (event.toolName === "subagent_wait") setImmediate(waiting); });
      pi.registerProvider("wait-test", { api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fake", models: [{ id: "fake", name: "fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
        streamSimple(model) {
          const stream = createAssistantMessageEventStream();
          const turn = calls++;
          const content = turn === 0 ? [{ type: "toolCall", id: "spawn", name: "subagent_spawn", arguments: { prompt: "slow" } }] : turn === 1 ? [{ type: "toolCall", id: "wait", name: "subagent_wait", arguments: { ids: [harness.request!.runId] } }, { type: "toolCall", id: "sibling", name: "sibling", arguments: {} }] : [{ type: "text", text: "Steering processed" }];
          const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: turn < 2 ? "toolUse" : "stop", timestamp: Date.now() } as AssistantMessage;
          queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(message); });
          return stream;
        },
      });
    } }],
  });
  await loader.reload();
  const { session } = await createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager: settings, noTools: "builtin" });
  try {
    await session.bindExtensions({ mode: "print" });
    await session.setModel(runtime.getModel("wait-test", "fake")!);
    const prompt = session.prompt("start");
    await started;
    await session.prompt("change direction", { streamingBehavior: "steer", source: "interactive" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(siblingSignal).toBeDefined();
    expect(siblingSignal?.aborted).toBe(false);
    finishSibling();
    await prompt;
    expect(session.messages.some((message) => message.role === "toolResult" && JSON.stringify(message).includes('"outcome":"interrupted"'))).toBe(true);
    expect(harness.request?.signal.aborted).toBe(false);
    expect(session.messages.filter((message) => message.role === "user" && JSON.stringify(message.content).includes("change direction"))).toHaveLength(1);
    expect(calls).toBeGreaterThan(2);
    harness.finish({ finalText: "slow child complete" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.messages.filter((message) => "customType" in message && message.customType === "pi-subagents-results")).toHaveLength(1);
  } finally { finishSibling(); await session.abort(); session.dispose(); }
}, 15000);

const testSdkRoot = process.env.PI_SUBAGENTS_TEST_SDK_ROOT;
const nestedCodemodeTest = testSdkRoot ? it : it.skip;

nestedCodemodeTest(
  testSdkRoot
    ? "opt-in SDK codemode nested wait releases for steering and delivers once"
    : "skipped: repository SDK has no createCodemodeExtension/ctx.executeTool; set PI_SUBAGENTS_TEST_SDK_ROOT to test a supporting SDK",
  async () => {
    // This test intentionally loads only the supplied SDK and its colocated pi-ai
    // dependency. It does not discover local extensions, credentials, or context.
    const root = testSdkRoot!;
    const sdk = await import(pathToFileURL(path.join(root, "dist/index.js")).href) as {
      createCodemodeExtension?: () => (pi: unknown) => void;
      ModelRuntime: typeof ModelRuntime;
      createAgentSession: typeof createAgentSession;
      DefaultResourceLoader: typeof DefaultResourceLoader;
      SessionManager: typeof SessionManager;
      SettingsManager: typeof SettingsManager;
    };
    const ai = await import(pathToFileURL(path.join(root, "node_modules/@earendil-works/pi-ai/dist/index.js")).href) as {
      InMemoryCredentialStore: typeof InMemoryCredentialStore;
      createAssistantMessageEventStream: typeof createAssistantMessageEventStream;
    };
    expect(typeof sdk.createCodemodeExtension).toBe("function");

    const cwd = process.cwd();
    const settings = sdk.SettingsManager.inMemory({ retry: { enabled: false } });
    const harness = new ControlledHarness();
    let waiting!: () => void;
    const started = new Promise<void>((resolve) => { waiting = resolve; });
    let calls = 0;
    let nestedWaitResult: unknown;
    const runtime = await sdk.ModelRuntime.create({ credentials: new ai.InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir: cwd,
      settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [{ name: "nested-wait-test", factory(pi: any) {
        sdk.createCodemodeExtension!()(pi);
        createPiSubagentsExtension({ readJevConfig: async () => undefined, createPiHarness: () => harness, createClaudeHarness: () => harness })(pi);
        pi.on("tool_execution_start", (event: { toolName: string; parentToolCallId?: string }) => {
          if (event.toolName === "subagent_wait" && event.parentToolCallId) setImmediate(waiting);
        });
        pi.on("tool_execution_end", (event: { toolName: string; parentToolCallId?: string; result: unknown }) => {
          if (event.toolName === "subagent_wait" && event.parentToolCallId) nestedWaitResult = event.result;
        });
        pi.registerProvider("nested-wait-test", { api: "openai-completions", baseUrl: "http://unused.invalid", apiKey: "fake", models: [{ id: "fake", name: "fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
          streamSimple(model: any) {
            const stream = ai.createAssistantMessageEventStream();
            const turn = calls++;
            const content = turn === 0
              ? [{ type: "toolCall", id: "spawn", name: "subagent_spawn", arguments: { prompt: "slow" } }]
              : turn === 1
                ? [{ type: "toolCall", id: "nested-wait", name: "codemode", arguments: { code: "await tools.subagent_wait({ ids: ['run-1'] }); return 'wait released';" } }]
                : [{ type: "text", text: "Steering processed" }];
            const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: turn < 2 ? "toolUse" : "stop", timestamp: Date.now() } as AssistantMessage;
            queueMicrotask(() => { stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(message); });
            return stream;
          },
        });
      } }],
    });
    await loader.reload();
    const { session } = await sdk.createAgentSession({ cwd, agentDir: cwd, modelRuntime: runtime, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd), settingsManager: settings, noTools: "builtin", tools: ["codemode", "subagent_spawn", "subagent_wait"] });
    try {
      await session.bindExtensions({ mode: "print" });
      await session.setModel(runtime.getModel("nested-wait-test", "fake")!);
      const prompt = session.prompt("start");
      await started;
      await session.prompt("change direction", { streamingBehavior: "steer", source: "interactive" });
      await prompt;
      expect(JSON.stringify(nestedWaitResult)).toContain('"outcome":"interrupted"');
      expect(harness.request?.signal.aborted).toBe(false);
      expect(session.messages.filter((message: unknown) => JSON.stringify(message).includes("change direction"))).toHaveLength(1);
      harness.finish({ finalText: "slow child complete" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.messages.filter((message: any) => message.customType === "pi-subagents-results")).toHaveLength(1);
    } finally { harness.finish?.({ finalText: "cleanup" }); await session.abort(); session.dispose(); }
  },
  15000,
);
