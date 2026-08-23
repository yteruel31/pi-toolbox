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

const positiveInteger = (maximum: number) => Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(maximum),
);

export const DEFAULT_KNOWLEDGE_CONFIG = {
  roots: [] as readonly string[],
  extensions: ["md", "mdx", "txt"] as readonly string[],
  excludes: ["node_modules", ".git"] as readonly string[],
  limits: {
    maxRoots: 16,
    maxFiles: 10_000,
    maxDepth: 24,
    maxFileBytes: 2 * 1024 * 1024,
    maxTotalBytes: 128 * 1024 * 1024,
  },
} as const;

const KnowledgeLimitsSchema = Schema.Struct({
  maxRoots: positiveInteger(64),
  maxFiles: positiveInteger(100_000),
  maxDepth: positiveInteger(128),
  maxFileBytes: positiveInteger(16 * 1024 * 1024),
  maxTotalBytes: positiveInteger(1024 * 1024 * 1024),
});

export const KnowledgeConfigSchema = Schema.Struct({
  roots: Schema.Array(Schema.String),
  extensions: Schema.Array(Schema.String),
  excludes: Schema.Array(Schema.String),
  limits: KnowledgeLimitsSchema,
});
export type KnowledgeConfig = typeof KnowledgeConfigSchema.Type;

export const ContextConfigSchema = Schema.Struct({
  version: Schema.Literal(CONTEXT_CONFIG_VERSION),
  models: Schema.Struct({
    observer: Schema.optionalKey(ModelRouteSchema),
    reflector: Schema.optionalKey(ModelRouteSchema),
    dropper: Schema.optionalKey(ModelRouteSchema),
    consolidation: Schema.optionalKey(ModelRouteSchema),
  }),
  knowledge: KnowledgeConfigSchema,
});
export type ContextConfig = typeof ContextConfigSchema.Type;

/** Defaults for a fresh installation: no filesystem roots are scanned. */
export const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  version: CONTEXT_CONFIG_VERSION,
  models: {},
  knowledge: DEFAULT_KNOWLEDGE_CONFIG,
};
