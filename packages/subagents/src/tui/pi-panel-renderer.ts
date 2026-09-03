import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import type { RouteFieldProvenance, RoutingScope } from "../agents/types.js";
import type {
  RunInspection,
  RunListEntry,
  RunStatus,
  RunTranscriptEntry,
} from "../shared/types.js";
import type { KeyHint } from "./keys.js";
import {
  modelHarnessForEditor,
  routingModelDisplayValue,
  selectedRoutingModelChoice,
  type RoutingEditorField,
  type RoutingEditorState,
} from "./routing-editor.js";
import type { RoutingAgentRow, RoutingViewState } from "./routing-view.js";
import { formatRunModel } from "../shared/run-display.js";
import { formatRunIdentity } from "../shared/run-identity.js";
import type { RunsViewState } from "./runs-view.js";
import { formatElapsed, wrapText } from "./text.js";

export function renderRunsPanel(
  theme: Theme,
  state: RunsViewState,
  width: number,
  maxRows: number,
  listHints: readonly KeyHint[],
  detailHints: readonly KeyHint[],
  editorLines?: readonly string[],
): string[] {
  const hints = state.mode === "detail" ? detailHints : listHints;
  const content = state.mode === "detail"
    ? renderRunDetail(
        theme,
        state,
        Math.max(1, width - 2),
        Math.max(1, maxRows - 4),
        editorLines,
      )
    : renderRunsList(theme, state, Math.max(1, width - 2), Math.max(1, maxRows - 4));
  return frame(theme, "SUBAGENT RUNS", content, renderHints(theme, hints), width, maxRows);
}

export function renderRoutingPanel(
  theme: Theme,
  state: RoutingViewState,
  width: number,
  maxRows: number,
  hints: readonly KeyHint[],
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const bodyRows = Math.max(1, maxRows - 4);
  const content = renderRoutingList(theme, state, innerWidth, bodyRows);
  return frame(theme, "AGENT ROUTING", content, renderHints(theme, hints), width, maxRows);
}

export function renderRoutingEditorPanel(
  theme: Theme,
  state: RoutingEditorState,
  width: number,
  maxRows: number,
  hints: readonly KeyHint[],
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const bodyRows = Math.max(1, maxRows - 4);
  const content = renderRoutingEditor(theme, state, innerWidth, bodyRows);
  return frame(theme, "EDIT AGENT ROUTE", content, renderHints(theme, hints), width, maxRows);
}

function renderRunsList(
  theme: Theme,
  state: RunsViewState,
  width: number,
  maxRows: number,
): string[] {
  const counts = countStatuses(state.runs);
  const summary = [
    statusCount(theme, "running", counts.running),
    statusCount(theme, "queued", counts.queued),
    statusCount(theme, "completed", counts.completed),
    statusCount(theme, "failed", counts.failed + counts.cancelled),
  ].join(theme.fg("dim", "  ·  "));
  const lines = [padAnsi(summary, width), divider(theme, width)];
  const noticeRows = state.pendingCancelId ? 3 : state.notice ? 1 : 0;
  const available = Math.max(0, maxRows - lines.length - noticeRows);

  if (state.runs.length === 0) {
    lines.push(...emptyState(
      theme,
      "No runs yet",
      "Ask Pi to spawn a background task. It will appear here live.",
      width,
      available,
    ));
  } else {
    const viewport = pairedViewport(state.runs.length, state.selectedIndex, available);
    if (viewport.start > 0) {
      lines.push(padAnsi(theme.fg("dim", `  ↑ ${viewport.start} earlier`), width));
    }
    for (let index = viewport.start; index < viewport.end; index += 1) {
      const run = state.runs[index];
      if (run) lines.push(...runRow(theme, run, index === state.selectedIndex, width));
    }
    if (viewport.end < state.runs.length) {
      lines.push(padAnsi(theme.fg("dim", `  ↓ ${state.runs.length - viewport.end} later`), width));
    }
  }
  if (state.pendingCancelId) {
    lines.push(...cancelConfirmationBlock(theme, state, width));
  } else if (state.notice) {
    lines.push(noticeLine(theme, state.notice, width));
  }
  return lines.slice(0, maxRows);
}

