import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import type {
  ContextRuntimeController,
  SessionHandle,
} from "../runtime/context-runtime.js";
import { RuntimeInactiveError } from "../runtime/errors.js";
import { MemoryStoreService } from "../runtime/services.js";
import { consolidateMemory, type ConsolidationStatus } from "./consolidator.js";
import { injectMemoryOnce, canonicalProject } from "./injector.js";
import { registerMemoryCommands } from "./commands.js";
import { registerMemoryTools } from "./tools.js";

const MAX_MESSAGE_CHARS = 4_000;
const MAX_EVENT_CHARS = 12_000;

export function extractAgentTranscript(event: AgentEndEvent) {
  const rows: string[] = [];
  const seen = new Set<string>();
  let userCount = 0;
  let total = 0;

  for (const message of event.messages as any[]) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (
      message.customType !== undefined ||
      message.synthetic === true ||
      message.hidden === true
    )
      continue;

    const blocks = Array.isArray(message.content) ? message.content : [];
    const text = blocks
      .filter(
        (block: any) => block?.type === "text" && typeof block.text === "string"
      )
      .map((block: any) => block.text.trim())
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_MESSAGE_CHARS);
    if (!text) continue;

    const row = `${message.role}: ${text}`;
    if (seen.has(row)) continue;
    if (total + row.length > MAX_EVENT_CHARS) break;
    seen.add(row);
    rows.push(row);
    total += row.length;
    if (message.role === "user") userCount += 1;
  }

  return { transcript: rows.join("\n\n"), userCount };
}
async function consolidate(
  handle: SessionHandle
): Promise<ConsolidationStatus> {
  return handle.run(consolidateMemory());
}
export function registerMemoryFeature(
  pi: ExtensionAPI,
  controller: ContextRuntimeController
): void {
  registerMemoryTools(pi, controller);
  registerMemoryCommands(pi, controller);
  pi.on("session_start", async (_event, ctx) => {
    try {
      const handle = await controller.start(ctx);
      try {
        await handle.run(
          Effect.map(MemoryStoreService, (store) =>
            injectMemoryOnce(pi, ctx, store)
          )
        );
      } catch {
        /* optional injection must not disable the runtime */
      }
    } catch (error) {
      ctx.ui.notify(
        `Context runtime did not start: ${
          error instanceof Error ? error.message : String(error)
        }`,
        "error"
      );
    }
  });
  pi.on("agent_end", async (event, ctx) => {
    const handle = controller.currentHandle;
    if (!handle) return;
    const captured = extractAgentTranscript(event);
    if (!captured.transcript) return;
    try {
      await handle.run(
        Effect.map(MemoryStoreService, (s) =>
          s.addPendingEvent(
            ctx.sessionManager.getSessionId(),
            canonicalProject(ctx.cwd),
            captured.transcript,
            captured.userCount
          )
        )
      );
    } catch (error) {
      // Session switches legitimately make captured work stale; active-store failures are diagnostic.
      if (!(error instanceof RuntimeInactiveError)) {
        ctx.ui.notify(
          `Memory event was not persisted: ${
            error instanceof Error ? error.message : String(error)
          }`,
          "warning"
        );
      }
    }
  });
  pi.on("session_before_switch", async (_event, ctx) => {
    const handle = controller.currentHandle;
    if (!handle) return;
    const status = await consolidate(handle).catch(
      (error) =>
        ({ status: "failed", message: String(error) } as ConsolidationStatus)
    );
    if (status.status === "failed")
      ctx.ui.notify(
        `Memory consolidation deferred: ${status.message}`,
        "warning"
      );
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    try {
      const handle = controller.currentHandle;
      if (handle) {
        const status = await consolidate(handle).catch(
          (error) =>
            ({
              status: "failed",
              message: String(error),
            } as ConsolidationStatus)
        );
        if (status.status === "failed") {
          ctx.ui.notify(
            `Memory consolidation deferred: ${status.message}`,
            "warning"
          );
        }
      }
    } finally {
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
    }
  });
}
