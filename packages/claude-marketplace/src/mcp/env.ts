import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { InstalledPlugin } from "../plugins/types.js";
import { collectPluginUserConfigSpecs } from "../plugins/user-config.js";
import { marketplaceEnvPath } from "../state/paths.js";
import { loadPluginMcpConfig } from "./config-loader.js";
import type { EnvReference } from "./types.js";

type EnvSpec = {
	name: string;
	defaultValue?: string;
};

export type MarketplaceEnvInitResult = {
	marketplace: string;
	path: string;
	added: string[];
	required: string[];
};

function unquoteEnvValue(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
		return trimmed.slice(1, -1).replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
	return trimmed;
}

function stripInlineComment(value: string): string {
	let quote: '"' | "'" | undefined;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if ((char === '"' || char === "'") && value[index - 1] !== "\\") quote = quote === char ? undefined : quote ?? char;
		if (char === "#" && !quote && /\s/.test(value[index - 1] ?? " ")) return value.slice(0, index).trimEnd();
	}
	return value;
}

export function parseDotEnv(content: string): Record<string, string> {
	const values: Record<string, string> = {};
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
		if (!match) continue;
		values[match[1]] = unquoteEnvValue(stripInlineComment(match[2]));
	}
	return values;
}

async function readMarketplaceEnvContent(marketplace: string): Promise<string> {
	try {
		return await readFile(marketplaceEnvPath(marketplace), "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return "";
		throw error;
	}
}

export async function readMarketplaceEnv(marketplace: string): Promise<Record<string, string>> {
	return parseDotEnv(await readMarketplaceEnvContent(marketplace));
}

function collectStrings(value: unknown, output: string[] = []): string[] {
	if (typeof value === "string") output.push(value);
	else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
	else if (value && typeof value === "object") Object.values(value as Record<string, unknown>).forEach((item) => collectStrings(item, output));
	return output;
}

export function collectEnvSpecs(value: unknown): EnvSpec[] {
	const seen = new Map<string, EnvSpec>();
	for (const text of collectStrings(value)) {
		for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g)) {
			const name = match[1];
			if (name === "CLAUDE_PLUGIN_ROOT" || name === "CLAUDE_PLUGIN_DATA") continue;
			if (!seen.has(name)) seen.set(name, { name, defaultValue: match[2] });
		}
	}
	return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveEnvReference(marketplace: string, spec: EnvSpec): Promise<EnvReference & { value?: string }> {
	if (process.env[spec.name] !== undefined) return { ...spec, missing: false, source: "process", value: process.env[spec.name] };
	const marketplaceEnv = await readMarketplaceEnv(marketplace);
	const fromFile = marketplaceEnv[spec.name];
	if (fromFile) return { ...spec, missing: false, source: "marketplace-env", value: fromFile };
	if (spec.defaultValue !== undefined) return { ...spec, missing: false, source: "default", value: spec.defaultValue };
	return { ...spec, missing: true, source: "missing" };
}

export async function collectEnvReferences(value: unknown, marketplace: string): Promise<EnvReference[]> {
	const references: EnvReference[] = [];
	for (const spec of collectEnvSpecs(value)) references.push(await resolveEnvReference(marketplace, spec));
	return references;
}

export async function resolveMarketplaceEnvValue(marketplace: string, name: string, defaultValue?: string): Promise<string | undefined> {
	return (await resolveEnvReference(marketplace, { name, defaultValue })).value;
}

export async function ensureMarketplaceEnvTemplate(marketplace: string, specs: EnvSpec[]): Promise<MarketplaceEnvInitResult> {
	const path = marketplaceEnvPath(marketplace);
	const required = specs.filter((spec) => spec.defaultValue === undefined && process.env[spec.name] === undefined);
	if (required.length === 0) return { marketplace, path, added: [], required: [] };

	const currentContent = await readMarketplaceEnvContent(marketplace);
	const current = parseDotEnv(currentContent);
	const toAdd = required.filter((spec) => current[spec.name] === undefined).map((spec) => spec.name);
	if (toAdd.length === 0) return { marketplace, path, added: [], required: required.map((spec) => spec.name) };

	const header = currentContent.trim().length === 0 ? [`# Claude marketplace environment for ${marketplace}`, "# Values are copied into generated Pi MCP config during sync.", ""] : [""];
	const lines = [...header, ...toAdd.map((name) => `${name}=`), ""];
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${currentContent.replace(/\s*$/, "\n")}${lines.join("\n")}`, { encoding: "utf8", mode: 0o600 });
	await chmod(path, 0o600);
	return { marketplace, path, added: toAdd, required: required.map((spec) => spec.name) };
}

export async function ensureMarketplaceEnvTemplateForPlugins(plugins: InstalledPlugin[]): Promise<MarketplaceEnvInitResult[]> {
	const specsByMarketplace = new Map<string, EnvSpec[]>();
	for (const plugin of plugins) {
		const config = await loadPluginMcpConfig(plugin);
		const userConfigSpecs = await collectPluginUserConfigSpecs(plugin);
		const specs = [...collectEnvSpecs(config), ...userConfigSpecs.map((spec) => ({ name: spec.envName, defaultValue: spec.defaultValue }))];
		if (specs.length === 0) continue;
		const existing = specsByMarketplace.get(plugin.marketplace) ?? [];
		const merged = new Map(existing.map((spec) => [spec.name, spec]));
		for (const spec of specs) if (!merged.has(spec.name)) merged.set(spec.name, spec);
		specsByMarketplace.set(plugin.marketplace, [...merged.values()]);
	}

	const results: MarketplaceEnvInitResult[] = [];
	for (const [marketplace, specs] of specsByMarketplace) results.push(await ensureMarketplaceEnvTemplate(marketplace, specs));
	return results;
}
