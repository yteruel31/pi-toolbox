import * as fs from "node:fs/promises";
import * as path from "node:path";

import { StringEnum } from "@earendil-works/pi-ai";
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { FileAgentDiscovery } from "./agents/discovery.js";
import { MAX_AGENT_SKILLS } from "./agents/limits.js";
import { DefaultRouteResolver } from "./agents/route-resolver.js";
import { FileRoutingStore } from "./agents/routing-store.js";
import {
  appendPreloadedSkills,
  preloadAgentSkills,
} from "./agents/skill-preloader.js";
import type {
  AgentSkillPreloadInput,
  AgentSkillPreloadResult,
} from "./agents/skill-preloader.js";
import type {
  AgentCatalog,
  AgentDefinition,
  InstalledAgentPackage,
  RoutingEntry,
  RoutingFile,
} from "./agents/types.js";
import type { SubagentHarness } from "./core/harness.js";
import { RunManager } from "./core/run-manager.js";
import { ClaudeHarness, type ClaudeHarnessOptions } from "./harnesses/claude.js";
import {
  PiHarness,
  type PiHarnessOptions,
  type PiModelRuntimeLike,
} from "./harnesses/pi.js";
import { describeError } from "./shared/errors.js";
import { formatRunIdentity } from "./shared/run-identity.js";
import { truncateText } from "./shared/truncate.js";
import type {
  PersistedRunState,
  RunResult,
  RunUsage,
} from "./shared/types.js";
import type { RoutingDataPort, RunsDataPort } from "./tui/binding.js";
import type { RunCounts } from "./tui/status.js";
import { openPiRoutingOverlay, openPiRunsOverlay } from "./tui/pi-views.js";
import { countRuns, statusText } from "./tui/status.js";

/** Event bus channel carrying `SubagentsStatusEvent` for status-bar consumers. */
export const SUBAGENTS_STATUS_CHANNEL = "pi-toolbox:subagents:status";

/** Versioned run totals; `counts: null` clears stale state on shutdown. */
export type SubagentsStatusEvent =
  | { v: 1; counts: RunCounts }
  | { v: 1; counts: null };

const STATE_ENTRY = "pi-subagents-state-v1";
const BTW_ENTRY = "pi-subagents-btw-v1";
const MAX_TOOL_TEXT = 49_000;
const MAX_IDS = 64;
const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export interface ExtensionDependencies {
  createPiHarness?(options: PiHarnessOptions): SubagentHarness;
  createClaudeHarness?(options: ClaudeHarnessOptions): SubagentHarness;
  createDiscovery?(ctx: ExtensionContext): Promise<FileAgentDiscovery>;
  createRoutingStore?(ctx: ExtensionContext): FileRoutingStore;
  preloadSkills?(input: AgentSkillPreloadInput): Promise<AgentSkillPreloadResult>;
}

/** Public dependency-injection seam for offline extension integration tests. */
export function createPiSubagentsExtension(
  dependencies: ExtensionDependencies = {},
): (pi: ExtensionAPI) => void {
  return (pi) => registerExtension(pi, dependencies);
}

/** Pi package entry point. The factory registers handlers only; no run starts here. */
export default createPiSubagentsExtension();

