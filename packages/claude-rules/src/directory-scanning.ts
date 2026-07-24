import * as fs from "node:fs";
import * as path from "node:path";

const IGNORED_DIRS = new Set([".git", ".bare", "node_modules", ".next", "dist", "build", "coverage", ".turbo", ".cache"]);
const MAX_DESCENDANT_DEPTH = 4;
const SKIPPABLE_DIRECTORY_ERROR_CODES = new Set(["EACCES", "ENOENT", "EPERM"]);

export type ReadDirectory = (directory: string) => fs.Dirent[];

const readDirectory: ReadDirectory = (directory) => fs.readdirSync(directory, { withFileTypes: true });

function readAccessibleDirectory(directory: string, read: ReadDirectory): fs.Dirent[] {
	try {
		return read(directory);
	} catch (error) {
		const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
		if (typeof code === "string" && SKIPPABLE_DIRECTORY_ERROR_CODES.has(code)) {
			return [];
		}
		throw error;
	}
}

export function findMarkdownFiles(dir: string, basePath = "", read: ReadDirectory = readDirectory): string[] {
	const files: string[] = [];

	const visit = (directory: string, relativeDirectory: string) => {
		for (const entry of readAccessibleDirectory(directory, read)) {
			const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
			const absolutePath = path.join(directory, entry.name);

			if (entry.isDirectory()) {
				if (!IGNORED_DIRS.has(entry.name)) {
					visit(absolutePath, relativePath);
				}
			} else if (entry.isFile() && entry.name.endsWith(".md")) {
				files.push(relativePath);
			}
		}
	};

	visit(dir, basePath);
	return files.sort((a, b) => a.localeCompare(b));
}

export function findDescendantDirectories(
	rootDir: string,
	targetDirectoryPath: string,
	read: ReadDirectory = readDirectory,
): string[] {
	const results: string[] = [];
	const targetParts = targetDirectoryPath.split("/");

	const visit = (directory: string, relativeDirectory: string, depth: number) => {
		if (depth > MAX_DESCENDANT_DEPTH) {
			return;
		}

		for (const entry of readAccessibleDirectory(directory, read)) {
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
