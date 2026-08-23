import { Context, Layer } from "effect";

import type { ContextConfig } from "../config/schema.js";
import type { PiModelBridgeApi } from "./pi-model.js";

export class SessionConfig extends Context.Service<SessionConfig, ContextConfig>()(
  "@yteruel31/pi-context/runtime/SessionConfig",
) {}

export class SessionGeneration extends Context.Service<SessionGeneration, {
  readonly id: number;
  readonly isCurrent: () => boolean;
}>()("@yteruel31/pi-context/runtime/SessionGeneration") {}

export class PiModelBridge extends Context.Service<PiModelBridge, PiModelBridgeApi>()(
  "@yteruel31/pi-context/runtime/PiModelBridge",
) {}

export function sessionLayer(config: ContextConfig, generation: number, isCurrent: () => boolean, bridge: PiModelBridgeApi) {
  return Layer.mergeAll(
    Layer.succeed(SessionConfig, config),
    Layer.succeed(SessionGeneration, { id: generation, isCurrent }),
    Layer.succeed(PiModelBridge, bridge),
  );
}
