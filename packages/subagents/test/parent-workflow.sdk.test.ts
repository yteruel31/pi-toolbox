import { expect, it } from "vitest";
import { Type } from "typebox";
import { createAssistantMessageEventStream, InMemoryCredentialStore, type AssistantMessage } from "@earendil-works/pi-ai";
import { ModelRuntime, createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import { createPiSubagentsExtension } from "../src/extension.js";
import type { HarnessRunOutcome, HarnessRunRequest, SubagentHarness } from "../src/core/harness.js";

class ControlledHarness implements SubagentHarness {
  readonly kind = "pi" as const;
  readonly supportsActiveMessages = false;
  readonly requests: HarnessRunRequest[] = [];
  readonly settled: boolean[] = [];
  private readonly pending: Array<(outcome: HarnessRunOutcome) => void> = [];

  run(request: HarnessRunRequest): Promise<HarnessRunOutcome> {
    this.requests.push(request);
    this.settled.push(false);
    return new Promise((resolve) => this.pending.push(resolve));
  }

  finish(index: number, finalText: string): void {
    if (this.settled[index]) return;
    this.settled[index] = true;
    this.pending[index]?.({ finalText });
  }
}

// This uses the repository's Pi 0.87.1 SDK directly, with no credentials,
// discovered extensions, or model calls. It observes one scripted flow; it
// does not claim that a scripted fake model learned a scheduling policy.
it("actual SDK lets parent work, collect a ready dependency, and auto-deliver remaining work", async () => {
  const cwd = process.cwd();
  const settings = SettingsManager.inMemory({ retry: { enabled: false } });
  const harness = new ControlledHarness();
  const observedActions: string[] = [];
  const observedModelTurns: string[][] = [];
  let calls = 0;
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [{ name: "parent-workflow-test", factory(pi) {
      createPiSubagentsExtension({
        readJevConfig: async () => undefined,
        createPiHarness: () => harness,
        createClaudeHarness: () => harness,
      })(pi);
      pi.registerTool({
        name: "useful_parent_action",
        label: "Useful parent action",
        description: "A controlled useful action owned by the parent.",
        parameters: Type.Object({}),
        async execute() {
          observedActions.push(`parent-action: workers=${harness.requests.length}, second-settled=${harness.settled[1]}`);
          expect(harness.requests).toHaveLength(2);
          expect(harness.settled[1]).toBe(false);
          harness.finish(0, "first worker result");
          await new Promise<void>((resolve) => setImmediate(resolve));
          return { content: [{ type: "text", text: "parent action complete" }], details: {} };
        },
      });
      pi.registerProvider("parent-workflow-test", {
        api: "openai-completions",
        baseUrl: "http://unused.invalid",
        apiKey: "fake",
        models: [{ id: "fake", name: "fake", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32000, maxTokens: 1000 }],
        streamSimple(model) {
          const stream = createAssistantMessageEventStream();
          const turn = calls++;
          const content = turn === 0
            ? [{ type: "toolCall", id: "spawn-1", name: "subagent_spawn", arguments: { prompt: "first independent task" } }]
            : turn === 1
              ? [{ type: "toolCall", id: "spawn-2", name: "subagent_spawn", arguments: { prompt: "second independent task" } }]
              : turn === 2
                ? [{ type: "toolCall", id: "useful", name: "useful_parent_action", arguments: {} }]
                : turn === 3
                  ? [{ type: "toolCall", id: "collect", name: "subagent_collect", arguments: { ids: ["run-1"] } }]
                  : [{ type: "text", text: turn === 4 ? "First dependency incorporated; second worker continues." : "Delivered remaining worker result." }];
          observedModelTurns.push(content.map((item) => "name" in item ? item.name : "text"));
          const message = { role: "assistant", content, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: turn < 4 ? "toolUse" : "stop", timestamp: Date.now() } as AssistantMessage;
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
    await session.setModel(runtime.getModel("parent-workflow-test", "fake")!);
    await session.prompt("coordinate bounded work");

    expect(observedActions).toEqual(["parent-action: workers=2, second-settled=false"]);
    expect(observedModelTurns.slice(0, 5)).toEqual([["subagent_spawn"], ["subagent_spawn"], ["useful_parent_action"], ["subagent_collect"], ["text"]]);
    expect(harness.settled).toEqual([true, false]);
    expect(session.messages.some((message) => message.role === "toolResult" && JSON.stringify(message.content).includes("first worker result"))).toBe(true);

    harness.finish(1, "second worker result");
    for (let i = 0; i < 6 && !session.messages.some((message) => "customType" in message && message.customType === "pi-subagents-results"); i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(session.messages.filter((message) => "customType" in message && message.customType === "pi-subagents-results")).toHaveLength(1);
    expect(observedModelTurns.at(-1)).toEqual(["text"]);
  } finally {
    harness.finish(0, "cleanup");
    harness.finish(1, "cleanup");
    await session.abort();
    session.dispose();
  }
}, 15000);
