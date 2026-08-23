import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryFeature } from "./memory/feature.js";
import { createContextRuntimeController } from "./runtime/context-runtime.js";
import { registerSessionFeature } from "./sessions/feature.js";

export default function piContextExtension(pi: ExtensionAPI): void {
  const controller = createContextRuntimeController();
  // The guard also keeps lifecycle-only test hosts useful; real Pi always supplies both APIs.
  if (
    typeof pi.registerTool === "function" &&
    typeof pi.registerCommand === "function"
  ) {
    registerMemoryFeature(pi, controller);
    // Full Pi hosts expose sendMessage; lifecycle-only compatibility hosts may not.
    if (typeof pi.sendMessage === "function") {
      registerSessionFeature(pi, controller);
    }
  } else {
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
