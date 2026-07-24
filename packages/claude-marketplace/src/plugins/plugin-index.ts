import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { loadMarketplaceManifest } from "../registry/marketplace-loader.js";
import { readMarketplacesStore } from "../registry/marketplace-store.js";
import type { MarketplacePluginEntry, StoredMarketplace } from "../registry/types.js";
import { scanPluginComponents } from "./component-scanner.js";
import { parseExternalPluginSource, pluginSourceType } from "./source.js";
import type { IndexedPlugin, PluginSourceType } from "./types.js";

export function pluginId(pluginName: string, marketplaceName: string): string {
	return `${pluginName}@${marketplaceName}`;
}

export function parsePluginSpec(spec: string): { name: string; marketplace?: string } {
	const trimmed = spec.trim();
	const [name, marketplace] = trimmed.split("@", 2);
	return { name, marketplace: marketplace || undefined };
}

function pluginVersion(entry: MarketplacePluginEntry, manifest?: Record<string, unknown>): string {
	const manifestVersion = manifest?.version;
	return typeof manifestVersion === "string" && manifestVersion ? manifestVersion : entry.version || "unknown";
}

async function readPluginManifest(pluginPath: string): Promise<{ path?: string; manifest?: Record<string, unknown> }> {
	const candidates = [join(pluginPath, ".claude-plugin", "plugin.json"), join(pluginPath, "plugin.json")];
	for (const candidate of candidates) {
		try {
			const value = JSON.parse(await readFile(candidate, "utf8")) as unknown;
			if (value && typeof value === "object" && !Array.isArray(value)) {
				return { path: candidate, manifest: value as Record<string, unknown> };
			}
		} catch {
			// Try the next known manifest location.
		}
	}
	return {};
}

function resolvePluginSource(marketplace: StoredMarketplace, entry: MarketplacePluginEntry): { sourceType: PluginSourceType; pluginPath?: string; externalSource?: ReturnType<typeof parseExternalPluginSource> } {
	const sourceType = pluginSourceType(entry);
	if (typeof entry.source !== "string") {
		return { sourceType, externalSource: parseExternalPluginSource(entry) };
	}
	return {
		sourceType,
		pluginPath: isAbsolute(entry.source) ? entry.source : join(marketplace.source, entry.source),
	};
}

async function indexMarketplacePlugins(marketplace: StoredMarketplace): Promise<IndexedPlugin[]> {
	const manifest = await loadMarketplaceManifest(marketplace.manifestPath);
	const plugins: IndexedPlugin[] = [];

	for (const entry of manifest.plugins) {
		const { sourceType, pluginPath, externalSource } = resolvePluginSource(marketplace, entry);
		const { path: pluginManifestPath, manifest: pluginManifest } = pluginPath ? await readPluginManifest(pluginPath) : {};
		const version = pluginVersion(entry, pluginManifest);
		plugins.push({
			id: pluginId(entry.name, marketplace.name),
			marketplace,
			entry,
			version,
			sourceType,
			pluginPath,
			externalSource,
			pluginManifestPath,
			pluginManifest,
			components: pluginPath ? await scanPluginComponents(pluginPath, pluginManifest) : undefined,
		});
	}

	return plugins.sort((a, b) => a.id.localeCompare(b.id));
}

export async function listIndexedPlugins(): Promise<IndexedPlugin[]> {
	const store = await readMarketplacesStore();
	const results: IndexedPlugin[] = [];
	for (const marketplace of store.marketplaces) {
		results.push(...(await indexMarketplacePlugins(marketplace)));
	}
	return results.sort((a, b) => a.id.localeCompare(b.id));
}

export async function resolvePluginSpecs(specs: string[]): Promise<IndexedPlugin[]> {
	const plugins = await listIndexedPlugins();
	const resolved: IndexedPlugin[] = [];

	for (const spec of specs) {
		const parsed = parsePluginSpec(spec);
		if (!parsed.name) throw new Error(`Invalid plugin spec: ${spec}`);

		const matches = plugins.filter((plugin) => plugin.entry.name === parsed.name && (!parsed.marketplace || plugin.marketplace.name === parsed.marketplace));
		if (matches.length === 0) throw new Error(`Plugin not found: ${spec}`);
		if (matches.length > 1) throw new Error(`Plugin ${parsed.name} exists in multiple marketplaces. Use plugin@marketplace.`);
		resolved.push(matches[0]);
	}

	return resolved;
}
