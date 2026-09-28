import type { Model } from "@earendil-works/pi-ai";
import type { ClaudeSupportedModel } from "../harnesses/claude.js";
import type { SubagentHarness } from "../core/harness.js";
import type { RunRoutingDiagnostic } from "../shared/types.js";
import { JevRoutingConflictError, deriveJevConstraints, type JevRouteInput, type JevRouteResult } from "./jev.js";
import { TOOL_DIALECT_CONFLICT, toolsCompatible } from "./tool-dialect.js";
import type { AgentDefinition, ResolvedRoute, RouteResolutionInput } from "./types.js";

export interface JevBackgroundInput {
  task: string;
  agent?: AgentDefinition;
  route: ResolvedRoute;
  resolutionInput: RouteResolutionInput;
  piModels: readonly Model<any>[];
  loadClaudeModels(signal: AbortSignal): Promise<readonly ClaudeSupportedModel[]>;
  resolveApiKey(signal: AbortSignal): Promise<string>;
  routeJev(input: JevRouteInput): Promise<JevRouteResult>;
  harnesses: Record<"pi" | "claude", SubagentHarness>;
}

/** A managed harness that defers all Jev preparation until after spawn returns. */
export function createJevBackgroundHarness(input: JevBackgroundInput): SubagentHarness {
  return {
    kind: input.route.harness,
    // Both production backends support active messaging. The manager still
    // keeps the editor read-only until the selected backend attaches control.
    supportsActiveMessages: true,
    async run(request) {
      request.reportProgress("Routing pending.");
      request.reportTranscript({ kind: "status", text: "Routing pending." });
      await abortable(new Promise<void>((resolve) => setImmediate(resolve)), request.signal);
      const constraints = deriveJevConstraints(input.route, input.resolutionInput);
      const clearlyPi = constraints.harness === "pi"
        || (constraints.model?.includes("/") === true && !constraints.model.startsWith("anthropic/"));
      let claudeModels: readonly ClaudeSupportedModel[] = [];
      let catalogFallback: string | undefined;
      if (!clearlyPi) {
        try {
          if (request.signal.aborted) throw abortError();
          claudeModels = await abortable(input.loadClaudeModels(request.signal), request.signal);
        } catch (error) {
          if (isAbort(error, request.signal)) throw abortError();
          catalogFallback = "Claude model catalogue is unavailable; routing continued with Pi models.";
        }
      }
      const failRouting = (error: JevRoutingConflictError): never => {
        request.reportRouting?.({
          harness: input.route.harness,
          model: input.route.model,
          thinkingLevel: input.route.thinking,
        }, { state: "failed", provenance: input.route.provenance });
        request.reportProgress("Routing failed: incompatible available routes; see the run diagnostic.");
        request.reportTranscript({ kind: "status", text: "Routing failed: incompatible available routes; see the run diagnostic." });
        throw error;
      };
      let result: JevRouteResult;
      try {
        if (request.signal.aborted) throw abortError();
        result = await abortable(input.routeJev({
          task: input.task,
          role: input.agent ? `${input.agent.name}: ${input.agent.description}` : "generic subagent",
          route: input.route,
          resolutionInput: input.resolutionInput,
          tools: input.agent?.tools,
          piModels: input.piModels,
          claudeModels,
          resolveApiKey: () => {
            if (request.signal.aborted) return Promise.reject(abortError());
            return input.resolveApiKey(request.signal);
          },
          signal: request.signal,
        }), request.signal);
      } catch (error) {
        if (error instanceof JevRoutingConflictError) failRouting(error);
        if (isAbort(error, request.signal)) throw abortError();
        result = { route: input.route, used: false, fallback: "Jev routing is unavailable; the configured route was used." };
      }
      // Same deterministic tool-dialect guard as configured routing: never start
      // a backend whose native tools the allowlist cannot name.
      if (!toolsCompatible(result.route.harness, input.agent?.tools)) {
        failRouting(new JevRoutingConflictError(`No compatible available route was found for the fixed routing constraints. ${TOOL_DIALECT_CONFLICT} No constraint was changed.`));
      }
      const diagnostic: RunRoutingDiagnostic = {
        state: result.fallback || catalogFallback ? "fallback" : "resolved",
        provenance: result.route.provenance,
        fallback: result.fallback ?? catalogFallback,
      };
      const routeText = formatResolvedRoute(result.route);
      request.reportProgress(routeText);
      request.reportTranscript({ kind: "status", text: routeText });
      if (diagnostic.fallback) {
        request.reportProgress(`Routing warning: ${diagnostic.fallback}`);
        request.reportTranscript({ kind: "status", text: `Routing warning: ${diagnostic.fallback}` });
      }
      if (request.reportRouting && !request.reportRouting({
        harness: result.route.harness,
        model: result.route.model,
        thinkingLevel: result.route.thinking,
      }, diagnostic)) throw abortError();
      if (request.signal.aborted) throw abortError();
      const actual = input.harnesses[result.route.harness];
      return actual.run({
        ...request,
        model: result.route.model,
        thinkingLevel: result.route.thinking,
      });
    },
  };
}

function formatResolvedRoute(route: JevRouteResult["route"]): string {
  const field = (name: "harness" | "model" | "thinking", value: string): string => {
    const mode = route.modes?.[name];
    const note = mode === "auto" && route.provenance[name] !== "jev"
      ? ", auto resolved as inherit"
      : mode === "inherit" ? ", inherit" : "";
    return `${value} (${route.provenance[name]}${note})`;
  };
  return `Routing resolved: backend=${field("harness", route.harness)}; model=${field("model", route.model ?? "default")}; thinking=${field("thinking", route.thinking ?? "default")}.`;
}

function abortError(): DOMException { return new DOMException("Aborted", "AbortError"); }
function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof DOMException && error.name === "AbortError");
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(abortError()); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { cleanup(); resolve(value); },
      (error) => { cleanup(); reject(error); },
    );
  });
}
