import type { LedgerEntry, SourceReferences } from "./types.js";

export interface ProjectedSources { entries: LedgerEntry[]; requestedIds: string[]; missingIds: string[]; excludedIds: string[] }
const source = (entry: LedgerEntry) => entry.type === "message" || entry.type === "branch_summary" || entry.type === "custom_message";
export function expandSourceReferences(branch: readonly LedgerEntry[], references: SourceReferences): string[] {
  const indexes = new Map(branch.map((entry, index) => [entry.id, index]));
  const ids = [...references.entryIds];
  for (const range of references.ranges) {
    const start = indexes.get(range.startEntryId), end = indexes.get(range.endEntryId);
    if (start === undefined || end === undefined || start > end) { ids.push(range.startEntryId, range.endEntryId); continue; }
    for (let i = start; i <= end; i++) ids.push(branch[i]!.id);
  }
  return [...new Set(ids)];
}
export function projectSources(branch: readonly LedgerEntry[], references: SourceReferences): ProjectedSources {
  const requestedIds = expandSourceReferences(branch, references);
  const byId = new Map(branch.map((entry) => [entry.id, entry]));
  const entries: LedgerEntry[] = [], missingIds: string[] = [], excludedIds: string[] = [];
  for (const id of requestedIds) {
    const entry = byId.get(id);
    if (!entry) missingIds.push(id);
    else if (!source(entry)) excludedIds.push(id);
    else entries.push(entry);
  }
  return { entries, requestedIds, missingIds, excludedIds };
}
