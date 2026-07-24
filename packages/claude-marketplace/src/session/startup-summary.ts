import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { readHookBridgeStore } from "../hooks/hook-store.js";
import type { SyncedHook } from "../hooks/types.js";
import { readMcpBridgeStore } from "../mcp/mcp-store.js";
import type { SyncedMcpServer } from "../mcp/types.js";
import { checkPiPackages, missingRequiredPackages, type PrerequisiteStatus } from "../prerequisites/check-pi-packages.js";
import { readInstalledPluginsStore } from "../plugins/installed-store.js";
import type { InstalledPlugin } from "../plugins/types.js";
import { readMarketplacesStore } from "../registry/marketplace-store.js";
import type { StoredMarketplace } from "../registry/types.js";

const STATUS_KEY = "claude-marketplace";
const WIDGET_KEY = "claude-marketplace-summary";
const DEFAULT_PLUGIN_LIMIT = 5;
const SUMMARY_WIDGET_TTL_MS = 8000;

let summaryWidgetClearTimer: ReturnType<typeof setTimeout> | undefined;
let summaryWidgetGeneration = 0;

export type StartupSummary = {
	marketplaces: StoredMarketplace[];
	plugins: InstalledPlugin[];
	enabledHooks: SyncedHook[];
	syncedMcpServers: SyncedMcpServer[];
	prerequisites: PrerequisiteStatus[];
};

