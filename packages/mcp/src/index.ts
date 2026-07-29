import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** U1 intentionally registers no lifecycle hooks, tools, commands, or resources. */
export default function mcpExtension(_pi: ExtensionAPI): void {}

export { DEFAULT_UI_SETTINGS, getMcpConfigPaths, loadMcpConfig } from "./config.js";
export type { ConfigDiagnostic, McpConfig, McpServerDefinition, McpUiSettings } from "./config.js";