function runRow(
  theme: Theme,
  run: RunListEntry,
  selected: boolean,
  width: number,
): string[] {
  const glyph = theme.fg(statusColor(run.status), statusGlyph(run.status));
  const marker = selected ? theme.fg("accent", "▸") : " ";
  const identity = `${marker} ${glyph} ${theme.fg("accent", run.id)}  ${theme.fg("text", formatRunIdentity(run))}`;
  const status = theme.fg(statusColor(run.status), run.status.toUpperCase());
  const first = columns(identity, `${status}  ${theme.fg("dim", formatElapsed(run.elapsedMs))}`, width);
  const harness = theme.fg("muted", run.harness.toUpperCase());
  const model = theme.fg(
    run.model ? "text" : "dim",
    formatRunModel(run.model, run.thinkingLevel, "parent model")!,
  );
  const second = padAnsi(`    ${harness}${theme.fg("dim", "  ·  ")}${model}`, width);
  return selected
    ? [theme.bg("selectedBg", first), theme.bg("selectedBg", second)]
    : [first, second];
}

function renderRunDetail(
  theme: Theme,
  state: RunsViewState,
  width: number,
  maxRows: number,
  editorLines: readonly string[] | undefined,
): string[] {
  const detail = state.detail;
  if (!detail) return [];
  const inspection = detail.inspection;
  if (!inspection) {
    return emptyState(theme, "Loading run", detail.runId, width, maxRows);
  }

  const glyph = theme.fg(statusColor(inspection.status), statusGlyph(inspection.status));
  const identity = columns(
    `${glyph} ${theme.fg("accent", inspection.id)}  ${theme.bold(formatRunIdentity(inspection))}`,
    theme.fg(statusColor(inspection.status), inspection.status.toUpperCase()),
    width,
  );
  const metadata = padAnsi(
    `${theme.fg("muted", inspection.harness.toUpperCase())}${theme.fg("dim", "  ·  ")}${theme.fg(inspection.model ? "text" : "dim", formatRunModel(inspection.model, inspection.thinkingLevel, "parent model")!)}${theme.fg("dim", `  ·  ${formatElapsed(inspection.elapsedMs)}`)}`,
    width,
  );
  const usage = inspection.usage
    ? padAnsi(theme.fg(
        "dim",
        `${inspection.usage.turns} turns  ·  ${(inspection.usage.input + inspection.usage.output).toLocaleString()} tokens  ·  $${inspection.usage.costUsd.toFixed(4)}`,
      ), width)
    : undefined;
  const inputBlock = state.pendingCancelId
    ? cancelConfirmationBlock(theme, state, width)
    : runInputBlock(theme, inspection, detail.submitting, editorLines, width);
  const noticeBlock = state.notice ? [noticeLine(theme, state.notice, width)] : [];

  // Tiny terminals keep identity and input/read-only state, sacrificing
  // metadata and transcript before either of those critical regions.
  if (maxRows <= 1) return [identity].slice(0, maxRows);
  if (maxRows < 1 + inputBlock.length) {
    return [identity, ...inputBlock.slice(-(maxRows - 1))];
  }

  const header = [identity];
  if (maxRows >= 1 + inputBlock.length + 1) header.push(metadata);
  if (usage && maxRows >= header.length + inputBlock.length + 1) header.push(usage);
  const fixedRows = header.length + inputBlock.length + noticeBlock.length;
  const transcriptBudget = Math.max(0, maxRows - fixedRows);
  const transcript = renderTranscriptViewport(
    theme,
    inspection,
    detail.scrollOffset,
    width,
    transcriptBudget,
  );
  return [
    ...header,
    ...transcript,
    ...noticeBlock,
    ...inputBlock,
  ].slice(0, maxRows);
}

function cancelConfirmationBlock(
  theme: Theme,
  state: RunsViewState,
  width: number,
): string[] {
  const runId = state.pendingCancelId;
  if (!runId) return [];
  const run = state.runs.find((candidate) => candidate.id === runId);
  const identity = state.detail?.runId === runId
    ? state.detail.inspection ?? run
    : run;
  const title = identity ? formatRunIdentity(identity) : undefined;
  return [
    sectionLabel(theme, "CONFIRM CANCELLATION", width),
    padAnsi(
      `  ${theme.fg("warning", `Stop ${runId}${title ? ` · ${title}` : ""}?`)}`,
      width,
    ),
    padAnsi(
      `  ${theme.fg("accent", "y / enter")} ${theme.fg("dim", "cancel run")}  ·  ${theme.fg("accent", "n / esc")} ${theme.fg("dim", "keep running")}`,
      width,
    ),
  ];
}

