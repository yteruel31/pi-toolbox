import type { InstalledPlugin } from "../plugins/types.js";
import { replaceUserConfigPlaceholders, resolvePluginUserConfig, type ResolvedPluginUserConfig } from "../plugins/user-config.js";
import { pluginDataPath } from "../state/paths.js";
import { readMarketplaceEnv, resolveMarketplaceEnvValue } from "./env.js";
import type { McpServerConfig } from "./types.js";

function safeName(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "server";
}

export function piMcpServerName(plugin: InstalledPlugin, originalServerName: string): string {
	return `claude_${safeName(plugin.marketplace)}_${safeName(plugin.name)}_${safeName(originalServerName)}`;
}

export function mcpServerId(plugin: InstalledPlugin, originalServerName: string): string {
	return `${plugin.marketplace}/${plugin.name}/${originalServerName}`;
}

async function replacePlaceholders(value: string, plugin: InstalledPlugin, userConfig: ResolvedPluginUserConfig): Promise<string> {
	let result = value.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.cachePath).replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, pluginDataPath(plugin.marketplace, plugin.name));
	result = replaceUserConfigPlaceholders(result, userConfig);
	for (const match of [...result.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)]) {
		const replacement = await resolveMarketplaceEnvValue(plugin.marketplace, match[1], match[2]);
		if (replacement !== undefined) result = result.replaceAll(match[0], replacement);
	}
	return result;
}

async function transformValue(value: unknown, plugin: InstalledPlugin, userConfig: ResolvedPluginUserConfig): Promise<unknown> {
	if (typeof value === "string") return replacePlaceholders(value, plugin, userConfig);
	if (Array.isArray(value)) return Promise.all(value.map((item) => transformValue(item, plugin, userConfig)));
	if (value && typeof value === "object") {
		const entries = await Promise.all(Object.entries(value as Record<string, unknown>).map(async ([key, nested]) => [key, await transformValue(nested, plugin, userConfig)] as const));
		return Object.fromEntries(entries);
	}
	return value;
}

export async function transformMcpServerConfig(config: McpServerConfig, plugin: InstalledPlugin): Promise<McpServerConfig> {
	const userConfig = await resolvePluginUserConfig(plugin, await readMarketplaceEnv(plugin.marketplace));
	const transformed = (await transformValue(config, plugin, userConfig)) as McpServerConfig;
	const stdioEnv = transformed.command === undefined
		? undefined
		: {
			...(transformed.env ?? {}),
			...userConfig.env,
			CLAUDE_PLUGIN_ROOT: plugin.cachePath,
			CLAUDE_PLUGIN_DATA: pluginDataPath(plugin.marketplace, plugin.name),
		};
	return {
		...transformed,
		...(stdioEnv ? { env: stdioEnv } : {}),
		lifecycle: transformed.lifecycle ?? "lazy",
		directTools: transformed.directTools ?? false,
	};
}
