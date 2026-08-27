import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import type { ContextRuntimeController } from "../runtime/context-runtime.js";
import {
  SessionIndexService,
  SessionSyncService,
} from "../runtime/services.js";
import type { SessionSyncResult } from "./schema.js";

function summary(result: SessionSyncResult): string {
  return `+${result.added} ~${result.updated} -${result.removed} moved ${result.moved}; ${result.unchanged} unchanged`;
}

export function registerSessionCommands(
  pi: ExtensionAPI,
  controller: ContextRuntimeController
): void {
  const register = (
    name: "session-sync" | "session-reindex",
    rebuild: boolean
  ) =>
    pi.registerCommand(name, {
      description: rebuild
        ? "Force full re-index of all managed session files"
        : "Force an immediate incremental session index sync",
      handler: async (_args, ctx) => {
        const handle = controller.currentHandle;
        if (!handle) {
          ctx.ui.notify("Session index is not ready yet.", "warning");
          return;
        }
        ctx.ui.setStatus(
          "context-sessions",
          rebuild ? "Re-indexing sessions…" : "Syncing sessions…"
        );
        try {
          const result = await handle.run(
            Effect.flatMap(SessionSyncService, (sync) =>
              Effect.promise(rebuild ? sync.reindex : sync.sync)
            )
          );
          const count = await handle.run(
            Effect.map(SessionIndexService, (index) => index.size())
          );
          ctx.ui.notify(
            `${rebuild ? "Re-indexed" : "Synced"}: ${summary(result)} (${count} total)`,
            "info"
          );
        } catch {
          ctx.ui.notify(
            `${rebuild ? "Re-index" : "Sync"} failed; the existing session index remains available.`,
            "error"
          );
        } finally {
          ctx.ui.setStatus("context-sessions", undefined);
        }
      },
    });

  register("session-sync", false);
  register("session-reindex", true);
}
