import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const OBSERVATIONS_RECORDED = "context.observations.recorded";
export const REFLECTIONS_RECORDED = "context.reflections.recorded";
export const OBSERVATIONS_DROPPED = "context.observations.dropped";
export const FOLDED = "context.folded";
export const MEMORY_ID = /^[a-f0-9]{12}$/;
export const PRIORITIES = ["low", "medium", "high", "critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface SourceRange { startEntryId: string; endEntryId: string }
export interface SourceReferences { entryIds: string[]; ranges: SourceRange[] }
export interface MemoryRecord {
  id: string;
  timestamp: string;
  priority: Priority;
  text: string;
  sources: SourceReferences;
  supersedesIds?: string[];
}
export interface Observation extends MemoryRecord {}
export interface Reflection extends MemoryRecord { supportingObservationIds: string[] }
export interface LedgerClocks { observations: number; reflections: number; drops: number; folds: number }
export interface RecordedData<T> { version: 1; clock: number; throughEntryId: string; records: T[] }
export interface DroppedData { version: 1; clock: number; throughEntryId: string; ids: string[]; reason?: string }
export interface FoldedData {
  version: 1;
  clock: number;
  throughEntryId: string;
  clocks: LedgerClocks;
  observations: Observation[];
  reflections: Reflection[];
  droppedIds: string[];
}
export type LedgerEntry = SessionEntry | ({ type: string; id: string; parentId?: string | null; timestamp?: string; customType?: string; data?: unknown } & Record<string, unknown>);
export type ParsedLedgerEvent =
  | { kind: "observations"; data: RecordedData<Observation> }
  | { kind: "reflections"; data: RecordedData<Reflection> }
  | { kind: "dropped"; data: DroppedData }
  | { kind: "folded"; data: FoldedData };

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const strings = (v: unknown, allowEmpty = true): v is string[] => Array.isArray(v) && (allowEmpty || v.length > 0) && v.every(string);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const exactKeys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every((key) => allowed.includes(key));
const iso = (v: unknown): v is string => string(v) && !Number.isNaN(Date.parse(v));
const ids = (v: unknown, allowEmpty = true): v is string[] => strings(v, allowEmpty) && v.every((id) => MEMORY_ID.test(id));

export function isSourceReferences(v: unknown): v is SourceReferences {
  if (!object(v) || !exactKeys(v, ["entryIds", "ranges"]) || !strings(v.entryIds) || !Array.isArray(v.ranges)) return false;
  return v.entryIds.length + v.ranges.length > 0 && v.ranges.every((range) => object(range) && exactKeys(range, ["startEntryId", "endEntryId"]) && string(range.startEntryId) && string(range.endEntryId));
}
function isBaseRecord(v: unknown): v is MemoryRecord {
  if (!object(v) || !MEMORY_ID.test(String(v.id)) || !iso(v.timestamp) || !PRIORITIES.includes(v.priority as Priority) || !string(v.text) || /\r|\n/.test(v.text) || v.text.length > 2_000 || !isSourceReferences(v.sources)) return false;
  return v.supersedesIds === undefined || ids(v.supersedesIds);
}
export const isObservation = (v: unknown): v is Observation => isBaseRecord(v) && exactKeys(v as unknown as Record<string, unknown>, ["id", "timestamp", "priority", "text", "sources", "supersedesIds"]);
export const isReflection = (v: unknown): v is Reflection => isBaseRecord(v) && object(v) && ids(v.supportingObservationIds) && exactKeys(v, ["id", "timestamp", "priority", "text", "sources", "supersedesIds", "supportingObservationIds"]);
const isRecorded = <T>(v: unknown, guard: (item: unknown) => item is T, allowEmpty = false): v is RecordedData<T> => object(v) && exactKeys(v, ["version", "clock", "throughEntryId", "records"]) && v.version === 1 && integer(v.clock) && string(v.throughEntryId) && Array.isArray(v.records) && (allowEmpty || v.records.length > 0) && v.records.every(guard);
const isClocks = (v: unknown): v is LedgerClocks => object(v) && exactKeys(v, ["observations", "reflections", "drops", "folds"]) && integer(v.observations) && integer(v.reflections) && integer(v.drops) && integer(v.folds);

export function parseLedgerEntry(entry: LedgerEntry): { event?: ParsedLedgerEvent; malformed?: string } {
  if (entry.type !== "custom") return {};
  const type = entry.customType;
  if (![OBSERVATIONS_RECORDED, REFLECTIONS_RECORDED, OBSERVATIONS_DROPPED, FOLDED].includes(type ?? "")) return {};
  const data = entry.data;
  if (type === OBSERVATIONS_RECORDED && isRecorded(data, isObservation, true)) return { event: { kind: "observations", data } };
  if (type === REFLECTIONS_RECORDED && isRecorded(data, isReflection, true)) return { event: { kind: "reflections", data } };
  if (type === OBSERVATIONS_DROPPED && object(data) && exactKeys(data, ["version", "clock", "throughEntryId", "ids", "reason"]) && data.version === 1 && integer(data.clock) && string(data.throughEntryId) && ids(data.ids) && (data.reason === undefined || string(data.reason))) return { event: { kind: "dropped", data: data as unknown as DroppedData } };
  if (type === FOLDED && object(data) && exactKeys(data, ["version", "clock", "throughEntryId", "clocks", "observations", "reflections", "droppedIds"]) && data.version === 1 && integer(data.clock) && string(data.throughEntryId) && isClocks(data.clocks) && Array.isArray(data.observations) && data.observations.every(isObservation) && Array.isArray(data.reflections) && data.reflections.every(isReflection) && ids(data.droppedIds)) return { event: { kind: "folded", data: data as unknown as FoldedData } };
  return { malformed: `Ignored malformed ${type} entry ${entry.id || "(unknown)"}` };
}
