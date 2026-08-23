import type { AssistantMessage, Context as ModelContext, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import type { ContextConfig, ModelRole, ThinkingLevel } from "../config/schema.js";
import { ModelCompletionError, ModelResolutionError } from "./errors.js";

export interface ResolvedRoleModel {
  readonly model: Model<any>;
  readonly thinkingLevel?: ThinkingLevel;
}

export interface PiModelBridgeApi {
  resolve(role: ModelRole): Effect.Effect<ResolvedRoleModel, ModelResolutionError>;
  complete(
    role: ModelRole,
    context: ModelContext,
    options?: ModelsApiStreamOptions<any>,
  ): Effect.Effect<AssistantMessage, ModelResolutionError | ModelCompletionError>;
}

/** Creates a session-confined bridge; registry, active model, and auth remain owned by Pi. */
export function makePiModelBridge(ctx: ExtensionContext, config: ContextConfig): PiModelBridgeApi {
  const resolve = Effect.fn("PiModelBridge.resolve")(function*(role: ModelRole) {
    const route = config.models[role];
    if (route !== undefined) {
      const model = ctx.modelRegistry.find(route.provider, route.model);
      if (model === undefined) {
        return yield* new ModelResolutionError({
          role,
          message: `Configured ${role} model ${route.provider}/${route.model} is not registered in this Pi session`,
        });
      }
      return { model, ...(route.thinkingLevel === undefined ? {} : { thinkingLevel: route.thinkingLevel }) };
    }
    if (ctx.model === undefined) {
      return yield* new ModelResolutionError({ role, message: `No ${role} model is configured and Pi has no active model` });
    }
    return {
      model: ctx.model,
      ...(ctx.thinkingLevel === undefined || ctx.thinkingLevel === "off" ? {} : { thinkingLevel: ctx.thinkingLevel }),
    };
  });

  const complete = Effect.fn("PiModelBridge.complete")(function*(
    role: ModelRole,
    context: ModelContext,
    options?: ModelsApiStreamOptions<any>,
  ) {
    const resolved = yield* resolve(role);
    const completionOptions = resolved.thinkingLevel === undefined
      ? options
      : { ...options, reasoning: resolved.thinkingLevel };
    return yield* Effect.tryPromise({
      try: () => ctx.modelRegistry.complete(resolved.model, context, completionOptions),
      catch: (cause) => new ModelCompletionError({ role, message: `Pi model completion failed for ${role}`, cause }),
    });
  });

  return { resolve, complete };
}