function runInputBlock(
  theme: Theme,
  inspection: RunInspection,
  submitting: boolean,
  editorLines: readonly string[] | undefined,
  width: number,
): string[] {
  if (inspection.messaging.editable && editorLines) {
    return [
      sectionLabel(theme, submitting ? "SENDING" : "MESSAGE", width),
      ...editorLines.map((line) => padAnsi(`  ${line}`, width)),
    ];
  }
  return [
    sectionLabel(theme, "READ ONLY", width),
    padAnsi(
      `  ${theme.fg("dim", inspection.messaging.reason ?? "This run cannot accept more input.")}`,
      width,
    ),
  ];
}

function renderTranscriptViewport(
  theme: Theme,
  inspection: RunInspection,
  scrollOffset: number,
  width: number,
  maxRows: number,
): string[] {
  if (maxRows <= 0) return [];
  const entries = inspection.transcript;
  const boundedOffset = Math.min(Math.max(0, scrollOffset), Math.max(0, entries.length - 1));
  const end = Math.max(0, entries.length - boundedOffset);
  const availableEntries = entries.slice(0, end);
  const rendered = availableEntries.flatMap((entry) => renderTranscriptEntry(theme, entry, width));
  const reserveBottom = boundedOffset > 0 ? 1 : 0;
  const bodyRows = Math.max(0, maxRows - reserveBottom);
  const visible = rendered.slice(-bodyRows);
  const hiddenLines = rendered.length - visible.length;
  if (visible.length > 0 && (hiddenLines > 0 || inspection.transcriptDropped > 0)) {
    const omitted = inspection.transcriptDropped + hiddenLines;
    visible[0] = padAnsi(theme.fg("dim", `  … ${omitted} earlier transcript item${omitted === 1 ? "" : "s"}`), width);
  }
  if (visible.length === 0 && bodyRows > 0) {
    visible.push(padAnsi(theme.fg("dim", "  Waiting for transcript events…"), width));
  }
  if (boundedOffset > 0) {
    visible.push(padAnsi(
      theme.fg("warning", `  ↓ ${boundedOffset} newer event${boundedOffset === 1 ? "" : "s"} · PageDown to follow`),
      width,
    ));
  }
  return visible.slice(0, maxRows);
}

function renderTranscriptEntry(
  theme: Theme,
  entry: RunTranscriptEntry,
  width: number,
): string[] {
  switch (entry.kind) {
    case "status":
      return [padAnsi(`${theme.fg("borderMuted", "  ┊")} ${theme.fg("dim", entry.text)}`, width)];
    case "user":
      return transcriptTextBlock(theme, "YOU", entry.text, width, "user");
    case "assistant":
      return transcriptTextBlock(theme, "ASSISTANT", entry.text, width, "assistant");
    case "tool": {
      const color = entry.phase === "error" ? "error" : entry.phase === "complete" ? "success" : "toolTitle";
      const heading = `${theme.fg(color, "  TOOL")} ${theme.bold(theme.fg("text", entry.toolName))}${theme.fg("dim", `  ·  ${entry.phase}${entry.callId ? `  ·  ${entry.callId}` : ""}`)}`;
      const lines = [padAnsi(heading, width)];
      if (entry.input) lines.push(...transcriptDetailLines(theme, "input", entry.input, width));
      if (entry.output) lines.push(...transcriptDetailLines(theme, "output", entry.output, width));
      return lines;
    }
  }
}

function transcriptTextBlock(
  theme: Theme,
  label: string,
  text: string,
  width: number,
  kind: "user" | "assistant",
): string[] {
  const available = Math.max(1, width - 4);
  const wrapped = wrapText(text, available);
  const heading = padAnsi(theme.bold(theme.fg(kind === "user" ? "accent" : "customMessageLabel", `  ${label}`)), width);
  const body = (wrapped.length > 0 ? wrapped : [""]).map((line) => {
    const padded = padAnsi(`    ${theme.fg("text", line)}`, width);
    return kind === "user" ? theme.bg("userMessageBg", padded) : padded;
  });
  return [heading, ...body];
}

function transcriptDetailLines(
  theme: Theme,
  label: string,
  value: string,
  width: number,
): string[] {
  const wrapped = wrapText(value, Math.max(1, width - 8));
  return (wrapped.length > 0 ? wrapped : [""]).map((line, index) => padAnsi(
    `    ${theme.fg("dim", index === 0 ? `${label}: ` : "       ")}${theme.fg("toolOutput", line)}`,
    width,
  ));
}

