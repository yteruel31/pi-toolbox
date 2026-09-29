import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ClaudeSupportedModel } from "../harnesses/claude.js";
import { truncateText } from "../shared/truncate.js";
import { jevFailureDiagnostic, requestJevChoice, type JevFetch } from "./jev-client.js";
import {
  inheritedModel,
  inheritedThinking,
  resolveHarnessChoice,
  resolveModelChoice,
  resolveThinkingChoice,
} from "./route-resolver.js";
import { TOOL_DIALECT_CONFLICT, toolsCompatible } from "./tool-dialect.js";
import type { HarnessKind, ThinkingLevel } from "../shared/types.js";
import type {
  ResolvedRoute,
  RouteFieldProvenance,
  RouteResolutionInput,
} from "./types.js";

export const JEV_MAX_CHOICES = 255;

export interface JevConfig { enabled: boolean; credential?: string }

export interface JevCandidate {
  key: string;
  harness: HarnessKind;
  /** Undefined only for an inherited Claude SDK default or unknown parent Pi model. */
  model: string | undefined;
  thinking?: ThinkingLevel;
  /** Thinking is the backend default because the inherited model's levels are unknown. */
  thinkingDefault?: boolean;
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
  /** Compatibility value; new callers should lazily resolve only before a request. */
  apiKey?: string;
  resolveApiKey?: () => Promise<string>;
  signal?: AbortSignal;
}

export interface JevRouteResult { route: ResolvedRoute; used: boolean; fallback?: string }

export interface JevConstraints {
  harness?: HarnessKind;
  model?: string;
  /** The winning model layer is `inherit`: keep the backend-dependent parent/SDK default model. */
  inheritModel?: boolean;
  thinking?: ThinkingLevel;
  /** Thinking is fixed to the backend default (an inherited Claude SDK default effort). */
  thinkingDefault?: boolean;
  provenance: Partial<Record<"harness" | "model" | "thinking", RouteFieldProvenance>>;
}

/** A fixed thinking value for one backend; `value: undefined` is the backend default. */
interface ThinkingConstraint { value: ThinkingLevel | undefined; provenance: RouteFieldProvenance }

/**
 * Resolved-route `inherit` thinking without raw input: the value is only known
 * for the backend the route was resolved for; other backends use their default.
 */
const inheritedRouteThinking = new WeakMap<JevConstraints, { harness: HarnessKind; value: ThinkingLevel }>();

export class JevRoutingConflictError extends Error {
  override readonly name = "JevRoutingConflictError";
}

/**
 * Purpose descriptions for models whose catalogue entry reports no description.
 * Pi reports a display name and numbers only, so without these the service sees
 * what a model costs but nothing about what it is for. Entries only describe
 * models a harness already offers: this table never adds a candidate, and any
 * model missing from it falls back to whatever its harness reports.
 */
const CURATED: Record<string, string> = {
  "gpt-6-astra": "Best for the hardest end-to-end coding, application, research, and judgment work.",
  "gpt-6-sol": "Built for complex coding and agentic workflows, including ambiguous everyday tasks, code changes, and research.",
  "gpt-6-luna": "Most efficient for focused, high-volume summarization, extraction, and focused coding with known success criteria.",
  "gpt-5.6-sol": "Strong for complex or ambiguous coding, research, computer-use, and security work.",
  "gpt-5.6-terra": "Balanced model for everyday coding work.",
  "gpt-5.6-luna": "Fast model for repeatable extraction, classification, and transformations.",
  "claude-fable-5-1": "Demanding, slower long-horizon agentic model with always-on thinking.",
  "claude-opus-5-5": "Long-running agentic coding and knowledge work at moderate latency, with always-on thinking.",
  "claude-opus-5": "Complex agentic coding and enterprise model with moderate latency.",
  "claude-sonnet-5": "Fast model balancing speed and intelligence.",
  "claude-haiku-4-5": "Fastest Claude option; effort controls are not supported.",
};

