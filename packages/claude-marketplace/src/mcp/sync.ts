import { piMcpAdapterConfigPath } from "../state/paths.js";
import { readMcpBridgeStore, removeSyncedMcpServers, upsertSyncedMcpServers } from "./mcp-store.js";
import { readPiMcpAdapterConfig, writePiMcpAdapterConfig } from "./pi-mcp-config.js";
import { preparePluginMcpServers } from "./status.js";
import type { InstalledPlugin } from "../plugins/types.js";
import type { PreparedMcpServer, SyncedMcpServer } from "./types.js";

export type SyncResult = {
	servers: SyncedMcpServer[];
	adapterConfigPath: string;
};

export type UnsyncResult = {
	servers: SyncedMcpServer[];
	adapterConfigPath: string;
};

export async function preparePluginsForMcpSync(plugins: InstalledPlugin[]): Promise<PreparedMcpServer[]> {
	const prepared: PreparedMcpServer[] = [];
	for (const plugin of plugins) prepared.push(...(await preparePluginMcpServers(plugin)));
	return prepared;
}

export async function syncPreparedMcpServers(prepared: PreparedMcpServer[]): Promise<SyncResult> {
	const adapterConfigPath = piMcpAdapterConfigPath();
	const adapterConfig = await readPiMcpAdapterConfig();
	const bridgeStore = await readMcpBridgeStore();
	const managedByPiName = new Map(bridgeStore.servers.map((server) => [server.piServerName, server]));
	const adapterServers = adapterConfig.mcpServers ?? {};

	for (const server of prepared) {
		const existing = adapterServers[server.piServerName];
		const managed = managedByPiName.get(server.piServerName);
		if (existing && !managed) {
			throw new Error(`Refusing to overwrite existing MCP server ${server.piServerName} in ${adapterConfigPath}.`);
		}
	}

	const now = new Date().toISOString();
	const synced = prepared.map<SyncedMcpServer>((server) => ({
		id: server.id,
		piServerName: server.piServerName,
		marketplace: server.plugin.marketplace,
		plugin: server.plugin.name,
		pluginVersion: server.plugin.version,
		originalServer: server.originalName,
		syncedAt: now,
		adapterConfigPath,
		directTools: server.config.directTools ?? false,
		lifecycle: server.config.lifecycle ?? "lazy",
	}));

	for (const server of prepared) adapterServers[server.piServerName] = server.config;
	await writePiMcpAdapterConfig({ ...adapterConfig, mcpServers: adapterServers });
	await upsertSyncedMcpServers(synced);
	return { servers: synced, adapterConfigPath };
}

export async function unsyncMcpServers(ids: string[]): Promise<UnsyncResult> {
	const adapterConfigPath = piMcpAdapterConfigPath();
	const bridgeStore = await readMcpBridgeStore();
	const idSet = new Set(ids);
	const targets = bridgeStore.servers.filter((server) => idSet.has(server.id));
	if (targets.length === 0) return { servers: [], adapterConfigPath };

	const adapterConfig = await readPiMcpAdapterConfig();
	const adapterServers = adapterConfig.mcpServers ?? {};
	for (const server of targets) delete adapterServers[server.piServerName];
	await writePiMcpAdapterConfig({ ...adapterConfig, mcpServers: adapterServers });
	await removeSyncedMcpServers(targets.map((server) => server.id));
	return { servers: targets, adapterConfigPath };
}