export type StartupSummaryReport = {
	message: string;
	type: "info" | "warning";
};

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : pluralForm}`;
}

function formatMarketplaceCount(count: number): string {
	return plural(count, "marketplace");
}

function sourceSuffix(plugin: InstalledPlugin): string {
	return plugin.sourceType === "local" ? "" : `, ${plugin.sourceType}`;
}

function enabledHookSummary(plugin: InstalledPlugin, enabledHooks: number): string | undefined {
	const detectedHooks = plugin.components.hooks.length;
	if (enabledHooks > 0 && detectedHooks > 0) return `${enabledHooks}/${detectedHooks} hooks enabled`;
	if (enabledHooks > 0) return plural(enabledHooks, "hook") + " enabled";
	if (detectedHooks > 0) return plural(detectedHooks, "hook");
	return undefined;
}

function syncedMcpSummary(plugin: InstalledPlugin, syncedMcpServers: number): string | undefined {
	const detectedMcpServers = plugin.components.mcpServers.length;
	if (syncedMcpServers > 0 && detectedMcpServers > 0) return `${syncedMcpServers}/${detectedMcpServers} MCP synced`;
	if (syncedMcpServers > 0) return `${syncedMcpServers} MCP synced`;
	if (detectedMcpServers > 0) return `${detectedMcpServers} MCP`;
	return undefined;
}

function pluginComponentSummary(plugin: InstalledPlugin, hooks: SyncedHook[], mcpServers: SyncedMcpServer[]): string {
	const enabledHooks = hooks.filter((hook) => hook.marketplace === plugin.marketplace && hook.plugin === plugin.name).length;
	const syncedMcpServers = mcpServers.filter((server) => server.marketplace === plugin.marketplace && server.plugin === plugin.name).length;
	const parts = [
		plugin.components.commands.length > 0 ? plural(plugin.components.commands.length, "command") : undefined,
		plugin.components.skills.length > 0 ? plural(plugin.components.skills.length, "skill") : undefined,
		plugin.components.agents.length > 0 ? plural(plugin.components.agents.length, "agent") : undefined,
		enabledHookSummary(plugin, enabledHooks),
		syncedMcpSummary(plugin, syncedMcpServers),
	].filter((part): part is string => Boolean(part));

	return parts.length > 0 ? parts.join(", ") : "no bridged components";
}

function formatPluginLine(plugin: InstalledPlugin, hooks: SyncedHook[], mcpServers: SyncedMcpServer[]): string {
	return `  - ${plugin.name}@${plugin.marketplace} v${plugin.version}${sourceSuffix(plugin)} — ${pluginComponentSummary(plugin, hooks, mcpServers)}`;
}

function missingOptionalMcpAdapter(summary: StartupSummary): PrerequisiteStatus | undefined {
	if (summary.syncedMcpServers.length === 0) return undefined;
	return summary.prerequisites.find((status) => status.name === "pi-mcp-adapter" && !status.installed);
}

function warningLines(summary: StartupSummary): string[] {
	const missingRequired = missingRequiredPackages(summary.prerequisites);
	const missingMcpAdapter = missingOptionalMcpAdapter(summary);
	const lines: string[] = [];

	if (missingRequired.length > 0) {
		lines.push(`Missing required packages: ${missingRequired.map((status) => status.name).join(", ")}.`);
		lines.push(...missingRequired.map((status) => `  ${status.installCommand}`));
	}

	if (missingMcpAdapter) {
		const verb = summary.syncedMcpServers.length === 1 ? "is" : "are";
		lines.push(`${missingMcpAdapter.name} is missing but ${plural(summary.syncedMcpServers.length, "MCP server")} ${verb} synced.`);
		lines.push(`  ${missingMcpAdapter.installCommand}`);
	}

	return lines;
}

export function buildClaudeMarketplaceStatusText(summary: StartupSummary): string | undefined {
	if (summary.plugins.length > 0) {
		const parts = [plural(summary.plugins.length, "plugin"), summary.enabledHooks.length > 0 ? plural(summary.enabledHooks.length, "hook") : undefined, summary.syncedMcpServers.length > 0 ? `${summary.syncedMcpServers.length} MCP` : undefined].filter(
			(part): part is string => Boolean(part),
		);
		return `Claude Marketplace: ${parts.join(", ")}`;
	}

	if (summary.marketplaces.length > 0) {
		return `Claude Marketplace: ${formatMarketplaceCount(summary.marketplaces.length)}, no plugins installed`;
	}

	return undefined;
}

export function buildClaudeMarketplaceStartupReport(summary: StartupSummary, pluginLimit = DEFAULT_PLUGIN_LIMIT): StartupSummaryReport | undefined {
	const warnings = warningLines(summary);
	const hasMarketplaceState = summary.marketplaces.length > 0 || summary.plugins.length > 0;

	if (!hasMarketplaceState && warnings.length === 0) return undefined;

	const lines = [
		"Claude Marketplace for Pi",
		"",
		`Configured marketplaces: ${summary.marketplaces.length}`,
		`Installed plugins: ${summary.plugins.length}`,
		`Enabled hooks: ${summary.enabledHooks.length}`,
		`Synced MCP servers: ${summary.syncedMcpServers.length}`,
	];

	if (summary.plugins.length > 0) {
		const visiblePlugins = [...summary.plugins].sort((a, b) => a.id.localeCompare(b.id)).slice(0, pluginLimit);
		lines.push("", "Installed:", ...visiblePlugins.map((plugin) => formatPluginLine(plugin, summary.enabledHooks, summary.syncedMcpServers)));

		const hiddenCount = summary.plugins.length - visiblePlugins.length;
		if (hiddenCount > 0) lines.push(`  + ${plural(hiddenCount, "more plugin")}`);
	} else if (summary.marketplaces.length > 0) {
		lines.push("", "No plugins installed yet.");
	}

	if (warnings.length > 0) {
		lines.push("", "Warnings:", ...warnings.map((line) => (line.startsWith("  ") ? line : `  ${line}`)));
	}

	lines.push("", "Commands:", "  /claude-marketplace-plugin-list --installed", "  /claude-marketplace-plugin-info <plugin[@marketplace]>");

	return {
		message: lines.join("\n"),
		type: warnings.length > 0 ? "warning" : "info",
	};
}

async function collectStartupSummary(pi: ExtensionAPI): Promise<StartupSummary> {
	const [marketplaces, installed, hooks, mcp] = await Promise.all([readMarketplacesStore(), readInstalledPluginsStore(), readHookBridgeStore(), readMcpBridgeStore()]);

	return {
		marketplaces: marketplaces.marketplaces,
		plugins: installed.plugins,
		enabledHooks: hooks.hooks,
		syncedMcpServers: mcp.servers,
		prerequisites: checkPiPackages(pi),
	};
}

export function clearClaudeMarketplaceSummaryWidget(ctx?: ExtensionContext): void {
	summaryWidgetGeneration += 1;
	if (summaryWidgetClearTimer) {
		clearTimeout(summaryWidgetClearTimer);
		summaryWidgetClearTimer = undefined;
	}
	if (!ctx) return;
	try {
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	} catch {
		// The caller may be cleaning up after a session replacement/reload where the
		// captured context is already stale. Clearing the timer is sufficient.
	}
}

function showTemporarySummaryWidget(ctx: ExtensionContext, text: string | undefined): void {
	clearClaudeMarketplaceSummaryWidget(ctx);
	if (!text) return;

	const generation = summaryWidgetGeneration;
	ctx.ui.setWidget(WIDGET_KEY, [text], { placement: "belowEditor" });
	summaryWidgetClearTimer = setTimeout(() => {
		if (generation !== summaryWidgetGeneration) return;
		try {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
		} catch {
			// Session replacement/reload can make captured extension contexts stale before
			// the timeout fires. The next session_start owns any replacement UI state.
		}
		summaryWidgetClearTimer = undefined;
	}, SUMMARY_WIDGET_TTL_MS);
	summaryWidgetClearTimer.unref?.();
}

export async function updateClaudeMarketplaceSessionSummary(pi: ExtensionAPI, event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
	try {
		const summary = await collectStartupSummary(pi);
		// Keep the Claude Marketplace count out of the persistent footer; show it as a
		// temporary below-editor hint on startup/reload instead.
		ctx.ui.setStatus(STATUS_KEY, undefined);

		if (event.reason !== "startup" && event.reason !== "reload") return;

		showTemporarySummaryWidget(ctx, buildClaudeMarketplaceStatusText(summary));

		const report = buildClaudeMarketplaceStartupReport(summary);
		if (!report) return;
		ctx.ui.notify(report.message, report.type);
	} catch (error) {
		ctx.ui.setStatus(STATUS_KEY, undefined);
		clearClaudeMarketplaceSummaryWidget(ctx);
		if (event.reason === "startup" || event.reason === "reload") {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Claude Marketplace startup summary failed: ${message}`, "warning");
		}
	}
}