/** Internal metadata only. Sources verified 2026-09-24. */
export const JEV_METADATA_SOURCES = [
  "https://learn.chatgpt.com/docs/models",
  "https://platform.claude.com/docs/en/models/overview",
  "https://platform.claude.com/docs/en/build-with-claude/effort",
  "https://platform.claude.com/docs/en/models/fable-5-1/overview",
  "https://platform.claude.com/docs/en/models/opus-5-5/overview",
  "https://platform.claude.com/docs/en/models/opus-5/overview",
  "https://platform.claude.com/docs/en/models/sonnet-5/overview",
  "https://platform.claude.com/docs/en/models/haiku-4-5/overview",
] as const;

/**
 * Extract constraints before parent defaults. `auto` and absent fields are free;
 * literals are fixed; `inherit` keeps the backend-dependent inherited value.
 * Without raw input, all non-parent fields except `auto` modes are fixed, and
 * resolved `inherit` thinking stays fixed only on the backend it was resolved for.
 */
export function deriveJevConstraints(route: ResolvedRoute, input?: RouteResolutionInput): JevConstraints {
  if (!input) {
    const modes = route.modes ?? {};
    const harnessFixed = fixed(route.provenance.harness) && modes.harness !== "auto";
    const modelFixed = fixed(route.provenance.model) && modes.model !== "auto";
    const inheritModel = modelFixed && (route.model === undefined || modes.model === "inherit");
    const thinkingFixed = fixed(route.provenance.thinking) && modes.thinking !== "auto";
    const thinkingDefault = thinkingFixed && route.thinking === undefined && modes.thinking === "inherit";
    const thinkingInherited = thinkingFixed && route.thinking !== undefined && modes.thinking === "inherit";
    const thinkingValue = thinkingFixed && route.thinking !== undefined && !thinkingInherited;
    const constraints: JevConstraints = {
      harness: harnessFixed ? route.harness : undefined,
      model: modelFixed && !inheritModel ? route.model : undefined,
      ...(inheritModel ? { inheritModel } : {}),
      thinking: thinkingValue ? route.thinking : undefined,
      ...(thinkingDefault ? { thinkingDefault } : {}),
      provenance: {
        ...(harnessFixed ? { harness: route.provenance.harness } : {}),
        ...(modelFixed ? { model: route.provenance.model } : {}),
        ...(thinkingValue || thinkingDefault || thinkingInherited ? { thinking: route.provenance.thinking } : {}),
      },
    };
    if (thinkingInherited) inheritedRouteThinking.set(constraints, { harness: route.harness, value: route.thinking! });
    return constraints;
  }

  const harnessChoice = resolveHarnessChoice(input);
  const modelChoice = resolveModelChoice(input);
  // Harness `inherit` means the parent backend, which is always Pi.
  let effectiveHarness: HarnessKind | undefined = harnessChoice.kind === "value"
    ? harnessChoice.value
    : harnessChoice.kind === "inherit" ? "pi" : undefined;
  let harnessProvenance = effectiveHarness ? harnessChoice.provenance : undefined;
  const model = modelChoice.kind === "value" ? modelChoice.value : undefined;
  if (!effectiveHarness && model !== undefined) {
    effectiveHarness = inferHarness(model);
    if (effectiveHarness) harnessProvenance = "jev";
  }
  // With an unknown backend only harness-independent literals are known here;
  // profile effort and `inherit` are resolved per candidate backend.
  let thinking: ThinkingConstraint | undefined;
  if (effectiveHarness) {
    thinking = inputThinking(input, effectiveHarness);
  } else {
    const choice = resolveThinkingChoice(input, "pi");
    if (choice.kind === "value" && choice.provenance !== "agent-default") thinking = choice;
  }
  const inheritModel = modelChoice.kind === "inherit";
  return {
    harness: effectiveHarness,
    model,
    ...(inheritModel ? { inheritModel } : {}),
    thinking: thinking?.value,
    ...(thinking && thinking.value === undefined ? { thinkingDefault: true } : {}),
    provenance: {
      ...(harnessProvenance ? { harness: harnessProvenance } : {}),
      ...(model !== undefined || inheritModel ? { model: modelChoice.provenance } : {}),
      ...(thinking ? { thinking: thinking.provenance } : {}),
    },
  };
}

