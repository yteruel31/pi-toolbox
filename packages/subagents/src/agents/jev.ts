import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ClaudeSupportedModel } from "../harnesses/claude.js";
import { truncateText } from "../shared/truncate.js";
import { requestJevChoice, type JevFetch } from "./jev-client.js";
import type { HarnessKind, ThinkingLevel } from "../shared/types.js";
import type {
  ResolvedRoute,
  RouteFieldProvenance,
  RouteResolutionInput,
  RoutingEntry,
} from "./types.js";

export const JEV_MAX_CHOICES = 255;

export interface JevConfig { enabled: boolean; credential?: string }

export interface JevCandidate {
  key: string;
  harness: HarnessKind;
  model: string;
  thinking?: ThinkingLevel;
  description: string;
}

export interface JevRouteInput {
  task: string;
  role?: string;
  route: ResolvedRoute;
  /** Raw resolution input lets Jev distinguish parent fallbacks from constraints. */
  resolutionInput?: RouteResolutionInput;
  /** Exact named-agent tools; routing never rewrites this allowlist. */
  tools?: readonly string[];
  piModels: readonly Model<any>[];
  claudeModels: readonly ClaudeSupportedModel[];
  apiKey: string;
  signal?: AbortSignal;
}

export interface JevRouteResult { route: ResolvedRoute; used: boolean; fallback?: string }

export interface JevConstraints {
  harness?: HarnessKind;
  model?: string;
  thinking?: ThinkingLevel;
  provenance: Partial<Record<"harness" | "model" | "thinking", RouteFieldProvenance>>;
}

export class JevRoutingConflictError extends Error {
  override readonly name = "JevRoutingConflictError";
}

const CURATED: Record<string, string> = {
  "gpt-6-astra": "Best for the hardest end-to-end coding, application, research, and judgment work.",
  "gpt-5.6-sol": "Strong for complex or ambiguous coding, research, computer-use, and security work.",
  "gpt-5.6-terra": "Balanced model for everyday coding work.",
  "gpt-5.6-luna": "Fast model for repeatable extraction, classification, and transformations.",
  "claude-fable-5-1": "Demanding, slower long-horizon agentic model with always-on thinking.",
  "claude-opus-5": "Complex agentic coding and enterprise model with moderate latency.",
  "claude-sonnet-5": "Fast model balancing speed and intelligence.",
  "claude-haiku-4-5": "Fastest Claude option; effort controls are not supported.",
};

/** Internal metadata only. Sources verified 2026-09-21. */
export const JEV_METADATA_SOURCES = [
  "https://learn.chatgpt.com/docs/models",
  "https://platform.claude.com/docs/en/models/overview",
  "https://platform.claude.com/docs/en/build-with-claude/effort",
  "https://platform.claude.com/docs/en/models/fable-5-1/overview",
  "https://platform.claude.com/docs/en/models/opus-5/overview",
  "https://platform.claude.com/docs/en/models/sonnet-5/overview",
  "https://platform.claude.com/docs/en/models/haiku-4-5/overview",
] as const;

/** Extract constraints before parent defaults. Without raw input, all non-parent fields are fixed. */
export function deriveJevConstraints(route: ResolvedRoute, input?: RouteResolutionInput): JevConstraints {
  if (!input) {
    return {
      harness: fixed(route.provenance.harness) ? route.harness : undefined,
      model: fixed(route.provenance.model) && route.model !== undefined ? route.model : undefined,
      thinking: fixed(route.provenance.thinking) && route.thinking !== undefined ? route.thinking : undefined,
      provenance: {
        ...(fixed(route.provenance.harness) ? { harness: route.provenance.harness } : {}),
        ...(fixed(route.provenance.model) && route.model !== undefined ? { model: route.provenance.model } : {}),
        ...(fixed(route.provenance.thinking) && route.thinking !== undefined ? { thinking: route.provenance.thinking } : {}),
      },
    };
  }

  const harness = layered(input, "harness");
  const model = layered(input, "model");
  let effectiveHarness = harness?.value as HarnessKind | undefined;
  let harnessProvenance = harness?.provenance;
  if (!effectiveHarness && typeof model?.value === "string") {
    effectiveHarness = inferHarness(model.value);
    if (effectiveHarness) harnessProvenance = "jev";
  }
  let thinking = layeredWithoutAgent(input, "thinking");
  if (!thinking && effectiveHarness === "claude" && input.agent?.defaults.effort !== undefined) {
    thinking = { value: input.agent.defaults.effort, provenance: "agent-default" };
  }
  if (!thinking && input.agent?.defaults.thinking !== undefined) {
    thinking = { value: input.agent.defaults.thinking, provenance: "agent-default" };
  }
  return {
    harness: effectiveHarness,
    model: model?.value === "inherit" && model.provenance === "agent-default" ? undefined : model?.value,
    thinking: thinking?.value as ThinkingLevel | undefined,
    provenance: {
      ...(harnessProvenance ? { harness: harnessProvenance } : {}),
      ...(model ? { model: model.provenance } : {}),
      ...(thinking ? { thinking: thinking.provenance } : {}),
    },
  };
}

