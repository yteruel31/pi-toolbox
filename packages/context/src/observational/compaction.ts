import type { LedgerEntry } from "./ledger/types.js";
import { foldLedger } from "./ledger/fold.js";
import { boundText, PI_MAX_BYTES } from "./tokens.js";

export interface PreparedCompaction { previousSummary?: string; firstKeptEntryId: string; tokensBefore: number; fileOps?: unknown }
export function renderMemorySummary(branch: readonly LedgerEntry[]): { summary: string; details: Record<string, unknown> } | undefined {
  const state = foldLedger(branch);
  if (!state.observations.length && !state.reflections.length) return undefined;
  const rows = ["<observational-memory version=\"1\">", "## Reflections", ...state.reflections.map((item) => `[${item.id}] [${item.priority}] ${item.text}`), "", "## Observations", ...state.observations.map((item) => `[${item.id}] ${item.timestamp} [${item.priority}] ${item.text}`), "</observational-memory>"];
  const summary = boundText(rows.join("\n"), Math.floor(PI_MAX_BYTES / 2), 1_000, "\n… [observational memory truncated]\n</observational-memory>");
  return { summary, details: { version: 1, clocks: state.clocks, throughEntryId: state.throughEntryId, droppedCount: state.droppedIds.size, malformedCount: state.malformedCount } };
}
export function compactObservational(branch: readonly LedgerEntry[], preparation: PreparedCompaction) {
  const rendered = renderMemorySummary(branch);
  if (!rendered) return undefined;
  const rawPrevious = typeof preparation.previousSummary === "string" ? preparation.previousSummary.trim() : "";
  const previous = rawPrevious ? boundText(rawPrevious, Math.floor(PI_MAX_BYTES / 2) - 128, 995) : "";
  const summary = `<context-compaction>\n${[previous, rendered.summary].filter(Boolean).join("\n\n")}\n</context-compaction>`;
  return { summary, firstKeptEntryId: preparation.firstKeptEntryId, tokensBefore: preparation.tokensBefore, details: { ...(preparation.fileOps && typeof preparation.fileOps === "object" ? preparation.fileOps as object : {}), observational: rendered.details } };
}
