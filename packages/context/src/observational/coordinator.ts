import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer, Queue } from "effect";
import { ModelWorkGate, PiModelBridge, SessionGeneration } from "../runtime/services.js";
import { runDropper } from "./agents/dropper.js";
import { runObserver, type ObserverSource } from "./agents/observer.js";
import { runReflector } from "./agents/reflector.js";
import { foldLedger, type FoldedLedger } from "./ledger/fold.js";
import { FOLDED, OBSERVATIONS_DROPPED, OBSERVATIONS_RECORDED, REFLECTIONS_RECORDED, parseLedgerEntry, type LedgerEntry, type Observation, type Reflection } from "./ledger/types.js";

export interface CoordinatorThresholds { observerSources: number; reflectorCount: number; reflectorCharacters: number; dropperCount: number; dropperCharacters: number; foldEvents: number }
export const defaultCoordinatorThresholds: CoordinatorThresholds = { observerSources: 1, reflectorCount: 8, reflectorCharacters: 6 * 1024, dropperCount: 40, dropperCharacters: 20 * 1024, foldEvents: 128 };
export interface CoordinatorStatus { state: "idle" | "running" | "failed"; lastErrorCategory?: "model" | "validation" | "append"; startedAt?: number; finishedAt?: number }
export interface ObservationalCoordinator { offer(): boolean; status(): CoordinatorStatus; hasState(): boolean }

const MAX_SOURCE_CHARS = 8_000;
const MAX_BATCH_CHARS = 40_000;
const messageText = (entry: any): string => {
  if (entry.hidden || entry.synthetic || entry.customType || entry.message?.hidden || entry.message?.synthetic || entry.message?.customType) return "";
  const content = entry.message?.content;
  if (typeof content === "string") return content.slice(0, MAX_SOURCE_CHARS);
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").slice(0, MAX_SOURCE_CHARS);
};

export function observationProgress(branch: readonly LedgerEntry[]): { clock: number; throughEntryId?: string } {
  let clock = 0; let throughEntryId: string | undefined;
  for (const entry of branch) {
    const event = parseLedgerEntry(entry).event;
    if (event?.kind === "folded" && event.data.clocks.observations > clock) { clock = event.data.clocks.observations; throughEntryId = event.data.throughEntryId; }
    if (event?.kind === "observations" && event.data.clock > clock) { clock = event.data.clock; throughEntryId = event.data.throughEntryId; }
  }
  return { clock, throughEntryId };
}

export function selectObserverSources(branch: readonly any[], throughEntryId?: string): ObserverSource[] {
  const position = throughEntryId ? branch.findIndex((entry) => entry.id === throughEntryId) : -1;
  const selected: ObserverSource[] = []; let characters = 0;
  for (const entry of branch.slice(position + 1)) {
    if (selected.length === 64) break;
    if (entry.type !== "message" || !["user", "assistant"].includes(entry.message?.role)) continue;
    const text = messageText(entry);
    if (!text) continue;
    const bounded = text.slice(0, Math.max(0, MAX_BATCH_CHARS - characters));
    if (!bounded) break;
    selected.push({ id: entry.id, role: entry.message.role, text: bounded });
    characters += bounded.length;
    if (characters >= MAX_BATCH_CHARS) break;
  }
  return selected;
}

const eventsSinceFold = (branch: readonly any[]) => {
  const lastFold = branch.findLastIndex((entry) => entry.type === "custom" && entry.customType === FOLDED);
  return branch.slice(lastFold + 1).filter((entry) => entry.type === "custom" && [OBSERVATIONS_RECORDED, REFLECTIONS_RECORDED, OBSERVATIONS_DROPPED].includes(entry.customType)).length;
};
const uniqueRecords = <T extends { id: string }>(records: readonly T[], existing: readonly { id: string }[]) => {
  const ids = new Set(existing.map((record) => record.id));
  return records.filter((record) => !ids.has(record.id) && Boolean(ids.add(record.id)));
};
const category = (error: unknown): "model" | "validation" | "append" => String(error).toLowerCase().includes("validation") ? "validation" : String(error).toLowerCase().includes("append") ? "append" : "model";

export interface ProcessOnceOptions {
  branch(): LedgerEntry[];
  append(type: string, data: unknown): boolean;
  isAccepting(): boolean;
  runObserver(sources: readonly ObserverSource[]): Effect.Effect<Observation[], unknown>;
  runReflector(observations: readonly Observation[], reflections: readonly Reflection[]): Effect.Effect<Reflection[], unknown>;
  runDropper(observations: readonly Observation[]): Effect.Effect<string[], unknown>;
  thresholds: CoordinatorThresholds;
  reoffer(): void;
}

