import type { MarketplacePluginEntry, StoredMarketplace } from "../registry/types.js";
import type { ParsedExternalPluginSource } from "./source.js";

export type PluginSourceType = "local" | "github" | "external";

export type PluginComponentSummary = {
	commands: string[];
	skills: string[];
	agents: string[];
	hooks: string[];
	mcpServers: string[];
};

export type IndexedPlugin = {
	id: string;
	marketplace: StoredMarketplace;
	entry: MarketplacePluginEntry;
	version: string;
	sourceType: PluginSourceType;
	pluginPath?: string;
	externalSource?: ParsedExternalPluginSource;
	pluginManifestPath?: string;
	pluginManifest?: Record<string, unknown>;
	components?: PluginComponentSummary;
};

export type InstalledPlugin = {
	id: string;
	marketplace: string;
	name: string;
	version: string;
	sourceType: PluginSourceType;
	sourcePath: string;
	cachePath: string;
	installedAt: string;
	enabled: boolean;
	components: PluginComponentSummary;
};

export type InstalledPluginsStore = {
	version: 1;
	plugins: InstalledPlugin[];
};
