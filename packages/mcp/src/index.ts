import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGatewayCommand } from "./commands.js";
import { loadMcpConfig } from "./config.js";
import { McpRuntime, registerMcpTool } from "./runtime.js";
import { appStatusText } from "./apps/status.js";
import { DirectToolRegistry } from "./mcp/direct-tools.js";
import { registerMcpCommand } from "./mcp-command.js";
import { mcpStatusSnapshot, mcpStatusText } from "./mcp/status.js";

/** Registers lazy entry points; no process, socket, listener, timer, or network occurs at load. */
export default function mcpExtension(pi: ExtensionAPI): void {
	let runtime: McpRuntime | undefined;
	let unsubscribeStatus: (() => void) | undefined;
	let lifecycle: Promise<void> = Promise.resolve();
	const enqueueLifecycle = (operation: () => Promise<void>): Promise<void> => {
		const next = lifecycle.catch(() => undefined).then(operation);
		lifecycle = next;
		return next;
	};
	const directTools = new DirectToolRegistry(pi);
	registerGatewayCommand(pi);
	registerMcpCommand(pi, () => runtime);
	registerMcpTool(pi, () => runtime);
	pi.on("session_start", (_event, ctx) => enqueueLifecycle(async () => {
		const previous = runtime;
		unsubscribeStatus?.(); unsubscribeStatus = undefined;
		directTools.detach(previous);
		if (previous) await previous.close();
		ctx?.ui.setStatus("mcp-ui", undefined);
		ctx?.ui.setStatus("mcp-status", undefined);
		runtime = new McpRuntime(loadMcpConfig(), undefined, undefined, undefined, {
			context: ctx,
			onUiStatus: (status) => {
				ctx?.ui.setStatus("mcp-ui", status ? appStatusText(status) : undefined);
			},
		});
		directTools.attach(runtime);
		const current = runtime;
		const renderStatus = (): void => {
			if (runtime !== current) return;
			const servers = mcpStatusSnapshot(current);
			const text = mcpStatusText(servers);
			const warning = servers.some((server) => server.state === "auth-required" || server.state === "error" || server.state === "invalid");
			ctx?.ui.setStatus("mcp-status", text ? ctx.ui.theme.fg(warning ? "warning" : "muted", text) : undefined);
		};
		unsubscribeStatus = current.manager.onChange(renderStatus);
		renderStatus();
		directTools.startDiscovery(current);
	}));
	pi.on("session_shutdown", (_event, ctx) => enqueueLifecycle(async () => {
		const previous = runtime;
		runtime = undefined;
		unsubscribeStatus?.(); unsubscribeStatus = undefined;
		directTools.detach(previous);
		await previous?.close();
		ctx?.ui.setStatus("mcp-ui", undefined);
		ctx?.ui.setStatus("mcp-status", undefined);
	}));
}

export { DEFAULT_UI_SETTINGS, getMcpConfigPaths, loadMcpConfig } from "./config.js";
export type { ConfigDiagnostic, DirectToolsSetting, McpConfig, McpServerControls, McpServerDefinition, McpUiSettings } from "./config.js";
export { GatewayClient } from "./gateway/client.js";
export { TailscaleAdapter } from "./tailscale.js";
export { McpAppController } from "./apps/controller.js";
export { appResourceUri, selectAppResource } from "./apps/resource.js";
