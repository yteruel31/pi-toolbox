import type { InstalledPlugin } from "../plugins/types.js";

export type McpServerConfig = Record<string, unknown> & {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	lifecycle?: "lazy" | "eager" | "keep-alive";
	directTools?: boolean | string[];
};

export type ClaudeMcpConfig = {
	mcpServers: Record<string, McpServerConfig>;
};

export type EnvReference = {
	name: string;
	defaultValue?: string;
	missing: boolean;
	source: "process" | "marketplace-env" | "default" | "missing";
};

export type RuntimeDiagnostic = {
	command: string;
	available: boolean;
};

export type McpServerDiagnostics = {
	localCode: boolean;
	serverDirectory?: string;
	env: EnvReference[];
	runtimes: RuntimeDiagnostic[];
	files: string[];
	riskNotes: string[];
};

export type PreparedMcpServer = {
	id: string;
	plugin: InstalledPlugin;
	originalName: string;
	piServerName: string;
	rawConfig: McpServerConfig;
	config: McpServerConfig;
	diagnostics: McpServerDiagnostics;
};

export type SyncedMcpServer = {
	id: string;
	piServerName: string;
	marketplace: string;
	plugin: string;
	pluginVersion: string;
	originalServer: string;
	syncedAt: string;
	adapterConfigPath: string;
	directTools: boolean | string[];
	lifecycle: string;
};

export type McpBridgeStore = {
	version: 1;
	servers: SyncedMcpServer[];
};
