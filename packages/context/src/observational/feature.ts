import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerObservationalCommands } from "./commands.js";
import { compactObservational } from "./compaction.js";
import type { LedgerEntry } from "./ledger/types.js";
import { registerObservationalTools } from "./tools.js";

export function registerObservationalFeature(pi: ExtensionAPI): void {
  registerObservationalTools(pi);
  registerObservationalCommands(pi);
  pi.on("session_before_compact", (event) => {
    // Validation is deliberately tolerant; programming/invariant errors still propagate.
    const compaction = compactObservational(event.branchEntries as LedgerEntry[], event.preparation);
    return compaction ? { compaction } : undefined;
  });
}
