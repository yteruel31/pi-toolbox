import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import type {
  HarnessRunOutcome,
  HarnessRunRequest,
  SubagentHarness,
} from "../src/core/harness.js";
import { FileAgentDiscovery } from "../src/agents/discovery.js";
import { FileRoutingStore } from "../src/agents/routing-store.js";
import { createPiSubagentsExtension } from "../src/extension.js";

class ControlledHarness implements SubagentHarness {
  readonly supportsActiveMessages = false;
  requests: HarnessRunRequest[] = [];
  private pending: Array<{
    resolve: (outcome: HarnessRunOutcome) => void;
    reject: (error: unknown) => void;
  }> = [];

  constructor(readonly kind: "pi" | "claude" = "pi") {}

  run(request: HarnessRunRequest): Promise<HarnessRunOutcome> {
    this.requests.push(request);
    return new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  finish(index: number, text: string): void {
    this.pending[index]?.resolve({
      finalText: text,
      effectiveModel: "fake/model",
      usage: {
        input: 3,
        output: 2,
        cacheRead: 1,
        cacheWrite: 0,
        costUsd: 0.01,
        turns: 1,
        contextTokens: 6,
      },
    });
  }
}

interface FakeRuntime {
  pi: ExtensionAPI;
  handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>;
  entries: Array<{ customType: string; data: unknown }>;
  messages: Array<{ message: unknown; options: unknown }>;
  emitted: Array<{ channel: string; data: unknown }>;
}

function fakePi(): FakeRuntime {
  const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  const messages: Array<{ message: unknown; options: unknown }> = [];
  const emitted: Array<{ channel: string; data: unknown }> = [];
  const pi = {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool);
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
      commands.set(name, command);
    },
    appendEntry(customType: string, data: unknown) {
      entries.push({ customType, data });
    },
    sendMessage(message: unknown, options: unknown) {
      messages.push({ message, options });
    },
    events: {
      emit(channel: string, data: unknown) {
        emitted.push({ channel, data });
      },
      on: () => () => {},
    },
  } as unknown as ExtensionAPI;
  return { pi, handlers, tools, commands, entries, messages, emitted };
}

function fakeContext(cwd: string, entries: FakeRuntime["entries"]): ExtensionContext {
  return {
    cwd,
    mode: "print",
    hasUI: false,
    ui: { setStatus() {}, notify() {} },
    isIdle: () => true,
    isProjectTrusted: () => true,
    model: { provider: "fake", id: "parent" },
    thinkingLevel: "medium",
    modelRegistry: {
      find: () => ({ provider: "fake", id: "parent" }),
      getAvailable: () => [{ provider: "fake", id: "parent" }],
    },
    sessionManager: {
      getBranch: () => entries.map(({ customType, data }, index) => ({
        type: "custom",
        id: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        timestamp: new Date().toISOString(),
        customType,
        data,
      })),
    },
  } as unknown as ExtensionContext;
}

async function emit(runtime: FakeRuntime, name: string, event: unknown, ctx: ExtensionContext) {
  for (const handler of runtime.handlers.get(name) ?? []) await handler(event, ctx);
}

