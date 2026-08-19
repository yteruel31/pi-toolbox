import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { parseDirectTools, type DirectToolsSetting, type McpConfig } from "../config.js";
import type { ServerState } from "./manager.js";
import { isDirectToolCandidate } from "./direct-tools.js";
import type { McpRuntime } from "../runtime.js";

export type McpDisplayState = ServerState | "disabled" | "invalid";
export interface McpStatusTool {
	name: string;
	description?: string;
	selected: boolean;
}
export interface McpStatusServer {
	name: string;
	state: McpDisplayState;
	transport: "http" | "sse" | "stdio" | "invalid";
	directTools: DirectToolsSetting;
	tools: McpStatusTool[];
	counts: { tools: number; resources: number; resourceTemplates: number; prompts: number };
}

function selected(setting: DirectToolsSetting, name: string): boolean {
	return setting === true || Array.isArray(setting) && setting.includes(name);
}

function effectiveDirectTools(runtime: McpRuntime, name: string): DirectToolsSetting {
	const parsed = runtime.serverConfigs.get(name)?.directTools;
	if (parsed !== undefined) return parsed;
	const raw = runtime.config.mcpServers[name]?.directTools;
	if (raw === undefined) return runtime.config.settings.directTools ?? false;
	return parseDirectTools(raw) ?? false;
}

function transport(config: McpConfig, name: string): McpStatusServer["transport"] {
	const raw = config.mcpServers[name];
	if (typeof raw?.command === "string") return "stdio";
	const marker = raw?.transport ?? raw?.type;
	if (typeof raw?.url !== "string") return "invalid";
	return typeof marker === "string" && marker.toLowerCase().includes("sse") ? "sse" : "http";
}

function visibleTools(server: string, tools: Tool[], setting: DirectToolsSetting): McpStatusTool[] {
	return tools.filter((tool) => isDirectToolCandidate(server, tool)).map((tool) => ({
		name: tool.name,
		...(tool.description ? { description: tool.description.slice(0, 2_000) } : {}),
		selected: selected(setting, tool.name),
	}));
}

export function mcpStatusSnapshot(runtime: McpRuntime): McpStatusServer[] {
	const current = new Map(runtime.manager.status().map((server) => [server.name, server]));
	return Object.keys(runtime.config.mcpServers).sort((a, b) => a.localeCompare(b)).map((name) => {
		const setting = effectiveDirectTools(runtime, name);
		const server = current.get(name);
		const state: McpDisplayState = runtime.disabledServers.has(name)
			? "disabled"
			: !server
				? "invalid"
				: server.state;
		const tools = server ? visibleTools(name, runtime.manager.modelTools(name), setting) : [];
		return {
			name,
			state,
			transport: transport(runtime.config, name),
			directTools: setting,
			tools,
			counts: {
				tools: server?.tools.length ?? 0,
				resources: server?.resources.length ?? 0,
				resourceTemplates: server?.resourceTemplates.length ?? 0,
				prompts: server?.prompts.length ?? 0,
			},
		};
	});
}

/** Aggregate server totals behind the footer text; `total` is every configured server. */
export interface McpStatusCounts {
	total: number;
	/** Every server that is not disabled, connected or not. */
	enabled: number;
	connected: number;
	authRequired: number;
	/** `error` plus `invalid` states. */
	errors: number;
	disabled: number;
}

export function mcpStatusCounts(servers: readonly McpStatusServer[]): McpStatusCounts {
	return {
		total: servers.length,
		enabled: servers.filter((server) => server.state !== "disabled").length,
		connected: servers.filter((server) => server.state === "connected").length,
		authRequired: servers.filter((server) => server.state === "auth-required").length,
		errors: servers.filter((server) => server.state === "error" || server.state === "invalid").length,
		disabled: servers.filter((server) => server.state === "disabled").length,
	};
}

export function mcpStatusText(servers: readonly McpStatusServer[]): string | undefined {
	if (!servers.length) return undefined;
	const counts = mcpStatusCounts(servers);
	let text = `MCP ${counts.connected}/${counts.enabled}`;
	if (counts.authRequired) text += ` · ${counts.authRequired} auth`;
	if (counts.errors) text += ` · ${counts.errors} err`;
	if (counts.disabled) text += ` · ${counts.disabled} off`;
	return text;
}

/** Event bus channel carrying `McpStatusEvent` for footer/status consumers. */
export const MCP_STATUS_CHANNEL = "pi-toolbox:mcp:status";

/** Versioned status payload; `counts: null` clears stale state (session start, shutdown). */
export type McpStatusEvent = { v: 1; counts: McpStatusCounts } | { v: 1; counts: null };
