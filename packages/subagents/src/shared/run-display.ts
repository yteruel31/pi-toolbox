import type { ThinkingLevel } from "./types.js";

/** Format run model metadata, appending thinking only when it is known. */
export function formatRunModel(
  model: string | undefined,
  thinkingLevel: ThinkingLevel | undefined,
  fallback?: string,
): string | undefined {
  const label = model ?? fallback ?? (thinkingLevel ? "parent model" : undefined);
  if (!label) return undefined;
  return thinkingLevel ? `${label} (${thinkingLevel})` : label;
}
