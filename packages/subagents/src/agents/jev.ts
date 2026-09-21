import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ClaudeSupportedModel } from "../harnesses/claude.js";
import { describeError } from "../shared/errors.js";
import { truncateText } from "../shared/truncate.js";
import type { HarnessKind, ThinkingLevel } from "../shared/types.js";
import type { ResolvedRoute, RouteFieldProvenance } from "./types.js";

export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";
export const JEV_TIMEOUT_MS = 5_000;
export const JEV_MAX_CHOICES = 255;

export interface JevConfig {
  enabled: boolean;
  credential?: string;
}

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
  piModels: readonly Model<any>[];
  claudeModels: readonly ClaudeSupportedModel[];
  apiKey: string;
  signal?: AbortSignal;
}

export interface JevRouteResult {
  route: ResolvedRoute;
  used: boolean;
  fallback?: string;
}

export type JevFetch = typeof fetch;

const CURATED: Record<string, string> = {
  "gpt-6-astra": "Best for the hardest end-to-end coding, application, research, and judgment work.",
  "gpt-5.6-sol": "Strong for complex or ambiguous coding, computer use, research, and security work.",
  "gpt-5.6-terra": "Balanced everyday coding model with lower cost.",
  "gpt-5.6-luna": "Fast choice for repeatable extraction, classification, and transformations.",
  "claude-fable-5-1": "Demanding long-horizon reasoning model with always-on thinking.",
  "claude-opus-5": "Strong for moderately complex agentic coding.",
  "claude-sonnet-5": "Fast model balancing speed and intelligence.",
  "claude-haiku-4-5": "Fastest Claude option; effort controls aren't supported.",
};

/** Internal metadata only. Sources verified 2026-09-21. */
export const JEV_METADATA_SOURCES = [
  "https://learn.chatgpt.com/docs/models",
  "https://platform.claude.com/docs/en/models/overview",
  "https://platform.claude.com/docs/en/build-with-claude/effort",
] as const;

export function buildJevCandidates(
  piModels: readonly Model<any>[],
  claudeModels: readonly ClaudeSupportedModel[],
  fixedHarness?: HarnessKind,
): JevCandidate[] {
  const candidates: JevCandidate[] = [];
  if (!fixedHarness || fixedHarness === "pi") {
    for (const model of piModels) {
      const modelName = `${model.provider}/${model.id}`;
      const levels = getSupportedThinkingLevels(model);
      const choices = levels.length > 0 ? levels : [undefined];
      for (const thinking of choices) {
        candidates.push(candidate("pi", modelName, thinking, model.name));
      }
    }
  }
  if (!fixedHarness || fixedHarness === "claude") {
    for (const model of claudeModels) {
      const modelName = model.value;
      const levels = model.supportsEffort
        ? normalizeClaudeEfforts(model.supportedEffortLevels)
        : [undefined];
      for (const thinking of levels) {
        candidates.push(candidate("claude", modelName, thinking, model.displayName));
      }
    }
  }
  return dedupe(candidates);
}

