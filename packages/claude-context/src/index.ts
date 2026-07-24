import * as fs from "node:fs";
import * as path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type ClaudeContextFile = {
	relativePath: string;
	displayPath: string;
	absolutePath: string;
	title: string;
};

const IGNORED_DIRS = new Set([".git", ".bare", "node_modules", ".next", "dist", "build", "coverage", ".turbo", ".cache"]);
const MAX_DESCENDANT_DEPTH = 4;
const MAX_SCANNED_FILES = 2_000;

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

function extractPathLikeTokens(command: string): string[] {
	return [...command.matchAll(/(?:^|\s)([./]?\w[\w@./(){}+,-]*(?:\.\w+|\/\w[\w@./(){}+,-]*))(?=\s|$)/g)].map((match) => match[1]);
}

function findDescendantContextFiles(rootDir: string): string[] {
	if (!fs.existsSync(rootDir)) {
		return [];
	}

	const results: string[] = [];
	let scannedFiles = 0;

	const visit = (directory: string, relativeDirectory: string, depth: number) => {
		if (depth > MAX_DESCENDANT_DEPTH || scannedFiles > MAX_SCANNED_FILES) {
			return;
		}

		for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
			if (IGNORED_DIRS.has(entry.name)) {
				continue;
			}

			const absolutePath = path.join(directory, entry.name);
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;

			if (entry.isDirectory()) {
				visit(absolutePath, relativePath, depth + 1);
			} else if (entry.isFile()) {
				scannedFiles += 1;
				if (entry.name === "CLAUDE.md") {
					results.push(relativePath);
				}
			}
		}
	};

	visit(rootDir, "", 0);
	return results.sort((a, b) => a.localeCompare(b));
}

function parseContextFile(rootDir: string, relativePath: string): ClaudeContextFile {
	const absolutePath = path.join(rootDir, relativePath);
	const content = fs.readFileSync(absolutePath, "utf8");
	const heading = content.match(/^##?\s+(.+)$/m);
	const title = heading?.[1]?.trim() || relativePath;

	return {
		relativePath,
		displayPath: relativePath,
		absolutePath,
		title,
	};
}

function isWithinContextDirectory(filePath: string, contextFilePath: string): boolean {
	const directory = contextFilePath.replace(/(^|\/)CLAUDE\.md$/, "");
	return directory === "" || filePath === directory || filePath.startsWith(`${directory}/`);
}

function matchingContextFiles(contextFiles: ClaudeContextFile[], files: string[]): ClaudeContextFile[] {
	if (files.length === 0) {
		return [];
	}

	return contextFiles.filter((contextFile) => files.some((file) => isWithinContextDirectory(file, contextFile.relativePath)));
}

function formatContextFile(contextFile: ClaudeContextFile): string {
	return `- ${contextFile.displayPath} - ${contextFile.title}`;
}

function formatContextBadge(contextFile: ClaudeContextFile): string {
	return contextFile.relativePath.replace(/\/CLAUDE\.md$/, "").replace(/^CLAUDE\.md$/, ".");
}

export default function claudeContextExtension(pi: ExtensionAPI): void {
	let contextFiles: ClaudeContextFile[] = [];
	let cwd = "";
	let feedbackVersion = 0;
	let feedbackTimeout: ReturnType<typeof setTimeout> | undefined;
	const touchedFiles = new Set<string>();

	const showTemporaryFeedback = (ctx: ExtensionContext, status: string, widgetLines?: string[]) => {
		feedbackVersion += 1;
		const currentVersion = feedbackVersion;

		ctx.ui.setStatus("claude-context", status);
		ctx.ui.setWidget("claude-context", widgetLines);

		if (feedbackTimeout) {
			clearTimeout(feedbackTimeout);
		}

		feedbackTimeout = setTimeout(() => {
			if (feedbackVersion !== currentVersion) {
				return;
			}

			ctx.ui.setStatus("claude-context", undefined);
			ctx.ui.setWidget("claude-context", undefined);
		}, 6_000);
	};

	const refreshContextFiles = (currentCwd: string) => {
		cwd = currentCwd;
		contextFiles = findDescendantContextFiles(cwd).map((file) => parseContextFile(cwd, file));
	};

	pi.on("session_start", async (_event, ctx) => {
		refreshContextFiles(ctx.cwd);

		if (contextFiles.length > 0) {
			ctx.ui.notify(`Loaded ${contextFiles.length} Claude context file(s)`, "info");
		}
	});

	pi.on("resources_discover", async (event) => {
		refreshContextFiles(event.cwd);
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
		if (contextFiles.length === 0) {
			showTemporaryFeedback(ctx, "context: 0");
			return;
		}

		const prompt = event.prompt.toLowerCase();
		const promptFiles = extractPathLikeTokens(event.prompt)
			.map((file) => normalizeProjectPath(file, cwd))
			.filter((file): file is string => Boolean(file));
		const filesForMatching = [...new Set([...touchedFiles, ...promptFiles])];
		const pathMatchedContextFiles = matchingContextFiles(contextFiles, filesForMatching);
		const textMatchedContextFiles = contextFiles.filter((contextFile) => {
			const haystack = `${contextFile.relativePath} ${contextFile.title}`.toLowerCase();
			return prompt.split(/\W+/).some((word) => word.length >= 5 && haystack.includes(word));
		});

		const relevantContextFiles = [...new Map([...pathMatchedContextFiles, ...textMatchedContextFiles].map((contextFile) => [contextFile.displayPath, contextFile])).values()];
		const highlightedContextFiles = relevantContextFiles.length > 0 ? relevantContextFiles : contextFiles;
		const shownContextFiles = highlightedContextFiles.slice(0, 80).map(formatContextFile).join("\n");
		const remaining = highlightedContextFiles.length > 80 ? `\n- ...and ${highlightedContextFiles.length - 80} more context file(s)` : "";
		const touchedFilesList = filesForMatching.slice(-30).map((file) => `- ${file}`).join("\n");
		const visualContextFiles = highlightedContextFiles.slice(0, 6).map(formatContextBadge);
		const visualSuffix = highlightedContextFiles.length > visualContextFiles.length ? ` +${highlightedContextFiles.length - visualContextFiles.length}` : "";
		const matchLabel = pathMatchedContextFiles.length > 0 ? "path-matched" : relevantContextFiles.length > 0 ? "relevant" : "available";

		showTemporaryFeedback(ctx, `context: ${highlightedContextFiles.length} ${matchLabel}`, [
			`Claude context (${highlightedContextFiles.length} ${matchLabel}): ${visualContextFiles.join(", ")}${visualSuffix}`,
		]);

		return {
			systemPrompt: `${event.systemPrompt}\n\n## Claude context files\n\nThis environment uses Claude Code context files (\`CLAUDE.md\`) from the current directory and descendant project directories. Before changing code, identify context files relevant to the files, framework, or feature area you are touching and read them with the read tool. Treat these files as project instructions.\n\n${filesForMatching.length > 0 ? `Files detected for context path matching:\n${touchedFilesList}\n\n` : ""}Available context files${pathMatchedContextFiles.length > 0 ? " matching detected file paths" : relevantContextFiles.length > 0 ? " likely relevant to the current request" : ""}:\n${shownContextFiles}${remaining}\n`,
		};
	});
}
