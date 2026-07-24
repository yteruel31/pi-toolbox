import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ClaudeRuleScope = "project" | "user";

type ClaudeRule = {
	relativePath: string;
	displayPath: string;
	scope: ClaudeRuleScope;
	title: string;
	paths: string[];
};

function normalizeProjectPath(filePath: string, cwd: string): string | undefined {
	if (!filePath || filePath.startsWith("-")) {
		return undefined;
	}

	const withoutQuotes = filePath.replace(/^["']|["']$/g, "");
	const absolutePath = path.isAbsolute(withoutQuotes) ? withoutQuotes : path.resolve(cwd, withoutQuotes);

	const relativePath = path.relative(cwd, absolutePath).replaceAll(path.sep, "/");
	if (!relativePath || relativePath.startsWith("..")) {
		return undefined;
	}

	return relativePath;
}

function expandBraces(pattern: string): string[] {
	const match = pattern.match(/\{([^{}]+)\}/);
	if (!match) {
		return [pattern];
	}

	return match[1]
		.split(",")
		.flatMap((part) => expandBraces(pattern.slice(0, match.index) + part + pattern.slice((match.index ?? 0) + match[0].length)));
}

function globToRegExp(pattern: string): RegExp {
	let source = "^";

	for (let index = 0; index < pattern.length; index += 1) {
		const char = pattern[index];
		const next = pattern[index + 1];

		if (char === "*" && next === "*") {
			source += ".*";
			index += 1;
		} else if (char === "*") {
			source += "[^/]*";
		} else if (char === "?") {
			source += "[^/]";
		} else {
			source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
		}
	}

	return new RegExp(`${source}$`);
}

function matchesRulePath(filePath: string, rulePath: string): boolean {
	return expandBraces(rulePath).some((pattern) => globToRegExp(pattern).test(filePath));
}

function matchingRulesForFiles(rules: ClaudeRule[], files: string[]): ClaudeRule[] {
	if (files.length === 0) {
		return [];
	}

	return rules.filter((rule) => {
		if (rule.paths.length === 0) {
			return false;
		}
		return files.some((file) => rule.paths.some((rulePath) => matchesRulePath(file, rulePath)));
	});
}

function extractPathLikeTokens(command: string): string[] {
	return [...command.matchAll(/(?:^|\s)([./]?[\w@-][\w@./(){}+,-]*\.\w+)(?=\s|$)/g)].map((match) => match[1]);
}

const IGNORED_DIRS = new Set([".git", ".bare", "node_modules", ".next", "dist", "build", "coverage", ".turbo", ".cache"]);
const MAX_DESCENDANT_DEPTH = 4;

function findMarkdownFiles(dir: string, basePath = ""): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}

	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
		const absolutePath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			if (!IGNORED_DIRS.has(entry.name)) {
				files.push(...findMarkdownFiles(absolutePath, relativePath));
			}
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(relativePath);
		}
	}

	return files.sort((a, b) => a.localeCompare(b));
}

function findDescendantDirectories(rootDir: string, targetDirectoryPath: string): string[] {
	if (!fs.existsSync(rootDir)) {
		return [];
	}

	const results: string[] = [];
	const targetParts = targetDirectoryPath.split("/");

	const visit = (directory: string, relativeDirectory: string, depth: number) => {
		if (depth > MAX_DESCENDANT_DEPTH) {
			return;
		}

		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || IGNORED_DIRS.has(entry.name)) {
				continue;
			}

			const absolutePath = path.join(directory, entry.name);
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			const relativeParts = relativePath.split("/");
			const tail = relativeParts.slice(-targetParts.length).join("/");

			if (tail === targetDirectoryPath) {
				results.push(relativePath);
			}

			visit(absolutePath, relativePath, depth + 1);
		}
	};

	visit(rootDir, "", 0);
	return results.sort((a, b) => a.localeCompare(b));
}

