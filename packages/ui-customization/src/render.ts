import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterModel } from "./model.js";
import { formatTokens } from "./usage.js";

interface Column {
  id: "session" | "mcp" | "path" | "context" | "model" | "thinking" | "subagents";
  label: string;
  value: string;
  minWidth: number;
  maxWidth: number;
  priority: number;
}

const SEPARATOR_WIDTH = 3;
const COMPACT_BREAKPOINT = 60;
const ABSORBED_STATUS_KEYS = new Set(["session-title"]);

function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001a\u001c-\u001f\u007f]/g, "")
    .replace(/ +/g, " ")
    .trim();
}

function padToWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width, "…");
  return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

function contextColor(percent: number | null): ThemeColor {
  if (percent !== null && percent > 90) return "error";
  if (percent !== null && percent > 70) return "warning";
  return "text";
}

function thinkingColor(level: string): ThemeColor {
  const colors: Record<string, ThemeColor> = {
    off: "thinkingOff",
    minimal: "thinkingMinimal",
    low: "thinkingLow",
    medium: "thinkingMedium",
    high: "thinkingHigh",
    xhigh: "thinkingXhigh",
    max: "thinkingMax",
  };
  return colors[level] ?? "thinkingText";
}

function contextValue(model: FooterModel): string {
  const tokens = model.context.tokens === null ? "?" : formatTokens(model.context.tokens);
  const percent = model.context.percent === null ? "?" : `${model.context.percent.toFixed(1)}%`;
  const parts = [`${percent} ${tokens}/${formatTokens(model.context.contextWindow)}`];
  if ((model.usage.cacheRead > 0 || model.usage.cacheWrite > 0) && model.usage.latestCacheHitRate !== undefined) {
    parts.push(`CH${model.usage.latestCacheHitRate.toFixed(1)}%`);
  }
  if (model.usage.cost) parts.push(`$${model.usage.cost.toFixed(3)}`);
  return parts.join(" ");
}

function createColumns(model: FooterModel, theme: Theme): Column[] {
  const columns: Column[] = [{
    id: "session",
    label: "SESSION",
    value: theme.fg("accent", model.sessionName ?? "untitled"),
    minWidth: 9,
    maxWidth: 26,
    priority: 7,
  }];

  if (model.mcp && model.mcp.enabled + model.mcp.disabled > 0) {
    const color: ThemeColor = model.mcp.errors > 0
      ? "error"
      : model.mcp.authRequired > 0
        ? "warning"
        : model.mcp.enabled > 0 && model.mcp.connected === model.mcp.enabled
          ? "success"
          : "muted";
    columns.push({
      id: "mcp",
      label: "MCPS",
      value: theme.fg(color, `${model.mcp.connected}/${model.mcp.enabled} ●`),
      minWidth: 7,
      maxWidth: 14,
      priority: 3,
    });
  }

  columns.push({
    id: "path",
    label: "PATH",
    value: theme.fg("muted", model.branch ? `${model.path} (${model.branch})` : model.path),
    minWidth: 10,
    maxWidth: 28,
    priority: 1,
  });

  columns.push({
    id: "context",
    label: "CONTEXT",
    value: theme.fg(contextColor(model.context.percent), contextValue(model)),
    minWidth: 18,
    maxWidth: 40,
    priority: 6,
  });

  const modelValue = model.providerCount > 1 && model.provider
    ? `${model.provider}/${model.modelName}`
    : model.modelName;
  columns.push({
    id: "model",
    label: "MODEL",
    value: theme.fg("text", modelValue),
    minWidth: 10,
    maxWidth: 24,
    priority: 5,
  });

  columns.push({
    id: "thinking",
    label: "THINKING",
    value: theme.fg(thinkingColor(model.thinking), `● ${model.thinking}`),
    minWidth: 8,
    maxWidth: 13,
    priority: 2,
  });

  if (model.subagents && model.subagents.running + model.subagents.completed + model.subagents.error > 0) {
    const counts = model.subagents;
    const values: string[] = [];
    if (counts.running > 0) values.push(theme.fg("accent", `● ${counts.running} run`));
    if (counts.completed > 0) values.push(theme.fg("success", `✓ ${counts.completed} done`));
    if (counts.error > 0) values.push(theme.fg("error", `× ${counts.error} err`));
    columns.push({
      id: "subagents",
      label: "SUB-AGENTS",
      value: values.join(" "),
      minWidth: 10,
      maxWidth: 32,
      priority: 4,
    });
  }

  return columns;
}

