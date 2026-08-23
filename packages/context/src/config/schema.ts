import { Schema } from "effect";

export const CONTEXT_CONFIG_VERSION = 1 as const;
export const MODEL_ROLES = ["observer", "reflector", "dropper", "consolidation"] as const;
export type ModelRole = (typeof MODEL_ROLES)[number];

const ThinkingLevelSchema = Schema.Literals(["minimal", "low", "medium", "high", "xhigh", "max"]);
export type ThinkingLevel = typeof ThinkingLevelSchema.Type;

export const ModelRouteSchema = Schema.Struct({
  provider: Schema.String,
  model: Schema.String,
  thinkingLevel: Schema.optionalKey(ThinkingLevelSchema),
});
export type ModelRoute = typeof ModelRouteSchema.Type;

export const ContextConfigSchema = Schema.Struct({
  version: Schema.Literal(CONTEXT_CONFIG_VERSION),
  models: Schema.Struct({
    observer: Schema.optionalKey(ModelRouteSchema),
    reflector: Schema.optionalKey(ModelRouteSchema),
    dropper: Schema.optionalKey(ModelRouteSchema),
    consolidation: Schema.optionalKey(ModelRouteSchema),
  }),
});
export type ContextConfig = typeof ContextConfigSchema.Type;

/** Defaults for a fresh installation: every worker role follows Pi's active model and thinking level. */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = { version: CONTEXT_CONFIG_VERSION, models: {} };