export function buildJevCandidates(
  piModels: readonly Model<any>[],
  claudeModels: readonly ClaudeSupportedModel[],
  fixedHarness?: HarnessKind,
  /** Backends whose thinking is fixed to the backend default instead of enumerated levels. */
  defaultThinking: ReadonlySet<HarnessKind> = new Set(),
): JevCandidate[] {
  const candidates: JevCandidate[] = [];
  if (!fixedHarness || fixedHarness === "pi") {
    for (const model of piModels) {
      // Claude catalog entries exposed through Pi belong to the Claude backend.
      if (inferHarness(`${model.provider}/${model.id}`) === "claude") continue;
      const levels = defaultThinking.has("pi") ? [] : getSupportedThinkingLevels(model);
      for (const thinking of levels.length ? levels : [undefined]) {
        candidates.push(candidate("pi", `${model.provider}/${model.id}`, thinking, model.name, piMetadata(model), { purposeId: model.id }));
      }
    }
  }
  if (!fixedHarness || fixedHarness === "claude") {
    for (const model of claudeModels) {
      const levels = defaultThinking.has("claude") ? [undefined] : claudeThinkingLevels(model);
      // The SDK catalogue describes its own models; curated purpose text only
      // fills in for a row that arrives with no description of its own.
      const describes = model.description.trim().length > 0;
      for (const thinking of levels) {
        candidates.push(candidate("claude", model.value, thinking, describes ? model.description : model.displayName, claudeMetadata(model), {
          purposeId: model.resolvedModel ?? model.value,
          harnessDescribed: describes,
        }));
      }
    }
  }
  return dedupe(candidates);
}

