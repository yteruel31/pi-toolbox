import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DefaultRouteResolver,
  FileAgentDiscovery,
  FileRoutingStore,
  isRouteMode,
} from "../src/agents/index.js";
import type { AgentDefinition, RouteResolutionInput, RoutingEntry } from "../src/agents/types.js";
import { JevRoutingConflictError, routeWithJev } from "../src/agents/jev.js";
import type { ClaudeSupportedModel } from "../src/harnesses/claude.js";
import type { RoutingDataPort } from "../src/tui/binding.js";
import {
  createRoutingEditorState,
  reduceRoutingEditorInput,
  routingEntryFromEditor,
} from "../src/tui/routing-editor.js";
import {
  initialRoutingViewState,
  normalizeRoutingEntry,
  reduceRoutingView,
  type RoutingAgentRow,
} from "../src/tui/routing-view.js";
import { createRoutingViewModel } from "../src/tui/view-models.js";

const resolver = new DefaultRouteResolver();
const PARENT = { model: "openai-codex/parent", thinking: "medium" as const };
const LOW_HIGH = { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null };
const LOW_ONLY = { off: null, minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null };

function agent(defaults: AgentDefinition["defaults"], tools?: string[]): AgentDefinition {
  return { name: "worker", description: "Work", systemPrompt: "Work", defaults, tools, source: { scope: "package", path: "/agent.md" } };
}
function input(overrides: Partial<RouteResolutionInput> = {}): RouteResolutionInput {
  return { explicit: {}, parent: PARENT, ...overrides };
}
function piModel(id: string, thinkingLevelMap: Record<string, string | null> = LOW_ONLY): Model<any> {
  return { id, name: id, provider: "openai-codex", api: "openai-responses", baseUrl: "", reasoning: true, thinkingLevelMap, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1, maxTokens: 1 } as Model<any>;
}
function claudeModel(value: string, efforts?: Array<"low" | "high">): ClaudeSupportedModel {
  return efforts
    ? { value, displayName: value, description: "", supportsEffort: true, supportedEffortLevels: efforts }
    : { value, displayName: value, description: "", supportsEffort: false };
}

type Decoded = [harness: string, model: string | null, thinking: string | null];
/** Offline Jev transport that records candidates and picks the first match. */
function jev(pick: (candidate: Decoded) => boolean = () => true) {
  const seen: Decoded[][] = [];
  const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const keys = Object.keys(JSON.parse(String(init?.body)).questions.route.criteria);
    const decoded = keys.map((key) => JSON.parse(Buffer.from(key, "base64url").toString()) as Decoded);
    seen.push(decoded);
    const index = Math.max(0, decoded.findIndex(pick));
    const choice = keys[index]!;
    return new Response(JSON.stringify({ answers: { route: { type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(keys.map((key) => [key, key === choice ? 1 : 0])) } } }));
  });
  return { fetcher, seen };
}

async function route(
  resolution: RouteResolutionInput,
  options: { piModels?: Model<any>[]; claudeModels?: ClaudeSupportedModel[]; tools?: string[]; fetcher?: ReturnType<typeof vi.fn>; apiKey?: string; signal?: AbortSignal } = {},
) {
  return routeWithJev({
    task: "task",
    route: resolver.resolve(resolution),
    resolutionInput: resolution,
    tools: options.tools,
    piModels: options.piModels ?? [],
    claudeModels: options.claudeModels ?? [],
    apiKey: "apiKey" in options ? options.apiKey : "key",
    signal: options.signal,
  }, (options.fetcher ?? vi.fn()) as never);
}

function expectNoModeLiteral(value: { harness: string; model?: string; thinking?: string }): void {
  for (const field of [value.harness, value.model, value.thinking]) expect(isRouteMode(field)).toBe(false);
}

