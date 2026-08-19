import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionContext,
  ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent";
import type { McpStatusCounts, SubagentStatusCounts } from "./events.js";
import { calculateUsageTotals, type UsageTotals } from "./usage.js";

export interface FooterContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface FooterModel {
  sessionName?: string;
  mcp?: McpStatusCounts;
  path: string;
  branch: string | null;
  usage: UsageTotals;
  context: FooterContextUsage;
  modelName: string;
  provider?: string;
  providerCount: number;
  thinking: string;
  subagents?: SubagentStatusCounts;
  extensionStatuses: ReadonlyMap<string, string>;
}

export interface ToolboxStatusState {
  mcp?: McpStatusCounts;
  subagents?: SubagentStatusCounts;
}

export function formatPathForFooter(cwd: string, home = process.env.HOME ?? process.env.USERPROFILE): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  const insideHome = relativeToHome === ""
    || (relativeToHome !== ".." && !relativeToHome.startsWith(`..${sep}`) && !isAbsolute(relativeToHome));
  if (!insideHome) return cwd;
  return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
}

export function buildFooterModel(
  ctx: ExtensionContext,
  footerData: ReadonlyFooterDataProvider,
  status: ToolboxStatusState,
): FooterModel {
  const context = ctx.getContextUsage();
  return {
    sessionName: ctx.sessionManager.getSessionName(),
    mcp: status.mcp,
    path: formatPathForFooter(ctx.sessionManager.getCwd()),
    branch: footerData.getGitBranch(),
    usage: calculateUsageTotals(ctx.sessionManager.getEntries()),
    context: context ?? {
      tokens: null,
      contextWindow: ctx.model?.contextWindow ?? 0,
      percent: null,
    },
    modelName: ctx.model?.id ?? "no-model",
    provider: ctx.model?.provider,
    providerCount: footerData.getAvailableProviderCount(),
    thinking: ctx.model?.reasoning ? ctx.thinkingLevel ?? "off" : "off",
    subagents: status.subagents,
    extensionStatuses: footerData.getExtensionStatuses(),
  };
}