export async function routeWithJev(input: JevRouteInput, fetchImpl: JevFetch = fetch): Promise<JevRouteResult> {
  const constraints = deriveJevConstraints(input.route, input.resolutionInput);
  const inferred = constraints.model ? inferHarness(constraints.model, input.claudeModels) : undefined;
  if (constraints.harness && inferred && constraints.harness !== inferred) {
    throw new JevRoutingConflictError("The fixed harness and model are incompatible. Check the profile, saved routing, or explicit spawn overrides; neither constraint was changed.");
  }
  if (inferred && constraints.harness === undefined) {
    constraints.harness = inferred;
    constraints.provenance.harness = "jev";
  }
  if (constraints.harness) pinThinking(constraints, input.resolutionInput, constraints.harness);
  const fixedHarness = constraints.harness ?? inferred;
  if (!input.resolutionInput && constraints.harness && constraints.provenance.harness && !constraints.model && !constraints.inheritModel && routeFieldUnset(input.route.model)) {
    delete constraints.provenance.model;
  }
  const defaultThinking = new Set((["pi", "claude"] as const).filter((harness) => {
    const thinking = thinkingConstraint(constraints, input.resolutionInput, harness);
    return thinking !== undefined && thinking.value === undefined;
  }));
  // An inherited model keeps its identity; only free fields remain choices.
  let candidates = constraints.inheritModel
    ? inheritedModelCandidates(input, constraints, defaultThinking)
    : buildJevCandidates(input.piModels, input.claudeModels, constraints.harness ?? fixedHarness, defaultThinking);
  const catalogCount = candidates.length;
  if (input.tools) candidates = candidates.filter((item) => toolsCompatible(item.harness, input.tools!));
  const toolCount = candidates.length;
  if (constraints.model) candidates = candidates.filter((item) => modelMatches(item, constraints.model!, input.piModels, input.claudeModels));
  const modelCount = candidates.length;
  const beforeThinking = candidates;
  candidates = candidates.flatMap((item) => {
    const thinking = thinkingConstraint(constraints, input.resolutionInput, item.harness);
    if (!thinking) return [item];
    if (thinking.value === undefined) return item.thinking === undefined ? [item] : [];
    return thinkingMatches(item, thinking.value) ? [{ ...item, thinking: thinking.value }] : [];
  });
  // `inherit` means the exact parent model on Pi. When its advertised levels
  // prove the fixed thinking unsupported, a free backend must not silently
  // swap it for the Claude SDK default model; surface the conflict instead.
  if (constraints.inheritModel && !constraints.harness &&
    beforeThinking.some((item) => item.harness === "pi") && !candidates.some((item) => item.harness === "pi")) {
    throw new JevRoutingConflictError("No compatible available route was found for the fixed routing constraints. The requested thinking/effort is not advertised by the inherited parent Pi model, so the backend was not switched to the Claude SDK default model. Check explicit, saved, and profile effort against runtime model capabilities. No constraint was changed.");
  }
  if (candidates.length === 0) {
    if (!input.resolutionInput && constraints.model && constraints.thinking !== undefined) {
      return { route: input.route, used: false };
    }
    // Discovery lists aliases, not every id the SDK accepts. A well-formed fixed
    // Claude id with compatible tools is kept verbatim for the SDK to validate;
    // it is never mapped to a catalogue alias whose resolved identity differs.
    if (catalogCount > 0 && toolCount > 0 && modelCount === 0 && constraints.harness === "claude" && isClaudeModelId(constraints.model)) {
      return keepUncataloguedClaudeModel(input.route, constraints);
    }
    // Categorical diagnostics only: never echo task, credentials, model IDs,
    // tool names, catalogue descriptions, or raw discovery/provider errors.
    const reason = catalogCount === 0
      ? "No candidates were advertised for the constrained backend. Check its available model catalogue and the automatic model scope. Catalogue availability is not a quota check."
      : toolCount === 0
        ? TOOL_DIALECT_CONFLICT
        : modelCount === 0
          ? "The fixed model has no unique match in the available catalogue. Check the profile/saved/spawn model and use a provider-qualified Pi ID or a discovered Claude alias."
          : "The requested thinking/effort is not advertised by the matching models. Check explicit, saved, and profile effort against runtime model capabilities.";
    throw new JevRoutingConflictError(`No compatible available route was found for the fixed routing constraints. ${reason} No constraint was changed.`);
  }

  if (constraints.model && thinkingConstraint(constraints, input.resolutionInput, candidates[0]!.harness) !== undefined) {
    const selectedConstraints = candidateConstraints(constraints, input.resolutionInput, candidates[0]!.harness);
    return { route: applyCandidate(input.route, candidates[0]!, selectedConstraints), used: false };
  }
  if (candidates.length === 1) {
    const selectedConstraints = candidateConstraints(constraints, input.resolutionInput, candidates[0]!.harness);
    return { route: applyCandidate(input.route, candidates[0]!, selectedConstraints), used: false };
  }
  if (candidates.length > JEV_MAX_CHOICES) {
    return safeFallback(input, constraints, `Jev routing has ${candidates.length} valid choices, above the ${JEV_MAX_CHOICES} service limit.`);
  }

  try {
    const criteria = Object.fromEntries(candidates.map((item) => [item.key, item.description]));
    const apiKey = input.apiKey ?? await input.resolveApiKey?.();
    if (!apiKey) return safeFallback(input, constraints, "Jev credentials are unavailable.");
    const answer = await requestJevChoice({
      apiKey,
      state: { task: input.task, role: bounded(input.role ?? "generic subagent", 500) },
      criteria,
      signal: input.signal,
      fetchImpl,
    });
    const selected = candidates.find((item) => item.key === answer.choice);
    if (!selected) return safeFallback(input, constraints, "Jev returned an unavailable route.");
    return { route: applyCandidate(input.route, selected, candidateConstraints(constraints, input.resolutionInput, selected.harness)), used: true };
  } catch (error) {
    if (input.signal?.aborted) throw new Error("Jev routing was cancelled.");
    if (error instanceof JevRoutingConflictError) throw error;
    return safeFallback(input, constraints, `Jev routing failed or returned an invalid response. ${jevFailureDiagnostic(error)}`);
  }
}

