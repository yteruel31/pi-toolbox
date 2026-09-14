import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore, configSchema, policySchema, presets, type Config } from "./config.js";
import { GuardrailsEngine, type Approval } from "./engine.js";
import { HistoryStore } from "./history.js";
import { piBridge, type CompletionBridge } from "./judge.js";
import { canonicalPath } from "./policies.js";
import { isTool, type Candidate } from "./types.js";
import { sanitize } from "./sanitize.js";
import { CHILD_CHANNEL, provideChildGate } from "./child-bridge.js";
import { GUARDRAILS_OVERLAY, GuardrailsPanel, initialPanelState, panelRows, type PanelAction } from "./tui/panel.js";

interface Dependencies {
  agentDir?: string;
  history?: (path: string) => HistoryStore;
  bridge?: CompletionBridge;
}
export function createGuardrailsExtension(deps: Dependencies = {}) {
  return (pi: ExtensionAPI): void => {
    let runtime: {
      ctx: ExtensionContext; sessionId: string; project: string; controller: AbortController;
      store: ConfigStore; history?: HistoryStore; engine?: GuardrailsEngine; bridge: CompletionBridge; unsubscribe?: () => void;
    } | undefined;
    const shutdown = () => {
      const old = runtime; runtime = undefined;
      old?.controller.abort(); old?.unsubscribe?.(); old?.history?.close();
    };
    pi.on("session_start", async (_event, ctx) => {
      shutdown();
      const agentDir = deps.agentDir ?? getAgentDir();
      const project = canonicalPath(ctx.cwd, ctx.cwd);
      const store = new ConfigStore(agentDir, ctx.cwd, CONFIG_DIR_NAME);
      const current: NonNullable<typeof runtime> = { ctx, sessionId: ctx.sessionManager.getSessionId(), project, controller: new AbortController(), store,
        bridge: deps.bridge ?? piBridge(() => current.ctx), history: undefined as HistoryStore | undefined,
        engine: undefined as GuardrailsEngine | undefined, unsubscribe: undefined as (() => void) | undefined };
      runtime = current;
      try {
        current.history = (deps.history ?? ((path) => new HistoryStore(path)))(join(agentDir, "guardrails", "history.sqlite"));
        current.engine = new GuardrailsEngine({
          load: () => store.load(current.ctx.isProjectTrusted()), bridge: current.bridge, history: current.history,
          protectedPaths: [agentDir, join(project, CONFIG_DIR_NAME), resolve(dirname(fileURLToPath(import.meta.url)), "..")], signal: current.controller.signal,
        });
        current.unsubscribe = pi.events.on(CHILD_CHANNEL, (data) => provideChildGate(data, current.engine!, { sessionId: current.sessionId, project, signal: current.controller.signal }));
      } catch {
        // Register an unavailable gate as well: installing guardrails must not fail open for workers.
        current.unsubscribe = pi.events.on(CHILD_CHANNEL, (data) => {
          const r = data as { v?: number; parentSessionId?: string; provide?: (gate: unknown) => void };
          if (r?.v === 1 && r.parentSessionId === current.sessionId && typeof r.provide === "function") r.provide({ assess: async () => ({ block: true, reason: "Guardrails storage is unavailable. Repair it in the parent session." }), result() {} });
        });
        if (ctx.hasUI) ctx.ui.notify("Guardrails storage unavailable. Covered calls will be blocked.", "error");
      }
    });
    pi.on("session_shutdown", shutdown);
    pi.on("model_select", (_event, ctx) => { if (runtime) runtime.ctx = ctx; });
    const mainCandidate = (ctx: ExtensionContext, tool: Candidate["tool"], args: Record<string, unknown>, callId: string): Candidate => ({
      tool, args, cwd: ctx.cwd, actor: { kind: "main" }, callId, sessionId: ctx.sessionManager.getSessionId(), project: runtime!.project,
      leafId: ctx.sessionManager.getLeafId() ?? undefined,
    });
    const approval = (ctx: ExtensionContext): Approval | undefined => !ctx.hasUI ? undefined : async (entry, signal) => {
      const choice = await ctx.ui.select(`Guardrails · ${entry.tool}\n${sanitize(entry.summary, 1000)}\n${sanitize(entry.reason, 1500)}\nThis grants one call only. Execution is not yet observed.`, ["Allow once", "Deny", "Deny and stop"], { signal });
      if (choice === "Deny and stop") return "deny-stop";
      return choice === "Allow once" ? "allow-once" : "deny";
    };
    pi.on("tool_call", async (event, ctx) => {
      if (!isTool(event.toolName)) return;
      const current = runtime;
      if (!current?.engine || current.sessionId !== ctx.sessionManager.getSessionId()) return { block: true, reason: "Guardrails is not ready for this session." };
      current.ctx = ctx;
      const block = await current.engine.assess(mainCandidate(ctx, event.toolName, event.input, event.toolCallId), approval(ctx), ctx.signal);
      // Record the human choice before aborting; otherwise abort can win the approval race.
      if (block?.terminate) void ctx.abort();
      return block;
    });
    pi.on("tool_result", (event, ctx) => {
      if (runtime?.sessionId !== ctx.sessionManager.getSessionId()) return;
      runtime?.engine?.result({ callId: event.toolCallId, sessionId: ctx.sessionManager.getSessionId(), actor: { kind: "main" } }, event.isError);
    });
    pi.registerCommand("guardrails", {
      description: "Configure policies, test without execution, and inspect main/Pi worker decision history",
      handler: async (_args, ctx) => {
        const current = runtime;
        if (ctx.mode !== "tui" || !current?.engine || !current.history) {
          if (ctx.hasUI) ctx.ui.notify("Guardrails requires a native TUI and writable local history storage.", "error");
          return;
        }
        current.ctx = ctx;
        let snapshot = await current.store.load(ctx.isProjectTrusted());
        let draft: Config = structuredClone(snapshot.config);
        const state = initialPanelState();
        while (!current.controller.signal.aborted) {
          const action = await ctx.ui.custom<PanelAction>((tui, theme, keybindings, done) => new GuardrailsPanel({
            theme, keybindings, snapshot, draft, state, sessionId: current.sessionId, history: current.history!,
            model: () => { try { return current.bridge.resolve(draft).route; } catch { return "Unavailable (will require approval or block)"; } },
            maxRows: () => panelRows(tui.terminal.rows), onRender: () => tui.requestRender(), onDone: done,
          }), { overlay: true, overlayOptions: GUARDRAILS_OVERLAY });
          if (!action || action.type === "close" || current.controller.signal.aborted) break;
          try {
            if (action.type === "save") {
              if (!await ctx.ui.confirm("Save guardrails configuration?", `Protection: ${draft.enabled ? "enabled" : "disabled"}. Saves global settings and explicit policies. No tool will be executed.`)) continue;
              await current.store.save(configSchema.parse(draft), snapshot.revision);
              snapshot = await current.store.load(ctx.isProjectTrusted()); draft = structuredClone(snapshot.config);
              state.notice = "Global configuration saved. Applies to subsequent main and Pi worker calls.";
            } else if (action.type === "model") {
              const value = await ctx.ui.input("Judge provider/model-id (blank follows the active parent model)", draft.model);
              if (value !== undefined) { configSchema.parse({ ...draft, model: value }); draft.model = value; }
            } else if (action.type === "new" || action.type === "edit") {
              const previous = action.type === "edit" ? draft.policies.find((p) => p.id === action.id) : undefined;
              const value = await ctx.ui.editor("Policy JSON (staged until Ctrl+s). Conditions AND together. No shell execution.", JSON.stringify(previous ?? {
                id: `policy-${randomUUID().slice(0, 8)}`, name: "New policy", enabled: true, scope: "both", tools: ["bash"], kind: "natural", description: "Ask before making changes outside the project.", conditions: {}, action: "Ask",
              }, null, 2));
              if (value !== undefined) {
                const policy = policySchema.parse(JSON.parse(value));
                const next = [...draft.policies.filter((p) => p.id !== previous?.id), policy];
                configSchema.parse({ ...draft, policies: next }); draft.policies = next; state.policyId = policy.id;
              }
            } else if (action.type === "presets") {
              const name = await ctx.ui.select("Add missing preset (existing policies stay unchanged)", presets.map((p) => p.name));
              const preset = presets.find((p) => p.name === name);
              if (preset && !draft.policies.some((p) => p.id === preset.id)) draft.policies.push(structuredClone(preset));
            } else if (action.type === "test") {
              const actor = await ctx.ui.select("Test actor (never executes)", ["Main", "Pi subagent"]);
              if (!actor) continue;
              const command = await ctx.ui.input("Assess only (may use model credits). Do not enter secrets.", "git status");
              if (!command) continue;
              const candidate = mainCandidate(ctx, "bash", { command }, `test-${randomUUID()}`);
              if (actor === "Pi subagent") candidate.actor = { kind: "subagent", runId: "dry-run" };
              const testEngine = new GuardrailsEngine({ load: async () => ({ ...snapshot, config: { ...draft, enabled: true }, policies: [...draft.policies, ...snapshot.policies.filter((p) => p.source === "project")] }), bridge: current.bridge, history: current.history, protectedPaths: [deps.agentDir ?? getAgentDir(), join(current.project, CONFIG_DIR_NAME), resolve(dirname(fileURLToPath(import.meta.url)), "..")], signal: current.controller.signal });
              const evaluated = await testEngine.evaluate(candidate, current.controller.signal);
              state.notice = `TEST ONLY, not executed or recorded. ${evaluated.decision.action} · ${evaluated.decision.origin}: ${evaluated.decision.reason}`;
              state.detail = true; state.scroll = 0;
            }
          } catch {
            state.notice = "Change rejected or storage busy. Check the policy schema; reopen the panel if configuration changed elsewhere. No tool was executed.";
          }
        }
      },
    });
  };
}
export default createGuardrailsExtension();
