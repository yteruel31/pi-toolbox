import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiSubagentsExtension, type ExtensionDependencies } from "../src/extension.js";
import type { HarnessRunRequest, SubagentHarness } from "../src/core/harness.js";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

function model(provider: string, id: string) {
  return { provider, id, name: id, api: "test", baseUrl: "", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any;
}

class Harness implements SubagentHarness {
  readonly supportsActiveMessages = true;
  requests: HarnessRunRequest[] = [];
  constructor(readonly kind: "pi" | "claude" = "pi") {}
  run(request: HarnessRunRequest) { this.requests.push(request); return new Promise<any>(() => undefined); }
}

async function fixture(options: { config?: { enabled: boolean }; scoped?: any[]; available?: any[]; dependencies?: ExtensionDependencies } = {}) {
  const cwd = await mkdtemp(path.join(tmpdir(), "jev-extension-")); dirs.push(cwd);
  const handlers = new Map<string, Function[]>();
  const tools = new Map<string, ToolDefinition>();
  const pi = { on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {}, appendEntry() {}, sendMessage() {}, events: { emit() {}, on: () => () => {} } } as unknown as ExtensionAPI;
  const piHarness = new Harness("pi"), claudeHarness = new Harness("claude");
  let stored = options.config;
  const readJevConfig = vi.fn(async () => stored as any);
  createPiSubagentsExtension({ createPiHarness: () => piHarness, createClaudeHarness: () => claudeHarness, readJevConfig, listClaudeModels: async () => [], resolveJevKey: async () => "key", ...options.dependencies })(pi);
  const available = options.available ?? [model("openai", "a"), model("openai", "b")];
  const scopedModels = options.scoped ?? [];
  const ctx = { cwd, mode: "print", hasUI: false, ui: { setStatus() {}, notify() {} }, isIdle: () => true, isProjectTrusted: () => true, model: model("openai", "a"), thinkingLevel: "medium", ...(scopedModels.length ? { scopedModels } : {}), modelRegistry: { find: () => model("openai", "a"), getAvailable: () => available }, sessionManager: { getSessionId: () => "session", getBranch: () => [] } } as unknown as ExtensionContext;
  const emit = async (name: string, event: unknown = {}) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
  const spawn = (params: any, signal?: AbortSignal) => tools.get("subagent_spawn")!.execute("call", params, signal, undefined, ctx);
  await emit("session_start", { reason: "startup" });
  return { ctx, emit, spawn, tools, piHarness, claudeHarness, readJevConfig, setStored(value: any) { stored = value; } };
}

async function tick() { await new Promise<void>((resolve) => setImmediate(resolve)); }

describe("Jev extension wiring", () => {
  it("does no Jev catalogue, key, or router work while disabled", async () => {
    const routeJev = vi.fn(), listClaudeModels = vi.fn(), resolveJevKey = vi.fn();
    const f = await fixture({ dependencies: { routeJev, listClaudeModels, resolveJevKey } });
    await f.spawn({ prompt: "task" });
    expect(f.piHarness.requests).toHaveLength(1);
    expect(routeJev).not.toHaveBeenCalled(); expect(listClaudeModels).not.toHaveBeenCalled(); expect(resolveJevKey).not.toHaveBeenCalled();
  });

  it("snapshots configuration at session_start and refreshes only on the next start", async () => {
    const routeJev = vi.fn(async (input: any) => ({ route: input.route, used: false }));
    const f = await fixture({ dependencies: { routeJev } });
    f.setStored({ version: 1, enabled: true, credential: { source: "environment", value: "JEV_KEY" } });
    await f.spawn({ prompt: "still disabled" }); await tick(); expect(routeJev).not.toHaveBeenCalled();
    await f.emit("session_start", { reason: "reload" });
    await f.spawn({ prompt: "now enabled" }); await tick(); expect(routeJev).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: "scope excludes parent", scoped: [model("openai", "b")], explicit: {}, expected: ["openai/b"] },
    { name: "stale scope", scoped: [model("gone", "x")], explicit: {}, expected: [] },
    { name: "empty scope", scoped: [], explicit: {}, expected: ["openai/a", "openai/b"] },
    { name: "explicit outside scope", scoped: [model("openai", "b")], explicit: { model: "openai/a" }, expected: ["openai/a"] },
  ])("passes correct Pi candidates: $name", async ({ scoped, explicit, expected }) => {
    let captured: any;
    const routeJev = vi.fn(async (input: any) => { captured = input; return { route: input.route, used: false }; });
    const normalized = scoped.map((entry: any) => entry.model ? entry : { model: entry, thinkingLevel: "max" });
    const f = await fixture({ config: { enabled: true }, scoped: normalized, dependencies: { routeJev } });
    await f.spawn({ prompt: "route", ...explicit }); await tick();
    expect(captured.piModels.map((item: any) => `${item.provider}/${item.id}`)).toEqual(expected);
  });

  it("honors a profile model outside scope and ignores scoped thinking pins", async () => {
    let captured: any;
    const routeJev = vi.fn(async (input: any) => { captured = input; return { route: input.route, used: false }; });
    const f = await fixture({ config: { enabled: true }, scoped: [{ model: model("openai", "b"), thinkingLevel: "max" }], dependencies: {
      routeJev,
      createDiscovery: async () => ({ discover: async () => ({ agents: [{ name: "fixed", description: "fixed", systemPrompt: "", defaults: { model: "openai/a" }, source: { scope: "user", path: "/tmp/fixed" } }], warnings: [] }) }) as any,
      createRoutingStore: () => ({ read: async () => ({ routing: undefined }) }) as any,
    } });
    await f.spawn({ prompt: "route", agent: "fixed" }); await tick();
    expect(captured.piModels.map((item: any) => `${item.provider}/${item.id}`)).toEqual(["openai/a"]);
    expect(captured.resolutionInput.agent.defaults.model).toBe("openai/a");
  });

  it.each([false, true])("starts unit-implementer through the real router (saved route: %s)", async (saved) => {
    const astra = { ...model("openai-codex", "gpt-6-astra"), reasoning: true };
    const sol = { ...model("openai-codex", "gpt-5.6-sol"), reasoning: true };
    const profileTools = ["read", "grep", "find", "ls", "bash", "edit", "write", "contact_supervisor"];
    const resolveJevKey = vi.fn();
    const f = await fixture({ config: { enabled: true }, available: [astra, sol],
      scoped: [{ model: astra, thinkingLevel: "off" }], dependencies: {
        resolveJevKey,
        createDiscovery: async () => ({ discover: async () => ({ agents: [{
          name: "unit-implementer", description: "Work", systemPrompt: "Profile prompt",
          defaults: { thinking: "low" }, tools: profileTools, source: { scope: "package", path: "/fixture/agent.md" },
        }], warnings: [] }) }) as any,
        createRoutingStore: () => ({ read: async (scope: string) => ({ routing: saved && scope === "user"
          ? { agents: { "unit-implementer": { harness: "pi", model: "openai-codex/gpt-5.6-sol", thinking: "off" } } }
          : undefined }) }) as any,
      } });
    f.ctx.model = astra;
    const spawned = await f.spawn({ prompt: "task", agent: "unit-implementer" });
    await tick();
    expect(f.piHarness.requests).toHaveLength(1);
    expect(f.piHarness.requests[0]).toMatchObject({
      model: saved ? "openai-codex/gpt-5.6-sol" : "openai-codex/gpt-6-astra",
      thinkingLevel: saved ? "off" : "low", tools: profileTools, systemPrompt: "Profile prompt",
    });
    expect(resolveJevKey).not.toHaveBeenCalled();
    expect(f.claudeHarness.requests).toHaveLength(0);
    const id = (spawned.details as any).snapshot.id;
    const checked = await f.tools.get("subagent_check")!.execute("check", { id }, undefined, undefined, f.ctx);
    expect(JSON.stringify(checked.details)).toContain('"state":"resolved"');
    await f.emit("session_shutdown", { reason: "quit" });
  });

  it("returns before deferred routing resolves and cancellation prevents a late backend start", async () => {
    let release!: () => void;
    const routeJev = vi.fn(() => new Promise<any>((resolve) => { release = () => resolve({ route: { harness: "pi", model: "openai/a", thinking: undefined, provenance: { harness: "parent", model: "jev", thinking: "parent" } }, used: true }); }));
    const f = await fixture({ config: { enabled: true }, dependencies: { routeJev } });
    const spawned = await f.spawn({ prompt: "route" });
    expect((spawned.details as any).snapshot.routing.state).toBe("pending"); expect(routeJev).not.toHaveBeenCalled();
    await tick();
    await f.emit("session_shutdown", { reason: "quit" }); release(); await tick();
    expect(f.piHarness.requests).toHaveLength(0); expect(f.claudeHarness.requests).toHaveLength(0);
  });

  it("shutdown settles while catalogue work resolves late without starting a backend", async () => {
    let release!: () => void;
    const f = await fixture({ config: { enabled: true }, dependencies: { listClaudeModels: () => new Promise<any>((resolve) => { release = () => resolve([]); }) } });
    await f.spawn({ prompt: "route" }); await tick();
    await f.emit("session_shutdown", { reason: "quit" }); release(); await tick();
    expect(f.piHarness.requests).toHaveLength(0); expect(f.claudeHarness.requests).toHaveLength(0);
  });
});
