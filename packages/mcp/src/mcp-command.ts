import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeAuthorizationUrl } from "./auth/coordinator.js";
import { writeMcpServerControls } from "./config-writer.js";
import { mcpStatusSnapshot, mcpStatusText } from "./mcp/status.js";
import type { McpRuntime } from "./runtime.js";
import { McpPanel, type McpPanelResult } from "./tui/mcp-panel.js";

export function registerMcpCommand(pi: ExtensionAPI, getRuntime: () => McpRuntime | undefined): void {
	pi.registerCommand("mcp", {
		description: "Inspect and configure MCP servers",
		getArgumentCompletions: () => null,
		handler: async (_args, ctx) => {
			const runtime = getRuntime();
			if (!runtime) {
				ctx.ui.notify("MCP is unavailable before session start.", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify(mcpStatusText(mcpStatusSnapshot(runtime)) ?? "No MCP servers configured.", "info");
				return;
			}

			const result = await ctx.ui.custom<McpPanelResult | null>((tui, theme, _keybindings, done) => {
				let unsubscribe: () => void = () => {};
				let finished = false;
				const finish = (value: McpPanelResult | null): void => {
					if (finished) return;
					finished = true;
					unsubscribe();
					done(value);
				};
				const panel = new McpPanel({
					theme,
					servers: mcpStatusSnapshot(runtime),
					onRender: () => tui.requestRender(),
					onDone: finish,
					onReconnect: async (server) => { await runtime.manager.connect(server, true); },
					onAuthenticate: async (server) => {
						if (!runtime.coordinator) throw new Error("OAuth unavailable");
						const result = await runtime.coordinator.begin(server);
						const authorizationUrl = safeAuthorizationUrl(result.authorizationUrl);
						await copyToClipboard(authorizationUrl);
						return `Authorization URL copied for ${server}; open it in your browser.`;
					},
				});
				unsubscribe = runtime.manager.onChange(() => panel.updateServers(mcpStatusSnapshot(runtime)));
				return panel;
			}, { overlay: true, overlayOptions: { width: "85%", minWidth: 60, maxHeight: "85%", anchor: "center", margin: 1 } });

			if (!result || !Object.keys(result.updates).length) return;
			try {
				await writeMcpServerControls(result.updates);
			} catch {
				ctx.ui.notify("MCP configuration could not be saved; the existing file was not changed.", "error");
				return;
			}
			ctx.ui.notify("MCP configuration saved. Reloading…", "info");
			await ctx.reload();
			return;
		},
	});
}