/** Fixed thinking for one backend from resolution layers; undefined when free (`auto`/absent). */
function inputThinking(input: RouteResolutionInput, harness: HarnessKind): ThinkingConstraint | undefined {
  const choice = resolveThinkingChoice(input, harness);
  if (choice.kind === "value") return { value: choice.value, provenance: choice.provenance };
  if (choice.kind === "inherit") return { value: inheritedThinking(input, harness), provenance: choice.provenance };
  return undefined;
}

function thinkingConstraint(constraints: JevConstraints, input: RouteResolutionInput | undefined, harness: HarnessKind): ThinkingConstraint | undefined {
  if (input) return inputThinking(input, harness);
  const provenance = constraints.provenance.thinking ?? "explicit";
  const inherited = inheritedRouteThinking.get(constraints);
  if (inherited) return { value: harness === inherited.harness ? inherited.value : undefined, provenance };
  if (constraints.thinking !== undefined) return { value: constraints.thinking, provenance };
  return constraints.thinkingDefault ? { value: undefined, provenance } : undefined;
}

function pinThinking(constraints: JevConstraints, input: RouteResolutionInput | undefined, harness: HarnessKind): void {
  const thinking = thinkingConstraint(constraints, input, harness);
  if (!thinking) return;
  constraints.thinking = thinking.value;
  constraints.thinkingDefault = thinking.value === undefined ? true : undefined;
  constraints.provenance.thinking = thinking.provenance;
}

function candidateConstraints(constraints: JevConstraints, input: RouteResolutionInput | undefined, harness: HarnessKind): JevConstraints {
  const next = { ...constraints, provenance: { ...constraints.provenance } };
  const inherited = inheritedRouteThinking.get(constraints);
  if (inherited) inheritedRouteThinking.set(next, inherited);
  pinThinking(next, input, harness);
  return next;
}

/**
 * Candidates for an inherited model: the exact parent model on Pi (at its
 * advertised thinking levels) and the SDK default model on Claude. The model
 * identity is never replaced by a catalogue entry.
 */
function inheritedModelCandidates(input: JevRouteInput, constraints: JevConstraints, defaultThinking: ReadonlySet<HarnessKind>): JevCandidate[] {
  const candidates: JevCandidate[] = [];
  const harnesses: HarnessKind[] = constraints.harness ? [constraints.harness] : ["pi", "claude"];
  for (const harness of harnesses) {
    const thinking = thinkingConstraint(constraints, input.resolutionInput, harness);
    // Without raw input, a resolved Pi route already carries the exact inherited parent model.
    const model = input.resolutionInput
      ? inheritedModel(input.resolutionInput, harness)
      : harness === "pi" && input.route.harness === "pi" ? input.route.model : undefined;
    const known = harness === "pi" && model !== undefined
      ? input.piModels.find((item) => `${item.provider}/${item.id}` === model)
      : undefined;
    if (known) {
      const levels = defaultThinking.has("pi") ? [] : getSupportedThinkingLevels(known);
      for (const level of levels.length ? levels : [undefined]) {
        candidates.push(candidate("pi", model, level, known.name, piMetadata(known), { purposeId: known.id }));
      }
      continue;
    }
    // Unknown capabilities: pass a fixed thinking value through, otherwise keep the backend default.
    const described = harness === "pi" ? "Pi child session with the parent session model." : "Claude Code with the Claude Agent SDK default model.";
    candidates.push({ ...candidate(harness, model, thinking?.value, described), ...(thinking ? {} : { thinkingDefault: true }) });
  }
  return dedupe(candidates);
}

