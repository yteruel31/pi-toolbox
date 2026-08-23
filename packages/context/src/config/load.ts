import { readFile } from "node:fs/promises";

import { Effect, Schema } from "effect";

import { ContextConfigError } from "../runtime/errors.js";
import { ContextConfigSchema, DEFAULT_CONTEXT_CONFIG, type ContextConfig } from "./schema.js";

const decodeConfig = Schema.decodeUnknownEffect(ContextConfigSchema, { onExcessProperty: "error" });

export const loadContextConfig = Effect.fn("loadContextConfig")(function*(configPath: string) {
  const text = yield* Effect.tryPromise({
    try: () => readFile(configPath, "utf8"),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return Effect.succeed(undefined);
      return Effect.fail(new ContextConfigError({ path: configPath, message: `Cannot read context config at ${configPath}`, cause }));
    }),
  );
  if (text === undefined) return DEFAULT_CONTEXT_CONFIG;

  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch (cause) {
    return yield* new ContextConfigError({ path: configPath, message: `Context config at ${configPath} is not valid JSON`, cause });
  }

  return yield* decodeConfig(input).pipe(
    Effect.mapError((cause) => new ContextConfigError({
      path: configPath,
      message: `Context config at ${configPath} is malformed or uses an unsupported version; expected version 1: ${String(cause)}`,
      cause,
    })),
  );
}) as (configPath: string) => Effect.Effect<ContextConfig, ContextConfigError>;
