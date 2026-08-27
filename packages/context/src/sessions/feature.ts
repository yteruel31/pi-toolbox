import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import type { ContextRuntimeController } from "../runtime/context-runtime.js";
import { SessionIndexService } from "../runtime/services.js";
import { registerSessionCommands } from "./commands.js";
import { injectSessionPrimerOnce } from "./primer.js";
import { registerSessionTools } from "./tools.js";

export function registerSessionFeature(
  pi: ExtensionAPI,
  controller: ContextRuntimeController
): void {
  registerSessionTools(pi, controller);
  registerSessionCommands(pi, controller);
  pi.on("session_start", async (_event, ctx) => {
    const handle = controller.currentHandle;
    if (!handle) return;
    try {
      await handle.run(
        Effect.map(SessionIndexService, (index) =>
          injectSessionPrimerOnce(pi, ctx, index)
        )
      );
    } catch {
      // Session context is optional and must never disable memory.
    }
  });
}
