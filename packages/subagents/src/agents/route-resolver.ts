import type {
  ResolvedRoute,
  RouteFieldProvenance,
  RouteResolutionInput,
  RouteResolver,
  RoutingEntry,
} from "./types.js";

/** Pure route resolution with exact, per-field precedence and provenance. */
export class DefaultRouteResolver implements RouteResolver {
  resolve(input: RouteResolutionInput): ResolvedRoute {
    const harness = resolveSavedField(input, "harness")
      ?? fromAgent(input, "harness")
      ?? { value: "pi" as const, provenance: "parent" as const };

    const harnessValue = harness.value ?? "pi";
    const model = resolveSavedField(input, "model")
      ?? fromAgent(input, "model")
      ?? {
        value: harnessValue === "pi" ? input.parent.model : undefined,
        provenance: "parent" as const,
      };

    const thinking = resolveSavedField(input, "thinking")
      ?? fromAgent(input, "thinking")
      ?? {
        value: harnessValue === "pi" ? input.parent.thinking : undefined,
        provenance: "parent" as const,
      };

    return {
      harness: harnessValue,
      model: model.value,
      thinking: thinking.value,
      provenance: {
        harness: harness.provenance,
        model: model.provenance,
        thinking: thinking.provenance,
      },
    };
  }
}

export const routeResolver: RouteResolver = new DefaultRouteResolver();

type RouteField = "harness" | "model" | "thinking";
type FieldValue<K extends RouteField> = RoutingEntry[K];
interface FieldResolution<K extends RouteField> {
  value: FieldValue<K>;
  provenance: RouteFieldProvenance;
}

function resolveSavedField<K extends RouteField>(
  input: RouteResolutionInput,
  field: K,
): FieldResolution<K> | undefined {
  const explicit = fromEntry(input.explicit, field, "explicit");
  if (explicit) return explicit;
  const project = fromEntry(input.projectRouting, field, "saved-project");
  if (project) return project;
  const user = fromEntry(input.userRouting, field, "saved-user");
  if (user) return user;
  return fromEntry(
    input.savedRouting,
    field,
    input.savedRoutingProvenance?.[field] ?? "saved-user",
  );
}

function fromAgent<K extends RouteField>(
  input: RouteResolutionInput,
  field: K,
): FieldResolution<K> | undefined {
  return fromEntry(input.agent?.defaults, field, "agent-default");
}

function fromEntry<K extends RouteField>(
  entry: Pick<RoutingEntry, RouteField> | RoutingEntry | undefined,
  field: K,
  provenance: RouteFieldProvenance,
): FieldResolution<K> | undefined {
  if (!entry || entry[field] === undefined) return undefined;
  return { value: entry[field] as FieldValue<K>, provenance };
}
