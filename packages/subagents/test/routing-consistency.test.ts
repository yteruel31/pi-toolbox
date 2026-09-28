import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DefaultRouteResolver, FileRoutingStore } from "../src/agents/index.js";
import { JevRoutingConflictError, routeWithJev } from "../src/agents/jev.js";
import type { AgentDefinition, RouteResolutionInput, RoutingEntry } from "../src/agents/types.js";
import type { HarnessRunRequest, SubagentHarness } from "../src/core/harness.js";
import { createPiSubagentsExtension, type ExtensionDependencies } from "../src/extension.js";
import type { ClaudeSupportedModel } from "../src/harnesses/claude.js";
import { renderRoutingPanel } from "../src/tui/pi-panel-renderer.js";
import { initialRoutingViewState, ROUTING_KEY_HINTS, type RoutingAgentRow } from "../src/tui/routing-view.js";

const resolver = new DefaultRouteResolver();
const PARENT = { model: "openai-codex/parent", thinking: "medium" as const };
const LOW_ONLY = { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null };
const LOW_HIGH = { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null };
const LOW_MAX = { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: "max" };
const OFFLINE = () => vi.fn(async () => { throw new Error("offline"); });

function agent(defaults: AgentDefinition["defaults"], tools?: string[]): AgentDefinition {
  return { name: "worker", description: "Work", systemPrompt: "Work", defaults, tools, source: { scope: "package", path: "/agent.md" } };
}
function input(overrides: Partial<RouteResolutionInput> = {}): RouteResolutionInput {
  return { explicit: {}, parent: PARENT, ...overrides };
}
function piModel(id: string, thinkingLevelMap: Record<string, string | null> = LOW_ONLY): Model<any> {
  return { id, name: id, provider: "openai-codex", api: "openai-responses", baseUrl: "", reasoning: true, thinkingLevelMap, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 } as Model<any>;
}
function claudeModel(value: string, efforts: Array<"low" | "high" | "max"> = ["low", "high"], resolvedModel?: string): ClaudeSupportedModel {
  return { value, displayName: value, description: "", supportsEffort: true, supportedEffortLevels: efforts, ...(resolvedModel ? { resolvedModel } : {}) };
}

type Decoded = [harness: string, model: string | null, thinking: string | null];
function jev(pick: (candidate: Decoded) => boolean = () => true) {
  const seen: Decoded[][] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const keys = Object.keys(JSON.parse(String(init?.body)).questions.route.criteria);
    const decoded = keys.map((key) => JSON.parse(Buffer.from(key, "base64url").toString()) as Decoded);
    seen.push(decoded);
    const choice = keys[Math.max(0, decoded.findIndex(pick))]!;
    return new Response(JSON.stringify({ answers: { route: { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])) } } }));
  });
  return { fetcher, seen };
}

async function route(
  resolution: RouteResolutionInput,
  options: { piModels?: Model<any>[]; claudeModels?: ClaudeSupportedModel[]; tools?: string[]; fetcher?: ReturnType<typeof vi.fn>; raw?: boolean } = {},
) {
  return routeWithJev({
    task: "task",
    route: resolver.resolve(resolution),
    ...(options.raw === false ? {} : { resolutionInput: resolution }),
    tools: options.tools,
    piModels: options.piModels ?? [],
    claudeModels: options.claudeModels ?? [],
    apiKey: "key",
  }, (options.fetcher ?? vi.fn()) as never);
}

