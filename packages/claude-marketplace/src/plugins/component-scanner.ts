import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import type { PluginComponentSummary } from "./types.js";

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function listFiles(root: string, predicate: (path: string) => boolean): Promise<string[]> {
	if (!(await pathExists(root))) return [];

	const results: string[] = [];
	async function walk(dir: string): Promise<void> {
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
			} else if (entry.isFile() && predicate(path)) {
				results.push(path);
			}
		}
	}

	await walk(root);
	return results.sort();
}

function withoutMarkdownExtension(path: string): string {
	return path.replace(/\.md$/i, "");
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const value = JSON.parse(await readFile(path, "utf8")) as unknown;
		return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

function objectKeys(value: unknown): string[] {
	return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value as Record<string, unknown>) : [];
}

function hookEventKeys(value: unknown): string[] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return [];
	const object = value as { hooks?: unknown };
	return object.hooks ? objectKeys(object.hooks) : objectKeys(value);
}

async function readPluginManifest(pluginPath: string): Promise<Record<string, unknown> | undefined> {
	return (await readJsonObject(join(pluginPath, ".claude-plugin", "plugin.json"))) ?? (await readJsonObject(join(pluginPath, "plugin.json")));
}

export async function scanPluginComponents(pluginPath: string, pluginManifest?: Record<string, unknown>): Promise<PluginComponentSummary> {
	const manifest = pluginManifest ?? (await readPluginManifest(pluginPath));
	const commandFiles = await listFiles(join(pluginPath, "commands"), (path) => path.endsWith(".md"));
	const skillFiles = await listFiles(join(pluginPath, "skills"), (path) => basename(path) === "SKILL.md");
	if (await pathExists(join(pluginPath, "SKILL.md"))) skillFiles.unshift(join(pluginPath, "SKILL.md"));
	const agentFiles = await listFiles(join(pluginPath, "agents"), (path) => path.endsWith(".md"));

	const hooksConfig = (await readJsonObject(join(pluginPath, "hooks", "hooks.json"))) ?? manifest?.hooks;
	const mcpConfig = (await readJsonObject(join(pluginPath, ".mcp.json"))) ?? { mcpServers: manifest?.mcpServers };

	return {
		commands: commandFiles.map((path) => withoutMarkdownExtension(relative(join(pluginPath, "commands"), path))),
		skills: skillFiles.map((path) => {
			if (path === join(pluginPath, "SKILL.md")) return "SKILL";
			return relative(join(pluginPath, "skills"), path).replace(/\/SKILL\.md$/i, "");
		}),
		agents: agentFiles.map((path) => withoutMarkdownExtension(relative(join(pluginPath, "agents"), path))),
		hooks: hookEventKeys(hooksConfig),
		mcpServers: objectKeys((mcpConfig as { mcpServers?: unknown } | undefined)?.mcpServers),
	};
}
