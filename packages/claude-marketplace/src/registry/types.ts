export type MarketplaceManifest = {
	name: string;
	owner?: {
		name?: string;
		email?: string;
	};
	metadata?: {
		description?: string;
		version?: string;
		pluginRoot?: string;
		[key: string]: unknown;
	};
	plugins: MarketplacePluginEntry[];
	[key: string]: unknown;
};

export type MarketplacePluginEntry = {
	name: string;
	source: string | Record<string, unknown>;
	description?: string;
	version?: string;
	category?: string;
	tags?: string[];
	keywords?: string[];
	author?: {
		name?: string;
		email?: string;
	};
	[key: string]: unknown;
};

export type StoredMarketplace = {
	name: string;
	sourceType: "local";
	source: string;
	manifestPath: string;
	pluginRoot?: string;
	ownerName?: string;
	description?: string;
	metadataVersion?: string;
	pluginCount: number;
	addedAt: string;
	refreshedAt: string;
};

export type MarketplacesStore = {
	version: 1;
	marketplaces: StoredMarketplace[];
};