function parseRule(rulesDir: string, relativePath: string, scope: ClaudeRuleScope, displayRoot: string, matchPathPrefix = ""): ClaudeRule {
	const content = fs.readFileSync(path.join(rulesDir, relativePath), "utf8");
	const paths: string[] = [];

	const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
	if (frontmatter) {
		const lines = frontmatter[1].split("\n");
		let inPaths = false;

		for (const line of lines) {
			if (/^paths:\s*$/.test(line)) {
				inPaths = true;
				continue;
			}

			if (inPaths) {
				const match = line.match(/^\s*-\s*["']?([^"']+)["']?\s*$/);
				if (match) {
					paths.push(match[1]);
					continue;
				}

				if (/^\S/.test(line)) {
					inPaths = false;
				}
			}
		}
	}

	const body = frontmatter ? content.slice(frontmatter[0].length) : content;
	const heading = body.match(/^##?\s+(.+)$/m);
	const title = heading?.[1]?.trim() || relativePath.replace(/\.md$/, "");

	return {
		relativePath,
		displayPath: `${displayRoot}/${relativePath}`,
		scope,
		title,
		paths: matchPathPrefix ? paths.map((rulePath) => `${matchPathPrefix}/${rulePath}`) : paths,
	};
}

function formatRule(rule: ClaudeRule): string {
	const pathHint = rule.paths.length > 0 ? ` (${rule.paths.join(", ")})` : "";
	return `- ${rule.displayPath} - ${rule.title}${pathHint}`;
}

function formatRuleBadge(rule: ClaudeRule): string {
	const scopePrefix = rule.scope === "user" ? "user:" : "";
	return `${scopePrefix}${rule.relativePath.replace(/\.md$/, "")}`;
}

export default function claudeRulesExtension(pi: ExtensionAPI): void {
	let rules: ClaudeRule[] = [];
	let cwd = "";
	let feedbackVersion = 0;
	let feedbackTimeout: ReturnType<typeof setTimeout> | undefined;
	const touchedFiles = new Set<string>();

	const showTemporaryFeedback = (ctx: ExtensionContext, status: string, widgetLines?: string[]) => {
		feedbackVersion += 1;
		const currentVersion = feedbackVersion;

		ctx.ui.setStatus("claude-rules", status);
		ctx.ui.setWidget("claude-rules", widgetLines);

		if (feedbackTimeout) {
			clearTimeout(feedbackTimeout);
		}

		feedbackTimeout = setTimeout(() => {
			if (feedbackVersion !== currentVersion) {
				return;
			}

			ctx.ui.setStatus("claude-rules", undefined);
			ctx.ui.setWidget("claude-rules", undefined);
		}, 6_000);
	};

	const refreshRules = (currentCwd: string) => {
		cwd = currentCwd;

		const projectRulesDir = path.join(cwd, ".claude", "rules");
		const userRulesDir = path.join(os.homedir(), ".claude", "rules");
		const loadedRules: ClaudeRule[] = [];

		loadedRules.push(...findMarkdownFiles(projectRulesDir).map((file) => parseRule(projectRulesDir, file, "project", ".claude/rules")));

		for (const rulesDir of findDescendantDirectories(cwd, ".claude/rules")) {
			const absoluteRulesDir = path.join(cwd, rulesDir);
			const projectPrefix = rulesDir.replace(/(^|\/)\.claude\/rules$/, "");
			loadedRules.push(...findMarkdownFiles(absoluteRulesDir).map((file) => parseRule(absoluteRulesDir, file, "project", rulesDir, projectPrefix)));
		}

		if (path.resolve(userRulesDir) !== path.resolve(projectRulesDir)) {
			loadedRules.push(...findMarkdownFiles(userRulesDir).map((file) => parseRule(userRulesDir, file, "user", "~/.claude/rules")));
		}

		rules = loadedRules;
	};

	pi.on("session_start", async (_event, ctx) => {
		refreshRules(ctx.cwd);

		if (rules.length > 0) {
			const projectRules = rules.filter((rule) => rule.scope === "project").length;
			const userRules = rules.filter((rule) => rule.scope === "user").length;
			ctx.ui.notify(`Loaded ${rules.length} Claude rule(s): ${projectRules} project, ${userRules} user`, "info");
		}
	});

	pi.on("resources_discover", async (event) => {
		refreshRules(event.cwd);
	});

	pi.on("tool_call", async (event) => {
		const input = event.input as { path?: string; command?: string };

		if (["read", "write", "edit"].includes(event.toolName) && input.path) {
			const projectPath = normalizeProjectPath(input.path, cwd);
			if (projectPath) {
				touchedFiles.add(projectPath);
			}
		}

		if (event.toolName === "bash" && input.command) {
			for (const token of extractPathLikeTokens(input.command)) {
				const projectPath = normalizeProjectPath(token, cwd);
				if (projectPath) {
					touchedFiles.add(projectPath);
				}
			}
		}
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (rules.length === 0) {
			showTemporaryFeedback(ctx, "rules: 0");
			return;
		}

		const prompt = event.prompt.toLowerCase();
		const promptFiles = extractPathLikeTokens(event.prompt)
			.map((file) => normalizeProjectPath(file, cwd))
			.filter((file): file is string => Boolean(file));
		const filesForMatching = [...new Set([...touchedFiles, ...promptFiles])];
		const pathMatchedRules = matchingRulesForFiles(rules, filesForMatching);
		const textMatchedRules = rules.filter((rule) => {
			const haystack = `${rule.relativePath} ${rule.title} ${rule.paths.join(" ")}`.toLowerCase();
			return prompt.split(/\W+/).some((word) => word.length >= 5 && haystack.includes(word));
		});

		const relevantRules = [...new Map([...pathMatchedRules, ...textMatchedRules].map((rule) => [rule.relativePath, rule])).values()];
		const highlightedRules = relevantRules.length > 0 ? relevantRules : rules;
		const shownRules = highlightedRules.slice(0, 80).map(formatRule).join("\n");
		const remaining = highlightedRules.length > 80 ? `\n- ...and ${highlightedRules.length - 80} more rule(s)` : "";
		const touchedFilesList = filesForMatching.slice(-30).map((file) => `- ${file}`).join("\n");
		const visualRules = highlightedRules.slice(0, 6).map(formatRuleBadge);
		const visualSuffix = highlightedRules.length > visualRules.length ? ` +${highlightedRules.length - visualRules.length}` : "";
		const matchLabel = pathMatchedRules.length > 0 ? "path-matched" : relevantRules.length > 0 ? "relevant" : "available";

		showTemporaryFeedback(ctx, `rules: ${highlightedRules.length} ${matchLabel}`, [
			`Claude rules (${highlightedRules.length} ${matchLabel}): ${visualRules.join(", ")}${visualSuffix}`,
		]);

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Claude rules\n\nThis environment uses Claude Code rule files from repository scope (\`.claude/rules/\`) and user scope (\`~/.claude/rules/\`). Before changing code, identify rule files relevant to the files, framework, or feature area you are touching and read them with the read tool. Treat these rules as project instructions.\n\n${filesForMatching.length > 0 ? `Files detected for rule path matching:\n${touchedFilesList}\n\n` : ""}Available rules${pathMatchedRules.length > 0 ? " matching detected file paths" : relevantRules.length > 0 ? " likely relevant to the current request" : ""}:\n${shownRules}${remaining}\n`,
		};
	});
}
