import type {
  ExtensionCommandContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import type {
  AgentCatalog,
  AgentDefinition,
  AgentRouting,
  AgentScope,
} from "../agents.ts";
import {
  effectiveAgentRouting,
  repairAgentRoutingFile,
  writeAgentRouting,
} from "../agents.ts";
import { REASONING_EFFORTS } from "../domain.ts";

const DEFAULT_VALUE = "<default>";
const CUSTOM_VALUE = "<custom…>";

type RoutingPanelAction =
  | { readonly type: "edit"; readonly agent: string; readonly scope: AgentScope }
  | { readonly type: "reset"; readonly agent: string; readonly scope: AgentScope }
  | { readonly type: "close" };

interface RoutingSelection {
  index: number;
  name?: string;
  scope: AgentScope;
}

function reconcileSelection(
  selection: RoutingSelection,
  agents: ReadonlyArray<AgentDefinition>,
) {
  const stableIndex = selection.name
    ? agents.findIndex((agent) => agent.name === selection.name)
    : -1;
  selection.index =
    stableIndex >= 0
      ? stableIndex
      : Math.min(Math.max(selection.index, 0), Math.max(0, agents.length - 1));
  selection.name = agents[selection.index]?.name;
}

class AgentRoutingDashboard implements Component {
  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly catalog: AgentCatalog,
    private readonly selection: RoutingSelection,
    private readonly done: (action: RoutingPanelAction) => void,
  ) {}

  handleInput(data: string): void {
    const agents = this.catalog.agents;
    reconcileSelection(this.selection, agents);

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ type: "close" });
      return;
    }
    if (data === "\t") {
      if (this.catalog.projectTrusted) {
        this.selection.scope = this.selection.scope === "user" ? "project" : "user";
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
      if (agents.length > 0) {
        this.selection.index =
          (this.selection.index - 1 + agents.length) % agents.length;
        this.selection.name = agents[this.selection.index]?.name;
        this.tui.requestRender();
      }
      return;
    }
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
      if (agents.length > 0) {
        this.selection.index = (this.selection.index + 1) % agents.length;
        this.selection.name = agents[this.selection.index]?.name;
        this.tui.requestRender();
      }
      return;
    }

    const selected = agents[this.selection.index];
    if (!selected) return;
    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.done({ type: "edit", agent: selected.name, scope: this.selection.scope });
      return;
    }
    if (data === "d" || data === "D") {
      this.done({ type: "reset", agent: selected.name, scope: this.selection.scope });
    }
  }

  render(width: number): string[] {
    const theme = this.theme;
    const scopeLabel =
      this.selection.scope === "user"
        ? "user · ~/.pi/agent/subagents.json"
        : "project · .pi/subagents.json";
    const lines = [
      theme.fg("accent", theme.bold("Subagent agent routing")),
      theme.fg("muted", `Editing ${scopeLabel}`),
      "",
    ];

    reconcileSelection(this.selection, this.catalog.agents);
    for (let index = 0; index < this.catalog.agents.length; index++) {
      const agent = this.catalog.agents[index]!;
      const routing = effectiveAgentRouting(this.catalog, agent.name);
      const selected = index === this.selection.index;
      const prefix = selected ? theme.fg("accent", "> ") : "  ";
      const source = theme.fg("dim", `[${agent.scope}]`);
      const effectiveSource = routing.scope ? ` · ${routing.scope} mapping` : " · defaults";
      const route = `${routing.harness} · ${routing.model ?? "default model"} · ${routing.thinking ?? "default thinking"}${effectiveSource}`;
      const text = `${prefix}${selected ? theme.fg("accent", agent.name) : agent.name} ${source}  ${theme.fg("muted", route)}`;
      lines.push(truncateToWidth(text, Math.max(1, width)));
    }

    if (this.catalog.agents.length === 0) {
      lines.push(theme.fg("warning", "No agents found in user or project scope."));
    }
    lines.push("");
    lines.push(
      truncateToWidth(
        theme.fg(
          "dim",
          this.catalog.projectTrusted
            ? "↑↓ navigate · tab user/project · enter edit · d reset mapping · esc close"
            : "↑↓ navigate · enter edit · d reset mapping · esc close · project scope unavailable (untrusted)",
        ),
        Math.max(1, width),
      ),
    );
    return lines;
  }

  invalidate(): void {}
}

function assignmentForScope(
  catalog: AgentCatalog,
  scope: AgentScope,
  name: string,
): AgentRouting | undefined {
  return scope === "user"
    ? catalog.userRouting.agents[name]
    : catalog.projectRouting.agents[name];
}

async function selectHarness(
  ctx: ExtensionCommandContext,
  current: AgentRouting | undefined,
): Promise<AgentRouting["harness"] | null> {
  const currentLabel = current?.harness ?? "default";
  const choices = [DEFAULT_VALUE, "pi", "claude"];
  const currentValue = current?.harness ?? DEFAULT_VALUE;
  const selected = await ctx.ui.select(
    `Harness (current: ${currentLabel})`,
    [currentValue, ...choices.filter((choice) => choice !== currentValue)],
  );
  if (selected === undefined) return null;
  return selected === DEFAULT_VALUE ? undefined : (selected as "pi" | "claude");
}

