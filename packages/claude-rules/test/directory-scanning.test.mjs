import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";

import { findDescendantDirectories, findMarkdownFiles } from "../src/directory-scanning.ts";

const temporaryDirectories = [];

function createTemporaryDirectory() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claude-rules-"));
	temporaryDirectories.push(directory);
	return directory;
}

function permissionDenied(directory) {
	return Object.assign(new Error(`EPERM: operation not permitted, scandir '${directory}'`), {
		code: "EPERM",
		path: directory,
		syscall: "scandir",
	});
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("descendant rule discovery skips unreadable directories and continues scanning", () => {
	const root = createTemporaryDirectory();
	const blockedDirectory = path.join(root, "blocked");
	const rulesDirectory = path.join(root, "package", ".claude", "rules");
	fs.mkdirSync(blockedDirectory);
	fs.mkdirSync(rulesDirectory, { recursive: true });

	const readDirectory = (directory) => {
		if (directory === blockedDirectory) {
			throw permissionDenied(directory);
		}
		return fs.readdirSync(directory, { withFileTypes: true });
	};

	assert.deepEqual(findDescendantDirectories(root, ".claude/rules", readDirectory), ["package/.claude/rules"]);
});

test("rule file discovery skips unreadable subdirectories", () => {
	const root = createTemporaryDirectory();
	const blockedDirectory = path.join(root, "blocked");
	fs.mkdirSync(blockedDirectory);
	fs.writeFileSync(path.join(root, "project.md"), "# Project rule\n");

	const readDirectory = (directory) => {
		if (directory === blockedDirectory) {
			throw permissionDenied(directory);
		}
		return fs.readdirSync(directory, { withFileTypes: true });
	};

	assert.deepEqual(findMarkdownFiles(root, "", readDirectory), ["project.md"]);
});

test("directory discovery still surfaces unexpected filesystem errors", () => {
	const root = createTemporaryDirectory();
	const diskError = Object.assign(new Error("I/O failure"), { code: "EIO" });

	assert.throws(() => findDescendantDirectories(root, ".claude/rules", () => {
		throw diskError;
	}), diskError);
});
