import type { HarnessKind, ThinkingLevel } from "../shared/types.js";
import type {
  ResolvedRoute,
  RouteFieldProvenance,
  RouteMode,
  RouteResolutionInput,
  RouteResolver,
  RoutingEntry,
} from "./types.js";

export const ROUTE_MODES: readonly RouteMode[] = ["auto", "inherit"];

/** Exact bare lowercase modes only; `Auto` or `openrouter/auto` stay literal. */
export function isRouteMode(value: unknown): value is RouteMode {
  return value === "auto" || value === "inherit";
}

/**
 * Boundary normalization for a configured model value, matching profile
 * frontmatter: surrounding whitespace is dropped before mode detection, while
 * case and qualified ids such as `openrouter/auto` stay literal. Undefined for
 * a non-string or blank value.
 */
export function normalizeRouteModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Outcome of walking one field's layers from highest to lowest precedence.
 * `default` means no layer set the field, so it falls to parent/backend defaults.
 */
export type RouteFieldChoice<T> =
  | { kind: "value"; value: T; provenance: RouteFieldProvenance }
  | { kind: RouteMode; provenance: RouteFieldProvenance }
  | { kind: "default"; provenance: "parent" };

type RouteField = "harness" | "model" | "thinking";

/** Harness choice: explicit > trusted project > user > legacy saved > profile. */
export function resolveHarnessChoice(input: RouteResolutionInput): RouteFieldChoice<HarnessKind> {
  return walk<HarnessKind>(input, "harness", input.agent?.defaults.harness);
}

/** Model choice with the same precedence as the harness. */
export function resolveModelChoice(input: RouteResolutionInput): RouteFieldChoice<string> {
  return walk<string>(input, "model", input.agent?.defaults.model);
}

/**
 * Thinking choice for a concrete backend. Only the profile layer is
 * backend-dependent: a Claude route prefers profile `effort` over `thinking`.
 */
export function resolveThinkingChoice(
  input: RouteResolutionInput,
  harness: HarnessKind,
): RouteFieldChoice<ThinkingLevel> {
  const defaults = input.agent?.defaults;
  const profile = harness === "claude" && defaults?.effort !== undefined
    ? defaults.effort
    : defaults?.thinking;
  return walk<ThinkingLevel>(input, "thinking", profile);
}

/** `inherit` semantics: parent values on Pi, SDK defaults (omitted) on Claude. */
export function inheritedModel(input: RouteResolutionInput, harness: HarnessKind): string | undefined {
  return harness === "pi" ? input.parent.model : undefined;
}

export function inheritedThinking(input: RouteResolutionInput, harness: HarnessKind): ThinkingLevel | undefined {
  return harness === "pi" ? input.parent.thinking : undefined;
}

/**
 * Pure route resolution with exact, per-field precedence and provenance.
 * Modes never reach the result as literals: `inherit` and `auto` both resolve
 * to the backend-dependent inherited value; Jev may later replace `auto` fields.
 */
export class DefaultRouteResolver implements RouteResolver {
  resolve(input: RouteResolutionInput): ResolvedRoute {
    const harness = resolveHarnessChoice(input);
    const harnessValue = harness.kind === "value" ? harness.value : "pi";
    const model = resolveModelChoice(input);
    const thinking = resolveThinkingChoice(input, harnessValue);

    const modes: NonNullable<ResolvedRoute["modes"]> = {};
    if (isRouteMode(harness.kind)) modes.harness = harness.kind;
    if (isRouteMode(model.kind)) modes.model = model.kind;
    if (isRouteMode(thinking.kind)) modes.thinking = thinking.kind;

    return {
      harness: harnessValue,
      model: model.kind === "value" ? model.value : inheritedModel(input, harnessValue),
      thinking: thinking.kind === "value" ? thinking.value : inheritedThinking(input, harnessValue),
      provenance: {
        harness: harness.provenance,
        model: model.provenance,
        thinking: thinking.provenance,
      },
      ...(Object.keys(modes).length > 0 ? { modes } : {}),
    };
  }
}

export const routeResolver: RouteResolver = new DefaultRouteResolver();

function walk<T>(
  input: RouteResolutionInput,
  field: RouteField,
  profile: unknown,
): RouteFieldChoice<T> {
  const layers: Array<[Pick<RoutingEntry, RouteField> | undefined, RouteFieldProvenance]> = [
    [input.explicit, "explicit"],
    [input.projectRouting, "saved-project"],
    [input.userRouting, "saved-user"],
    [input.savedRouting, input.savedRoutingProvenance?.[field] ?? "saved-user"],
  ];
  for (const [entry, provenance] of layers) {
    const choice = fromValue<T>(entry?.[field], provenance);
    if (choice) return choice;
  }
  return fromValue<T>(profile, "agent-default") ?? { kind: "default", provenance: "parent" };
}

function fromValue<T>(value: unknown, provenance: RouteFieldProvenance): RouteFieldChoice<T> | undefined {
  if (value === undefined) return undefined;
  if (isRouteMode(value)) return { kind: value, provenance };
  return { kind: "value", value: value as T, provenance };
}