describe("inherited model with fixed thinking and a free backend", () => {
  it.each([
    ["absent", {}],
    ["auto", { harness: "auto" as const }],
  ])("rejects instead of silently switching to the Claude SDK default when the harness is %s", async (_case, harness) => {
    const fetcher = vi.fn();
    const failure = await route(
      input({ explicit: harness, userRouting: { model: "inherit", thinking: "max" } }),
      { piModels: [piModel("parent", LOW_ONLY)], claudeModels: [claudeModel("sonnet", ["low", "max"])], fetcher },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JevRoutingConflictError);
    expect((failure as Error).message).toContain("thinking/effort is not advertised");
    expect((failure as Error).message).not.toContain("openai-codex");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects without raw resolution input too", async () => {
    const failure = await route(
      input({ userRouting: { model: "inherit", thinking: "max" } }),
      { piModels: [piModel("parent", LOW_ONLY)], claudeModels: [claudeModel("sonnet", ["low", "max"])], raw: false },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JevRoutingConflictError);
  });

  it("still lets Jev choose the backend when the inherited Pi model supports the fixed thinking", async () => {
    const { fetcher, seen } = jev(([harness]) => harness === "claude");
    const result = await route(
      input({ userRouting: { model: "inherit", thinking: "max" } }),
      { piModels: [piModel("parent", LOW_MAX)], claudeModels: [claudeModel("sonnet", ["low", "max"])], fetcher },
    );
    expect(seen[0]).toEqual([["pi", PARENT.model, "max"], ["claude", null, "max"]]);
    expect(result).toMatchObject({ used: true, route: { harness: "claude", model: undefined, thinking: "max" } });
  });

  it("passes a fixed thinking value through for an unknown parent model", async () => {
    const { fetcher, seen } = jev(([harness]) => harness === "pi");
    const result = await route(
      input({ userRouting: { model: "inherit", thinking: "max" } }),
      { piModels: [piModel("other", LOW_ONLY)], claudeModels: [claudeModel("sonnet")], fetcher },
    );
    expect(seen[0]).toEqual([["pi", PARENT.model, "max"], ["claude", null, "max"]]);
    expect(result.route).toMatchObject({ harness: "pi", model: PARENT.model, thinking: "max" });
  });

  it("keeps a fixed Claude harness on the SDK default model with fixed effort", async () => {
    const result = await route(
      input({ explicit: { harness: "claude" }, userRouting: { model: "inherit", thinking: "max" } }),
      { piModels: [piModel("parent", LOW_ONLY)], claudeModels: [claudeModel("sonnet")] },
    );
    expect(result).toMatchObject({ used: false, route: { harness: "claude", model: undefined, thinking: "max" } });
  });

  it("still lets a Claude tool allowlist select the Claude backend for an inherited model", async () => {
    const result = await route(
      input({ userRouting: { model: "inherit", thinking: "max" } }),
      { piModels: [piModel("parent", LOW_ONLY)], claudeModels: [claudeModel("sonnet")], tools: ["Read"] },
    );
    expect(result.route).toMatchObject({ harness: "claude", model: undefined, thinking: "max" });
  });
});

describe("harness auto with a fixed Claude model on fallback", () => {
  it("falls back like inherit (Pi), matching the Jev-disabled route and keeping the model id", async () => {
    const resolution = input({ explicit: { harness: "auto" }, agent: agent({ harness: "claude", model: "claude-sonnet-5" }) });
    const disabled = resolver.resolve(resolution);
    const result = await route(resolution, { piModels: [piModel("a")], claudeModels: [claudeModel("sonnet", ["low", "high"], "claude-sonnet-5")], fetcher: OFFLINE() });
    expect(result.fallback).toBeDefined();
    expect(result.route).toMatchObject({ harness: disabled.harness, model: "claude-sonnet-5", thinking: disabled.thinking, provenance: disabled.provenance });
    expect(result.route.harness).toBe("pi");
  });

  it("keeps a fixed Claude harness on fallback", async () => {
    const resolution = input({ explicit: { harness: "claude" }, agent: agent({ model: "claude-sonnet-5" }) });
    const result = await route(resolution, { claudeModels: [claudeModel("sonnet", ["low", "high"], "claude-sonnet-5")], fetcher: OFFLINE() });
    expect(result.route).toMatchObject({ harness: "claude", model: "claude-sonnet-5", provenance: { harness: "explicit" } });
  });

  it("rejects the Pi fallback for a Claude tool allowlist instead of starting without tools", async () => {
    const resolution = input({ explicit: { harness: "auto" }, agent: agent({ model: "claude-sonnet-5" }, ["Read"]) });
    await expect(route(resolution, { claudeModels: [claudeModel("sonnet", ["low", "high"], "claude-sonnet-5")], tools: ["Read"], fetcher: OFFLINE() }))
      .rejects.toBeInstanceOf(JevRoutingConflictError);
  });

  it("keeps the existing implied-backend fallback for an absent harness", async () => {
    const resolution = input({ agent: agent({ model: "claude-sonnet-5" }) });
    const result = await route(resolution, { claudeModels: [claudeModel("sonnet", ["low", "high"], "claude-sonnet-5")], fetcher: OFFLINE() });
    expect(result.route).toMatchObject({ harness: "claude", model: "claude-sonnet-5" });
  });
});

