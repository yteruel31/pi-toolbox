import { access, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { MarketplaceManifest, StoredMarketplace } from "./types.js";

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function stripSurroundingQuotes(value: string): string {
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
		return value.slice(1, -1);
	}
	return value;
}

function marketplaceRootFromManifest(manifestPath: string): string {
	const manifestDir = dirname(manifestPath);
	return manifestDir.endsWith(".claude-plugin") ? dirname(manifestDir) : manifestDir;
}

function validateManifest(value: unknown, manifestPath: string): MarketplaceManifest {
	if (!value || typeof value !== "object") {
		throw new Error(`${manifestPath} is not a JSON object.`);
	}

	const manifest = value as Partial<MarketplaceManifest>;
	if (!manifest.name || typeof manifest.name !== "string") {
		throw new Error(`${manifestPath} is missing required string field "name".`);
	}
	if (!Array.isArray(manifest.plugins)) {
		throw new Error(`${manifestPath} is missing required array field "plugins".`);
	}

	for (const [index, plugin] of manifest.plugins.entries()) {
		if (!plugin || typeof plugin !== "object") {
			throw new Error(`${manifestPath} plugin at index ${index} is not an object.`);
		}
		const entry = plugin as { name?: unknown; source?: unknown };
		if (typeof entry.name !== "string" || entry.name.length === 0) {
			throw new Error(`${manifestPath} plugin at index ${index} is missing required string field "name".`);
		}
		if (typeof entry.source !== "string" && (!entry.source || typeof entry.source !== "object")) {
			throw new Error(`${manifestPath} plugin ${entry.name} is missing required field "source".`);
		}
	}

	return manifest as MarketplaceManifest;
}

export async function resolveMarketplaceManifestPath(source: string): Promise<string> {
	const normalized = stripSurroundingQuotes(source.trim());
	if (!normalized) throw new Error("Missing marketplace source.");

	const absoluteSource = isAbsolute(normalized) ? normalized : resolve(process.cwd(), normalized);
	const sourceStat = await stat(absoluteSource).catch(() => undefined);
	if (!sourceStat) throw new Error(`Marketplace source not found: ${absoluteSource}`);

	if (sourceStat.isFile()) return absoluteSource;
	if (!sourceStat.isDirectory()) throw new Error(`Marketplace source is not a file or directory: ${absoluteSource}`);

	const candidates = [join(absoluteSource, ".claude-plugin", "marketplace.json"), join(absoluteSource, "marketplace.json")];
	for (const candidate of candidates) {
		if (await exists(candidate)) return candidate;
	}

	throw new Error(`No marketplace manifest found in ${absoluteSource}. Expected .claude-plugin/marketplace.json or marketplace.json.`);
}

export async function loadMarketplaceManifest(manifestPath: string): Promise<MarketplaceManifest> {
	const raw = await readFile(manifestPath, "utf8");
	return validateManifest(JSON.parse(raw), manifestPath);
}

export async function loadMarketplaceFromSource(source: string): Promise<{ manifest: MarketplaceManifest; stored: StoredMarketplace }> {
	const manifestPath = await resolveMarketplaceManifestPath(source);
	const manifest = await loadMarketplaceManifest(manifestPath);
	const root = marketplaceRootFromManifest(manifestPath);
	const now = new Date().toISOString();

	return {
		manifest,
		stored: {
			name: manifest.name,
			sourceType: "local",
			source: root,
			manifestPath,
			pluginRoot: manifest.metadata?.pluginRoot,
			ownerName: manifest.owner?.name,
			description: manifest.metadata?.description,
			metadataVersion: manifest.metadata?.version,
			pluginCount: manifest.plugins.length,
			addedAt: now,
			refreshedAt: now,
		},
	};
}

export async function refreshStoredMarketplace(marketplace: StoredMarketplace): Promise<StoredMarketplace> {
	const manifest = await loadMarketplaceManifest(marketplace.manifestPath);
	return {
		...marketplace,
		name: manifest.name,
		pluginRoot: manifest.metadata?.pluginRoot,
		ownerName: manifest.owner?.name,
		description: manifest.metadata?.description,
		metadataVersion: manifest.metadata?.version,
		pluginCount: manifest.plugins.length,
		refreshedAt: new Date().toISOString(),
	};
}
