import { Context, Effect, Layer } from "effect";
import {
  KnowledgeIndexService,
  KnowledgeSyncService,
  SessionGeneration,
} from "../runtime/services.js";
import type { KnowledgeSyncResult } from "./schema.js";

export type KnowledgeSyncStatus = {
  readonly state: "idle" | "syncing" | "ready" | "failed";
  readonly operation?: "sync" | "reindex";
  readonly completedAt?: string;
  readonly diagnostic?: string;
};

export interface KnowledgeSync {
  readonly status: () => KnowledgeSyncStatus;
  readonly sync: () => Promise<KnowledgeSyncResult>;
  readonly reindex: () => Promise<KnowledgeSyncResult>;
}

export function makeKnowledgeSyncLayer(
  options: { readonly now?: () => Date } = {}
) {
  const now = options.now ?? (() => new Date());

  // The release finalizer drains the native Promise queue before the provided
  // KnowledgeIndex layer is finalized. Effect fiber interruption cannot cancel
  // SQLite work already running inside a JavaScript Promise.
  return Layer.effectContext(
    Effect.gen(function* () {
      const index = yield* KnowledgeIndexService;
      const generation = yield* SessionGeneration;
      let status: KnowledgeSyncStatus = { state: "idle" };
      let operation: Promise<void> = Promise.resolve();
      let accepting = true;

      const run = (kind: "sync" | "reindex"): Promise<KnowledgeSyncResult> => {
        if (!accepting) {
          return Promise.reject(
            new Error("Knowledge sync service is shutting down")
          );
        }
        const next = operation.then(async () => {
          if (!accepting || !generation.isCurrent()) {
            throw new Error("Knowledge runtime generation is stale");
          }
          status = { state: "syncing", operation: kind };
          try {
            const result = await (kind === "sync"
              ? index.sync()
              : index.rebuild());
            if (!accepting || !generation.isCurrent()) {
              throw new Error("Knowledge runtime generation is stale");
            }
            status = {
              state: "ready",
              operation: kind,
              completedAt: now().toISOString(),
            };
            return result;
          } catch (error) {
            status = {
              state: "failed",
              operation: kind,
              diagnostic:
                "Knowledge index operation failed; retry with /knowledge-reindex.",
            };
            throw error;
          }
        });
        operation = next.then(
          () => undefined,
          () => undefined
        );
        return next;
      };

      const service: KnowledgeSync = {
        status: () => status,
        sync: () => run("sync"),
        reindex: () => run("reindex"),
      };

      // Queue startup before publishing the service. Its rejection is observed;
      // callers can inspect failed status and retry without an unhandled rejection.
      void service.sync().catch(() => undefined);

      return yield* Effect.acquireRelease(
        Effect.succeed(Context.make(KnowledgeSyncService, service)),
        () =>
          Effect.promise(async () => {
            accepting = false;
            await operation;
          })
      );
    })
  );
}