describe("fallback thinking validation", () => {
  const models = [piModel("parent", LOW_ONLY), piModel("a", LOW_HIGH), piModel("b", LOW_HIGH)];

  it("does not treat inherited parent thinking as a fixed constraint", async () => {
    const parentHigh = { model: "openai-codex/parent", thinking: "high" as const };
    const generic = await route({ explicit: {}, parent: parentHigh }, { piModels: models, fetcher: OFFLINE() });
    expect(generic).toMatchObject({ used: false, route: { harness: "pi", model: "openai-codex/parent", thinking: "high", provenance: { thinking: "parent" } } });
    expect(generic.fallback).toBeDefined();
    const unresolved = await route({ explicit: {}, parent: parentHigh }, { piModels: models, fetcher: OFFLINE(), raw: false });
    expect(unresolved.route).toMatchObject({ model: "openai-codex/parent", thinking: "high" });
    const inheritMode = await route({ explicit: { harness: "pi", model: "auto", thinking: "inherit" }, parent: parentHigh }, { piModels: models, fetcher: OFFLINE() });
    expect(inheritMode.route).toMatchObject({ model: "openai-codex/parent", thinking: "high", modes: { thinking: "inherit" } });
  });

  it("validates explicit fixed thinking against the fallback model's supported levels", async () => {
    const parentLow = { model: "openai-codex/parent", thinking: "low" as const };
    await expect(route({ explicit: { thinking: "high" }, parent: parentLow }, { piModels: models, fetcher: OFFLINE() }))
      .rejects.toBeInstanceOf(JevRoutingConflictError);
    const supported = await route({ explicit: { thinking: "high" }, parent: { model: "openai-codex/a", thinking: "low" } }, { piModels: models, fetcher: OFFLINE() });
    expect(supported.route).toMatchObject({ model: "openai-codex/a", thinking: "high", provenance: { thinking: "explicit" } });
    const profile = await route({ explicit: {}, agent: agent({ thinking: "low" }), parent: parentLow }, { piModels: models, fetcher: OFFLINE() });
    expect(profile.route).toMatchObject({ model: "openai-codex/parent", thinking: "low", provenance: { thinking: "agent-default" } });
  });
});

describe("routing value whitespace", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it("normalizes saved model whitespace like the profile and routing UI", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-subagents-ws-")); roots.push(root);
    const store = new FileRoutingStore({ agentDir: path.join(root, "agent"), cwd: path.join(root, "project"), projectTrusted: true });
    await store.write("user", { version: 1, agents: {
      auto: { model: " auto " }, inherit: { model: "\tinherit\n" }, qualified: { model: " openrouter/auto " }, cased: { model: " Claude-Opus-5-5[1m] " },
    } });
    const saved = (await store.read("user")).routing!.agents;
    expect(saved).toEqual({ auto: { model: "auto" }, inherit: { model: "inherit" }, qualified: { model: "openrouter/auto" }, cased: { model: "Claude-Opus-5-5[1m]" } });
    expect(JSON.parse(await readFile(store.routingPath("user"), "utf8")).agents.auto.model).toBe("auto");
    expect(resolver.resolve(input({ userRouting: saved.auto }))).toMatchObject({ model: PARENT.model, modes: { model: "auto" } });
    expect(resolver.resolve(input({ userRouting: saved.qualified })).modes).toBeUndefined();

    // Hand-edited files are normalized on read as well.
    const projectFile = store.routingPath("project");
    await mkdir(path.dirname(projectFile), { recursive: true, mode: 0o700 });
    await writeFile(projectFile, JSON.stringify({ version: 1, agents: { worker: { model: " inherit ", extra: 1 } } }), { mode: 0o600 });
    expect((await store.read("project")).routing!.agents.worker).toEqual({ model: "inherit", extra: 1 });
    await expect(store.write("user", { version: 1, agents: { blank: { model: "   " } } })).rejects.toThrow("invalid model");
  });
});

