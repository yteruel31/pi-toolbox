import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { InstalledPlugin } from "./types.js";

export type PluginUserConfigOption = {
	type: "string" | "number" | "boolean" | "directory" | "file";
	title: string;
	description: string;
	sensitive?: boolean;
	required?: boolean;
	default?: string | number | boolean | string[];
	multiple?: boolean;
	min?: number;
	max?: number;
};

export type PluginUserConfigSpec = {
	key: string;
	envName: string;
	defaultValue?: string;
	sensitive: boolean;
	required: boolean;
};

export type ResolvedPluginUserConfig = {
	byKey: Record<string, string>;
	env: Record<string, string>;
};

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readPluginManifest(plugin: InstalledPlugin): Promise<Record<string, unknown> | undefined> {
	return (await readJsonObject(join(plugin.cachePath, ".claude-plugin", "plugin.json"))) ?? (await readJsonObject(join(plugin.cachePath, "plugin.json")));
}

function normalizeUserConfigOption(value: unknown): PluginUserConfigOption | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const option = value as Record<string, unknown>;
	if (!["string", "number", "boolean", "directory", "file"].includes(String(option.type))) return undefined;
	if (typeof option.title !== "string" || typeof option.description !== "string") return undefined;
	return option as PluginUserConfigOption;
}

function stringifyDefault(value: PluginUserConfigOption["default"]): string | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) return value.join(",");
	return String(value);
}

export function pluginUserConfigEnvName(key: string): string {
	return `CLAUDE_PLUGIN_OPTION_${key.replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}`;
}

export async function loadPluginUserConfig(plugin: InstalledPlugin): Promise<Record<string, PluginUserConfigOption>> {
	const manifest = await readPluginManifest(plugin);
	const userConfig = manifest?.userConfig;
	if (!userConfig || typeof userConfig !== "object" || Array.isArray(userConfig)) return {};

	const normalized: Record<string, PluginUserConfigOption> = {};
	for (const [key, value] of Object.entries(userConfig as Record<string, unknown>)) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		const option = normalizeUserConfigOption(value);
		if (option) normalized[key] = option;
	}
	return normalized;
}

export async function collectPluginUserConfigSpecs(plugin: InstalledPlugin): Promise<PluginUserConfigSpec[]> {
	const userConfig = await loadPluginUserConfig(plugin);
	return Object.entries(userConfig)
		.map(([key, option]) => ({
			key,
			envName: pluginUserConfigEnvName(key),
			defaultValue: stringifyDefault(option.default),
			sensitive: option.sensitive === true,
			required: option.required === true,
		}))
		.sort((a, b) => a.envName.localeCompare(b.envName));
}

export async function resolvePluginUserConfig(plugin: InstalledPlugin, marketplaceEnv: Record<string, string>, processEnv: NodeJS.ProcessEnv = process.env): Promise<ResolvedPluginUserConfig> {
	const specs = await collectPluginUserConfigSpecs(plugin);
	const byKey: Record<string, string> = {};
	const env: Record<string, string> = {};
	for (const spec of specs) {
		const value = processEnv[spec.envName] ?? marketplaceEnv[spec.envName] ?? processEnv[spec.key] ?? marketplaceEnv[spec.key] ?? spec.defaultValue;
		if (value === undefined || value === "") continue;
		byKey[spec.key] = value;
		env[spec.envName] = value;
	}
	return { byKey, env };
}

export function replaceUserConfigPlaceholders(text: string, userConfig: ResolvedPluginUserConfig): string {
	return text.replace(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => userConfig.byKey[key] ?? match);
}
