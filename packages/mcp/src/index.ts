import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGatewayCommand } from "./commands.js";
import { loadMcpConfig } from "./config.js";
import { McpRuntime, registerMcpTool } from "./runtime.js";

/** Registers lazy entry points; no process, socket, listener, timer, or network occurs at load. */
export default function mcpExtension(pi: ExtensionAPI): void {
	let runtime: McpRuntime | undefined;
	registerGatewayCommand(pi);
	registerMcpTool(pi, () => runtime);
	pi.on("session_start", async () => {
		await runtime?.manager.close();
		runtime = new McpRuntime(loadMcpConfig());
	});
	pi.on("session_shutdown", async () => {
		const previous = runtime;
		runtime = undefined;
		await previous?.manager.close();
	});
}

export { DEFAULT_UI_SETTINGS, getMcpConfigPaths, loadMcpConfig } from "./config.js";
export type { ConfigDiagnostic, McpConfig, McpServerDefinition, McpUiSettings } from "./config.js";
export { GatewayClient } from "./gateway/client.js";
export { TailscaleAdapter } from "./tailscale.js";
