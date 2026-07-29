import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerGatewayCommand } from "./commands.js";

/** Registers only a lazy command; no process, socket, listener, or Tailscale mutation occurs at load. */
export default function mcpExtension(pi: ExtensionAPI): void {
	registerGatewayCommand(pi);
}

export { DEFAULT_UI_SETTINGS, getMcpConfigPaths, loadMcpConfig } from "./config.js";
export type { ConfigDiagnostic, McpConfig, McpServerDefinition, McpUiSettings } from "./config.js";
export { GatewayClient } from "./gateway/client.js";
export { TailscaleAdapter } from "./tailscale.js";
