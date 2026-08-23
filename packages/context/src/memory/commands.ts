import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ContextRuntimeController } from "../runtime/context-runtime.js";
import { consolidateMemory } from "./consolidator.js";

export function registerMemoryCommands(
  pi: ExtensionAPI,
  controller: ContextRuntimeController
): void {
  pi.registerCommand("memory-consolidate", {
    description: "Manually trigger persistent memory consolidation",
    handler: async (_args, ctx) => {
      const handle = controller.currentHandle;
      if (!handle) {
        ctx.ui.notify("Memory store not initialized", "warning");
        return;
      }
      ctx.ui.notify("Consolidating memory...", "info");
      try {
        const status = await handle.run(consolidateMemory({ force: true }));
        ctx.ui.notify(
          status.message,
          status.status === "failed" ? "error" : "info"
        );
      } catch (error) {
        ctx.ui.notify(
          `Consolidation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error"
        );
      }
    },
  });
}
