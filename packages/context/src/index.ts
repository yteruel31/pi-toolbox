import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  knowledgeSessionStart,
  registerKnowledgeFeature,
} from "./knowledge/feature.js";
import { registerMemoryFeature } from "./memory/feature.js";
import { registerObservationalFeature } from "./observational/feature.js";
import { createContextRuntimeController } from "./runtime/context-runtime.js";
import { registerSessionFeature } from "./sessions/feature.js";

export function registerContextFeatures(
  pi: ExtensionAPI,
  controller: ReturnType<typeof createContextRuntimeController>
): void {
  // The guard also keeps lifecycle-only test hosts useful; real Pi always supplies both APIs.
  if (
    typeof pi.registerTool === "function" &&
    typeof pi.registerCommand === "function"
  ) {
    registerMemoryFeature(pi, controller);
    // Full Pi hosts expose sendMessage; lifecycle-only compatibility hosts may not.
    if (typeof pi.sendMessage === "function") {
      let sessionStart: any;
      const sessionPi = new Proxy(pi, {
        get(target, property, receiver) {
          if (property === "on") {
            return (name: string, handler: any) => {
              if (name === "session_start") {
                sessionStart = handler;
              } else {
                return target.on(name as any, handler);
              }
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      registerSessionFeature(sessionPi, controller);
      registerKnowledgeFeature(pi, controller, false);
      pi.on("session_start", async (event, ctx) => {
        try {
          await sessionStart?.(event, ctx);
        } catch {
          // Optional session context must not prevent local knowledge context.
        }
        await knowledgeSessionStart(pi, controller, ctx);
      });
    }
    registerObservationalFeature(pi);
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

export default function piContextExtension(pi: ExtensionAPI): void {
  registerContextFeatures(pi, createContextRuntimeController());
}