class Harness implements SubagentHarness {
  readonly supportsActiveMessages = true;
  requests: HarnessRunRequest[] = [];
  constructor(readonly kind: "pi" | "claude") {}
  run(request: HarnessRunRequest) { this.requests.push(request); return new Promise<any>(() => undefined); }
}

function extModel(provider: string, id: string) {
  return { provider, id, name: id, api: "test", baseUrl: "", reasoning: false, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as any;
}

describe("spawn routing consistency", () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

  async function fixture(options: { enabled?: boolean; profile?: AgentDefinition; saved?: RoutingEntry; dependencies?: ExtensionDependencies } = {}) {
    const cwd = await mkdtemp(path.join(tmpdir(), "routing-consistency-")); dirs.push(cwd);
    const handlers = new Map<string, Function[]>();
    const tools = new Map<string, ToolDefinition>();
    const pi = { on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); }, registerTool(tool: ToolDefinition) { tools.set(tool.name, tool); }, registerCommand() {}, appendEntry() {}, sendMessage() {}, events: { emit() {}, on: () => () => {} } } as unknown as ExtensionAPI;
    const piHarness = new Harness("pi"), claudeHarness = new Harness("claude");
    const profile = options.profile;
    createPiSubagentsExtension({
      createPiHarness: () => piHarness,
      createClaudeHarness: () => claudeHarness,
      readJevConfig: async () => (options.enabled ? { version: 1, enabled: true, credential: { source: "environment", value: "JEV_KEY" } } : undefined) as any,
      listClaudeModels: async () => [],
      resolveJevKey: async () => "key",
      createDiscovery: async () => ({ discover: async () => ({ agents: profile ? [profile] : [], warnings: [] }) }) as any,
      createRoutingStore: () => ({ read: async (scope: string) => ({ routing: options.saved && scope === "user" ? { version: 1, agents: { worker: options.saved } } : undefined }) }) as any,
      ...options.dependencies,
    })(pi);
    const available = [extModel("openai", "a"), extModel("openai", "b")];
    const ctx = { cwd, mode: "print", hasUI: false, ui: { setStatus() {}, notify() {} }, isIdle: () => true, isProjectTrusted: () => true, model: extModel("openai", "a"), thinkingLevel: "medium", modelRegistry: { find: () => extModel("openai", "a"), getAvailable: () => available }, sessionManager: { getSessionId: () => "session", getBranch: () => [] } } as unknown as ExtensionContext;
    for (const fn of handlers.get("session_start") ?? []) await fn({ reason: "startup" }, ctx);
    const spawn = (params: any) => tools.get("subagent_spawn")!.execute("call", params, undefined, undefined, ctx);
    const check = (id: string) => tools.get("subagent_check")!.execute("check", { id }, undefined, undefined, ctx);
    return { spawn, check, piHarness, claudeHarness };
  }
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const claudeProfile = agent({ harness: "claude" }, ["Read", "Grep", "my_extension_tool"]);

  it.each([
    ["explicit inherit", { harness: "inherit" }, undefined],
    ["explicit auto", { harness: "auto" }, undefined],
    ["saved inherit", {}, { harness: "inherit" as const }],
    ["saved pi", {}, { harness: "pi" as const }],
  ])("rejects a Claude-tool profile routed to Pi with Jev disabled: %s", async (_case, explicit, saved) => {
    const f = await fixture({ profile: claudeProfile, saved });
    await expect(f.spawn({ prompt: "task", agent: "worker", ...explicit })).rejects.toThrow("another backend's native tool names");
    expect(f.piHarness.requests).toHaveLength(0);
    expect(f.claudeHarness.requests).toHaveLength(0);
  });

  it("keeps valid allowlists with unknown extension names on both backends", async () => {
    const claude = await fixture({ profile: claudeProfile });
    await claude.spawn({ prompt: "task", agent: "worker" });
    expect(claude.claudeHarness.requests[0]?.tools).toEqual(["Read", "Grep", "my_extension_tool"]);
    const piTools = ["read", "grep", "contact_supervisor", "my_extension_tool"];
    const pi = await fixture({ profile: agent({ harness: "claude" }, piTools) });
    await pi.spawn({ prompt: "task", agent: "worker", harness: "inherit" });
    expect(pi.piHarness.requests[0]?.tools).toEqual(piTools);
  });

  it("fails the run instead of starting Pi without tools when the router fails unexpectedly", async () => {
    const routeJev = vi.fn(async () => { throw new Error("unexpected"); });
    const f = await fixture({ enabled: true, profile: claudeProfile, dependencies: { routeJev } });
    const spawned = await f.spawn({ prompt: "task", agent: "worker", harness: "auto" });
    await tick(); await tick(); await tick();
    expect(f.piHarness.requests).toHaveLength(0);
    expect(f.claudeHarness.requests).toHaveLength(0);
    const checked = await f.check((spawned.details as any).snapshot.id);
    expect(JSON.stringify(checked.details)).toContain('"state":"failed"');
  });

  it("normalizes spawn model whitespace and keeps literal model ids", async () => {
    const f = await fixture();
    await f.spawn({ prompt: "inherit", model: " inherit " });
    await f.spawn({ prompt: "auto", model: "auto\n" });
    await f.spawn({ prompt: "literal", model: " openai/b " });
    await f.spawn({ prompt: "cased", model: "Auto" });
    expect(f.piHarness.requests.map((request) => request.model)).toEqual(["openai/a", "openai/a", "openai/b", "Auto"]);
    await expect(f.spawn({ prompt: "blank", model: "   " })).rejects.toThrow("model");
    expect(f.piHarness.requests).toHaveLength(4);
  });
});