async function execute(runtime: FakeRuntime, name: string, params: unknown, ctx: ExtensionContext) {
  const tool = runtime.tools.get(name);
  if (!tool) throw new Error(`missing ${name}`);
  return tool.execute("call-1", params, undefined, undefined, ctx);
}

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Pi extension composition", () => {
  it("registers six strict tools and composes wait, delivery, persistence, and shutdown", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-subagents-extension-"));
    temporary.push(cwd);
    const runtime = fakePi();
    const harness = new ControlledHarness("pi");
    createPiSubagentsExtension({
      createPiHarness: () => harness,
      createClaudeHarness: () => ({
        kind: "claude" as const,
        supportsActiveMessages: false,
        run: (request) => harness.run(request),
      }),
    })(runtime.pi);

    expect([...runtime.tools.keys()]).toEqual([
      "subagent_spawn",
      "subagent_agents",
      "subagent_wait",
      "subagent_cancel",
      "subagent_check",
      "subagent_list",
    ]);
    expect([...runtime.commands.keys()]).toEqual(["subagents", "btw"]);
    expect(runtime.tools.get("subagent_spawn")?.parameters).toMatchObject({ type: "object" });

    const ctx = fakeContext(cwd, runtime.entries);
    await emit(runtime, "session_start", { type: "session_start", reason: "startup" }, ctx);

    const spawned = await execute(runtime, "subagent_spawn", { prompt: "first task" }, ctx);
    expect((spawned.content[0] as { text: string } | undefined)?.text).toContain("run-1");
    expect(harness.requests[0]?.prompt).toBe("first task");
    expect(runtime.entries.some((entry) => entry.customType === "pi-subagents-state-v1")).toBe(true);

    const waitPromise = execute(runtime, "subagent_wait", { ids: ["run-1", "missing"] }, ctx);
    harness.finish(0, "finished one");
    const waited = await waitPromise;
    const waitedText = (waited.content[0] as { text: string } | undefined)?.text;
    expect(waitedText).toContain("finished one");
    expect(waitedText).toContain("missing: unknown run id");
    expect(waited.usage).toMatchObject({ input: 3, output: 2, totalTokens: 6 });
    await Promise.resolve();
    expect(runtime.messages).toHaveLength(0);

    await execute(runtime, "subagent_spawn", { prompt: "second task" }, ctx);
    harness.finish(1, "finished two");
    await Promise.resolve();
    await emit(runtime, "agent_settled", { type: "agent_settled" }, ctx);
    expect(runtime.messages).toHaveLength(1);
    expect(runtime.messages[0]?.message).toMatchObject({ customType: "pi-subagents-results" });
    expect(runtime.messages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
    await emit(runtime, "agent_settled", { type: "agent_settled" }, ctx);
    expect(runtime.messages).toHaveLength(1);

    await execute(runtime, "subagent_spawn", { prompt: "third task" }, ctx);
    await emit(runtime, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    expect(harness.requests[2]?.signal.aborted).toBe(true);
    await expect(execute(runtime, "subagent_list", {}, ctx)).rejects.toThrow("no active Pi session");
  });

  it("broadcasts versioned run counts without a UI and clears them on shutdown", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-subagents-status-"));
    temporary.push(cwd);
    const runtime = fakePi();
    const harness = new ControlledHarness("pi");
    createPiSubagentsExtension({
      createPiHarness: () => harness,
      createClaudeHarness: () => new ControlledHarness("claude"),
    })(runtime.pi);

    const ctx = fakeContext(cwd, runtime.entries);
    expect(ctx.hasUI).toBe(false);
    await emit(runtime, "session_start", { type: "session_start", reason: "startup" }, ctx);
    const statusEvents = () => runtime.emitted.filter((event) => event.channel === "pi-toolbox:subagents:status");
    expect(statusEvents().at(-1)?.data).toEqual({ v: 1, counts: { running: 0, completed: 0, error: 0 } });

    await execute(runtime, "subagent_spawn", { prompt: "task" }, ctx);
    expect(statusEvents().at(-1)?.data).toEqual({ v: 1, counts: { running: 1, completed: 0, error: 0 } });

    harness.finish(0, "done");
    await Promise.resolve();
    await emit(runtime, "agent_settled", { type: "agent_settled" }, ctx);
    expect(statusEvents().at(-1)?.data).toEqual({ v: 1, counts: { running: 0, completed: 1, error: 0 } });

    await emit(runtime, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);
    expect(statusEvents().at(-1)?.data).toEqual({ v: 1, counts: null });
  });

  it("wires package discovery and saved routing into named-agent spawn", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-subagents-package-"));
    const cwd = path.join(root, "project");
    const agentDir = path.join(root, "agent-home");
    const packageRoot = path.join(root, "profile-package");
    temporary.push(root);
    await Promise.all([
      mkdir(cwd, { recursive: true }),
      mkdir(path.join(packageRoot, "profiles"), { recursive: true }),
      mkdir(agentDir, { recursive: true }),
    ]);
    await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
      name: "example-profiles",
      pi: { subagents: { agents: ["./profiles"] } },
    }));
    await writeFile(path.join(packageRoot, "profiles", "reviewer.md"), [
      "---",
      "name: reviewer",
      "description: Review code.",
      "harness: pi",
      "thinking: low",
      "tools: read, grep, find, ls",
      "skills:",
      "  - code-review",
      "---",
      "Be exact and cite files.",
    ].join("\n"));

    const discovery = new FileAgentDiscovery({
      agentDir,
      packages: [{ source: "npm:example-profiles", root: packageRoot, scope: "user" }],
    });
    const routing = new FileRoutingStore({ agentDir, cwd, projectTrusted: true });
    await routing.write("user", {
      version: 1,
      agents: { reviewer: { model: "fake/routed", thinking: "high" } },
    });
    const runtime = fakePi();
    const piHarness = new ControlledHarness("pi");
    const claudeHarness = new ControlledHarness("claude");
    createPiSubagentsExtension({
      createPiHarness: () => piHarness,
      createClaudeHarness: () => claudeHarness,
      createDiscovery: async () => discovery,
      createRoutingStore: () => routing,
      preloadSkills: async (input) => ({
        content: `<skill name="${input.names[0]}">Use the checklist.</skill>`,
        loaded: [...input.names],
        warnings: [],
      }),
    })(runtime.pi);
    const ctx = fakeContext(cwd, runtime.entries);
    await emit(runtime, "session_start", { type: "session_start", reason: "startup" }, ctx);

    const catalog = await execute(runtime, "subagent_agents", {}, ctx);
    expect((catalog.content[0] as { text: string }).text).toContain("reviewer");
    expect((catalog.content[0] as { text: string }).text).toContain("fake/routed");
    expect((catalog.content[0] as { text: string }).text).toContain("code-review");

    const spawned = await execute(runtime, "subagent_spawn", {
      prompt: "review now",
      agent: "reviewer",
      name: "Custom review",
    }, ctx);
    expect(piHarness.requests).toEqual([]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(piHarness.requests[0]).toMatchObject({
      prompt: "review now",
      systemPrompt:
        "Be exact and cite files.\n\n<skill name=\"code-review\">Use the checklist.</skill>",
      tools: ["read", "grep", "find", "ls"],
      model: "fake/routed",
      thinkingLevel: "high",
    });
    expect(spawned.details).toMatchObject({
      snapshot: {
        title: "Custom review",
        agentProfile: "reviewer",
      },
      skills: { requested: ["code-review"] },
    });
    expect((spawned.content[0] as { text: string }).text).toContain(
      "Custom review (reviewer)",
    );

    await execute(runtime, "subagent_spawn", {
      prompt: "review with claude",
      agent: "reviewer",
      harness: "claude",
    }, ctx);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(claudeHarness.requests[0]).toMatchObject({
      prompt: "review with claude",
      systemPrompt:
        "Be exact and cite files.\n\n<skill name=\"code-review\">Use the checklist.</skill>",
      tools: ["read", "grep", "find", "ls"],
      model: "fake/routed",
      thinkingLevel: "high",
    });
  });

  it("fails closed on a malformed latest persisted state", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-subagents-restore-"));
    temporary.push(cwd);
    const runtime = fakePi();
    runtime.entries.push({
      customType: "pi-subagents-state-v1",
      data: {
        version: 1,
        nextSerial: 8,
        nextSettlementSeq: 1,
        runs: [],
      },
    });
    runtime.entries.push({ customType: "pi-subagents-state-v1", data: { version: 1 } });
    const harness = new ControlledHarness("pi");
    createPiSubagentsExtension({
      createPiHarness: () => harness,
      createClaudeHarness: () => new ControlledHarness("claude"),
    })(runtime.pi);
    const ctx = fakeContext(cwd, runtime.entries);
    await emit(runtime, "session_start", { type: "session_start", reason: "startup" }, ctx);

    const spawned = await execute(runtime, "subagent_spawn", { prompt: "fresh" }, ctx);
    expect((spawned.content[0] as { text: string }).text).toContain("run-1");
  });

  it("keeps /btw out of parent messages and rejects untrusted working directories", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "pi-subagents-btw-"));
    temporary.push(cwd);
    const runtime = fakePi();
    const harness = new ControlledHarness("pi");
    createPiSubagentsExtension({
      createPiHarness: () => harness,
      createClaudeHarness: () => new ControlledHarness("claude"),
    })(runtime.pi);
    const ctx = fakeContext(cwd, runtime.entries);
    await emit(runtime, "session_start", { type: "session_start", reason: "startup" }, ctx);

    const command = runtime.commands.get("btw")!;
    const pending = command.handler("what changed?", ctx as never);
    while (harness.requests.length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    harness.finish(0, "side answer");
    await pending;
    await emit(runtime, "agent_settled", { type: "agent_settled" }, ctx);
    expect(runtime.messages).toHaveLength(0);
    expect(runtime.entries.some((entry) =>
      entry.customType === "pi-subagents-btw-v1" &&
      JSON.stringify(entry.data).includes("side answer"),
    )).toBe(true);

    const untrusted = {
      ...ctx,
      isProjectTrusted: () => false,
    } as ExtensionContext;
    await expect(execute(runtime, "subagent_spawn", { prompt: "unsafe" }, untrusted))
      .rejects.toThrow("trusted Pi project");
  });
});
