import { Duration, Effect, Layer, Schedule } from "effect";

import {
  SessionGeneration,
  SessionIndexService,
  SessionSyncService,
} from "../runtime/services.js";
import type { SessionSyncResult } from "./schema.js";

export type SessionSyncStatus = {
  readonly state: "idle" | "syncing" | "ready" | "failed";
  readonly operation?: "sync" | "reindex";
  readonly completedAt?: string;
  readonly diagnostic?: string;
};

export interface SessionSync {
  readonly status: () => SessionSyncStatus;
  readonly sync: () => Promise<SessionSyncResult>;
  readonly reindex: () => Promise<SessionSyncResult>;
}

export interface SessionSyncLayerOptions {
  readonly interval?: Duration.Input;
  readonly now?: () => Date;
}

export function makeSessionSyncLayer(
  options: SessionSyncLayerOptions = {}
) {
  const interval = options.interval ?? "5 minutes";
  const now = options.now ?? (() => new Date());

  const install = Layer.effect(
    SessionSyncService,
    Effect.gen(function* () {
      const index = yield* SessionIndexService;
      const generation = yield* SessionGeneration;
      let status: SessionSyncStatus = { state: "idle" };

      const run = async (operation: "sync" | "reindex") => {
        if (!generation.isCurrent()) {
          throw new Error("Session runtime generation is stale");
        }
        status = { state: "syncing", operation };
        try {
          const value = await (
            operation === "sync" ? index.sync() : index.rebuild()
          );
          status = {
            state: "ready",
            operation,
            completedAt: now().toISOString(),
          };
          return value;
        } catch (cause) {
          status = {
            state: "failed",
            operation,
            diagnostic:
              "Session index operation failed; retry with /session-sync.",
          };
          throw cause;
        }
      };

      return {
        status: () => status,
        sync: () => run("sync"),
        reindex: () => run("reindex"),
      } satisfies SessionSync;
    })
  );

  const background = Layer.effectDiscard(
    Effect.gen(function* () {
      const sync = yield* SessionSyncService;
      const task = Effect.promise(sync.sync).pipe(
        Effect.catch(() => Effect.void),
        Effect.repeat(Schedule.spaced(interval))
      );
      yield* Effect.forkScoped(task);
    })
  );

  return Layer.merge(install, background.pipe(Layer.provide(install)));
}
