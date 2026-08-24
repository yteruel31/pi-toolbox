import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { foldLedger } from "./ledger/fold.js";
import { ledgerProgress } from "./ledger/progress.js";
import type { LedgerEntry } from "./ledger/types.js";
import { boundText } from "./tokens.js";

const line = (item: { id: string; priority: string; text: string }, full: boolean) => full ? `[${item.id}] [${item.priority}] ${item.text}` : `• ${item.text}`;
export function renderStatus(branch: readonly LedgerEntry[]): string {
  const state = foldLedger(branch), progress = ledgerProgress(branch, state);
  return boundText([
    "Observational memory status",
    `Observations: ${state.observations.length} active`,
    `Reflections: ${state.reflections.length} active`,
    `Dropped: ${state.droppedIds.size}; superseded: ${state.supersededIds.size}; malformed: ${state.malformedCount}`,
    `Clocks: observations=${state.clocks.observations} reflections=${state.clocks.reflections} drops=${state.clocks.drops} folds=${state.clocks.folds}`,
    `Progress: through=${progress.throughEntryId ?? "none"} remaining=${progress.remainingEntries}`,
    `Pressure: observations=${state.pressure.observationCharacters} chars reflections=${state.pressure.reflectionCharacters} chars`,
    ...state.diagnostics.map((item) => `Diagnostic: ${item}`),
  ].join("\n"));
}
export function renderView(branch: readonly LedgerEntry[], full = false): string {
  const state = foldLedger(branch);
  const parts = ["── Reflections ──", ...(state.reflections.length ? state.reflections.map((item) => line(item, full)) : ["No active reflections."]), "", "── Observations ──", ...(state.observations.length ? state.observations.map((item) => line(item, full)) : ["No active observations."])];
  if (full) parts.push("", "── Ledger detail ──", `Dropped IDs: ${[...state.droppedIds].join(", ") || "none"}`, `Superseded IDs: ${[...state.supersededIds].join(", ") || "none"}`, `Malformed entries: ${state.malformedCount}`);
  return boundText(parts.join("\n"));
}
export function registerObservationalCommands(pi: ExtensionAPI): void {
  pi.registerCommand("om:status", { description: "Show observational ledger status", handler: async (_args, ctx) => ctx.ui.notify(renderStatus(ctx.sessionManager.getBranch() as LedgerEntry[]), "info") });
  pi.registerCommand("om:view", { description: "Show active observational memory; pass full for provenance and ledger detail", handler: async (args, ctx) => {
    const mode = args.trim();
    if (mode && mode !== "full") { ctx.ui.notify("Usage: /om:view [full]", "info"); return; }
    ctx.ui.notify(renderView(ctx.sessionManager.getBranch() as LedgerEntry[], mode === "full"), "info");
  } });
}
