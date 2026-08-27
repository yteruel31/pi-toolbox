import type { LedgerEntry } from "./types.js";
import type { FoldedLedger } from "./fold.js";

export interface LedgerProgress { throughEntryId?: string; throughIndex: number; remainingEntries: number; clocks: FoldedLedger["clocks"] }
export function ledgerProgress(branch: readonly LedgerEntry[], folded: FoldedLedger): LedgerProgress {
  const throughIndex = folded.throughEntryId ? branch.findIndex((entry) => entry.id === folded.throughEntryId) : -1;
  return { throughEntryId: folded.throughEntryId, throughIndex, remainingEntries: Math.max(0, branch.length - throughIndex - 1), clocks: { ...folded.clocks } };
}
