import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type { ContextRuntimeController } from "../runtime/context-runtime.js";
import {
  KnowledgeIndexService,
  KnowledgeSyncService,
} from "../runtime/services.js";
import { registerKnowledgeCommands } from "./commands.js";
import { injectKnowledgeOverviewOnce } from "./overview.js";
import { registerKnowledgeTools } from "./tools.js";

export async function knowledgeSessionStart(
  pi: ExtensionAPI,
  controller: ContextRuntimeController,
  ctx: any
): Promise<void> {
  const handle = controller.currentHandle;
  if (!handle) return;
  try {
    await handle.run(
      Effect.flatMap(KnowledgeSyncService, (sync) =>
        Effect.map(KnowledgeIndexService, (index) =>
          injectKnowledgeOverviewOnce(
            pi,
            ctx,
            index,
            sync.status().state === "syncing"
          )
        )
      )
    );
  } catch {
    // Optional local knowledge must not affect memory or session context.
  }
}

export function registerKnowledgeFeature(
  pi: ExtensionAPI,
  controller: ContextRuntimeController,
  registerLifecycle = true
): void {
  registerKnowledgeTools(pi, controller);
  registerKnowledgeCommands(pi, controller);
  if (registerLifecycle)
    pi.on("session_start", async (_event, ctx) =>
      knowledgeSessionStart(pi, controller, ctx)
    );
}
