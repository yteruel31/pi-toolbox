import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { ContextRuntimeController } from "../runtime/context-runtime.js";
import { ObservationalCoordinatorService } from "./coordinator.js";
import { registerObservationalCommands } from "./commands.js";
import { compactObservational } from "./compaction.js";
import type { LedgerEntry } from "./ledger/types.js";
import { registerObservationalTools } from "./tools.js";

export function registerObservationalFeature(pi: ExtensionAPI, controller?: ContextRuntimeController): void {
  registerObservationalTools(pi);
  registerObservationalCommands(pi);
  pi.on("session_before_compact", (event) => {
    const compaction = compactObservational(event.branchEntries as LedgerEntry[], event.preparation);
    return compaction ? { compaction } : undefined;
  });
  if (controller === undefined) return;
  pi.on("turn_end", () => {
    const handle = controller.currentHandle;
    if (handle) void handle.run(Effect.gen(function*() { (yield* ObservationalCoordinatorService).offer(); })).catch(() => undefined);
  });
  let compactingGeneration: number | undefined;
  pi.on("agent_settled", (_event, ctx) => {
    const handle = controller.currentHandle;
    if (!handle || compactingGeneration === handle.generation || !ctx.isIdle() || ctx.hasPendingMessages() || (ctx.getContextUsage()?.percent ?? 0) < 82) return;
    void handle.run(Effect.gen(function*() { return (yield* ObservationalCoordinatorService).hasState(); })).then((hasState) => {
      if (!hasState || !handle.isCurrent() || controller.currentHandle !== handle || compactingGeneration === handle.generation) return;
      compactingGeneration = handle.generation;
      const reset = () => { if (compactingGeneration === handle.generation) compactingGeneration = undefined; };
      try { ctx.compact({ onComplete: reset, onError: reset }); } catch { reset(); }
    }).catch(() => undefined);
  });
}
