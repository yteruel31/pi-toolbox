import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  MCP_STATUS_CHANNEL,
  SUBAGENTS_STATUS_CHANNEL,
  readMcpStatusEvent,
  readSubagentStatusEvent,
} from "./events.js";
import { buildFooterModel, type ToolboxStatusState } from "./model.js";
import { renderFooter } from "./render.js";

export default function uiCustomizationExtension(pi: ExtensionAPI): void {
  const status: ToolboxStatusState = {};
  let enabled = true;
  let requestRender: (() => void) | undefined;

  const installFooter = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI || !enabled) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      requestRender = () => tui.requestRender();
      const unsubscribeBranch = footerData.onBranchChange(requestRender);
      return {
        invalidate(): void {},
        dispose(): void {
          unsubscribeBranch();
          requestRender = undefined;
        },
        render(width: number): string[] {
          return renderFooter(buildFooterModel(ctx, footerData, status), theme, width);
        },
      };
    });
  };

  pi.events.on(MCP_STATUS_CHANNEL, (payload) => {
    const counts = readMcpStatusEvent(payload);
    if (counts === undefined) return;
    if (counts === null) delete status.mcp;
    else status.mcp = counts;
    requestRender?.();
  });

  pi.events.on(SUBAGENTS_STATUS_CHANNEL, (payload) => {
    const counts = readSubagentStatusEvent(payload);
    if (counts === undefined) return;
    if (counts === null) delete status.subagents;
    else status.subagents = counts;
    requestRender?.();
  });

  pi.on("session_start", (_event, ctx) => installFooter(ctx));

  pi.on("session_info_changed", () => requestRender?.());
  pi.on("model_select", () => requestRender?.());
  pi.on("thinking_level_select", () => requestRender?.());
  pi.on("message_end", () => requestRender?.());
  pi.on("turn_end", () => requestRender?.());

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.hasUI && enabled) ctx.ui.setFooter(undefined);
    requestRender = undefined;
    delete status.mcp;
    delete status.subagents;
  });

  pi.registerCommand("footer", {
    description: "Toggle the structured Pi Toolbox footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      if (enabled) installFooter(ctx);
      else ctx.ui.setFooter(undefined);
      ctx.ui.notify(enabled ? "Structured footer enabled" : "Default footer restored", "info");
    },
  });
}

export {
  MCP_STATUS_CHANNEL,
  SUBAGENTS_STATUS_CHANNEL,
  readMcpStatusEvent,
  readSubagentStatusEvent,
} from "./events.js";
export type {
  McpStatusCounts,
  SubagentStatusCounts,
  ToolboxStatusEvent,
} from "./events.js";
export { buildFooterModel, formatPathForFooter } from "./model.js";
export type { FooterModel, ToolboxStatusState } from "./model.js";
export { renderFooter } from "./render.js";
export { calculateUsageTotals, formatTokens } from "./usage.js";
