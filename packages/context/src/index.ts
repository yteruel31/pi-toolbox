import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryFeature } from "./memory/feature.js";
import { createContextRuntimeController } from "./runtime/context-runtime.js";

export default function piContextExtension(pi: ExtensionAPI): void {
  const controller = createContextRuntimeController();
  // The guard also keeps lifecycle-only test hosts useful; real Pi always supplies both APIs.
  if (
    typeof pi.registerTool === "function" &&
    typeof pi.registerCommand === "function"
  )
    registerMemoryFeature(pi, controller);
  else {
    pi.on("session_start", async (_event, ctx) => {
      try {
        await controller.start(ctx);
      } catch (error) {
        ctx.ui.notify(
          `Context runtime did not start: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error"
        );
      }
    });
    pi.on("session_shutdown", async (_event, ctx) => {
      try {
        await controller.shutdown();
      } catch (error) {
        ctx.ui.notify(
          `Context runtime shutdown failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "error"
        );
      }
    });
  }
}