export const processObservationalOnce = Effect.fn("processObservationalOnce")(function*(options: ProcessOnceOptions) {
  const append = (type: string, data: unknown) => Effect.try({ try: () => {
    if (!options.isAccepting()) return false;
    if (!options.append(type, data)) throw new Error("append rejected");
    return true;
  }, catch: (cause) => new Error(`append failed: ${String(cause)}`) });
  let currentBranch = options.branch();
  const progress = observationProgress(currentBranch);
  const sources = selectObserverSources(currentBranch, progress.throughEntryId);
  if (sources.length >= options.thresholds.observerSources) {
    const batchThroughEntryId = sources.at(-1)!.id;
    const records = yield* options.runObserver(sources);
    currentBranch = options.branch();
    const latestProgress = observationProgress(currentBranch);
    const ids = new Set(currentBranch.map((entry) => entry.id));
    if (latestProgress.clock === progress.clock && latestProgress.throughEntryId === progress.throughEntryId && sources.every((source) => ids.has(source.id))) {
      const latest = foldLedger(currentBranch);
      yield* append(OBSERVATIONS_RECORDED, { version: 1, clock: latest.clocks.observations + 1, throughEntryId: batchThroughEntryId, records: uniqueRecords(records, latest.observations) });
      if (selectObserverSources(options.branch(), batchThroughEntryId).length > 0) options.reoffer();
    }
  }
  let state = foldLedger(options.branch());
  if ((state.observations.length >= options.thresholds.reflectorCount || state.pressure.observationCharacters >= options.thresholds.reflectorCharacters) && state.clocks.observations > state.clocks.reflections) {
    const startedClock = state.clocks.reflections;
    const records = yield* options.runReflector(state.observations, state.reflections);
    const latest = foldLedger(options.branch());
    if (latest.clocks.reflections === startedClock && latest.clocks.observations >= state.clocks.observations && latest.throughEntryId) yield* append(REFLECTIONS_RECORDED, { version: 1, clock: latest.clocks.reflections + 1, throughEntryId: latest.throughEntryId, records: uniqueRecords(records, latest.reflections) });
  }
  state = foldLedger(options.branch());
  if ((state.observations.length >= options.thresholds.dropperCount || state.pressure.observationCharacters >= options.thresholds.dropperCharacters) && state.clocks.observations > state.clocks.drops) {
    const startedClock = state.clocks.drops;
    const ids = [...new Set(yield* options.runDropper(state.observations))];
    const latest = foldLedger(options.branch());
    if (latest.clocks.drops === startedClock && latest.throughEntryId) yield* append(OBSERVATIONS_DROPPED, { version: 1, clock: latest.clocks.drops + 1, throughEntryId: latest.throughEntryId, ids: ids.filter((id) => latest.observations.some((record) => record.id === id)) });
  }
  state = foldLedger(options.branch());
  if (eventsSinceFold(options.branch()) >= options.thresholds.foldEvents && state.throughEntryId) yield* append(FOLDED, { version: 1, clock: state.clocks.folds + 1, throughEntryId: state.throughEntryId, clocks: state.clocks, observations: state.observations, reflections: state.reflections, droppedIds: [...state.droppedIds] });
});

export function makeObservationalCoordinatorLayer(pi: ExtensionAPI, ctx: ExtensionContext, thresholds: Partial<CoordinatorThresholds> = {}) {
  return Layer.effect(ObservationalCoordinatorService, Effect.gen(function*() {
    const queue = yield* Queue.sliding<void>(1); const bridge = yield* PiModelBridge; const gate = yield* ModelWorkGate; const generation = yield* SessionGeneration;
    const limits = { ...defaultCoordinatorThresholds, ...thresholds }; let accepting = true; let current: CoordinatorStatus = { state: "idle" };
    const branch = () => ctx.sessionManager.getBranch() as LedgerEntry[];
    const offer = () => accepting && generation.isCurrent() && Queue.offerUnsafe(queue, undefined);
    const process = processObservationalOnce({ branch, append: (type, data) => { if (!accepting || !generation.isCurrent()) return false; pi.appendEntry(type, data); return true; }, isAccepting: () => accepting && generation.isCurrent(), runObserver: (sources) => runObserver(bridge, sources), runReflector: (observations, reflections) => runReflector(bridge, observations, reflections), runDropper: (observations) => runDropper(bridge, observations), thresholds: limits, reoffer: () => { offer(); } });
    const guarded = gate.withPermits(1)(Effect.gen(function*() { current = { state: "running", startedAt: Date.now() }; yield* process; current = { state: "idle", startedAt: current.startedAt, finishedAt: Date.now() }; })).pipe(Effect.catch((error) => Effect.sync(() => { current = { state: "failed", lastErrorCategory: category(error), finishedAt: Date.now() }; })));
    yield* Effect.forever(Queue.take(queue).pipe(Effect.andThen(guarded))).pipe(Effect.forkScoped);
    yield* Effect.addFinalizer(() => Effect.sync(() => { accepting = false; }).pipe(Effect.andThen(Queue.shutdown(queue)), Effect.asVoid));
    return { offer, status: () => ({ ...current }), hasState: () => { const state = foldLedger(branch()); return state.observations.length + state.reflections.length > 0; } };
  }));
}
export class ObservationalCoordinatorService extends Context.Service<ObservationalCoordinatorService, ObservationalCoordinator>()("@yteruel31/pi-context/observational/Coordinator") {}
