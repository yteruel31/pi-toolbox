import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  listClaudeSupportedModels,
  type ClaudeModelCatalogOptions,
  type ClaudeSupportedModel,
} from "../harnesses/claude.js";
import { describeError } from "../shared/errors.js";
import { sanitizeTerminalText, truncateText } from "../shared/truncate.js";
import type {
  RoutingModelCatalog,
  RoutingModelChoice,
} from "./routing-editor.js";

const MAX_ROUTING_MODEL_CATALOG_ITEMS = 256;

export interface RoutingModelCatalogDependencies {
  listClaudeModels?(
    options: ClaudeModelCatalogOptions,
  ): Promise<readonly ClaudeSupportedModel[]>;
}

export interface LoadedRoutingModelCatalog {
  catalog: RoutingModelCatalog;
  claudeWarning?: string;
}

/** Build harness-specific picker values without hard-coding either catalogue. */
export async function loadRoutingModelCatalog(
  ctx: ExtensionContext,
  dependencies: RoutingModelCatalogDependencies = {},
): Promise<LoadedRoutingModelCatalog> {
  const scoped = ctx.scopedModels ?? [];
  const piModels = scoped.length > 0
    ? scoped.map((entry) => ({
        model: entry.model,
        thinking: entry.thinkingLevel,
      }))
    : ctx.modelRegistry.getAvailable().map((model) => ({
        model,
        thinking: undefined,
      }));
  const pi = dedupeModelChoices(piModels.map(({ model, thinking }) => {
    const value = modelChoiceValue(`${model.provider}/${model.id}`);
    const name = boundedCatalogText(model.name, 120);
    const bareId = modelChoiceValue(model.id);
    const description = [
      name && name !== value ? value : "",
      thinking ? `Scoped thinking: ${thinking}` : "",
    ].filter(Boolean).join(" · ");
    return {
      value,
      label: name || value,
      ...(description ? { description } : {}),
      ...(bareId && bareId !== value ? { aliases: [bareId] } : {}),
      ...(thinking ? { thinking } : {}),
    };
  }));

  try {
    const listModels = dependencies.listClaudeModels ?? listClaudeSupportedModels;
    const supported = await listModels({ cwd: ctx.cwd });
    if (supported.length > MAX_ROUTING_MODEL_CATALOG_ITEMS) {
      throw new Error(
        `Claude model discovery returned more than ${MAX_ROUTING_MODEL_CATALOG_ITEMS} entries.`,
      );
    }
    const claude = dedupeModelChoices(supported.map((model) => {
      const value = modelChoiceValue(model.value);
      const label = boundedCatalogText(model.displayName, 120) || value;
      const detail = boundedCatalogText(model.description, 300);
      const description = [value, detail].filter(Boolean).join(" · ");
      const resolvedModel = model.resolvedModel
        ? modelChoiceValue(model.resolvedModel)
        : "";
      return {
        value,
        label,
        ...(description ? { description } : {}),
        ...(resolvedModel && resolvedModel !== value
          ? { aliases: [resolvedModel] }
          : {}),
      };
    }));
    return { catalog: { pi, claude } };
  } catch (error) {
    return {
      catalog: { pi, claude: [] },
      claudeWarning: boundedCatalogText(describeError(error), 300) || "Unknown error.",
    };
  }
}

function dedupeModelChoices(
  choices: readonly RoutingModelChoice[],
): RoutingModelChoice[] {
  const seen = new Set<string>();
  const result: RoutingModelChoice[] = [];
  for (const choice of choices) {
    if (!choice.value || seen.has(choice.value)) continue;
    seen.add(choice.value);
    result.push(choice);
  }
  return result;
}

function modelChoiceValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 200 ||
    /\s/.test(trimmed) ||
    sanitizeTerminalText(trimmed) !== trimmed
  ) {
    return "";
  }
  return trimmed;
}

function boundedCatalogText(value: string, maxChars: number): string {
  return truncateText(
    sanitizeTerminalText(value).replace(/\s+/g, " ").trim(),
    maxChars,
  );
}