function registerExtension(pi: ExtensionAPI, dependencies: ExtensionDependencies): void {
  let manager: RunManager | undefined;
  let sessionContext: ExtensionContext | undefined;
  let piHarness: SubagentHarness | undefined;
  let claudeHarness: SubagentHarness | undefined;
  let deliveryScheduled = false;
  let shuttingDown = false;
  const runListeners = new Set<() => void>();

  const notifyRunListeners = (): void => {
    for (const listener of [...runListeners]) {
      try {
        listener();
      } catch {
        // A broken or closing view must not affect run lifecycle.
      }
    }
  };

  const requireSession = () => {
    if (!manager || !sessionContext || !piHarness || !claudeHarness) {
      throw new Error("Subagents are not ready: no active Pi session.");
    }
    return { manager, ctx: sessionContext, piHarness, claudeHarness };
  };

  const emitStatus = (event: SubagentsStatusEvent): void => {
    pi.events?.emit(SUBAGENTS_STATUS_CHANNEL, event);
  };

  /** Counts are owned here and broadcast even without a UI; the text slot stays UI-only. */
  const updateStatus = (): void => {
    if (!manager) return;
    const runs = manager.list();
    emitStatus({ v: 1, counts: countRuns(runs) });
    const current = sessionContext;
    if (!current?.hasUI) return;
    current.ui.setStatus("subagents", statusText(runs));
  };

  const deliverIfIdle = (): void => {
    deliveryScheduled = false;
    const current = sessionContext;
    if (!current || !manager || shuttingDown || !current.isIdle()) return;
    const results = manager.drainDeliveries();
    if (results.length === 0) return;
    pi.sendMessage(
      {
        customType: "pi-subagents-results",
        content: formatDeliveredResults(results),
        display: true,
        details: { ids: results.map((result) => result.id) },
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
    updateStatus();
  };

  const scheduleDelivery = (): void => {
    if (deliveryScheduled || shuttingDown) return;
    deliveryScheduled = true;
    queueMicrotask(deliverIfIdle);
  };

  pi.on("session_start", async (_event, ctx) => {
    shuttingDown = false;
    sessionContext = ctx;
    const restore = findLatestPersistedState(ctx);
    const trustedCwd = await fs.realpath(ctx.cwd).catch(() => path.resolve(ctx.cwd));
    const modelRuntime = modelRuntimeAdapter(ctx);
    const parentModel = ctx.model ?? undefined;
    piHarness = dependencies.createPiHarness?.({
      modelRuntime,
      parentModel,
      parentThinkingLevel: ctx.thinkingLevel,
      defaultWorkingDir: trustedCwd,
      isProjectTrusted: (cwd) => isWithin(trustedCwd, path.resolve(cwd)) && ctx.isProjectTrusted(),
      agentDir: getAgentDir(),
    }) ?? new PiHarness({
      modelRuntime,
      parentModel,
      parentThinkingLevel: ctx.thinkingLevel,
      defaultWorkingDir: trustedCwd,
      isProjectTrusted: (cwd) => isWithin(trustedCwd, path.resolve(cwd)) && ctx.isProjectTrusted(),
      agentDir: getAgentDir(),
    });
    claudeHarness = dependencies.createClaudeHarness?.({}) ?? new ClaudeHarness();
    manager = new RunManager({
      maxActiveRuns: 4,
      restore,
      hooks: {
        persist: (state) => {
          if (!shuttingDown) pi.appendEntry(STATE_ENTRY, state);
          updateStatus();
        },
        onDeliverableResults: () => {
          updateStatus();
          scheduleDelivery();
        },
        onChange: notifyRunListeners,
      },
    });
    updateStatus();
    if (manager.pendingDeliveryCount() > 0) scheduleDelivery();
  });

  pi.on("agent_settled", (_event, ctx) => {
    sessionContext = ctx;
    deliverIfIdle();
  });

  pi.on("session_shutdown", (event, ctx) => {
    shuttingDown = true;
    sessionContext = ctx;
    manager?.shutdown(`parent session ${event.reason}`);
    if (ctx.hasUI) ctx.ui.setStatus("subagents", undefined);
    emitStatus({ v: 1, counts: null });
    manager = undefined;
    piHarness = undefined;
    claudeHarness = undefined;
    sessionContext = undefined;
    deliveryScheduled = false;
    runListeners.clear();
  });

  pi.registerTool({
    name: "subagent_spawn",
    label: "Spawn subagent",
    description:
      "Start one autonomous background run and return immediately. Child harnesses have normal host permissions.",
    promptSnippet: "Spawn an autonomous background subagent on Pi or Claude Code.",
    promptGuidelines: [
      "Use subagent_spawn for self-contained work that can continue in the background.",
      "After subagent_spawn, keep working; use subagent_wait only when the result blocks progress.",
      "Children cannot spawn more agents or ask the user, so make the prompt complete and self-contained.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 100_000 }),
      agent: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      harness: Type.Optional(StringEnum(["pi", "claude"] as const)),
      working_dir: Type.Optional(Type.String({ minLength: 1, maxLength: 4_096 })),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      reasoning_effort: Type.Optional(StringEnum(THINKING_LEVELS)),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      sessionContext = ctx;
      const runtime = requireSession();
      const workingDir = await validateWorkingDirectory(params.working_dir, ctx);
      const resolution = await resolveSpawn(
        ctx,
        params.agent,
        {
          harness: params.harness,
          model: params.model,
          thinking: params.reasoning_effort,
        },
        dependencies,
      );
      const baseHarness = resolution.route.harness === "claude"
        ? runtime.claudeHarness
        : runtime.piHarness;
      const requestedSkills = resolution.agent?.skills ?? [];
      const harness = requestedSkills.length > 0
        ? withSkillPreloading(
          baseHarness,
          {
            names: requestedSkills,
            cwd: workingDir,
            projectTrusted: ctx.isProjectTrusted(),
            agentDir: getAgentDir(),
          },
          dependencies.preloadSkills ?? preloadAgentSkills,
        )
        : baseHarness;
      const snapshot = runtime.manager.spawn({
        prompt: params.prompt,
        title: params.name,
        agentProfile: params.agent,
        harness,
        systemPrompt: resolution.agent?.systemPrompt,
        tools: resolution.agent?.tools,
        workingDir,
        model: resolution.route.model,
        thinkingLevel: resolution.route.thinking,
      });
      updateStatus();
      return textResult(
        `Started ${snapshot.id} (${snapshot.harness}, ${snapshot.status})${snapshot.title ? `: ${formatRunIdentity(snapshot)}` : ""}.`,
        {
          snapshot,
          route: resolution.route,
          skills: { requested: requestedSkills },
        },
      );
    },
  });

  pi.registerTool({
    name: "subagent_agents",
    label: "List subagent profiles",
    description: "Discover named subagent profiles and show their effective saved routing.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      sessionContext = ctx;
      const { catalog, routes, routingWarnings } = await discoverResolvedAgents(ctx, dependencies);
      const rows = catalog.agents.map((agent) => ({
        name: agent.name,
        description: agent.description,
        tools: agent.tools,
        skills: agent.skills,
        source: agent.source.scope,
        package: agent.source.packageName,
        harness: routes.get(agent.name)?.harness,
        model: routes.get(agent.name)?.model,
        thinking: routes.get(agent.name)?.thinking,
      }));
      return textResult(
        boundedJson({ agents: rows, warnings: [...catalog.warnings, ...routingWarnings] }),
        { agents: rows.length, warnings: catalog.warnings.length + routingWarnings.length },
      );
    },
  });

  pi.registerTool({
    name: "subagent_wait",
    label: "Wait for subagents",
    description: "Wait for listed runs to settle and consume their final results in request order.",
    promptGuidelines: [
      "Use subagent_wait only when one or more background results are required before continuing.",
    ],
    parameters: Type.Object({
      ids: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        minItems: 1,
        maxItems: MAX_IDS,
      }),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      sessionContext = ctx;
      const runtime = requireSession();
      onUpdate?.(textResult("Waiting for subagent runs…", { ids: params.ids }));
      const report = await runtime.manager.wait(params.ids, { signal });
      updateStatus();
      const results = report.entries.flatMap((entry) =>
        entry.kind === "result" ? [entry.result] : [],
      );
      return textResult(formatWaitReport(report), { report }, aggregateToolUsage(results));
    },
  });

  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel subagents",
    description: "Request cancellation of active runs without deleting their records.",
    parameters: Type.Object({
      ids: Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
        minItems: 1,
        maxItems: MAX_IDS,
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      sessionContext = ctx;
      const report = requireSession().manager.cancel(params.ids);
      updateStatus();
      return textResult(boundedJson(report), { report });
    },
  });

  pi.registerTool({
    name: "subagent_check",
    label: "Check subagent",
    description: "Inspect one run's status and bounded recent activity without consuming it.",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, maxLength: 100 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      sessionContext = ctx;
      const inspection = requireSession().manager.check(params.id);
      return textResult(boundedJson(inspection), { inspection });
    },
  });

  pi.registerTool({
    name: "subagent_list",
    label: "List subagents",
    description: "List every tracked background run in creation order.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      sessionContext = ctx;
      const runs = requireSession().manager.list();
      return textResult(boundedJson({ runs }), { runs });
    },
  });

  const createRunsPort = (): RunsDataPort => ({
    list: () => requireSession().manager.list(),
    inspect: (id) => {
      try {
        return requireSession().manager.check(id);
      } catch {
        return undefined;
      }
    },
    sendMessage: async (id, text) => {
      await requireSession().manager.sendMessage(id, text);
    },
    cancel: (id) => {
      requireSession().manager.cancel([id]);
      updateStatus();
    },
    subscribe(listener) {
      let active = true;
      runListeners.add(listener);
      return () => {
        if (!active) return;
        active = false;
        runListeners.delete(listener);
      };
    },
  });

  const createRoutingPort = (ctx: ExtensionContext): RoutingDataPort => ({
    async rows() {
      const resolved = await discoverResolvedAgents(ctx, dependencies);
      return {
        rows: resolved.catalog.agents.map((agent) => ({
          name: agent.name,
          description: agent.description,
          definitionScope: agent.source.scope,
          route: resolved.routes.get(agent.name)!,
          userEntry: resolved.userRouting?.agents[agent.name],
          projectEntry: resolved.projectRouting?.agents[agent.name],
        })),
        invalid: {
          user: resolved.routingWarnings.find((warning) => warning.startsWith("User routing")),
          project: resolved.routingWarnings.find((warning) => warning.startsWith("Project routing")),
        },
      };
    },
    async saveMapping(scope, agentName, entry) {
      const store = dependencies.createRoutingStore?.(ctx) ?? createOfficialRoutingStore(ctx);
      const current = await store.read(scope);
      if (current.invalidReason) throw new Error(current.invalidReason);
      const routing = current.routing ?? { version: 1, agents: {} };
      await store.write(scope, {
        ...routing,
        version: 1,
        agents: { ...routing.agents, [agentName]: entry },
      });
    },
    async deleteMapping(scope, agentName) {
      const store = dependencies.createRoutingStore?.(ctx) ?? createOfficialRoutingStore(ctx);
      const current = await store.read(scope);
      if (current.invalidReason) throw new Error(current.invalidReason);
      if (!current.routing?.agents[agentName]) return;
      const agents = { ...current.routing.agents };
      delete agents[agentName];
      await store.write(scope, { ...current.routing, version: 1, agents });
    },
    async backupAndReset(scope) {
      const store = dependencies.createRoutingStore?.(ctx) ?? createOfficialRoutingStore(ctx);
      const backupPath = await store.backupInvalid(scope);
      await store.write(scope, { version: 1, agents: {} });
      return backupPath;
    },
  });

  pi.registerCommand("subagents", {
    description: "Inspect background runs or named-agent routing",
    handler: async (args, ctx) => {
      sessionContext = ctx;
      let mode = args.trim().toLowerCase();
      if (ctx.mode === "tui") {
        if (!mode) {
          const choice = await ctx.ui.select("Subagents", ["runs", "agents"]);
          if (!choice) return;
          mode = choice;
        }
        if (mode === "runs") {
          await openPiRunsOverlay(ctx, createRunsPort());
          return;
        }
        if (mode === "agents") {
          await openPiRoutingOverlay(ctx, createRoutingPort(ctx));
          return;
        }
      }
      if (mode === "agents") {
        const { catalog, routes, routingWarnings } = await discoverResolvedAgents(ctx, dependencies);
        const lines = catalog.agents.map((agent) => {
          const route = routes.get(agent.name);
          return `${agent.name}: ${route?.harness ?? "pi"}${route?.model ? ` / ${route.model}` : ""}${route?.thinking ? ` / ${route.thinking}` : ""}`;
        });
        showHuman(ctx, ["Subagent routing", ...lines, ...catalog.warnings, ...routingWarnings].join("\n"));
        return;
      }
      const runs = requireSession().manager.list();
      const lines = runs.length === 0
        ? ["No subagent runs in this session."]
        : runs.map((run) => `${run.id}  ${run.status}  ${run.harness}  ${formatRunIdentity(run)}`);
      showHuman(ctx, ["Subagent runs", ...lines].join("\n"));
    },
  });

  pi.registerCommand("btw", {
    description: "Ask a one-off Pi side question without adding it to parent model context",
    handler: async (args, ctx) => {
      sessionContext = ctx;
      let question = args.trim();
      if (!question && ctx.hasUI) question = (await ctx.ui.input("Ask a side question"))?.trim() ?? "";
      if (!question) {
        showHuman(ctx, "Usage: /btw <question>", "warning");
        return;
      }
      try {
        const workingDir = await validateWorkingDirectory(undefined, ctx);
        const runtime = requireSession();
        const snapshot = runtime.manager.spawn({
          prompt: question,
          title: `BTW: ${truncateText(question, 120)}`,
          harness: runtime.piHarness,
          workingDir,
          model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
          thinkingLevel: ctx.thinkingLevel,
          autoDeliver: false,
        });
        updateStatus();
        showHuman(ctx, `${snapshot.id} is answering…`);
        const report = await runtime.manager.wait([snapshot.id]);
        const entry = report.entries[0];
        const answer = entry?.kind === "result"
          ? formatOneResult(entry.result)
          : "The side question run disappeared.";
        pi.appendEntry(BTW_ENTRY, { id: snapshot.id, answer });
        showHuman(ctx, answer, entry?.kind === "result" && entry.result.status === "completed" ? "info" : "error");
      } catch (error) {
        const message = truncateText(describeError(error), 1_000);
        pi.appendEntry(BTW_ENTRY, { error: message });
        showHuman(ctx, `BTW failed: ${message}`, "error");
      } finally {
        updateStatus();
      }
    },
  });
}

