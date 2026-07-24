import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, resolve, sep, join } from "node:path";
import { promisify } from "node:util";
import type { MarketplacePluginEntry } from "../registry/types.js";
import type { IndexedPlugin, PluginSourceType } from "./types.js";

const execFileAsync = promisify(execFile);

export type GitHubPluginSource = {
	kind: "github";
	repo: string;
	ref?: string;
	sha?: string;
	path?: string;
	url?: string;
	raw: Record<string, unknown>;
};

export type ParsedExternalPluginSource = GitHubPluginSource;

function stringField(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function parseExternalPluginSource(entry: MarketplacePluginEntry): ParsedExternalPluginSource | undefined {
	if (!entry.source || typeof entry.source !== "object" || Array.isArray(entry.source)) return undefined;
	const raw = entry.source as Record<string, unknown>;
	const sourceKind = stringField(raw.source) ?? stringField(raw.type) ?? stringField(raw.kind);
	if (sourceKind !== "github") return undefined;

	const repo = stringField(raw.repo) ?? stringField(raw.repository);
	if (!repo) return undefined;

	return {
		kind: "github",
		repo,
		ref: stringField(raw.ref) ?? stringField(raw.branch) ?? stringField(raw.tag),
		sha: stringField(raw.sha) ?? stringField(raw.commit),
		path: stringField(raw.path),
		url: stringField(raw.url) ?? stringField(raw.cloneUrl) ?? stringField(raw.clone_url),
		raw,
	};
}

export function pluginSourceType(entry: MarketplacePluginEntry): PluginSourceType {
	if (typeof entry.source === "string") return "local";
	return parseExternalPluginSource(entry)?.kind ?? "external";
}

function cloneUrl(source: GitHubPluginSource): string {
	if (source.url) return source.url;
	if (source.repo.includes("://") || source.repo.startsWith("file:") || isAbsolute(source.repo) || source.repo.startsWith(".")) {
		return source.repo;
	}
	return `https://github.com/${source.repo.replace(/\.git$/, "")}.git`;
}

async function git(args: string[], cwd?: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd, timeout: 120_000, maxBuffer: 1024 * 1024 * 10 });
	return String(stdout).trim();
}

function assertPathInside(parent: string, child: string): void {
	const relative = child === parent ? "" : child.startsWith(`${parent}${sep}`) ? child.slice(parent.length + 1) : "..";
	if (relative === ".." || relative.startsWith(`..${sep}`) || isAbsolute(relative)) {
		throw new Error(`External plugin path escapes repository checkout: ${child}`);
	}
}

async function checkoutGitHubSource(source: GitHubPluginSource, checkoutDir: string): Promise<void> {
	const url = cloneUrl(source);
	const args = ["clone", "--no-tags", "--depth", "1"];
	if (source.ref) args.push("--branch", source.ref);
	args.push(url, checkoutDir);
	await git(args);

	if (source.sha) {
		const head = await git(["rev-parse", "HEAD"], checkoutDir);
		if (head !== source.sha) {
			throw new Error(`GitHub source ${source.repo} resolved to ${head}, expected ${source.sha}.`);
		}
	}
}

export function formatExternalPluginSource(source: ParsedExternalPluginSource | undefined): string | undefined {
	if (!source) return undefined;
	return [
		`github:${source.repo}`,
		source.ref ? `ref=${source.ref}` : undefined,
		source.sha ? `sha=${source.sha}` : undefined,
		source.path ? `path=${source.path}` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join(" ");
}

export async function materializeIndexedPluginSource(plugin: IndexedPlugin, destination: string): Promise<{ sourceType: PluginSourceType; sourcePath: string }> {
	await rm(destination, { recursive: true, force: true });
	await mkdir(dirname(destination), { recursive: true });

	if (plugin.sourceType === "local") {
		if (!plugin.pluginPath) throw new Error(`Local plugin path missing: ${plugin.id}`);
		await cp(plugin.pluginPath, destination, { recursive: true });
		return { sourceType: "local", sourcePath: plugin.pluginPath };
	}

	if (plugin.sourceType === "github" && plugin.externalSource?.kind === "github") {
		const tempRoot = await mkdtemp(join(tmpdir(), "pi-claude-marketplace-git-"));
		try {
			const checkoutDir = join(tempRoot, "repo");
			await checkoutGitHubSource(plugin.externalSource, checkoutDir);
			const pluginPath = resolve(checkoutDir, plugin.externalSource.path ?? ".");
			assertPathInside(checkoutDir, pluginPath);
			await cp(pluginPath, destination, { recursive: true });
			return { sourceType: "github", sourcePath: formatExternalPluginSource(plugin.externalSource) ?? plugin.externalSource.repo };
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	}

	throw new Error(`Unsupported external plugin source for ${plugin.id}.`);
}