function renderRoutingEditor(
  theme: Theme,
  state: RoutingEditorState,
  width: number,
  maxRows: number,
): string[] {
  const scope = state.session.scope.toUpperCase();
  const modelChoice = selectedRoutingModelChoice(state);
  const modelHarness = modelHarnessForEditor(state).toUpperCase();
  const modelDescription = modelChoice.description
    ? `${modelHarness} · ${modelChoice.description}`
    : `${modelHarness} model override`;
  const content = [
    columns(
      `${theme.fg("accent", "◆")} ${theme.bold(theme.fg("text", state.session.agentName))}`,
      theme.fg("accent", `${scope} MAPPING`),
      width,
    ),
    padAnsi(theme.fg("dim", "Set only the overrides this agent needs. Inherited values follow the parent session."), width),
    sectionLabel(theme, "ROUTE OVERRIDES", width),
    ...editorField(
      theme,
      "harness",
      "01",
      "HARNESS",
      choiceValue(theme, state.harness),
      "Execution environment: Pi child session or Claude Agent SDK",
      state.selectedField,
      width,
    ),
    ...editorField(
      theme,
      "model",
      "02",
      "MODEL",
      modelChoiceValue(theme, modelChoice),
      modelDescription,
      state.selectedField,
      width,
    ),
    ...editorField(
      theme,
      "thinking",
      "03",
      "THINKING",
      choiceValue(theme, state.thinking),
      "Reasoning effort override",
      state.selectedField,
      width,
    ),
    sectionLabel(theme, "SAVED OVERRIDE", width),
    padAnsi(routePreview(theme, state), width),
  ];
  return content.slice(0, maxRows);
}

function editorField(
  theme: Theme,
  field: RoutingEditorField,
  number: string,
  label: string,
  value: string,
  description: string,
  selectedField: RoutingEditorField,
  width: number,
): string[] {
  const selected = field === selectedField;
  const marker = selected ? theme.fg("accent", "▸") : " ";
  const heading = padAnsi(
    `${marker} ${theme.fg(selected ? "accent" : "dim", number)}  ${theme.bold(theme.fg(selected ? "text" : "muted", label))}`,
    width,
  );
  const valueLine = padAnsi(`     ${selected ? theme.fg("accent", "›") : " "} ${value}`, width);
  const descriptionLine = padAnsi(`       ${theme.fg("dim", description)}`, width);
  return selected
    ? [theme.bg("selectedBg", heading), theme.bg("selectedBg", valueLine), theme.bg("selectedBg", descriptionLine)]
    : [heading, valueLine, descriptionLine];
}

function choiceValue(theme: Theme, value: string): string {
  const label = value === "inherit" ? "INHERIT" : value.toUpperCase();
  return `${theme.fg("dim", "‹")} ${theme.fg(value === "inherit" ? "muted" : "accent", label)} ${theme.fg("dim", "›")}`;
}

function modelChoiceValue(
  theme: Theme,
  choice: ReturnType<typeof selectedRoutingModelChoice>,
): string {
  const color =
    choice.value === "" ? "muted" : choice.legacy ? "warning" : "accent";
  return `${theme.fg("dim", "‹")} ${theme.fg(color, choice.label)} ${theme.fg("dim", "›")}`;
}

function routePreview(theme: Theme, state: RoutingEditorState): string {
  const parts = [
    `harness=${state.harness}`,
    `model=${state.model ? routingModelDisplayValue(state.model) : "inherit"}`,
    `thinking=${state.thinking}`,
  ];
  return `  ${theme.fg("muted", parts.join("  ·  "))}`;
}