function safeFallback(input: JevRouteInput, constraints: JevConstraints, reason: string): JevRouteResult {
  // A harness `auto` falls back exactly like `inherit` (the ordinary route), as
  // when Jev is disabled: a backend Jev merely inferred from a fixed model is
  // not a constraint. The fixed model itself is kept unchanged.
  const harnessConstraint = input.route.modes?.harness === "auto" && constraints.provenance.harness === "jev"
    ? undefined
    : constraints.harness;
  const harness = harnessConstraint ?? input.route.harness;
  if (!toolsCompatible(harness, input.tools)) {
    throw new JevRoutingConflictError("The fixed route is incompatible with the tool allowlist.");
  }
  // The ordinary route already resolves `auto` as `inherit`; never forward a mode literal.
  const next = structuredClone(input.route);
  if (harnessConstraint) {
    next.harness = harnessConstraint;
    next.provenance.harness = constraints.provenance.harness ?? next.provenance.harness;
  }
  if (input.resolutionInput && next.harness !== input.route.harness) {
    // A fixed model implied another backend: re-resolve backend-dependent thinking.
    const thinking = thinkingConstraint(constraints, input.resolutionInput, next.harness);
    next.thinking = thinking ? thinking.value : inheritedThinking(input.resolutionInput, next.harness);
    next.provenance.thinking = thinking?.provenance ?? resolveThinkingChoice(input.resolutionInput, next.harness).provenance;
  }
  if (next.harness === "claude" && next.provenance.thinking === "parent" && constraints.thinking === undefined) {
    next.thinking = undefined;
  }
  // Only an explicit literal is validated: inherited parent thinking is not a
  // fixed constraint, and the backend adapts it exactly as with Jev disabled.
  const thinking = literalThinking(constraints, input.resolutionInput, next.harness);
  if (thinking !== undefined) {
    const actualModel = constraints.model ?? next.model;
    const actualCandidates = actualModel === undefined ? [] : buildJevCandidates(input.piModels, input.claudeModels, next.harness)
      .filter((item) => modelMatches(item, actualModel, input.piModels, input.claudeModels) ||
        (item.harness === "pi" && !actualModel.includes("/") &&
          input.piModels.filter((model) => model.id === actualModel).length === 1 &&
          item.model === `${input.piModels.find((model) => model.id === actualModel)!.provider}/${actualModel}`));
    if (actualCandidates.length > 0 && !actualCandidates.some((item) => thinkingMatches(item, thinking))) {
      throw new JevRoutingConflictError("The fixed route does not support the requested thinking or effort.");
    }
  }
  return fallback(next, reason);
}

/** Literal thinking fixed by a spawn, saved, or profile layer for `harness`; undefined for inherit/auto/parent. */
function literalThinking(constraints: JevConstraints, input: RouteResolutionInput | undefined, harness: HarnessKind): ThinkingLevel | undefined {
  if (input) {
    const choice = resolveThinkingChoice(input, harness);
    return choice.kind === "value" ? choice.value : undefined;
  }
  if (inheritedRouteThinking.has(constraints)) return undefined;
  return constraints.thinking;
}

function keepUncataloguedClaudeModel(route: ResolvedRoute, constraints: JevConstraints): JevRouteResult {
  const next = structuredClone(route);
  next.harness = "claude";
  next.provenance.harness = constraints.provenance.harness ?? next.provenance.harness;
  next.model = constraints.model;
  next.provenance.model = constraints.provenance.model ?? next.provenance.model;
  // Effort support is unknown without catalogue metadata: pass the fixed value
  // or the SDK default through instead of letting Jev pick one.
  next.thinking = constraints.thinking;
  next.provenance.thinking = constraints.provenance.thinking ?? next.provenance.thinking;
  return fallback(next, "The fixed Claude model is not in the discovered catalogue; it was kept unchanged for the Claude SDK to validate.");
}

