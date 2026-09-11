import { copyToClipboard, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeAuthorizationUrl } from "./auth/coordinator.js";
import { GatewayConfiguration, gatewayAgentPrompt } from "./commands.js";
import { writeMcpServerControls } from "./config-writer.js";
import { mcpStatusSnapshot, mcpStatusText } from "./mcp/status.js";
import type { McpRuntime } from "./runtime.js";
import { ConfigurationPanel, type ConfigurationPanelResult, type ConfigurationSection } from "./tui/configuration-panel.js";

export function registerMcpCommand(
	pi: ExtensionAPI,
	getRuntime: () => McpRuntime | undefined,
	gateway = new GatewayConfiguration(),
): void {
	pi.registerCommand("mcp", {
		description: "Configure MCP servers, gateway publication, and diagnostics",
		getArgumentCompletions: () => null,
		handler: async (_args, ctx) => {
			let section: ConfigurationSection = "Servers";
			for (;;) {
				const runtime = getRuntime();
				if (!runtime) {
					ctx.ui.notify("MCP is unavailable before session start. Run /reload if maintenance failed.", "error");
					return;
				}
				if (ctx.mode !== "tui") {
					ctx.ui.notify(`${mcpStatusText(mcpStatusSnapshot(runtime)) ?? "No MCP servers configured."}\nGateway: ${gateway.status().mode}. Use the mcp gateway actions for diagnostics and validated configuration.`, "info");
					return;
				}

				const result = await ctx.ui.custom<ConfigurationPanelResult | null>((tui, theme, _keybindings, done) => {
					let unsubscribe: () => void = () => {};
					const panel = new ConfigurationPanel({
						theme, section,
						report: gateway.latest(),
						maxRows: () => Math.min(26, Math.max(1, Math.floor(tui.terminal.rows * 0.85) - 2)),
						servers: mcpStatusSnapshot(runtime),
						gatewayConfigured: runtime.gatewayConfigured,
						onRender: () => tui.requestRender(),
						onDone: done,
						onDispose: () => unsubscribe(),
						onValidate: () => gateway.validate(),
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
				}, { overlay: true, overlayOptions: { width: "80%", minWidth: 48, maxHeight: "85%", anchor: "center", margin: 1 } });

				if (!result) return;
				if ("action" in result) {
					if (result.action === "custom" || result.action === "repair") {
						// Await custom() disposal before starting/queuing the current agent's conversation.
						pi.sendUserMessage(gatewayAgentPrompt(result.action, gateway.latest()), { deliverAs: "followUp" });
						return;
					}
					if (result.action === "tailscale") await gateway.configure({ mode: "tailscale" }, ctx);
					else if (result.action === "remove") await gateway.deactivate(ctx);
					else await gateway.validate();
					section = "Diagnostics";
					continue;
				}
				if (!Object.keys(result.updates).length) return;
				try { await writeMcpServerControls(result.updates); }
				catch {
					ctx.ui.notify("MCP configuration could not be saved; the existing file was not changed.", "error");
					return;
				}
				ctx.ui.notify("MCP configuration saved. Reloading…", "info");
				await ctx.reload();
				return;
			}
		},
	});
}
