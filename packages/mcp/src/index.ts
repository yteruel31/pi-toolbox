import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGatewayCommand } from "./commands.js";
import { loadMcpConfig } from "./config.js";
import { McpRuntime, registerMcpTool } from "./runtime.js";
import { appStatusText } from "./apps/status.js";
import { DirectToolRegistry } from "./mcp/direct-tools.js";

/** Registers lazy entry points; no process, socket, listener, timer, or network occurs at load. */
export default function mcpExtension(pi: ExtensionAPI): void {
	let runtime: McpRuntime | undefined;
	const directTools = new DirectToolRegistry(pi);
	registerGatewayCommand(pi);
	registerMcpTool(pi, () => runtime);
	pi.on("session_start", async (_event, ctx) => {
		const previous = runtime;
		directTools.detach(previous);
		if (previous) await previous.close();
		ctx?.ui.setStatus("mcp-ui", undefined);
		runtime = new McpRuntime(loadMcpConfig(), undefined, undefined, undefined, {
			context: ctx,
			onUiStatus: (status) => {
				ctx?.ui.setStatus("mcp-ui", status ? appStatusText(status) : undefined);
			},
		});
		directTools.attach(runtime);
		directTools.startDiscovery(runtime);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		const previous = runtime;
		runtime = undefined;
		directTools.detach(previous);
		await previous?.close();
		ctx?.ui.setStatus("mcp-ui", undefined);
	});
}

export { DEFAULT_UI_SETTINGS, getMcpConfigPaths, loadMcpConfig } from "./config.js";
export type { ConfigDiagnostic, DirectToolsSetting, McpConfig, McpServerDefinition, McpUiSettings } from "./config.js";
export { GatewayClient } from "./gateway/client.js";
export { TailscaleAdapter } from "./tailscale.js";
export { McpAppController } from "./apps/controller.js";
export { appResourceUri, selectAppResource } from "./apps/resource.js";