describe("reserved routing modes: central resolver", () => {
  it("reserves only exact bare lowercase auto and inherit", () => {
    expect(["auto", "inherit"].every(isRouteMode)).toBe(true);
    for (const literal of ["Auto", "INHERIT", " auto", "auto ", "openrouter/auto", "auto/x", "", undefined]) {
      expect(isRouteMode(literal)).toBe(false);
    }
    for (const literal of ["Auto", "INHERIT", "openrouter/auto", "anthropic/inherit"]) {
      const resolved = resolver.resolve(input({ explicit: { model: literal } }));
      expect(resolved).toMatchObject({ model: literal, provenance: { model: "explicit" } });
      expect(resolved.modes).toBeUndefined();
    }
  });

  it("resolves each field independently: explicit > project > user > profile > parent", () => {
    const resolved = resolver.resolve(input({
      explicit: { harness: "auto" },
      projectRouting: { model: "inherit", thinking: "low" },
      userRouting: { harness: "claude", model: "user-model", thinking: "auto" },
      agent: agent({ harness: "claude", model: "agent-model", thinking: "high" }),
    }));
    expect(resolved).toEqual({
      harness: "pi",
      model: PARENT.model,
      thinking: "low",
      provenance: { harness: "explicit", model: "saved-project", thinking: "saved-project" },
      modes: { harness: "auto", model: "inherit" },
    });
  });

  it.each([
    ["explicit", { explicit: { model: "auto" } }],
    ["saved-project", { projectRouting: { model: "auto" } }],
    ["saved-user", { userRouting: { model: "auto" } }],
  ] as const)("lets %s auto override a lower fixed profile model", (provenance, layer) => {
    const resolved = resolver.resolve(input({ ...layer, agent: agent({ model: "fixed-profile", thinking: "high" }) }));
    expect(resolved).toMatchObject({ model: PARENT.model, thinking: "high", provenance: { model: provenance }, modes: { model: "auto" } });
  });

  it("falls through absent fields and stops at a mode", () => {
    const absent = resolver.resolve(input({ userRouting: {}, agent: agent({ thinking: "high" }) }));
    expect(absent).toMatchObject({ thinking: "high", provenance: { thinking: "agent-default" } });
    expect(absent.modes).toBeUndefined();
    const stopped = resolver.resolve(input({ userRouting: { thinking: "inherit" }, agent: agent({ thinking: "high" }) }));
    expect(stopped).toMatchObject({ thinking: PARENT.thinking, provenance: { thinking: "saved-user" }, modes: { thinking: "inherit" } });
  });

  it("inherits parent values on Pi and omits SDK defaults on Claude", () => {
    const modes = { model: "inherit", thinking: "inherit" } as const;
    expect(resolver.resolve(input({ explicit: { harness: "pi" }, userRouting: modes }))).toMatchObject({
      harness: "pi", model: PARENT.model, thinking: PARENT.thinking,
    });
    const claude = resolver.resolve(input({ explicit: { harness: "claude" }, userRouting: modes, agent: agent({ model: "sonnet", effort: "max" }) }));
    expect(claude).toMatchObject({ harness: "claude", model: undefined, thinking: undefined, provenance: { model: "saved-user", thinking: "saved-user" } });
  });

  it("resolves harness inherit as the parent Pi backend over a fixed profile harness", () => {
    expect(resolver.resolve(input({ projectRouting: { harness: "inherit" }, agent: agent({ harness: "claude" }) }))).toMatchObject({
      harness: "pi", model: PARENT.model, thinking: PARENT.thinking, provenance: { harness: "saved-project" }, modes: { harness: "inherit" },
    });
  });

  it("applies profile effort modes only on Claude and keeps independent fields fixed", () => {
    const profile = agent({ harness: "claude", model: "inherit", effort: "inherit", thinking: "high" });
    expect(resolver.resolve(input({ agent: profile }))).toMatchObject({
      harness: "claude", model: undefined, thinking: undefined, provenance: { thinking: "agent-default" }, modes: { model: "inherit", thinking: "inherit" },
    });
    expect(resolver.resolve(input({ explicit: { harness: "pi" }, agent: profile }))).toMatchObject({ harness: "pi", model: PARENT.model, thinking: "high" });
    // Inheriting the model does not unset a fixed thinking value.
    expect(resolver.resolve(input({ agent: agent({ harness: "claude", model: "inherit", effort: "max" }) })).thinking).toBe("max");
  });
});

