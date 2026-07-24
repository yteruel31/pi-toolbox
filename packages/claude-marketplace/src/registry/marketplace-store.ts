import { marketplacesStorePath } from "../state/paths.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { MarketplacesStore, StoredMarketplace } from "./types.js";

const EMPTY_STORE: MarketplacesStore = { version: 1, marketplaces: [] };

export async function readMarketplacesStore(): Promise<MarketplacesStore> {
	const store = await readJsonFile<MarketplacesStore>(marketplacesStorePath(), EMPTY_STORE);
	return {
		version: 1,
		marketplaces: Array.isArray(store.marketplaces) ? store.marketplaces : [],
	};
}

export async function writeMarketplacesStore(store: MarketplacesStore): Promise<void> {
	await writeJsonFile(marketplacesStorePath(), store);
}

export async function upsertMarketplace(marketplace: StoredMarketplace): Promise<{ store: MarketplacesStore; previous?: StoredMarketplace }> {
	const store = await readMarketplacesStore();
	const previous = store.marketplaces.find((entry) => entry.name === marketplace.name);
	const nextMarketplace = previous ? { ...marketplace, addedAt: previous.addedAt } : marketplace;

	return {
		store: {
			version: 1,
			marketplaces: [...store.marketplaces.filter((entry) => entry.name !== marketplace.name), nextMarketplace].sort((a, b) =>
				a.name.localeCompare(b.name),
			),
		},
		previous,
	};
}

export async function removeMarketplace(name: string): Promise<StoredMarketplace | undefined> {
	const store = await readMarketplacesStore();
	const removed = store.marketplaces.find((entry) => entry.name === name);
	if (!removed) return undefined;

	await writeMarketplacesStore({
		version: 1,
		marketplaces: store.marketplaces.filter((entry) => entry.name !== name),
	});

	return removed;
}