function availablePiModels(ctx: ExtensionCommandContext): string[] {
  return [
    ...new Set(
      ctx.modelRegistry
        .getAvailable()
        .map((model) => `${model.provider}/${model.id}`),
    ),
  ].sort();
}

async function selectModel(
  ctx: ExtensionCommandContext,
  harness: "pi" | "claude",
  current: AgentRouting | undefined,
): Promise<string | undefined | null> {
  const candidates =
    harness === "claude"
      ? ["sonnet", "opus", "haiku"]
      : availablePiModels(ctx);
  const choices = [DEFAULT_VALUE, ...candidates, CUSTOM_VALUE];
  const currentValue = current?.model ?? DEFAULT_VALUE;
  const selected = await ctx.ui.select(
    `Model (current: ${current?.model ?? "default"})`,
    [currentValue, ...choices.filter((choice) => choice !== currentValue)],
  );
  if (selected === undefined) return null;
  if (selected === DEFAULT_VALUE) return undefined;
  if (selected !== CUSTOM_VALUE) return selected;
  const custom = await ctx.ui.input(
    "Custom model",
    harness === "claude" ? "sonnet, opus, haiku, or model id" : "provider/model-id",
  );
  const value = custom?.trim();
  return value || null;
}

async function selectThinking(
  ctx: ExtensionCommandContext,
  current: AgentRouting | undefined,
): Promise<AgentRouting["thinking"] | null> {
  const choices = [DEFAULT_VALUE, ...REASONING_EFFORTS];
  const currentValue = current?.thinking ?? DEFAULT_VALUE;
  const selected = await ctx.ui.select(
    `Thinking (current: ${current?.thinking ?? "default"})`,
    [currentValue, ...choices.filter((choice) => choice !== currentValue)],
  );
  if (selected === undefined) return null;
  return selected === DEFAULT_VALUE
    ? undefined
    : (selected as NonNullable<AgentRouting["thinking"]>);
}

async function editRouting(
  ctx: ExtensionCommandContext,
  catalog: AgentCatalog,
  action: Extract<RoutingPanelAction, { type: "edit" }>,
): Promise<boolean> {
  const current = assignmentForScope(catalog, action.scope, action.agent);
  const harness = await selectHarness(ctx, current);
  if (harness === null) return false;
  const effectiveHarness = harness ?? "pi";
  const model = await selectModel(ctx, effectiveHarness, current);
  if (model === null) return false;
  const thinking = await selectThinking(ctx, current);
  if (thinking === null) return false;

  const routing: AgentRouting = {
    ...(harness ? { harness } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
  };
  writeAgentRouting(catalog, action.scope, action.agent, routing);
  ctx.ui.notify(
    Object.keys(routing).length > 0
      ? `Saved ${action.scope} routing for ${action.agent}`
      : `Cleared ${action.scope} routing for ${action.agent}`,
    "info",
  );
  return true;
}

export async function openAgentRoutingPanel(
  ctx: ExtensionCommandContext,
  loadCatalog: () => AgentCatalog,
): Promise<void> {
  const selection: RoutingSelection = { index: 0, scope: "user" };

  while (true) {
    let catalog: AgentCatalog;
    try {
      catalog = loadCatalog();
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      return;
    }
    if (catalog.warnings.length > 0) {
      ctx.ui.notify(catalog.warnings[0]!, "warning");
    }

    const action = await ctx.ui.custom<RoutingPanelAction>(
      (tui, theme, keybindings, done) =>
        new AgentRoutingDashboard(tui, theme, keybindings, catalog, selection, done),
      {
        overlay: true,
        overlayOptions: { anchor: "center", width: "100%", maxHeight: "100%" },
      },
    );

    if (!action || action.type === "close") return;

    if (catalog.routingErrors[action.scope]) {
      const confirmed = await ctx.ui.confirm(
        "Repair invalid subagent routing?",
        `Back up and replace the invalid ${action.scope} routing file before continuing?`,
      );
      if (!confirmed) continue;
      try {
        repairAgentRoutingFile(catalog, action.scope);
        ctx.ui.notify(
          `Backed up and reset the invalid ${action.scope} routing file`,
          "warning",
        );
        catalog = loadCatalog();
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
        continue;
      }
      if (action.type === "reset") continue;
    }

    if (action.type === "edit") {
      try {
        await editRouting(ctx, catalog, action);
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
      continue;
    }

    const existing = assignmentForScope(catalog, action.scope, action.agent);
    if (!existing) {
      ctx.ui.notify(`No ${action.scope} mapping for ${action.agent}`, "info");
      continue;
    }
    const confirmed = await ctx.ui.confirm(
      "Reset subagent routing?",
      `Remove the ${action.scope} mapping for ${action.agent}?`,
    );
    if (!confirmed) continue;
    try {
      writeAgentRouting(catalog, action.scope, action.agent, undefined);
      ctx.ui.notify(`Reset ${action.scope} routing for ${action.agent}`, "info");
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    }
  }
}