describe("reserved routing modes: Jev", () => {
  it("routes an auto model over a fixed profile model and keeps fixed thinking", async () => {
    const { fetcher, seen } = jev(([, model]) => model === "openai-codex/two");
    const result = await route(
      input({ userRouting: { model: "auto" }, agent: agent({ model: "openai-codex/one", thinking: "low" }) }),
      { piModels: [piModel("one"), piModel("two")], fetcher },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(seen[0]!.map(([, model]) => model)).toEqual(["openai-codex/one", "openai-codex/two"]);
    expect(result).toMatchObject({ used: true, route: { harness: "pi", model: "openai-codex/two", thinking: "low", provenance: { model: "jev", thinking: "agent-default" } } });
  });

  it("keeps an inherited Pi model identity while Jev chooses free thinking", async () => {
    const { fetcher, seen } = jev(([, , thinking]) => thinking === "high");
    const result = await route(
      input({ agent: agent({ harness: "pi", model: "inherit" }) }),
      { piModels: [piModel("parent", LOW_HIGH), piModel("other", LOW_HIGH)], fetcher },
    );
    expect(seen[0]).toEqual([["pi", PARENT.model, "low"], ["pi", PARENT.model, "high"]]);
    expect(result).toMatchObject({ used: true, route: { harness: "pi", model: PARENT.model, thinking: "high", provenance: { model: "agent-default", thinking: "jev" } } });
  });

  it("keeps an inherited Pi model identity without raw resolution input", async () => {
    const { fetcher, seen } = jev(([, , thinking]) => thinking === "high");
    const resolved = resolver.resolve(input({ agent: agent({ harness: "pi", model: "inherit" }) }));
    expect(resolved).toMatchObject({ model: PARENT.model, modes: { model: "inherit" }, provenance: { thinking: "parent" } });
    const result = await routeWithJev({
      task: "task",
      route: resolved,
      piModels: [piModel("parent", LOW_HIGH), piModel("other", LOW_HIGH)],
      claudeModels: [],
      apiKey: "key",
    }, fetcher as never);
    expect(seen[0]).toEqual([["pi", PARENT.model, "low"], ["pi", PARENT.model, "high"]]);
    expect(result).toMatchObject({ used: true, route: { harness: "pi", model: PARENT.model, thinking: "high", provenance: { model: "agent-default", thinking: "jev" } } });
  });

  it("lets Jev choose the backend for an inherited model without substituting a catalogue model", async () => {
    const { fetcher, seen } = jev(([harness]) => harness === "claude");
    const result = await route(
      input({ userRouting: { model: "inherit" } }),
      { piModels: [piModel("parent")], claudeModels: [claudeModel("sonnet", ["low", "high"])], fetcher },
    );
    expect(seen[0]).toEqual([["pi", PARENT.model, "low"], ["claude", null, null]]);
    expect(result.route).toMatchObject({ harness: "claude", model: undefined, thinking: undefined, provenance: { harness: "jev", model: "saved-user", thinking: "parent" } });
  });

  it("resolves a Claude inherited model with auto thinking to SDK defaults without Jev", async () => {
    const fetcher = vi.fn();
    const result = await route(
      input({ userRouting: { thinking: "auto" }, agent: agent({ harness: "claude", model: "inherit" }) }),
      { claudeModels: [claudeModel("sonnet", ["low", "high"])], fetcher },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.route).toMatchObject({ harness: "claude", model: undefined, thinking: undefined, provenance: { model: "agent-default", thinking: "parent" } });
  });

  it("narrows Claude thinking inherit to the SDK default effort for every model", async () => {
    const { fetcher, seen } = jev(([, model]) => model === "opus");
    const result = await route(
      input({ explicit: { harness: "claude" }, userRouting: { thinking: "inherit" } }),
      { claudeModels: [claudeModel("sonnet", ["low", "high"]), claudeModel("opus", ["high"])], fetcher },
    );
    expect(seen[0]).toEqual([["claude", "sonnet", null], ["claude", "opus", null]]);
    expect(result.route).toMatchObject({ harness: "claude", model: "opus", thinking: undefined, provenance: { model: "jev", thinking: "saved-user" } });
  });

  it("treats Pi thinking inherit as the parent thinking constraint", async () => {
    const fetcher = vi.fn();
    const parentHigh = { ...PARENT, thinking: "high" as const };
    const result = await route(
      { explicit: { harness: "pi" }, userRouting: { thinking: "inherit" }, parent: parentHigh },
      { piModels: [piModel("a", LOW_HIGH), piModel("b", LOW_ONLY)], fetcher },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.route).toMatchObject({ model: "openai-codex/a", thinking: "high", provenance: { thinking: "saved-user" } });
  });

  it("lets harness auto override a fixed profile harness", async () => {
    const { fetcher, seen } = jev(([harness]) => harness === "pi");
    const result = await route(
      input({ explicit: { harness: "auto" }, agent: agent({ harness: "claude" }) }),
      { piModels: [piModel("one")], claudeModels: [claudeModel("sonnet")], fetcher },
    );
    expect(new Set(seen[0]!.map(([harness]) => harness))).toEqual(new Set(["pi", "claude"]));
    expect(result.route).toMatchObject({ harness: "pi", model: "openai-codex/one", provenance: { harness: "jev" } });
  });

  it("filters inherited-model backends by tool dialect", async () => {
    const fetcher = vi.fn();
    const result = await route(
      input({ agent: agent({ model: "inherit" }, ["read", "bash"]) }),
      { piModels: [piModel("parent")], claudeModels: [claudeModel("sonnet")], tools: ["read", "bash"], fetcher },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.route).toMatchObject({ harness: "pi", model: PARENT.model });
    await expect(route(
      input({ agent: agent({ harness: "claude", model: "inherit" }, ["bash"]) }),
      { tools: ["bash"] },
    )).rejects.toBeInstanceOf(JevRoutingConflictError);
  });

  it("rejects fixed thinking unsupported by the inherited Pi model", async () => {
    const failure = await route(
      input({ explicit: { harness: "pi" }, userRouting: { model: "inherit", thinking: "max" } }),
      { piModels: [piModel("parent", LOW_ONLY)] },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JevRoutingConflictError);
    expect((failure as Error).message).toContain("thinking/effort is not advertised");
  });

  it.each([
    ["service failure", { fetcher: vi.fn(async () => { throw new Error("offline"); }) }],
    ["missing credentials", { apiKey: undefined }],
    ["invalid choice", { fetcher: vi.fn(async () => new Response("{}")) }],
  ] as const)("resolves auto as inherit on %s and never forwards a mode literal", async (_case, options) => {
    const resolution = input({
      userRouting: { harness: "auto", model: "auto", thinking: "auto" },
      agent: agent({ harness: "claude", model: "sonnet", effort: "high" }),
    });
    const result = await route(resolution, { piModels: [piModel("a"), piModel("b")], ...options });
    expect(result.used).toBe(false);
    expect(result.fallback).toBeDefined();
    expect(result.route).toMatchObject({ harness: "pi", model: PARENT.model, thinking: PARENT.thinking });
    expectNoModeLiteral(result.route);
  });

  it("keeps qualified or differently cased auto as a literal model constraint", async () => {
    const fetcher = vi.fn();
    const literal = { ...piModel("auto"), provider: "openrouter" } as Model<any>;
    const exact = await route(input({ explicit: { model: "openrouter/auto" } }), { piModels: [literal, piModel("one")], fetcher });
    expect(exact.route).toMatchObject({ harness: "pi", model: "openrouter/auto", provenance: { model: "explicit" } });
    await expect(route(input({ explicit: { model: "Auto" } }), { piModels: [piModel("one"), piModel("two")], fetcher }))
      .rejects.toThrow("no unique match");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("propagates cancellation while routing auto fields", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const pending = route(input({ explicit: { model: "auto" } }), { piModels: [piModel("a"), piModel("b")], fetcher, signal: controller.signal });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });
});

describe("reserved routing modes: configuration", () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
  async function workspace(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "pi-subagents-modes-"));
    roots.push(root);
    return root;
  }

  it("persists modes and literals in routing files and rejects non-reserved spellings", async () => {
    const root = await workspace();
    const store = new FileRoutingStore({ agentDir: join(root, "agent"), cwd: join(root, "project"), projectTrusted: true });
    const entry: RoutingEntry = { harness: "auto", model: "inherit", thinking: "auto" };
    await store.write("project", { version: 1, agents: { worker: entry, literal: { model: "Auto" } } });
    expect((await store.read("project")).routing?.agents).toEqual({ worker: entry, literal: { model: "Auto" } });
    await expect(store.write("user", { version: 1, agents: { worker: { harness: "Auto" as never } } })).rejects.toThrow("invalid harness");
    await expect(store.write("user", { version: 1, agents: { worker: { thinking: "INHERIT" as never } } })).rejects.toThrow("invalid thinking");
    // Untrusted project routing, including modes, stays ignored.
    const untrusted = new FileRoutingStore({ agentDir: join(root, "agent"), cwd: join(root, "project"), projectTrusted: false });
    expect((await untrusted.read("project")).routing).toBeUndefined();
  });

  it("accepts modes in agent frontmatter and rejects other spellings", async () => {
    const root = await workspace();
    const agentDir = join(root, "agent");
    await mkdir(join(agentDir, "agents"), { recursive: true });
    const write = (name: string, extra: string) => writeFile(join(agentDir, "agents", `${name}.md`), `---\nname: ${name}\ndescription: ${name}\n${extra}---\nBody.\n`);
    await write("modes", "harness: auto\nmodel: inherit\nthinking: auto\neffort: inherit\n");
    await write("literal", "model: openrouter/auto\n");
    await write("cased", "harness: Inherit\n");
    const catalog = await new FileAgentDiscovery({ agentDir }).discover({ cwd: join(root, "project"), projectTrusted: false });
    expect(catalog.agents.find((item) => item.name === "modes")?.defaults).toEqual({ harness: "auto", model: "inherit", thinking: "auto", effort: "inherit" });
    expect(catalog.agents.find((item) => item.name === "literal")?.defaults).toEqual({ model: "openrouter/auto" });
    expect(catalog.agents.some((item) => item.name === "cased")).toBe(false);
    expect(catalog.warnings.join("\n")).toContain("invalid harness default");
  });
});