describe("routing panel mode labels", () => {
  const theme = {
    fg: (_color: string, text: string) => text,
    bg: (_color: string, text: string) => text,
    bold: (text: string) => text,
    inverse: (text: string) => text,
  } as unknown as Theme;
  function row(harnessMode: "auto" | "inherit" | undefined, provenance: "saved-user" | "jev" = "saved-user"): RoutingAgentRow {
    return {
      name: "worker", description: "Work", definitionScope: "user",
      route: {
        harness: "pi", model: "openai-codex/parent", thinking: "medium",
        provenance: { harness: provenance, model: "parent", thinking: "parent" },
        ...(harnessMode ? { modes: { harness: harnessMode } } : {}),
      },
      userEntry: harnessMode ? { harness: harnessMode } : undefined, projectEntry: undefined,
    };
  }
  const header = (item: RoutingAgentRow) => renderRoutingPanel(theme, initialRoutingViewState({ rows: [item], projectTrusted: true }), 84, 24, ROUTING_KEY_HINTS)
    .find((line) => line.includes("worker"))!;

  it("labels unresolved harness modes instead of their inherited backend", () => {
    expect(header(row("auto"))).toContain("AUTO");
    expect(header(row("auto"))).not.toMatch(/\bPI\b/);
    expect(header(row("inherit"))).toContain("INHERIT");
    expect(header(row(undefined))).toMatch(/\bPI\b/);
  });
});