function withSkillPreloading(
  harness: SubagentHarness,
  input: AgentSkillPreloadInput,
  preloader: (input: AgentSkillPreloadInput) => Promise<AgentSkillPreloadResult>,
): SubagentHarness {
  return {
    kind: harness.kind,
    supportsActiveMessages: harness.supportsActiveMessages,
    async run(request) {
      // Start discovery after the spawn tool has returned its background run id.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (request.signal.aborted) return harness.run(request);

      const preload = await preloadUntilAbort(
        () => preloader({ ...input, signal: request.signal }),
        request.signal,
      );
      if (!preload) return harness.run(request);
      if (preload.loaded.length > 0) {
        const text = truncateText(
          `Preloaded skills: ${preload.loaded.join(", ")}`,
          400,
        );
        request.reportProgress(text);
        request.reportTranscript({ kind: "status", text });
      }
      for (const warning of preload.warnings.slice(0, MAX_AGENT_SKILLS)) {
        const text = truncateText(`Skill preload warning: ${warning}`, 400);
        request.reportProgress(text);
        request.reportTranscript({ kind: "status", text });
      }

      return harness.run({
        ...request,
        systemPrompt: appendPreloadedSkills(request.systemPrompt, preload.content),
      });
    },
  };
}

function preloadUntilAbort(
  load: () => Promise<AgentSkillPreloadResult>,
  signal: AbortSignal,
): Promise<AgentSkillPreloadResult | undefined> {
  const pending = Promise.resolve().then(load);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = (): void => finish(() => resolve(undefined));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (result) => finish(() => resolve(result)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

async function resolveSpawn(
  ctx: ExtensionContext,
  requestedAgent: string | undefined,
  explicit: RoutingEntry,
  dependencies: ExtensionDependencies,
): Promise<{ agent: AgentDefinition | undefined; route: ReturnType<DefaultRouteResolver["resolve"]> }> {
  let agent: AgentDefinition | undefined;
  let userRouting: RoutingEntry | undefined;
  let projectRouting: RoutingEntry | undefined;
  if (requestedAgent) {
    const discovery = dependencies.createDiscovery
      ? await dependencies.createDiscovery(ctx)
      : await createOfficialDiscovery(ctx);
    const catalog = await discovery.discover({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
    agent = catalog.agents.find((candidate) => candidate.name === requestedAgent);
    if (!agent) throw new Error(`Unknown subagent profile ${JSON.stringify(truncateText(requestedAgent, 100))}.`);
    const store = dependencies.createRoutingStore?.(ctx) ?? createOfficialRoutingStore(ctx);
    const [user, project] = await Promise.all([store.read("user"), store.read("project")]);
    userRouting = user.routing?.agents[agent.name];
    projectRouting = project.routing?.agents[agent.name];
  }
  const route = new DefaultRouteResolver().resolve({
    explicit,
    agent,
    userRouting,
    projectRouting,
    parent: {
      model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
      thinking: ctx.thinkingLevel,
    },
  });
  return { agent, route };
}

async function discoverResolvedAgents(
  ctx: ExtensionContext,
  dependencies: ExtensionDependencies,
): Promise<{
  catalog: AgentCatalog;
  routes: Map<string, ReturnType<DefaultRouteResolver["resolve"]>>;
  routingWarnings: string[];
  userRouting: RoutingFile | undefined;
  projectRouting: RoutingFile | undefined;
  store: FileRoutingStore;
}> {
  const discovery = dependencies.createDiscovery
    ? await dependencies.createDiscovery(ctx)
    : await createOfficialDiscovery(ctx);
  const catalog = await discovery.discover({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() });
  const store = dependencies.createRoutingStore?.(ctx) ?? createOfficialRoutingStore(ctx);
  const [user, project] = await Promise.all([store.read("user"), store.read("project")]);
  const routingWarnings = [
    user.invalidReason ? `User routing ignored: ${user.invalidReason}` : undefined,
    project.invalidReason ? `Project routing ignored: ${project.invalidReason}` : undefined,
  ].filter((warning): warning is string => Boolean(warning));
  const resolver = new DefaultRouteResolver();
  const routes = new Map<string, ReturnType<DefaultRouteResolver["resolve"]>>();
  for (const agent of catalog.agents) {
    routes.set(agent.name, resolver.resolve({
      explicit: {},
      agent,
      userRouting: user.routing?.agents[agent.name],
      projectRouting: project.routing?.agents[agent.name],
      parent: {
        model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
        thinking: ctx.thinkingLevel,
      },
    }));
  }
  return {
    catalog,
    routes,
    routingWarnings,
    userRouting: user.routing,
    projectRouting: project.routing,
    store,
  };
}

async function createOfficialDiscovery(ctx: ExtensionContext): Promise<FileAgentDiscovery> {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(ctx.cwd, agentDir, {
    projectTrusted: ctx.isProjectTrusted(),
  });
  const packageManager = new DefaultPackageManager({ cwd: ctx.cwd, agentDir, settingsManager: settings });
  const packages: InstalledAgentPackage[] = packageManager.listConfiguredPackages().flatMap((pkg) => {
    const root = pkg.installedPath ?? packageManager.getInstalledPath(pkg.source, pkg.scope);
    return root ? [{ source: pkg.source, root, scope: pkg.scope }] : [];
  });
  return new FileAgentDiscovery({
    agentDir,
    packages,
    packageSettings: {
      user: settings.getGlobalSettings().packages,
      project: settings.getProjectSettings().packages,
    },
  });
}

function createOfficialRoutingStore(ctx: ExtensionContext): FileRoutingStore {
  return new FileRoutingStore({
    agentDir: getAgentDir(),
    cwd: ctx.cwd,
    projectTrusted: ctx.isProjectTrusted(),
  });
}

function modelRuntimeAdapter(ctx: ExtensionContext): PiModelRuntimeLike {
  return {
    getModel(provider, modelId) {
      const model = ctx.modelRegistry.find(provider, modelId);
      return model ?? undefined;
    },
    async getAvailable(_providerId, options) {
      if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return ctx.modelRegistry.getAvailable();
    },
  };
}

async function validateWorkingDirectory(value: string | undefined, ctx: ExtensionContext): Promise<string> {
  if (!ctx.isProjectTrusted()) throw new Error("Subagent working directories require a trusted Pi project.");
  const raw = value?.startsWith("@") ? value.slice(1) : value;
  const resolved = path.resolve(ctx.cwd, raw ?? ".");
  let real: string;
  let stats;
  try {
    [real, stats] = await Promise.all([fs.realpath(resolved), fs.stat(resolved)]);
  } catch {
    throw new Error("The requested subagent working directory does not exist or cannot be inspected.");
  }
  if (!stats.isDirectory()) throw new Error("The requested subagent working directory is not a directory.");
  const trustedRoot = await fs.realpath(ctx.cwd);
  if (!isWithin(trustedRoot, real)) {
    throw new Error("The requested subagent working directory is outside the trusted Pi project.");
  }
  return real;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function findLatestPersistedState(ctx: ExtensionContext): PersistedRunState | undefined {
  const entries = ctx.sessionManager.getBranch();
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as unknown as { type?: string; customType?: string; data?: unknown };
    if (entry.type === "custom" && entry.customType === STATE_ENTRY) {
      // The latest state is authoritative. Malformed latest data fails closed
      // instead of resurrecting an older lifecycle snapshot.
      return isPersistedState(entry.data) ? entry.data : undefined;
    }
  }
  return undefined;
}

function isPersistedState(value: unknown): value is PersistedRunState {
  if (!isRecord(value)) return false;
  if (
    value.version !== 1 ||
    !isPositiveInteger(value.nextSerial) ||
    !isPositiveInteger(value.nextSettlementSeq) ||
    !Array.isArray(value.runs) ||
    value.runs.length > 10_000
  ) {
    return false;
  }
  return value.runs.every((record) => {
    if (!isRecord(record)) return false;
    return (
      typeof record.id === "string" && /^run-[1-9][0-9]*$/.test(record.id) &&
      isPositiveInteger(record.serial) &&
      typeof record.title === "string" &&
      (record.agentProfile === undefined || typeof record.agentProfile === "string") &&
      (record.harness === "pi" || record.harness === "claude") &&
      ["queued", "running", "completed", "failed", "cancelled"].includes(String(record.status)) &&
      typeof record.createdAt === "number" && Number.isFinite(record.createdAt) &&
      Array.isArray(record.activity) && record.activity.length <= 1_000 &&
      record.activity.every((entry) =>
        isRecord(entry) && typeof entry.at === "number" && Number.isFinite(entry.at) && typeof entry.text === "string"
      ) &&
      (record.transcript === undefined || (
        Array.isArray(record.transcript) &&
        record.transcript.length <= 1_000 &&
        record.transcript.every(isPersistedTranscriptEntry)
      )) &&
      (record.transcriptDropped === undefined || (
        typeof record.transcriptDropped === "number" &&
        Number.isSafeInteger(record.transcriptDropped) &&
        record.transcriptDropped >= 0
      )) &&
      typeof record.activityDropped === "number" && Number.isSafeInteger(record.activityDropped) && record.activityDropped >= 0 &&
      ["none", "waited", "delivered", "suppressed"].includes(String(record.consumption))
    );
  });
}

function isPersistedTranscriptEntry(value: unknown): boolean {
  if (!isRecord(value) || typeof value.at !== "number" || !Number.isFinite(value.at)) {
    return false;
  }
  if (value.kind === "status") {
    return typeof value.text === "string" &&
      (value.status === undefined || ["queued", "running", "completed", "failed", "cancelled"].includes(String(value.status)));
  }
  if (value.kind === "user" || value.kind === "assistant") {
    return typeof value.text === "string";
  }
  if (value.kind === "tool") {
    return typeof value.toolName === "string" &&
      ["start", "update", "complete", "error"].includes(String(value.phase)) &&
      (value.callId === undefined || typeof value.callId === "string") &&
      (value.input === undefined || typeof value.input === "string") &&
      (value.output === undefined || typeof value.output === "string");
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function textResult(text: string, details: unknown, usage?: ReturnType<typeof aggregateToolUsage>) {
  return {
    content: [{ type: "text" as const, text: truncateText(text, MAX_TOOL_TEXT) }],
    details,
    ...(usage ? { usage } : {}),
  };
}

function boundedJson(value: unknown): string {
  try {
    return truncateText(JSON.stringify(value, null, 2), MAX_TOOL_TEXT);
  } catch {
    return "The result could not be serialized.";
  }
}

function formatWaitReport(report: Awaited<ReturnType<RunManager["wait"]>>): string {
  const blocks = report.entries.map((entry) => entry.kind === "unknown"
    ? `${entry.id}: unknown run id`
    : formatOneResult(entry.result));
  return truncateText(blocks.join("\n\n"), MAX_TOOL_TEXT);
}

function formatDeliveredResults(results: readonly RunResult[]): string {
  const heading = results.length === 1 ? "Background subagent finished:" : "Background subagents finished:";
  return truncateText(`${heading}\n\n${results.map(formatOneResult).join("\n\n")}`, MAX_TOOL_TEXT);
}

function formatOneResult(result: RunResult): string {
  const header = `${result.id} (${result.harness}) ${result.status}: ${formatRunIdentity(result)}`;
  const body = result.status === "completed"
    ? result.finalText || "(no final text)"
    : result.errorText || result.finalText || "(no diagnostics)";
  return `${header}\n${body}`;
}

function aggregateToolUsage(results: readonly RunResult[]) {
  const total: RunUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: 0,
    turns: 0,
    contextTokens: 0,
  };
  let found = false;
  for (const result of results) {
    if (!result.usage) continue;
    found = true;
    total.input += result.usage.input;
    total.output += result.usage.output;
    total.cacheRead += result.usage.cacheRead;
    total.cacheWrite += result.usage.cacheWrite;
    total.costUsd += result.usage.costUsd;
    total.turns += result.usage.turns;
    total.contextTokens = Math.max(total.contextTokens, result.usage.contextTokens);
  }
  if (!found) return undefined;
  return {
    input: total.input,
    output: total.output,
    cacheRead: total.cacheRead,
    cacheWrite: total.cacheWrite,
    totalTokens: total.input + total.output + total.cacheRead + total.cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: total.costUsd },
  };
}

function showHuman(
  ctx: ExtensionContext,
  text: string,
  level: "info" | "warning" | "error" = "info",
): void {
  const bounded = truncateText(text, 8_000);
  if (ctx.hasUI) {
    ctx.ui.notify(bounded, level);
  } else if (ctx.mode === "print") {
    // Commands have no return channel in print mode; keep JSON mode unpolluted.
    console.log(bounded);
  }
}