function renderRoutingList(
  theme: Theme,
  state: RoutingViewState,
  width: number,
  maxRows: number,
): string[] {
  const mapped = state.rows.reduce(
    (count, row) => count + (scopeEntry(row, state.scope) ? 1 : 0),
    0,
  );
  const lines = [
    tabs(theme, state.scope, state.projectTrusted, width),
    padAnsi(
      `${theme.fg("text", `${state.rows.length} agents`)}${theme.fg("dim", "  ·  ")}${theme.fg(mapped > 0 ? "accent" : "dim", `${mapped} saved here`)}${theme.fg("dim", "  ·  ◆ mapped")}`,
      width,
    ),
  ];

  const invalidReason = state.invalid[state.scope];
  if (invalidReason) {
    lines.push(noticeLine(theme, `Invalid ${state.scope} routing: ${invalidReason}`, width));
  }
  if (state.resettingScope) {
    lines.push(noticeLine(theme, `Resetting ${state.resettingScope} routing…`, width));
  }
  lines.push(divider(theme, width));

  const noticeRows = state.notice ? 1 : 0;
  const available = Math.max(0, maxRows - lines.length - noticeRows);
  if (state.rows.length === 0) {
    lines.push(...emptyState(
      theme,
      "No named agents found",
      "Install an agent package or add an agent markdown file.",
      width,
      available,
    ));
  } else {
    const viewport = pairedViewport(state.rows.length, state.selectedIndex, available);
    if (viewport.start > 0) {
      lines.push(padAnsi(theme.fg("dim", `  ↑ ${viewport.start} earlier`), width));
    }
    for (let index = viewport.start; index < viewport.end; index += 1) {
      const row = state.rows[index];
      if (row) lines.push(...routingRow(theme, row, state.scope, index === state.selectedIndex, width));
    }
    if (viewport.end < state.rows.length) {
      lines.push(padAnsi(theme.fg("dim", `  ↓ ${state.rows.length - viewport.end} later`), width));
    }
  }
  if (state.notice) lines.push(noticeLine(theme, state.notice, width));
  return lines.slice(0, maxRows);
}

function routingRow(
  theme: Theme,
  row: RoutingAgentRow,
  scope: RoutingScope,
  selected: boolean,
  width: number,
): string[] {
  const saved = scopeEntry(row, scope) !== undefined;
  const marker = selected ? theme.fg("accent", "▸") : " ";
  const mapped = theme.fg(saved ? "accent" : "dim", saved ? "◆" : "·");
  const name = theme.fg("text", row.name);
  const harness = theme.fg(row.route.harness === "claude" ? "accent" : "muted", row.route.harness.toUpperCase());
  const first = columns(`${marker} ${mapped} ${name}`, harness, width);
  const routeModel = row.route.model
    ? routingModelDisplayValue(row.route.model)
    : "parent model";
  const route = `${routeModel}  ·  ${row.route.thinking ?? "parent thinking"}`;
  const provenance = `H:${sourceLabel(row.route.provenance.harness)} M:${sourceLabel(row.route.provenance.model)} T:${sourceLabel(row.route.provenance.thinking)}`;
  const second = columns(
    `    ${theme.fg("muted", row.definitionScope)}${theme.fg("dim", "  ·  ")}${theme.fg("text", route)}`,
    theme.fg("dim", provenance),
    width,
  );
  return selected
    ? [theme.bg("selectedBg", first), theme.bg("selectedBg", second)]
    : [first, second];
}

function frame(
  theme: Theme,
  title: string,
  content: readonly string[],
  footer: string,
  requestedWidth: number,
  maxRows: number,
): string[] {
  const width = Math.max(1, requestedWidth);
  if (width < 4) {
    return content.slice(0, maxRows).map((line) => truncateToWidth(line, width, ""));
  }
  const innerWidth = width - 2;
  const titleText = ` ${theme.bold(theme.fg("accent", title))} `;
  const topFill = "─".repeat(Math.max(0, width - visibleWidth(titleText) - 3));
  const top = `${theme.fg("borderAccent", "╭─")}${titleText}${theme.fg("borderAccent", `${topFill}╮`)}`;
  const bottom = theme.fg("borderAccent", `╰${"─".repeat(innerWidth)}╯`);
  const availableContent = Math.max(0, maxRows - 4);
  const boundedContent = content.slice(0, availableContent);
  while (boundedContent.length < availableContent) boundedContent.push("");
  const lines = [
    top,
    ...boundedContent.map((line) => framedLine(theme, line, innerWidth)),
    `${theme.fg("borderMuted", "├")}${theme.fg("borderMuted", "─".repeat(innerWidth))}${theme.fg("borderMuted", "┤")}`,
    framedLine(theme, footer, innerWidth),
    bottom,
  ];
  return lines.slice(0, maxRows).map((line) => truncateToWidth(line, width, ""));
}

function framedLine(theme: Theme, line: string, width: number): string {
  return `${theme.fg("borderMuted", "│")}${padAnsi(line, width)}${theme.fg("borderMuted", "│")}`;
}

function tabs(theme: Theme, scope: RoutingScope, projectTrusted: boolean, width: number): string {
  const user = scope === "user"
    ? theme.bg("selectedBg", theme.bold(theme.fg("accent", " USER ")))
    : theme.fg("dim", " USER ");
  const projectLabel = projectTrusted ? " PROJECT " : " PROJECT · UNTRUSTED ";
  const project = scope === "project"
    ? theme.bg("selectedBg", theme.bold(theme.fg("accent", projectLabel)))
    : theme.fg(projectTrusted ? "dim" : "warning", projectLabel);
  return padAnsi(` ${user}  ${project}`, width);
}

