import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { removeEnabledHooksForPlugins } from "../hooks/hook-store.js";
import { generatedPluginAgentsPath, generatedPluginPath, installedPluginsStorePath } from "../state/paths.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { InstalledPlugin, InstalledPluginsStore } from "./types.js";

const EMPTY_STORE: InstalledPluginsStore = { version: 1, plugins: [] };

function normalizeInstalledPluginsStore(store: InstalledPluginsStore): InstalledPluginsStore {
	return {
		version: 1,
		plugins: Array.isArray(store.plugins) ? store.plugins : [],
	};
}

export async function readInstalledPluginsStore(): Promise<InstalledPluginsStore> {
	return normalizeInstalledPluginsStore(await readJsonFile<InstalledPluginsStore>(installedPluginsStorePath(), EMPTY_STORE));
}

export function readInstalledPluginsStoreSync(): InstalledPluginsStore {
	try {
		return normalizeInstalledPluginsStore(JSON.parse(readFileSync(installedPluginsStorePath(), "utf8")) as InstalledPluginsStore);
	} catch {
		return EMPTY_STORE;
	}
}

export async function writeInstalledPluginsStore(store: InstalledPluginsStore): Promise<void> {
	await writeJsonFile(installedPluginsStorePath(), store);
}

export async function upsertInstalledPlugins(plugins: InstalledPlugin[]): Promise<void> {
	const store = await readInstalledPluginsStore();
	const ids = new Set(plugins.map((plugin) => plugin.id));
	await writeInstalledPluginsStore({
		version: 1,
		plugins: [...store.plugins.filter((plugin) => !ids.has(plugin.id)), ...plugins].sort((a, b) => a.id.localeCompare(b.id)),
	});
}

export async function removeInstalledPlugins(ids: string[]): Promise<InstalledPlugin[]> {
	const store = await readInstalledPluginsStore();
	const idSet = new Set(ids);
	const removed = store.plugins.filter((plugin) => idSet.has(plugin.id));
	await removeEnabledHooksForPlugins(removed);

	await writeInstalledPluginsStore({
		version: 1,
		plugins: store.plugins.filter((plugin) => !idSet.has(plugin.id)),
	});

	for (const plugin of removed) {
		await rm(plugin.cachePath, { recursive: true, force: true });
		await rm(generatedPluginPath(plugin.marketplace, plugin.name), { recursive: true, force: true });
		await rm(generatedPluginAgentsPath(plugin.marketplace, plugin.name), { recursive: true, force: true });
	}

	return removed;
}
