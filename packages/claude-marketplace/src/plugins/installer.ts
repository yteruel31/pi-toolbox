import { rm } from "node:fs/promises";
import { pluginCachePath } from "../state/paths.js";
import { generatePluginAgents } from "../components/agents.js";
import { generatePluginSkills } from "../components/skills.js";
import { enableSupportedHooksForPlugins } from "../hooks/hook-store.js";
import { scanPluginComponents } from "./component-scanner.js";
import { readInstalledPluginsStore, upsertInstalledPlugins } from "./installed-store.js";
import { materializeIndexedPluginSource } from "./source.js";
import type { IndexedPlugin, InstalledPlugin } from "./types.js";

function safeVersionSegment(version: string): string {
	return version.replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown";
}

async function materializeInstalledPlugin(plugin: IndexedPlugin, previous?: InstalledPlugin): Promise<InstalledPlugin> {
	const cachePath = pluginCachePath(plugin.marketplace.name, plugin.entry.name, safeVersionSegment(plugin.version));
	const materialized = await materializeIndexedPluginSource(plugin, cachePath);
	const components = await scanPluginComponents(cachePath, plugin.pluginManifest);

	const installedPlugin: InstalledPlugin = {
		id: plugin.id,
		marketplace: plugin.marketplace.name,
		name: plugin.entry.name,
		version: plugin.version,
		sourceType: materialized.sourceType,
		sourcePath: materialized.sourcePath,
		cachePath,
		installedAt: previous?.installedAt ?? new Date().toISOString(),
		enabled: previous?.enabled ?? true,
		components,
	};
	await generatePluginSkills(installedPlugin);
	await generatePluginAgents(installedPlugin);
	return installedPlugin;
}

export async function installIndexedPlugins(plugins: IndexedPlugin[]): Promise<InstalledPlugin[]> {
	const installed: InstalledPlugin[] = [];

	for (const plugin of plugins) {
		installed.push(await materializeInstalledPlugin(plugin));
	}

	await upsertInstalledPlugins(installed);
	await enableSupportedHooksForPlugins(installed);
	return installed;
}

export async function refreshInstalledIndexedPlugins(plugins: IndexedPlugin[]): Promise<InstalledPlugin[]> {
	const store = await readInstalledPluginsStore();
	const previousById = new Map(store.plugins.map((plugin) => [plugin.id, plugin]));
	const refreshed: InstalledPlugin[] = [];
	const obsoleteCachePaths: string[] = [];

	for (const plugin of plugins) {
		const previous = previousById.get(plugin.id);
		if (!previous) continue;
		const refreshedPlugin = await materializeInstalledPlugin(plugin, previous);
		refreshed.push(refreshedPlugin);
		if (previous.cachePath !== refreshedPlugin.cachePath) obsoleteCachePaths.push(previous.cachePath);
	}

	await upsertInstalledPlugins(refreshed);
	for (const cachePath of obsoleteCachePaths) {
		await rm(cachePath, { recursive: true, force: true });
	}
	return refreshed;
}
