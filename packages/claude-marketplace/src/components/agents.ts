import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { readInstalledPluginsStore } from "../plugins/installed-store.js";
import type { InstalledPlugin } from "../plugins/types.js";
import { generatedPluginAgentsPath, pluginDataPath } from "../state/paths.js";
export type AgentSource = {
	name: string;
	description: string;
	path: string;
	body: string;
	frontmatter: Record<string, string>;
};

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function findAgentFiles(root: string): Promise<string[]> {
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
			else if (entry.isFile() && entry.name.endsWith(".md")) results.push(path);
		}
	}
	await walk(root);
	return results.sort();
}

function splitMarkdownFrontmatter(content: string): { data: string; body: string } {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	return match ? { data: match[1], body: content.slice(match[0].length) } : { data: "", body: content };
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1);
	return trimmed;
}

function parseFrontmatter(data: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const line of data.split(/\r?\n/)) {
		const match = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
		if (match) fields[match[1]] = unquote(match[2]);
	}
	return fields;
}

function safeSlug(value: string, fallback: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "") || fallback;
}

export function generatedAgentName(plugin: InstalledPlugin, sourceName: string): string {
	const base = safeSlug(`claude-${plugin.marketplace}-${plugin.name}-${sourceName}`, "agent");
	if (base.length <= 90) return base;
	const hash = createHash("sha1").update(base).digest("hex").slice(0, 8);
	return `${base.slice(0, 81).replace(/-+$/g, "")}-${hash}`;
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function parseToolList(value: string | undefined): string[] {
	if (!value) return [];
	return value
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
}

function mapClaudeTool(tool: string): string | undefined {
	if (tool.startsWith("mcp__")) return "mcp";
	const map: Record<string, string | undefined> = {
		Bash: "bash",
		BashOutput: "bash",
		KillBash: "bash",
		Read: "read",
		Grep: "grep",
		Glob: "find",
		LS: "ls",
		Write: "write",
		Edit: "edit",
		MultiEdit: "edit",
		WebFetch: "fetch_content",
		WebSearch: "web_search",
		AskUserQuestion: "ask_user",
		TodoWrite: undefined,
		Task: undefined,
	};
	return Object.hasOwn(map, tool) ? map[tool] : undefined;
}

function piToolsFromClaudeTools(tools: string[]): string[] {
	const mapped = tools.map(mapClaudeTool).filter((tool): tool is string => Boolean(tool));
	const unique = [...new Set(mapped)];
	return unique.length > 0 ? unique.sort() : ["read", "grep", "find", "bash"];
}

function rewriteAgentBody(body: string, plugin: InstalledPlugin): string {
	return body
		.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, plugin.cachePath)
		.replace(/\$\{CLAUDE_PLUGIN_DATA\}/g, pluginDataPath(plugin.marketplace, plugin.name))
		.replace(/\bAskUserQuestion\b/g, "ask_user")
		.replace(/Skill\("([^":]+):([^"]+)",\s*"([^"]*)"\)/g, (_match, pluginName: string, skillName: string, args: string) => {
			return `/skill:${safeSlug(`claude-${pluginName}-${skillName}`, "skill")} ${args}`.trim();
		})
		.replace(/Skill\("([^":]+):([^"]+)"\)/g, (_match, pluginName: string, skillName: string) => `/skill:${safeSlug(`claude-${pluginName}-${skillName}`, "skill")}`);
}

export async function listPluginAgentSources(plugin: InstalledPlugin): Promise<AgentSource[]> {
	const root = join(plugin.cachePath, "agents");
	if (!(await pathExists(root))) return [];

	const sources: AgentSource[] = [];
	for (const path of await findAgentFiles(root)) {
		const content = await readFile(path, "utf8");
		const { data, body } = splitMarkdownFrontmatter(content);
		const frontmatter = parseFrontmatter(data);
		sources.push({
			name: frontmatter.name || basename(path).replace(/\.md$/i, ""),
			description: frontmatter.description || `Claude marketplace agent from ${plugin.id}.`,
			path,
			body,
			frontmatter,
		});
	}
	return sources;
}

export async function generatePluginAgents(plugin: InstalledPlugin): Promise<string[]> {
	const targetRoot = generatedPluginAgentsPath(plugin.marketplace, plugin.name);
	await rm(targetRoot, { recursive: true, force: true });
	await mkdir(targetRoot, { recursive: true });

	const generated: string[] = [];
	for (const source of await listPluginAgentSources(plugin)) {
		const name = generatedAgentName(plugin, source.name);
		const tools = piToolsFromClaudeTools(parseToolList(source.frontmatter.tools));
		const omitted = ["model", "color", "permissionMode", "effort", "maxTurns", "isolation"].filter((field) => source.frontmatter[field] !== undefined);
		const noteLines = [
			`Generated from Claude marketplace agent ${source.name} in ${plugin.id}.`,
			`Plugin root: ${plugin.cachePath}`,
			`Plugin data: ${pluginDataPath(plugin.marketplace, plugin.name)}`,
			omitted.length ? `Claude-only metadata not mapped to Pi frontmatter: ${omitted.join(", ")}.` : undefined,
			parseToolList(source.frontmatter.tools).some((tool) => tool.startsWith("mcp__")) ? "Claude MCP direct-tool names were mapped to the Pi mcp proxy tool. Use mcp search/describe/tool calls when those tools are needed." : undefined,
		].filter((line): line is string => line !== undefined);
		const content = [
			"---",
			`name: ${yamlString(name)}`,
			`description: ${yamlString(source.description)}`,
			`tools: ${tools.join(", ")}`,
			"systemPromptMode: replace",
			"inheritProjectContext: true",
			"inheritSkills: true",
			"---",
			"",
			...noteLines.map((line) => `> ${line}`),
			"",
			rewriteAgentBody(source.body, plugin).trimStart(),
		].join("\n");
		const target = join(targetRoot, `${name}.md`);
		await writeFile(target, content);
		generated.push(target);
	}
	return generated;
}

export async function discoverGeneratedAgentPaths(): Promise<string[]> {
	const store = await readInstalledPluginsStore();
	const paths: string[] = [];
	for (const plugin of store.plugins) {
		try {
			paths.push(...(await generatePluginAgents(plugin)));
		} catch {
			// Ignore stale or partially removed plugin cache entries during discovery.
		}
	}
	return paths;
}
