import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createContextRuntimeController } from "./runtime/context-runtime.js";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Session lifecycle only; public context tools and commands are added by later units. */
export default function piContextExtension(pi: ExtensionAPI): void {
  const controller = createContextRuntimeController();

  pi.on("session_start", async (_event, ctx) => {
    try {
      await controller.start(ctx);
    } catch (error) {
      ctx.ui.notify(`Context runtime did not start: ${errorMessage(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      await controller.shutdown();
    } catch (error) {
      ctx.ui.notify(`Context runtime shutdown failed: ${errorMessage(error)}`, "error");
    }
  });
}
