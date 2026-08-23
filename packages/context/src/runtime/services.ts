import { Context, Layer, Semaphore } from "effect";

import type { MemoryStore } from "../memory/store.js";
import type { SessionIndex } from "../sessions/index.js";
import type { SessionSync } from "../sessions/sync.js";

import type { ContextConfig } from "../config/schema.js";
import type { PiModelBridgeApi } from "./pi-model.js";

export class SessionConfig extends Context.Service<
  SessionConfig,
  ContextConfig
>()("@yteruel31/pi-context/runtime/SessionConfig") {}

export class SessionGeneration extends Context.Service<
  SessionGeneration,
  {
    readonly id: number;
    readonly isCurrent: () => boolean;
  }
>()("@yteruel31/pi-context/runtime/SessionGeneration") {}

export class PiModelBridge extends Context.Service<
  PiModelBridge,
  PiModelBridgeApi
>()("@yteruel31/pi-context/runtime/PiModelBridge") {}

export class MemoryStoreService extends Context.Service<
  MemoryStoreService,
  MemoryStore
>()("@yteruel31/pi-context/runtime/MemoryStore") {}

export class SessionIndexService extends Context.Service<
  SessionIndexService,
  SessionIndex
>()("@yteruel31/pi-context/runtime/SessionIndex") {}

export class SessionSyncService extends Context.Service<
  SessionSyncService,
  SessionSync
>()("@yteruel31/pi-context/runtime/SessionSync") {}

export class ModelWorkGate extends Context.Service<
  ModelWorkGate,
  Semaphore.Semaphore
>()("@yteruel31/pi-context/runtime/ModelWorkGate") {}

export const modelWorkGateLayer = Layer.effect(
  ModelWorkGate,
  Semaphore.make(1)
);

export function sessionLayer(
  config: ContextConfig,
  generation: number,
  isCurrent: () => boolean,
  bridge: PiModelBridgeApi
) {
  return Layer.mergeAll(
    Layer.succeed(SessionConfig, config),
    Layer.succeed(SessionGeneration, { id: generation, isCurrent }),
    Layer.succeed(PiModelBridge, bridge)
  );
}