export function buildJevCandidates(
  piModels: readonly Model<any>[],
  claudeModels: readonly ClaudeSupportedModel[],
  fixedHarness?: HarnessKind,
): JevCandidate[] {
  const candidates: JevCandidate[] = [];
  if (!fixedHarness || fixedHarness === "pi") {
    for (const model of piModels) {
      // Claude catalog entries exposed through Pi belong to the Claude backend.
      if (inferHarness(`${model.provider}/${model.id}`) === "claude") continue;
      const levels = getSupportedThinkingLevels(model);
      for (const thinking of levels.length ? levels : [undefined]) {
        candidates.push(candidate("pi", `${model.provider}/${model.id}`, thinking, model.name, piMetadata(model)));
      }
    }
  }
  if (!fixedHarness || fixedHarness === "claude") {
    for (const model of claudeModels) {
      const levels = claudeThinkingLevels(model);
      for (const thinking of levels) {
        candidates.push(candidate("claude", model.value, thinking, model.description || model.displayName, claudeMetadata(model), model.resolvedModel));
      }
    }
  }
  return dedupe(candidates);
}

export async function routeWithJev(input: JevRouteInput, fetchImpl: JevFetch = fetch): Promise<JevRouteResult> {
  const constraints = deriveJevConstraints(input.route, input.resolutionInput);
  if (constraints.model === undefined && constraints.provenance.model === "agent-default") {
    return { route: input.route, used: false };
  }
  const inferred = constraints.model ? inferHarness(constraints.model, input.claudeModels) : undefined;
  if (constraints.harness && inferred && constraints.harness !== inferred) {
    throw new JevRoutingConflictError("The fixed harness and model are incompatible.");
  }
  const fixedHarness = constraints.harness ?? inferred;
  if (!input.resolutionInput && constraints.harness && constraints.provenance.harness && !constraints.model && routeFieldUnset(input.route.model)) {
    delete constraints.provenance.model;
  }
  let candidates = buildJevCandidates(input.piModels, input.claudeModels, constraints.harness ?? fixedHarness);
  if (input.tools) candidates = candidates.filter((item) => toolsCompatible(item.harness, input.tools!));
  if (constraints.model) candidates = candidates.filter((item) => modelMatches(item, constraints.model!, input.piModels, input.claudeModels));
  if (constraints.thinking !== undefined) candidates = candidates.filter((item) => thinkingMatches(item, constraints.thinking!));
  if (candidates.length === 0) return fallback(input.route, "No compatible available route was found for the fixed routing constraints.");

  if (constraints.model && constraints.thinking !== undefined) {
    return { route: applyCandidate(input.route, candidates[0]!, constraints), used: false };
  }
  if (candidates.length === 1) return { route: applyCandidate(input.route, candidates[0]!, constraints), used: false };
  if (candidates.length > JEV_MAX_CHOICES) {
    return fallback(input.route, `Jev routing has ${candidates.length} valid choices, above the ${JEV_MAX_CHOICES} service limit.`);
  }

  try {
    const criteria = Object.fromEntries(candidates.map((item) => [item.key, item.description]));
    const answer = await requestJevChoice({
      apiKey: input.apiKey,
      state: { task: input.task, role: bounded(input.role ?? "generic subagent", 500) },
      criteria,
      signal: input.signal,
      fetchImpl,
    });
    const selected = candidates.find((item) => item.key === answer.choice);
    if (!selected) return fallback(input.route, "Jev returned an unavailable route.");
    return { route: applyCandidate(input.route, selected, constraints), used: true };
  } catch {
    if (input.signal?.aborted) throw new Error("Jev routing was cancelled.");
    return fallback(input.route, "Jev routing failed or returned an invalid response.");
  }
}

function layered(input: RouteResolutionInput, field: "harness" | "model" | "thinking"):
  { value: any; provenance: RouteFieldProvenance } | undefined {
  const entries: Array<[RoutingEntry | undefined, RouteFieldProvenance]> = [
    [input.explicit, "explicit"], [input.projectRouting, "saved-project"], [input.userRouting, "saved-user"],
    [input.savedRouting, input.savedRoutingProvenance?.[field] ?? "saved-user"],
    [input.agent?.defaults, "agent-default"],
  ];
  for (const [entry, provenance] of entries) if (entry?.[field] !== undefined) return { value: entry[field], provenance };
  return undefined;
}

function layeredWithoutAgent(input: RouteResolutionInput, field: "thinking"):
  { value: any; provenance: RouteFieldProvenance } | undefined {
  const entries: Array<[RoutingEntry | undefined, RouteFieldProvenance]> = [
    [input.explicit, "explicit"], [input.projectRouting, "saved-project"], [input.userRouting, "saved-user"],
    [input.savedRouting, input.savedRoutingProvenance?.[field] ?? "saved-user"],
  ];
  for (const [entry, provenance] of entries) if (entry?.[field] !== undefined) return { value: entry[field], provenance };
  return undefined;
}

