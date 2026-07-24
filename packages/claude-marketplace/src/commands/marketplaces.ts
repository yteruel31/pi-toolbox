import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadMarketplaceFromSource, refreshStoredMarketplace } from "../registry/marketplace-loader.js";
import { readMarketplacesStore, removeMarketplace, upsertMarketplace, writeMarketplacesStore } from "../registry/marketplace-store.js";
import type { StoredMarketplace } from "../registry/types.js";
import { refreshInstalledIndexedPlugins } from "../plugins/installer.js";
import { readInstalledPluginsStore } from "../plugins/installed-store.js";
import { listIndexedPlugins } from "../plugins/plugin-index.js";
import { marketplacesStorePath } from "../state/paths.js";

function commandArg(args: string): string {
	const trimmed = args.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1).trim();
	}
	return trimmed;
}

function formatTimestamp(value: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return value;
	return date.toLocaleString();
}

function formatMarketplace(marketplace: StoredMarketplace): string {
	return [
		`${marketplace.name}`,
		`  source: ${marketplace.source}`,
		`  manifest: ${marketplace.manifestPath}`,
		`  plugins: ${marketplace.pluginCount}`,
		`  refreshed: ${formatTimestamp(marketplace.refreshedAt)}`,
	]
		.filter(Boolean)
		.join("\n");
}

export async function addMarketplaceCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const source = commandArg(args);
	if (!source) {
		ctx.ui.notify("Usage: /claude-marketplace-add <path-to-marketplace-root-or-manifest>", "warning");
		return;
	}

	try {
		const { stored } = await loadMarketplaceFromSource(source);
		const { store, previous } = await upsertMarketplace(stored);

		if (previous && previous.manifestPath !== stored.manifestPath) {
			const replace = await ctx.ui.confirm(
				"Replace Claude marketplace?",
				`Marketplace ${stored.name} already exists.\n\nCurrent: ${previous.manifestPath}\nNew: ${stored.manifestPath}`,
			);
			if (!replace) return;
		}

		await writeMarketplacesStore(store);
		const action = previous ? "Updated" : "Added";
		ctx.ui.notify(`${action} marketplace ${stored.name} with ${stored.pluginCount} plugins.`, "info");
	} catch (error) {
		ctx.ui.notify(`Failed to add marketplace: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

export async function listMarketplacesCommand(_args: string, ctx: ExtensionCommandContext): Promise<void> {
	const store = await readMarketplacesStore();
	if (store.marketplaces.length === 0) {
		ctx.ui.notify(`No Claude marketplaces configured.\n\nAdd one with:\n/claude-marketplace-add /path/to/claude-plugins-marketplace\n\nStore: ${marketplacesStorePath()}`, "info");
		return;
	}

	ctx.ui.notify(["Claude marketplaces", "", ...store.marketplaces.map(formatMarketplace)].join("\n"), "info");
}

export async function refreshMarketplacesCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const targetName = commandArg(args);
	const store = await readMarketplacesStore();
	if (store.marketplaces.length === 0) {
		ctx.ui.notify("No Claude marketplaces configured.", "warning");
		return;
	}

	const targets = targetName ? store.marketplaces.filter((marketplace) => marketplace.name === targetName) : store.marketplaces;
	if (targets.length === 0) {
		ctx.ui.notify(`Marketplace not found: ${targetName}`, "warning");
		return;
	}

	const refreshed: StoredMarketplace[] = [];
	const failures: string[] = [];
	for (const marketplace of targets) {
		try {
			refreshed.push(await refreshStoredMarketplace(marketplace));
		} catch (error) {
			failures.push(`${marketplace.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	let refreshedInstalledCount = 0;
	let missingInstalledCount = 0;
	if (refreshed.length > 0) {
		const refreshedNames = new Set(refreshed.map((marketplace) => marketplace.name));
		await writeMarketplacesStore({
			version: 1,
			marketplaces: [
				...store.marketplaces.filter((marketplace) => !refreshedNames.has(marketplace.name)),
				...refreshed,
			].sort((a, b) => a.name.localeCompare(b.name)),
		});

		const installedStore = await readInstalledPluginsStore();
		const installedIds = new Set(installedStore.plugins.filter((plugin) => refreshedNames.has(plugin.marketplace)).map((plugin) => plugin.id));
		const indexedPlugins = (await listIndexedPlugins()).filter((plugin) => installedIds.has(plugin.id));
		missingInstalledCount = installedIds.size - indexedPlugins.length;
		refreshedInstalledCount = (await refreshInstalledIndexedPlugins(indexedPlugins)).length;
	}

	const lines = [
		refreshed.length > 0 ? `Refreshed ${refreshed.length} marketplace(s): ${refreshed.map((marketplace) => marketplace.name).join(", ")}` : "No marketplaces refreshed.",
		refreshedInstalledCount > 0 ? `Updated ${refreshedInstalledCount} installed plugin(s), including generated skills and agents. Run /reload to expose generated resources.` : undefined,
		missingInstalledCount > 0 ? `Skipped ${missingInstalledCount} installed plugin(s) no longer present in refreshed marketplace indexes.` : undefined,
		...failures.map((failure) => `Failed: ${failure}`),
	].filter((line): line is string => line !== undefined);
	ctx.ui.notify(lines.join("\n"), failures.length > 0 || missingInstalledCount > 0 ? "warning" : "info");
}

export async function removeMarketplaceCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const name = commandArg(args);
	if (!name) {
		ctx.ui.notify("Usage: /claude-marketplace-remove <marketplace>", "warning");
		return;
	}

	const store = await readMarketplacesStore();
	const existing = store.marketplaces.find((marketplace) => marketplace.name === name);
	if (!existing) {
		ctx.ui.notify(`Marketplace not found: ${name}`, "warning");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Remove Claude marketplace?",
		`Remove ${name}?\n\nSource: ${existing.source}\n\nInstalled plugin cleanup will be handled by plugin uninstall commands once implemented.`,
	);
	if (!confirmed) return;

	await removeMarketplace(name);
	ctx.ui.notify(`Removed marketplace ${name}.`, "info");
}
