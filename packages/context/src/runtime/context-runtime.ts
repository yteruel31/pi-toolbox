import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Fiber, Layer, ManagedRuntime } from "effect";

import { loadContextConfig } from "../config/load.js";
import { contextPaths } from "../config/paths.js";
import type { ContextConfig } from "../config/schema.js";
import { knowledgeIndexLayer } from "../knowledge/index.js";
import { makeKnowledgeSyncLayer } from "../knowledge/sync.js";
import { memoryStoreLayer } from "../memory/store.js";
import { makeObservationalCoordinatorLayer, ObservationalCoordinatorService } from "../observational/coordinator.js";
import { sessionIndexLayer } from "../sessions/index.js";
import { makeSessionSyncLayer } from "../sessions/sync.js";
import { ContextStorageError, RuntimeInactiveError } from "./errors.js";
import { makePiModelBridge } from "./pi-model.js";
import {
  KnowledgeIndexService,
  KnowledgeSyncService,
  MemoryStoreService,
  ModelWorkGate,
  SessionIndexService,
  SessionSyncService,
  PiModelBridge,
  SessionConfig,
  SessionGeneration,
  modelWorkGateLayer,
  sessionLayer,
} from "./services.js";

type SessionServices =
  | SessionConfig
  | SessionGeneration
  | PiModelBridge
  | MemoryStoreService
  | KnowledgeIndexService
  | KnowledgeSyncService
  | SessionIndexService
  | SessionSyncService
  | ModelWorkGate
  | ObservationalCoordinatorService;
type Runtime = ManagedRuntime.ManagedRuntime<
  SessionServices,
  ContextStorageError
>;

export interface SessionHandle {
  readonly generation: number;
  readonly config: ContextConfig;
  readonly runtime: Runtime;
  readonly isCurrent: () => boolean;
  guard<A extends Array<unknown>>(
    callback: (...args: A) => void
  ): (...args: A) => boolean;
  run<A, E>(effect: Effect.Effect<A, E, SessionServices>): Promise<A>;
}

export interface ContextRuntimeController {
  readonly activeGeneration: number | undefined;
  readonly currentHandle: SessionHandle | undefined;
  start(ctx: ExtensionContext): Promise<SessionHandle>;
  shutdown(): Promise<void>;
}

export function createContextRuntimeController(
  options: {
    readonly agentDir?: string;
    readonly pi?: ExtensionAPI;
    /** Test/integration hook represented as a scoped Layer resource. */
    readonly onDispose?: () => void;
  } = {}
): ContextRuntimeController {
  let generation = 0;
  let active:
    | {
        generation: number;
        runtime: Runtime;
        accepting: boolean;
        handle?: SessionHandle;
      }
    | undefined;
  let operation = Promise.resolve();

  const enqueue = <A>(work: () => Promise<A>): Promise<A> => {
    const result = operation.then(work, work);
    operation = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  };

  const shutdownActive = async (): Promise<void> => {
    const previous = active;
    if (previous === undefined) return;
    previous.accepting = false;
    active = undefined;
    await previous.runtime.dispose();
  };

  return {
    get activeGeneration() {
      return active?.generation;
    },
    get currentHandle() {
      return active?.handle;
    },
    start: (ctx) =>
      enqueue(async () => {
        await shutdownActive();
        const id = ++generation;
        const config = await Effect.runPromise(
          loadContextConfig(contextPaths(options.agentDir).config)
        );
        const state: {
          generation: number;
          runtime: Runtime;
          accepting: boolean;
          handle?: SessionHandle;
        } = {
          generation: id,
          runtime: undefined as unknown as Runtime,
          accepting: true,
        };
        const isCurrent = () => active === state && state.accepting;
        const resources =
          options.onDispose === undefined
            ? Layer.empty
            : Layer.effectDiscard(
                Effect.acquireRelease(
                  Effect.sync(() => Effect.runFork(Effect.never)),
                  (fiber) =>
                    Fiber.interrupt(fiber).pipe(
                      Effect.andThen(Effect.sync(options.onDispose!))
                    )
                )
              );
        const paths = contextPaths(options.agentDir);
        const agentDir = options.agentDir ?? path.dirname(paths.root);
        const base = Layer.mergeAll(
          sessionLayer(config, id, isCurrent, makePiModelBridge(ctx, config)),
          memoryStoreLayer(paths.memoryDb),
          knowledgeIndexLayer(paths.knowledgeDb, config.knowledge),
          sessionIndexLayer(paths.sessionsDb, agentDir),
          modelWorkGateLayer,
          resources
        );
        const coordinator = options.pi === undefined
          ? Layer.succeed(ObservationalCoordinatorService, { offer: () => false, status: () => ({ state: "idle" as const }), hasState: () => false })
          : makeObservationalCoordinatorLayer(options.pi, ctx).pipe(Layer.provide(base));
        const runtime = ManagedRuntime.make(
          Layer.mergeAll(
            base,
            makeSessionSyncLayer().pipe(Layer.provide(base)),
            makeKnowledgeSyncLayer().pipe(Layer.provide(base)),
            coordinator
          )
        );
        state.runtime = runtime;
        active = state;
        // Build the Layer now: session resources must begin during session_start, not on first later use.
        await runtime.runPromise(Effect.void);

        const guard =
          <A extends Array<unknown>>(callback: (...args: A) => void) =>
          (...args: A): boolean => {
            if (!isCurrent()) return false;
            callback(...args);
            return true;
          };

        const handle: SessionHandle = {
          generation: id,
          config,
          runtime,
          isCurrent,
          guard,
          run: async <A, E>(effect: Effect.Effect<A, E, SessionServices>) => {
            if (!isCurrent()) {
              throw new RuntimeInactiveError({
                generation: id,
                message: `Context runtime generation ${id} is no longer active`,
              });
            }
            const value = await runtime.runPromise(effect);
            if (!isCurrent()) {
              throw new RuntimeInactiveError({
                generation: id,
                message: `Context runtime generation ${id} became stale`,
              });
            }
            return value;
          },
        };
        state.handle = handle;
        return handle;
      }),
    shutdown: () => enqueue(shutdownActive),
  };
}
