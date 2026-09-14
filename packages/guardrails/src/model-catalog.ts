import { getSupportedThinkingLevels, type Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.js";

export const modelRoute = (model: Model<any>): string => `${model.provider}/${model.id}`;
export interface JudgeCatalog {
  models: Model<any>[];
  activeRoute?: string;
}
/** Local configured-auth availability only. Never refresh providers or resolve credentials. */
export function judgeCatalog(ctx: ExtensionContext): JudgeCatalog {
  const scoped = new Set(ctx.scopedModels.map(({ model }) => modelRoute(model)));
  return {
    models: ctx.modelRegistry.getAvailable().filter((model) => !scoped.size || scoped.has(modelRoute(model))),
    activeRoute: ctx.model ? modelRoute(ctx.model) : undefined,
  };
}
export function selectedJudge(catalog: JudgeCatalog, route: string): Model<any> | undefined {
  return catalog.models.find((model) => modelRoute(model) === (route || catalog.activeRoute));
}
export function judgeThinking(catalog: JudgeCatalog, config: Pick<Config, "model">): Config["thinking"][] {
  const model = selectedJudge(catalog, config.model);
  return model ? getSupportedThinkingLevels(model) : [];
}
export interface ModelChoice { value: string; label: string; description?: string; unavailable?: boolean }
export function judgeChoices(catalog: JudgeCatalog, saved: string): ModelChoice[] {
  const choices: ModelChoice[] = [{ value: "", label: "Follow active parent model", description: catalog.activeRoute ?? "No active parent model" }];
  if (saved && !selectedJudge(catalog, saved)) choices.push({ value: saved, label: saved, description: "Saved route unavailable or outside scope; retained", unavailable: true });
  choices.push(...catalog.models.map((model) => ({ value: modelRoute(model), label: modelRoute(model), description: `${model.name || model.id}${modelRoute(model) === catalog.activeRoute ? " (active parent)" : ""}` })));
  return choices;
}
