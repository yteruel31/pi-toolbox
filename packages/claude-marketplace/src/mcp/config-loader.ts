import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstalledPlugin } from "../plugins/types.js";
import type { ClaudeMcpConfig, McpServerConfig } from "./types.js";

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function normalizeMcpServers(value: unknown): Record<string, McpServerConfig> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const servers: Record<string, McpServerConfig> = {};
	for (const [name, config] of Object.entries(value as Record<string, unknown>)) {
		if (config && typeof config === "object" && !Array.isArray(config)) servers[name] = config as McpServerConfig;
	}
	return servers;
}

export async function loadPluginMcpConfig(plugin: InstalledPlugin): Promise<ClaudeMcpConfig> {
	const fileConfig = await readJsonObject(join(plugin.cachePath, ".mcp.json"));
	const fileServers = normalizeMcpServers(fileConfig?.mcpServers);
	if (Object.keys(fileServers).length > 0) return { mcpServers: fileServers };

	const pluginManifest =
		(await readJsonObject(join(plugin.cachePath, ".claude-plugin", "plugin.json"))) ?? (await readJsonObject(join(plugin.cachePath, "plugin.json")));
	return { mcpServers: normalizeMcpServers(pluginManifest?.mcpServers) };
}
