import type { LedgerEntry, LedgerClocks, Observation, Reflection } from "./types.js";
import { parseLedgerEntry } from "./types.js";

export interface FoldedLedger {
  observations: Observation[];
  reflections: Reflection[];
  droppedIds: Set<string>;
  supersededIds: Set<string>;
  clocks: LedgerClocks;
  throughEntryId?: string;
  malformedCount: number;
  diagnostics: string[];
  pressure: { observationCharacters: number; reflectionCharacters: number };
}
const emptyClocks = (): LedgerClocks => ({ observations: 0, reflections: 0, drops: 0, folds: 0 });
const applyRecords = <T extends { id: string; supersedesIds?: string[] }>(target: Map<string, T>, records: T[], superseded: Set<string>) => {
  for (const record of records) {
    if (!target.has(record.id)) target.set(record.id, record);
    for (const id of record.supersedesIds ?? []) superseded.add(id);
  }
};
/** Pure, ordered fold. Callers must pass only the active branch. */
export function foldLedger(entries: readonly LedgerEntry[]): FoldedLedger {
  let observations = new Map<string, Observation>();
  let reflections = new Map<string, Reflection>();
  let dropped = new Set<string>();
  let superseded = new Set<string>();
  let clocks = emptyClocks();
  let throughEntryId: string | undefined;
  let malformedCount = 0;
  const diagnostics: string[] = [];
  for (const entry of entries) {
    const parsed = parseLedgerEntry(entry);
    if (parsed.malformed) {
      malformedCount++;
      if (diagnostics.length < 8) diagnostics.push(parsed.malformed);
      continue;
    }
    if (!parsed.event) continue;
    const { event } = parsed;
    if (event.kind === "folded") {
      if (event.data.clock <= clocks.folds) continue;
      observations = new Map(event.data.observations.map((item) => [item.id, item]));
      reflections = new Map(event.data.reflections.map((item) => [item.id, item]));
      dropped = new Set(event.data.droppedIds);
      superseded = new Set();
      for (const record of [...event.data.observations, ...event.data.reflections]) {
        for (const id of record.supersedesIds ?? []) superseded.add(id);
      }
      clocks = { ...event.data.clocks, folds: event.data.clock };
      throughEntryId = event.data.throughEntryId;
      continue;
    }
    const clockKey = event.kind === "observations" ? "observations" : event.kind === "reflections" ? "reflections" : "drops";
    if (event.data.clock <= clocks[clockKey]) continue;
    clocks = { ...clocks, [clockKey]: event.data.clock };
    throughEntryId = event.data.throughEntryId;
    if (event.kind === "observations") applyRecords(observations, event.data.records, superseded);
    else if (event.kind === "reflections") applyRecords(reflections, event.data.records, superseded);
    else for (const id of event.data.ids) dropped.add(id);
  }
  const activeObservations = [...observations.values()].filter((item) => !dropped.has(item.id) && !superseded.has(item.id));
  const activeReflections = [...reflections.values()].filter((item) => !superseded.has(item.id));
  return {
    observations: activeObservations,
    reflections: activeReflections,
    droppedIds: dropped,
    supersededIds: superseded,
    clocks,
    throughEntryId,
    malformedCount,
    diagnostics,
    pressure: {
      observationCharacters: activeObservations.reduce((n, item) => n + item.text.length, 0),
      reflectionCharacters: activeReflections.reduce((n, item) => n + item.text.length, 0),
    },
  };
}