describe("reserved routing modes: routing UI", () => {
  const session = { agentName: "worker", scope: "user" as const, current: {}, effectiveHarness: "claude" as const };
  const catalog = { pi: [], claude: [{ value: "sonnet", label: "Sonnet" }] };
  const right = "\x1b[C", down = "\x1b[B";

  it("distinguishes unset, inherit, and auto and saves only explicit choices", () => {
    let state = createRoutingEditorState(session, catalog);
    expect(state).toMatchObject({ harness: "unset", model: "", thinking: "unset" });
    expect(routingEntryFromEditor(state)).toEqual({});

    state = reduceRoutingEditorInput(state, right).state; // harness inherit
    state = reduceRoutingEditorInput(state, down).state;
    state = reduceRoutingEditorInput(state, right).state; // model inherit
    state = reduceRoutingEditorInput(state, right).state; // model auto
    state = reduceRoutingEditorInput(state, down).state;
    state = reduceRoutingEditorInput(state, right).state; // thinking inherit
    state = reduceRoutingEditorInput(state, right).state; // thinking auto
    const step = reduceRoutingEditorInput(state, "\r");
    expect(step.intent).toEqual({ kind: "save", entry: { harness: "inherit", model: "auto", thinking: "auto" } });
    expect(reduceRoutingEditorInput(state, "\x1b").intent).toEqual({ kind: "cancel" });
  });

  it("keeps a model mode across harness changes and reopens saved modes", () => {
    let state = createRoutingEditorState({ ...session, current: { harness: "auto", model: "inherit", thinking: "inherit" } }, catalog);
    expect(state).toMatchObject({ harness: "auto", model: "inherit", thinking: "inherit" });
    state = reduceRoutingEditorInput(state, right).state; // pi
    state = reduceRoutingEditorInput(state, right).state; // claude
    expect(state).toMatchObject({ harness: "claude", model: "inherit" });
  });

  it("normalizes modes, drops invalid spellings, and never saves on cancel", async () => {
    expect(normalizeRoutingEntry({ harness: "auto", model: " inherit ", thinking: "inherit" })).toEqual({ harness: "auto", model: "inherit", thinking: "inherit" });
    expect(normalizeRoutingEntry({ harness: "Auto" as never, thinking: "AUTO" as never })).toEqual({});

    const row: RoutingAgentRow = {
      name: "worker", description: "Work", definitionScope: "user",
      route: { harness: "pi", model: undefined, thinking: undefined, provenance: { harness: "parent", model: "parent", thinking: "parent" } },
      userEntry: undefined, projectEntry: undefined,
    };
    const opened = reduceRoutingView(initialRoutingViewState({ rows: [row], projectTrusted: true }), { kind: "key", action: "enter" });
    expect(reduceRoutingView(opened.state, { kind: "edit-cancelled" }).intents).toEqual([]);
    expect(reduceRoutingView(opened.state, { kind: "edit-committed", entry: { model: "auto" } }).intents).toEqual([
      { kind: "save-mapping", scope: "user", agentName: "worker", entry: { model: "auto" } },
    ]);

    const saves: RoutingEntry[] = [];
    const port: RoutingDataPort = {
      rows: async () => ({ rows: [row], invalid: {} }),
      saveMapping: async (_scope, _name, entry) => { saves.push(entry); },
      deleteMapping: async () => undefined,
      backupAndReset: async () => "/tmp/backup",
    };
    const model = createRoutingViewModel({ data: port, projectTrusted: true, loadImmediately: false });
    await model.refresh();
    model.dispatch({ kind: "key", action: "enter" });
    model.dispatch({ kind: "edit-cancelled" });
    model.dispatch({ kind: "key", action: "enter" });
    model.dispatch({ kind: "edit-committed", entry: { harness: "inherit", thinking: "auto" } });
    await vi.waitFor(() => expect(saves).toEqual([{ harness: "inherit", thinking: "auto" }]));
    model.dispose();
  });
});