export async function routeWithJev(
  input: JevRouteInput,
  fetchImpl: JevFetch = fetch,
): Promise<JevRouteResult> {
  const fixedHarness = fixed(input.route.provenance.harness) ? input.route.harness : undefined;
  const fixedModel = fixed(input.route.provenance.model) ? input.route.model : undefined;
  const fixedThinking = fixed(input.route.provenance.thinking) ? input.route.thinking : undefined;

  if (fixedModel && fixedThinking) return { route: input.route, used: false };
  let candidates = buildJevCandidates(input.piModels, input.claudeModels, fixedHarness);
  if (fixedModel) candidates = candidates.filter((item) => modelMatches(item, fixedModel));
  if (fixedThinking) candidates = candidates.filter((item) => item.thinking === fixedThinking);
  if (candidates.length === 0) return fallback(input.route, "No compatible available route was found.");
  if (candidates.length === 1) return { route: applyCandidate(input.route, candidates[0]!), used: false };
  if (candidates.length > JEV_MAX_CHOICES) {
    return fallback(input.route, `Jev routing has ${candidates.length} valid choices, above the ${JEV_MAX_CHOICES} service limit.`);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, JEV_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();
  try {
    const criteria = Object.fromEntries(candidates.map((item) => [item.key, item.description]));
    const response = await fetchImpl(JEV_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${input.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({
        state: { task: bounded(input.task, 20_000), role: bounded(input.role ?? "generic subagent", 500) },
        model: JEV_MODEL,
        questions: {
          route: {
            type: "choice",
            instructions: "Choose the available route that best balances capability and thinking effort for this task. Match task difficulty; don't maximize quality by default and don't optimize only for cost. Respect every explicit compatibility constraint encoded in the choices.",
            criteria,
          },
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) return fallback(input.route, `Jev returned HTTP ${response.status}.`);
    const raw: unknown = await response.json();
    const choice = parseChoice(raw);
    const selected = candidates.find((item) => item.key === choice);
    if (!selected) return fallback(input.route, "Jev returned an unavailable route.");
    return { route: applyCandidate(input.route, selected), used: true };
  } catch (error) {
    if (input.signal?.aborted) throw error;
    return fallback(input.route, timedOut ? "Jev routing timed out after 5 seconds." : `Jev routing failed: ${bounded(describeError(error), 180)}`);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

function candidate(harness: HarnessKind, model: string, thinking: ThinkingLevel | undefined, discovered: string): JevCandidate {
  const id = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const description = CURATED[id] ?? CURATED[model] ?? discovered;
  const effort = thinking ? ` Thinking/effort ${thinking}.` : " No selectable thinking/effort value.";
  return { key: encodeKey(harness, model, thinking), harness, model, thinking, description: `${description}${effort}` };
}

function normalizeClaudeEfforts(levels: ClaudeSupportedModel["supportedEffortLevels"]): Array<ThinkingLevel | undefined> {
  if (!levels?.length) return [undefined];
  return levels.filter((level): level is Exclude<ThinkingLevel, "off" | "minimal"> =>
    ["low", "medium", "high", "xhigh", "max"].includes(level));
}

function fixed(provenance: RouteFieldProvenance): boolean {
  return provenance === "explicit" || provenance === "saved-project" || provenance === "saved-user";
}

function modelMatches(candidate: JevCandidate, model: string): boolean {
  return candidate.model === model || candidate.model.endsWith(`/${model}`) || model.endsWith(`/${candidate.model}`);
}

function applyCandidate(route: ResolvedRoute, selected: JevCandidate): ResolvedRoute {
  const next = structuredClone(route);
  if (!fixed(route.provenance.harness)) { next.harness = selected.harness; next.provenance.harness = "jev"; }
  if (!fixed(route.provenance.model)) { next.model = selected.model; next.provenance.model = "jev"; }
  if (!fixed(route.provenance.thinking)) { next.thinking = selected.thinking; next.provenance.thinking = "jev"; }
  return next;
}

function parseChoice(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const answers = (value as { answers?: unknown }).answers;
  if (!answers || typeof answers !== "object") return undefined;
  const route = (answers as { route?: unknown }).route;
  if (!route || typeof route !== "object") return undefined;
  return typeof (route as { choice?: unknown }).choice === "string" ? (route as { choice: string }).choice : undefined;
}

function encodeKey(harness: HarnessKind, model: string, thinking?: ThinkingLevel): string {
  return Buffer.from(JSON.stringify([harness, model, thinking ?? null])).toString("base64url");
}

function dedupe(candidates: JevCandidate[]): JevCandidate[] {
  return [...new Map(candidates.map((item) => [item.key, item])).values()];
}

function fallback(route: ResolvedRoute, reason: string): JevRouteResult {
  return { route, used: false, fallback: bounded(reason, 240) };
}

function bounded(value: string, max: number): string {
  return truncateText(value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim(), max);
}
