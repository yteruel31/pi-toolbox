/**
 * Non-TUI textual summaries. SPEC: "Without a UI, commands return a concise
 * textual summary." These are the headless fallbacks for /subagents (and its
 * runs/agents sub-modes) in print/JSON/RPC-without-TUI contexts. Pure string
 * builders; every output is bounded.
 */

import { formatRunIdentity } from "../shared/run-identity.js";
import type { RunInspection, RunListEntry } from "../shared/types.js";
import type { RoutingAgentRow } from "./routing-view.js";
import { formatRouteSummary } from "./routing-view.js";
import { fitLine, formatElapsed, statusGlyph, wrapText } from "./text.js";

const SUMMARY_WIDTH = 120;
const MAX_SUMMARY_ROWS = 30;

function boundRows(lines: readonly string[]): string[] {
  const fitted = lines.map((line) => fitLine(line, SUMMARY_WIDTH));
  if (fitted.length <= MAX_SUMMARY_ROWS) return fitted;
  const kept = fitted.slice(0, MAX_SUMMARY_ROWS - 1);
  kept.push(
    fitLine(`… ${fitted.length - kept.length} more lines`, SUMMARY_WIDTH),
  );
  return kept;
}

/** Headless fallback for bare /subagents (the chooser has no meaning). */
export function chooserSummaryText(): string {
  return [
    "Subagents: no interactive UI available.",
    "Use /subagents runs for run status or /subagents agents for routing.",
  ].join("\n");
}

/** Headless fallback for /subagents runs. */
export function runsSummaryText(runs: readonly RunListEntry[]): string {
  if (runs.length === 0) return "No subagent runs in this session.";
  const rows = runs.map((run) => {
    const model = run.model ? ` · ${run.model}` : "";
    return fitLine(
      `${statusGlyph(run.status)} ${run.id} [${run.harness}] ${run.status} ${formatElapsed(run.elapsedMs)}${model} · ${formatRunIdentity(run)}`,
      SUMMARY_WIDTH,
    );
  });
  return boundRows([`Subagent runs (${runs.length}):`, ...rows]).join("\n");
}

/** Headless single-run summary (detail fallback). */
export function runInspectionSummaryText(inspection: RunInspection): string {
  const lines = [
    fitLine(
      `${inspection.id} [${inspection.harness}] ${inspection.status}${inspection.cancelRequested ? " (cancel requested)" : ""} · ${formatElapsed(inspection.elapsedMs)} · ${formatRunIdentity(inspection)}`,
      SUMMARY_WIDTH,
    ),
  ];
  if (inspection.model) lines.push(fitLine(`model: ${inspection.model}`, SUMMARY_WIDTH));
  if (inspection.transcriptDropped > 0) {
    lines.push(`… ${inspection.transcriptDropped} earlier transcript entries`);
  }
  for (const entry of inspection.transcript) {
    switch (entry.kind) {
      case "status": lines.push(fitLine(`• ${entry.text}`, SUMMARY_WIDTH)); break;
      case "user": lines.push(fitLine(`user: ${entry.text}`, SUMMARY_WIDTH)); break;
      case "assistant": lines.push(fitLine(`assistant: ${entry.text}`, SUMMARY_WIDTH)); break;
      case "tool":
        lines.push(fitLine(`tool ${entry.toolName} ${entry.phase}${entry.callId ? ` (${entry.callId})` : ""}`, SUMMARY_WIDTH));
        if (entry.input) lines.push(fitLine(`  input: ${entry.input}`, SUMMARY_WIDTH));
        if (entry.output) lines.push(fitLine(`  output: ${entry.output}`, SUMMARY_WIDTH));
    }
  }
  if (inspection.resultPreview !== undefined) {
    lines.push("output:");
    lines.push(...wrapText(inspection.resultPreview, SUMMARY_WIDTH));
  }
  return boundRows(lines).join("\n");
}

/** Headless fallback for /subagents agents. */
export function agentsSummaryText(
  rows: readonly RoutingAgentRow[],
  projectTrusted: boolean,
): string {
  const header = projectTrusted
    ? `Subagent routing (${rows.length} agents):`
    : `Subagent routing (${rows.length} agents; project untrusted, project scope ignored):`;
  if (rows.length === 0) return "No subagent agents discovered.";
  const body = rows.map((row) =>
    fitLine(
      `${row.name} [${row.definitionScope}] ${formatRouteSummary(row.route)}`,
      SUMMARY_WIDTH,
    ),
  );
  return boundRows([header, ...body]).join("\n");
}
