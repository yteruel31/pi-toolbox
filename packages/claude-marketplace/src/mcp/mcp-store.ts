import { mcpBridgeStorePath } from "../state/paths.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { McpBridgeStore, SyncedMcpServer } from "./types.js";

const EMPTY_STORE: McpBridgeStore = { version: 1, servers: [] };

function normalize(store: McpBridgeStore): McpBridgeStore {
	return { version: 1, servers: Array.isArray(store.servers) ? store.servers : [] };
}

export async function readMcpBridgeStore(): Promise<McpBridgeStore> {
	return normalize(await readJsonFile<McpBridgeStore>(mcpBridgeStorePath(), EMPTY_STORE));
}

export async function writeMcpBridgeStore(store: McpBridgeStore): Promise<void> {
	await writeJsonFile(mcpBridgeStorePath(), normalize(store));
}

export async function upsertSyncedMcpServers(servers: SyncedMcpServer[]): Promise<McpBridgeStore> {
	const store = await readMcpBridgeStore();
	const ids = new Set(servers.map((server) => server.id));
	const next = {
		version: 1 as const,
		servers: [...store.servers.filter((server) => !ids.has(server.id)), ...servers].sort((a, b) => a.id.localeCompare(b.id)),
	};
	await writeMcpBridgeStore(next);
	return next;
}

export async function removeSyncedMcpServers(ids: string[]): Promise<SyncedMcpServer[]> {
	const store = await readMcpBridgeStore();
	const idSet = new Set(ids);
	const removed = store.servers.filter((server) => idSet.has(server.id));
	await writeMcpBridgeStore({ version: 1, servers: store.servers.filter((server) => !idSet.has(server.id)) });
	return removed;
}
