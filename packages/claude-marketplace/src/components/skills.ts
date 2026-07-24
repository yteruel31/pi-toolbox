import { createHash } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { generatedPluginPath, generatedPluginSkillsPath, pluginDataPath } from "../state/paths.js";
import { readInstalledPluginsStore } from "../plugins/installed-store.js";
import type { InstalledPlugin } from "../plugins/types.js";
import { formatClaudeMarketplaceDescription } from "./display.js";
import { frontmatterBlock, readFrontmatterField, removeFrontmatterFields } from "./frontmatter.js";

export type SkillSource = {
	name: string;
	path: string;
	root: string;
};

async function fileExists(path: string): Promise<boolean> {
	try {
		await readFile(path, "utf8");
		return true;
	} catch {
		return false;
	}
}

async function findSkillFiles(root: string): Promise<string[]> {
	const results: string[] = [];
	async function walk(dir: string): Promise<void> {
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile() && entry.name === "SKILL.md") results.push(path);
		}
	}
	await walk(root);
	return results.sort();
}

function findSkillFilesSync(root: string): string[] {
	const results: string[] = [];
	function walk(dir: string): void {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) walk(path);
			else if (entry.isFile() && entry.name === "SKILL.md") results.push(path);
		}
	}
	walk(root);
	return results.sort();
}

function safeSlug(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || "skill";
}

export function generatedSkillName(plugin: InstalledPlugin, sourceName: string): string {
	const base = safeSlug(`claude-${plugin.name}-${sourceName}`);
	if (base.length <= 64) return base;
	const hash = createHash("sha1").update(base).digest("hex").slice(0, 8);
	return `${base.slice(0, 55).replace(/-+$/g, "")}-${hash}`;
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function piSkillCommandFor(pluginName: string, skillName: string): string {
	return `/skill:${safeSlug(`claude-${pluginName}-${skillName}`)}`;
}

function rewriteSkillBody(body: string, plugin: InstalledPlugin): string {
	return body
		.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.cachePath)
		.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, pluginDataPath(plugin.marketplace, plugin.name))
		.replace(/\bAskUserQuestion\b/g, "ask_user")
		.replace(/Skill\("([^":]+):([^"]+)",\s*"([^"]*)"\)/g, (_match, pluginName: string, skillName: string, args: string) => {
			return `${piSkillCommandFor(pluginName, skillName)} ${args}`.trim();
		})
		.replace(/Skill\("([^":]+):([^"]+)"\)/g, (_match, pluginName: string, skillName: string) => piSkillCommandFor(pluginName, skillName));
}

function rewriteFrontmatter(content: string, name: string, fallbackDescription: string, plugin: InstalledPlugin): string {
	const frontmatter = frontmatterBlock(content);
	const sourceDescription = readFrontmatterField(content, "description") ?? fallbackDescription;
	const argumentHint = readFrontmatterField(content, "argument-hint");
	const description = formatClaudeMarketplaceDescription(plugin, sourceDescription, argumentHint);
	const kept = frontmatter ? removeFrontmatterFields(frontmatter.data, ["name", "description"]) : [];
	const body = rewriteSkillBody(frontmatter ? content.slice(frontmatter.bodyStart) : content, plugin);
	return ["---", `name: ${yamlString(name)}`, `description: ${yamlString(description)}`, ...kept, "---", body.trimStart()].join("\n");
}

async function syncPluginSupportFiles(plugin: InstalledPlugin): Promise<void> {
	const targetRoot = generatedPluginPath(plugin.marketplace, plugin.name);
	for (const name of ["scripts", "references", "assets", "bin"] as const) {
		const target = join(targetRoot, name);
		await rm(target, { recursive: true, force: true });
		try {
			await cp(join(plugin.cachePath, name), target, { recursive: true });
		} catch {
			// The plugin does not ship this optional support directory.
		}
	}
}

export async function listPluginSkillSources(plugin: InstalledPlugin): Promise<SkillSource[]> {
	const sources: SkillSource[] = [];
	const rootSkill = join(plugin.cachePath, "SKILL.md");
	if (await fileExists(rootSkill)) {
		const content = await readFile(rootSkill, "utf8");
		sources.push({ name: readFrontmatterField(content, "name") ?? plugin.name, path: rootSkill, root: plugin.cachePath });
	}

	for (const path of await findSkillFiles(join(plugin.cachePath, "skills"))) {
		const content = await readFile(path, "utf8");
		const fallback = basename(dirname(path));
		sources.push({ name: readFrontmatterField(content, "name") ?? fallback, path, root: dirname(path) });
	}

	return sources;
}

export function listPluginSkillSourcesSync(plugin: InstalledPlugin): SkillSource[] {
	const sources: SkillSource[] = [];
	const rootSkill = join(plugin.cachePath, "SKILL.md");
	try {
		const content = readFileSync(rootSkill, "utf8");
		sources.push({ name: readFrontmatterField(content, "name") ?? plugin.name, path: rootSkill, root: plugin.cachePath });
	} catch {
		// The plugin does not ship a root skill.
	}

	for (const path of findSkillFilesSync(join(plugin.cachePath, "skills"))) {
		try {
			const content = readFileSync(path, "utf8");
			const fallback = basename(dirname(path));
			sources.push({ name: readFrontmatterField(content, "name") ?? fallback, path, root: dirname(path) });
		} catch {
			// Ignore partially removed plugin cache entries while building UI metadata.
		}
	}

	return sources;
}

export async function generatePluginSkills(plugin: InstalledPlugin): Promise<string[]> {
	const targetRoot = generatedPluginSkillsPath(plugin.marketplace, plugin.name);
	await syncPluginSupportFiles(plugin);
	await rm(targetRoot, { recursive: true, force: true });

	const generated: string[] = [];
	for (const source of await listPluginSkillSources(plugin)) {
		const name = generatedSkillName(plugin, source.name);
		const targetDir = join(targetRoot, name);
		await mkdir(dirname(targetDir), { recursive: true });
		await cp(source.root, targetDir, { recursive: true });
		const skillPath = join(targetDir, relative(source.root, source.path));
		const content = await readFile(skillPath, "utf8");
		await writeFile(skillPath, rewriteFrontmatter(content, name, `Claude marketplace skill from ${plugin.id}.`, plugin));
		generated.push(targetDir);
	}

	return generated;
}

export async function discoverGeneratedSkillPaths(): Promise<string[]> {
	const store = await readInstalledPluginsStore();
	const paths: string[] = [];
	for (const plugin of store.plugins) {
		try {
			paths.push(...(await generatePluginSkills(plugin)));
		} catch {
			// Ignore stale or partially removed plugin cache entries during resource discovery.
		}
	}
	return paths;
}