function renderHints(theme: Theme, hints: readonly KeyHint[]): string {
  return hints.map((hint) =>
    `${theme.fg("accent", hint.key)} ${theme.fg("dim", hint.description)}`
  ).join(theme.fg("borderMuted", "  ·  "));
}

function sectionLabel(theme: Theme, label: string, width: number): string {
  const styled = ` ${theme.fg("accent", label)} `;
  return `${styled}${theme.fg("borderMuted", "─".repeat(Math.max(0, width - visibleWidth(styled))))}`;
}

function divider(theme: Theme, width: number): string {
  return theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
}

function noticeLine(theme: Theme, notice: string, width: number): string {
  return padAnsi(`${theme.fg("warning", "!")} ${theme.fg("warning", notice)}`, width);
}

function emptyState(
  theme: Theme,
  title: string,
  description: string,
  width: number,
  maxRows: number,
): string[] {
  if (maxRows <= 0) return [];
  const lines = [
    padAnsi(theme.bold(theme.fg("muted", `  ${title}`)), width),
    padAnsi(theme.fg("dim", `  ${description}`), width),
  ];
  return lines.slice(0, maxRows);
}

function statusCount(theme: Theme, status: RunStatus, count: number): string {
  return `${theme.fg(statusColor(status), statusGlyph(status))} ${theme.fg(count > 0 ? "text" : "dim", `${count} ${status === "failed" ? "issues" : status}`)}`;
}

function countStatuses(runs: readonly RunListEntry[]): Record<RunStatus, number> {
  const counts: Record<RunStatus, number> = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const run of runs) counts[run.status] += 1;
  return counts;
}

function statusColor(status: RunStatus): "dim" | "accent" | "success" | "error" | "warning" {
  switch (status) {
    case "queued": return "dim";
    case "running": return "accent";
    case "completed": return "success";
    case "failed": return "error";
    case "cancelled": return "warning";
  }
}

function statusGlyph(status: RunStatus): string {
  switch (status) {
    case "queued": return "○";
    case "running": return "●";
    case "completed": return "✓";
    case "failed": return "×";
    case "cancelled": return "⊘";
  }
}

function sourceLabel(source: RouteFieldProvenance): string {
  switch (source) {
    case "explicit": return "arg";
    case "saved-project": return "project";
    case "saved-user": return "user";
    case "agent-default": return "agent";
    case "parent": return "parent";
  }
}

function scopeEntry(row: RoutingAgentRow, scope: RoutingScope): object | undefined {
  return scope === "user" ? row.userEntry : row.projectEntry;
}

function pairedViewport(
  length: number,
  selectedIndex: number,
  maxRows: number,
): { start: number; end: number } {
  if (length <= 0 || maxRows <= 0) return { start: 0, end: 0 };
  const selected = Math.min(Math.max(0, selectedIndex), length - 1);
  let itemCount = Math.max(1, Math.min(length, Math.floor(maxRows / 2)));
  let start = Math.min(Math.max(0, selected - Math.floor(itemCount / 2)), length - itemCount);
  let end = start + itemCount;
  while (itemCount > 1) {
    const rows = itemCount * 2 + (start > 0 ? 1 : 0) + (end < length ? 1 : 0);
    if (rows <= maxRows) break;
    itemCount -= 1;
    start = Math.min(Math.max(0, selected - Math.floor(itemCount / 2)), length - itemCount);
    end = start + itemCount;
  }
  return { start, end };
}

function columns(left: string, right: string, width: number, gap = 2): string {
  if (width <= 0) return "";
  const boundedRight = truncateToWidth(right, Math.max(0, width - gap), "");
  const rightWidth = visibleWidth(boundedRight);
  const leftWidth = Math.max(0, width - rightWidth - gap);
  const boundedLeft = truncateToWidth(left, leftWidth, leftWidth > 1 ? "…" : "");
  const spacing = " ".repeat(Math.max(gap, width - visibleWidth(boundedLeft) - rightWidth));
  return truncateToWidth(`${boundedLeft}${spacing}${boundedRight}`, width, "");
}

function padAnsi(text: string, width: number): string {
  const bounded = truncateToWidth(text, Math.max(0, width), "");
  return `${bounded}${" ".repeat(Math.max(0, width - visibleWidth(bounded)))}`;
}
