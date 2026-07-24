import type { InstalledPlugin } from "../plugins/types.js";
import { loadPluginMcpConfig } from "./config-loader.js";
import { readMcpBridgeStore } from "./mcp-store.js";
import { scanMcpServerDiagnostics } from "./runtime-scanner.js";
import { mcpServerId, piMcpServerName, transformMcpServerConfig } from "./transform.js";
import type { PreparedMcpServer, SyncedMcpServer } from "./types.js";

export async function preparePluginMcpServers(plugin: InstalledPlugin): Promise<PreparedMcpServer[]> {
	const config = await loadPluginMcpConfig(plugin);
	const prepared: PreparedMcpServer[] = [];
	for (const [originalName, rawConfig] of Object.entries(config.mcpServers)) {
		const transformed = await transformMcpServerConfig(rawConfig, plugin);
		prepared.push({
			id: mcpServerId(plugin, originalName),
			plugin,
			originalName,
			piServerName: piMcpServerName(plugin, originalName),
			rawConfig,
			config: transformed,
			diagnostics: await scanMcpServerDiagnostics(rawConfig, transformed, plugin),
		});
	}
	return prepared.sort((a, b) => a.id.localeCompare(b.id));
}

export async function syncedServersById(): Promise<Map<string, SyncedMcpServer>> {
	const store = await readMcpBridgeStore();
	return new Map(store.servers.map((server) => [server.id, server]));
}