function candidate(harness: HarnessKind, model: string, thinking: ThinkingLevel | undefined, discovered: string, facts = "", resolvedModel?: string): JevCandidate {
  const lookupModel = resolvedModel ?? model;
  const id = lookupModel.includes("/") ? lookupModel.slice(lookupModel.lastIndexOf("/") + 1) : lookupModel;
  const description = CURATED[id] ?? discovered;
  const effort = thinking === undefined ? " SDK default thinking/effort." : ` Thinking/effort ${thinking}.`;
  return { key: encodeKey(harness, model, thinking), harness, model, thinking, description: `${description}${facts}${effort}` };
}

function piMetadata(model: Model<any>): string {
  return ` Provider ${model.provider}; context ${model.contextWindow}; input cost ${model.cost.input}; output cost ${model.cost.output}; reasoning ${String(model.reasoning)}.`;
}
function claudeMetadata(model: ClaudeSupportedModel): string {
  return ` SDK model ${model.resolvedModel ?? model.value}; effort support ${model.supportsEffort === true ? "known" : "not advertised"}.`;
}

function claudeThinkingLevels(model: ClaudeSupportedModel): Array<ThinkingLevel | undefined> {
  const id = model.resolvedModel ?? model.value;
  if (model.supportsEffort === true && model.supportedEffortLevels?.length) {
    return [...new Set(model.supportedEffortLevels.filter((level) =>
      ["low", "medium", "high", "xhigh", "max"].includes(level)))];
  }
  // Exact verified disabled-thinking model only; Fable is always-on.
  if (id === "claude-haiku-4-5" || id === "claude-haiku-4-5-20251001") return [undefined, "off"];
  return [undefined];
}

function fixed(provenance: RouteFieldProvenance): boolean { return provenance !== "parent" && provenance !== "jev" }

function inferHarness(model: string, claudeModels: readonly ClaudeSupportedModel[] = []): HarnessKind | undefined {
  const unqualified = model.startsWith("anthropic/") ? model.slice("anthropic/".length) : model;
  if (model.startsWith("anthropic/") && unqualified.startsWith("claude-")) return "claude";
  if (unqualified.startsWith("claude-")) return "claude";
  if (claudeModels.some((item) => item.value === model || item.resolvedModel === model)) return "claude";
  if (model.includes("/")) return "pi";
  return undefined;
}

function modelMatches(candidate: JevCandidate, model: string, piModels: readonly Model<any>[], claudeModels: readonly ClaudeSupportedModel[]): boolean {
  if (candidate.model === model) return true;
  if (model.includes("/")) {
    if (candidate.harness !== "claude" || !model.startsWith("anthropic/")) return false;
    const normalized = model.slice("anthropic/".length);
    const metadata = claudeModels.find((item) => item.value === candidate.model);
    return normalized === candidate.model || normalized === metadata?.resolvedModel;
  }
  if (candidate.harness === "claude") {
    const metadata = claudeModels.find((item) => item.value === candidate.model);
    return model === metadata?.resolvedModel;
  }
  const matching = piModels.filter((item) => item.id === model);
  return matching.length === 1 && candidate.model === `${matching[0]!.provider}/${matching[0]!.id}`;
}

function thinkingMatches(candidate: JevCandidate, thinking: ThinkingLevel): boolean {
  return candidate.thinking === thinking || (candidate.harness === "claude" && thinking === "minimal" && candidate.thinking === "low");
}

function toolsCompatible(harness: HarnessKind, tools: readonly string[]): boolean {
  const known = harness === "claude"
    ? new Set(["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "WebSearch"])
    : new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);
  return tools.every((tool) => known.has(tool));
}

function applyCandidate(route: ResolvedRoute, selected: JevCandidate, constraints: JevConstraints): ResolvedRoute {
  const next = structuredClone(route);
  next.harness = constraints.harness ?? selected.harness;
  next.provenance.harness = constraints.provenance.harness ?? "jev";
  next.model = constraints.model ?? selected.model;
  next.provenance.model = constraints.provenance.model ?? "jev";
  next.thinking = constraints.thinking ?? selected.thinking;
  next.provenance.thinking = constraints.provenance.thinking ?? "jev";
  return next;
}

function encodeKey(harness: HarnessKind, model: string, thinking?: ThinkingLevel): string {
  return Buffer.from(JSON.stringify([harness, model, thinking ?? null])).toString("base64url");
}
function dedupe(candidates: JevCandidate[]): JevCandidate[] { return [...new Map(candidates.map((item) => [item.key, item])).values()] }
function fallback(route: ResolvedRoute, reason: string): JevRouteResult { return { route, used: false, fallback: bounded(reason, 240) } }
function routeFieldUnset(value: string | undefined): boolean { return value === undefined }
function bounded(value: string, max: number): string { return truncateText(value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim(), max) }