function columnsWidth(columns: readonly Column[], useNaturalWidth: boolean): number {
  const cells = columns.reduce((sum, column) => {
    const natural = Math.max(visibleWidth(column.label), visibleWidth(column.value));
    return sum + (useNaturalWidth ? Math.min(column.maxWidth, Math.max(column.minWidth, natural)) : column.minWidth);
  }, 0);
  return cells + Math.max(0, columns.length - 1) * SEPARATOR_WIDTH;
}

function selectColumns(columns: readonly Column[], width: number): Column[] {
  const selected = [...columns];
  while (selected.length > 1 && columnsWidth(selected, false) > width) {
    let lowest = 0;
    for (let index = 1; index < selected.length; index += 1) {
      if (selected[index]!.priority < selected[lowest]!.priority) lowest = index;
    }
    selected.splice(lowest, 1);
  }
  return selected;
}

function allocateWidths(columns: readonly Column[], width: number): number[] {
  const widths = columns.map((column) => column.minWidth);
  let remaining = Math.max(0, width - columnsWidth(columns, false));
  const order = columns
    .map((column, index) => ({ column, index }))
    .sort((a, b) => b.column.priority - a.column.priority);

  for (const { column, index } of order) {
    const natural = Math.min(column.maxWidth, Math.max(column.minWidth, visibleWidth(column.label), visibleWidth(column.value)));
    const growth = Math.min(remaining, natural - widths[index]!);
    widths[index] = widths[index]! + growth;
    remaining -= growth;
    if (remaining === 0) break;
  }
  return widths;
}

interface RenderedLayout {
  lines: string[];
  absorbed: ReadonlySet<Column["id"]>;
}

function renderColumns(model: FooterModel, theme: Theme, width: number): RenderedLayout {
  const columns = selectColumns(createColumns(model, theme), width);
  const widths = allocateWidths(columns, width);
  const separator = theme.fg("borderMuted", " │ ");
  const labelLine = columns.map((column, index) =>
    padToWidth(theme.fg("dim", column.label), widths[index]!),
  ).join(separator);
  const valueLine = columns.map((column, index) => padToWidth(column.value, widths[index]!)).join(separator);
  return {
    lines: [labelLine, valueLine].map((line) => truncateToWidth(line, width, "…")),
    absorbed: new Set(columns.map((column) => column.id)),
  };
}

function renderCompact(model: FooterModel, theme: Theme, width: number): RenderedLayout {
  const absorbed = new Set<Column["id"]>(["session", "context", "model"]);
  const parts = [theme.fg("accent", model.sessionName ?? "untitled")];
  if (model.mcp && model.mcp.enabled + model.mcp.disabled > 0) {
    parts.push(theme.fg("muted", `MCP ${model.mcp.connected}/${model.mcp.enabled}`));
  }
  const percent = model.context.percent === null ? "?" : `${model.context.percent.toFixed(1)}%`;
  parts.push(theme.fg(contextColor(model.context.percent), `${percent}/${formatTokens(model.context.contextWindow)}`));
  parts.push(theme.fg("text", model.modelName));
  if (model.subagents && model.subagents.running + model.subagents.completed + model.subagents.error > 0) {
    const { running, completed, error } = model.subagents;
    parts.push(theme.fg(error > 0 ? "error" : running > 0 ? "accent" : "muted", `${running}r/${completed}d/${error}e`));
  }
  return {
    lines: [truncateToWidth(parts.join(theme.fg("borderMuted", " • ")), width, "…")],
    absorbed,
  };
}

function renderExtensionStatuses(
  model: FooterModel,
  theme: Theme,
  width: number,
  absorbed: ReadonlySet<Column["id"]>,
): string | undefined {
  const excluded = new Set(ABSORBED_STATUS_KEYS);
  if (absorbed.has("mcp")) excluded.add("mcp-status");
  if (absorbed.has("subagents")) excluded.add("subagents");
  const statuses = [...model.extensionStatuses.entries()]
    .filter(([key]) => !excluded.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, text]) => sanitizeStatusText(text))
    .filter(Boolean);
  if (statuses.length === 0) return undefined;
  return truncateToWidth(statuses.join(theme.fg("borderMuted", " • ")), width, "…");
}

export function renderFooter(model: FooterModel, theme: Theme, width: number): string[] {
  if (width <= 0) return [];
  const rendered = width < COMPACT_BREAKPOINT
    ? renderCompact(model, theme, width)
    : renderColumns(model, theme, width);
  const extensionStatuses = renderExtensionStatuses(model, theme, width, rendered.absorbed);
  if (extensionStatuses) rendered.lines.push(extensionStatuses);
  return rendered.lines.map((line) => truncateToWidth(line, width, "…"));
}
