import { readInstalledPluginsStore } from "../plugins/installed-store.js";
import type { InstalledPlugin } from "../plugins/types.js";

export async function listInstalledPluginsBySpecs(specs: string[]): Promise<InstalledPlugin[]> {
	const store = await readInstalledPluginsStore();
	if (specs.length === 0) return store.plugins;

	return specs.map((spec) => {
		const matches = store.plugins.filter((plugin) => plugin.id === spec || plugin.name === spec);
		if (matches.length === 0) throw new Error(`Installed plugin not found: ${spec}`);
		if (matches.length > 1) throw new Error(`Installed plugin ${spec} is ambiguous. Use plugin@marketplace.`);
		return matches[0];
	});
}

export async function resolveOneInstalledPlugin(spec: string): Promise<InstalledPlugin> {
	return (await listInstalledPluginsBySpecs([spec]))[0];
}