/** Full Claude ids only (optionally `anthropic/`-qualified); bare aliases must come from discovery. */
function isClaudeModelId(model: string | undefined): model is string {
  return model !== undefined && model.length <= 200 && /^(?:anthropic\/)?claude-[a-z0-9][a-z0-9.-]*(?:\[[a-z0-9]+\])?$/i.test(model);
}

/**
 * Describe one candidate: what the harness discovered, the purpose text a bare
 * catalogue name can't carry, then the runtime facts.
 */
function candidate(
  harness: HarnessKind,
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
  discovered: string,
  facts = "",
  options: { purposeId?: string; harnessDescribed?: boolean } = {},
): JevCandidate {
  const discoveredText = bounded(discovered, 300) || model || harness;
  const purpose = options.harnessDescribed ? undefined : CURATED[purposeKey(options.purposeId ?? model ?? "")];
  const description = purpose ? `${discoveredText} ${purpose}` : discoveredText;
  const effort = thinking === undefined ? " SDK default thinking/effort." : ` Thinking/effort ${thinking}.`;
  return { key: encodeKey(harness, model, thinking), harness, model, thinking, description: `${description}${facts}${effort}` };
}

/** Exact catalogue id, minus its provider path and the SDK's `[1m]` long-context alias suffix. */
function purposeKey(id: string): string {
  const unqualified = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return unqualified.endsWith("[1m]") ? unqualified.slice(0, -"[1m]".length) : unqualified;
}

function piMetadata(model: Model<any>): string {
  const accepts = model.input?.length ? ` accepts ${model.input.join(" and ")};` : "";
  return ` Provider ${model.provider}; context ${model.contextWindow}; max output ${model.maxTokens};${accepts} input cost ${model.cost.input}; output cost ${model.cost.output}; reasoning ${String(model.reasoning)}.`;
}
function claudeMetadata(model: ClaudeSupportedModel): string {
  const adaptive = model.supportsAdaptiveThinking === true ? "; adaptive thinking advertised" : "";
  return ` SDK model ${model.resolvedModel ?? model.value}; effort support ${model.supportsEffort === true ? "known" : "not advertised"}${adaptive}.`;
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
  if (candidate.harness === "pi") {
    const exact = piModels.find((item) => `${item.provider}/${item.id}` === candidate.model);
    if (exact && model === exact.id && piModels.filter((item) => item.id === model).length === 1) return true;
  }
  if (model.includes("/")) {
    if (candidate.harness === "pi") {
      return candidate.model === model;
    }
    if (!model.startsWith("anthropic/")) return false;
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

function applyCandidate(route: ResolvedRoute, selected: JevCandidate, constraints: JevConstraints): ResolvedRoute {
  const next = structuredClone(route);
  next.harness = constraints.harness ?? selected.harness;
  next.provenance.harness = constraints.provenance.harness ?? "jev";
  next.model = constraints.model ?? selected.model;
  next.provenance.model = constraints.provenance.model ?? "jev";
  next.thinking = constraints.thinking ?? selected.thinking;
  next.provenance.thinking = constraints.provenance.thinking ?? (selected.thinkingDefault ? "parent" : "jev");
  return next;
}

function encodeKey(harness: HarnessKind, model: string | undefined, thinking?: ThinkingLevel): string {
  return Buffer.from(JSON.stringify([harness, model ?? null, thinking ?? null])).toString("base64url");
}
function dedupe(candidates: JevCandidate[]): JevCandidate[] { return [...new Map(candidates.map((item) => [item.key, item])).values()] }
function fallback(route: ResolvedRoute, reason: string): JevRouteResult { return { route, used: false, fallback: bounded(reason, 240) } }
function routeFieldUnset(value: string | undefined): boolean { return value === undefined }
function bounded(value: string, max: number): string { return truncateText(value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim(), max) }
