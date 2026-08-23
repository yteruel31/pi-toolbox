import { Schema } from "effect";

export class ContextConfigError extends Schema.TaggedError<ContextConfigError>()("ContextConfigError", {
  path: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

export class ModelResolutionError extends Schema.TaggedError<ModelResolutionError>()("ModelResolutionError", {
  role: Schema.String,
  message: Schema.String,
}) {}

export class ModelCompletionError extends Schema.TaggedError<ModelCompletionError>()("ModelCompletionError", {
  role: Schema.String,
  message: Schema.String,
  cause: Schema.Unknown,
}) {}

export class RuntimeInactiveError extends Schema.TaggedError<RuntimeInactiveError>()("RuntimeInactiveError", {
  generation: Schema.Number,
  message: Schema.String,
}) {}

export class ContextStorageError extends Schema.TaggedError<ContextStorageError>()("ContextStorageError", {
  path: Schema.String,
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}

export class ContextPathError extends Schema.TaggedError<ContextPathError>()("ContextPathError", {
  root: Schema.String,
  candidate: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Unknown),
}) {}
