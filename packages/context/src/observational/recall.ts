import type { LedgerEntry, Observation, Reflection } from "./ledger/types.js";
import { parseLedgerEntry, MEMORY_ID } from "./ledger/types.js";
import { foldLedger } from "./ledger/fold.js";
import { projectSources } from "./ledger/projection.js";
import { serializeSourceEntries } from "./serialize.js";

export interface RecallDetails { status: "active" | "invalid_id" | "unknown" | "dropped" | "superseded"; id: string; kind?: "observation" | "reflection"; memory?: Observation | Reflection; sourceEntryIds: string[]; missingSourceEntryIds: string[]; excludedSourceEntryIds: string[] }
export interface RecallResult { text: string; details: RecallDetails }
export function recall(branch: readonly LedgerEntry[], id: string): RecallResult {
  const base = { id, sourceEntryIds: [], missingSourceEntryIds: [], excludedSourceEntryIds: [] };
  if (!MEMORY_ID.test(id)) return { text: "Recall requires exactly one 12-character lowercase hexadecimal memory ID.", details: { ...base, status: "invalid_id" } };
  const folded = foldLedger(branch);
  let memory: Observation | Reflection | undefined = folded.observations.find((item) => item.id === id);
  let kind: "observation" | "reflection" | undefined = memory ? "observation" : undefined;
  if (!memory) {
    memory = folded.reflections.find((item) => item.id === id);
    if (memory) kind = "reflection";
  }
  if (!memory) {
    for (const entry of branch) {
      const event = parseLedgerEntry(entry).event;
      if (event?.kind === "observations" || event?.kind === "folded") {
        const found = (event.kind === "observations" ? event.data.records : event.data.observations).find((item) => item.id === id);
        if (found) { memory = found; kind = "observation"; break; }
      }
      if (event?.kind === "reflections" || event?.kind === "folded") {
        const found = (event.kind === "reflections" ? event.data.records : event.data.reflections).find((item) => item.id === id);
        if (found) { memory = found; kind = "reflection"; break; }
      }
    }
  }
  const inactiveStatus = folded.droppedIds.has(id) ? "dropped" : folded.supersededIds.has(id) ? "superseded" : undefined;
  if (inactiveStatus) {
    return { text: `Memory ${id} is ${inactiveStatus} and is not active. Use /om:view full for ledger detail.`, details: { ...base, status: inactiveStatus, ...(kind ? { kind } : {}), ...(memory ? { memory } : {}) } };
  }
  if (!memory || !kind) return { text: `No active observation or reflection ${id} exists on the current branch.`, details: { ...base, status: "unknown" } };
  const projected = projectSources(branch, memory.sources);
  const sources = serializeSourceEntries(projected.entries);
  const missing = projected.missingIds.length ? `\nMissing source entries: ${projected.missingIds.join(", ")}` : "";
  return { text: `${kind === "observation" ? "Observation" : "Reflection"} [${id}] ${memory.text}\n\n${sources || "No renderable source text is available."}${missing}`, details: { status: "active", id, kind, memory, sourceEntryIds: projected.requestedIds, missingSourceEntryIds: projected.missingIds, excludedSourceEntryIds: projected.excludedIds } };
}
