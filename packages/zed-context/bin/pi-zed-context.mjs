#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve, sep } from "node:path";

function fail(message) {
	process.stderr.write(`pi-zed-context: ${message}\n`);
	process.exit(1);
}

function option(name) {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function countSelectedLines(text) {
	if (!text) return 0;
	const newlineCount = text.match(/\n/g)?.length ?? 0;
	return Math.max(1, newlineCount + (text.endsWith("\n") ? 0 : 1));
}

function truncateUtf8(text, maxBytes) {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle), "utf8") <= maxBytes) low = middle;
		else high = middle - 1;
	}
	let end = low;
	const code = text.charCodeAt(end - 1);
	if (code >= 0xd800 && code <= 0xdbff) end -= 1;
	return text.slice(0, Math.max(0, end));
}

function boundSelection(text) {
	let bounded = text;
	let truncated = false;
	const lines = bounded.split("\n");
	if (lines.length > 2_000) {
		bounded = lines.slice(0, 2_000).join("\n");
		truncated = true;
	}
	if (Buffer.byteLength(bounded, "utf8") > 50 * 1024) {
		bounded = truncateUtf8(bounded, 50 * 1024);
		truncated = true;
	}
	return { text: bounded, truncated };
}

function stateDirectory() {
	const override = process.env.PI_ZED_CONTEXT_STATE_DIR?.trim();
	if (override) return resolve(override);
	return resolve(tmpdir(), `pi-zed-context-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

function ensurePrivateStateDirectory(directory) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(directory);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) fail(`unsafe state directory: ${directory}`);
	if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
		fail(`state directory is owned by another user: ${directory}`);
	}
	chmodSync(directory, 0o700);
}

function canonicalPath(path) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isInsideOrEqual(parent, child) {
	const path = relative(canonicalPath(parent), canonicalPath(child));
	return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

const command = process.argv[2] ?? "capture";
if (command === "lsp") {
	const workspace = option("--workspace") ?? process.cwd();
	const { runLspServer } = await import("./pi-zed-context-lsp.mjs");
	runLspServer({ workspace });
} else {
	if (command !== "capture") {
		fail("usage: pi-zed-context <lsp|capture> [--workspace PATH --file PATH --row NUMBER]");
	}

	const workspaceInput = option("--workspace") ?? process.env.ZED_WORKTREE_ROOT;
	const fileInput = option("--file") ?? process.env.ZED_FILE;
	const rowInput = option("--row") ?? process.env.ZED_ROW;
	const text = process.env.PI_ZED_SELECTED_TEXT ?? process.env.ZED_SELECTED_TEXT ?? "";
	if (!workspaceInput) fail("missing ZED_WORKTREE_ROOT / --workspace");
	if (!fileInput) fail("missing ZED_FILE / --file");
	if (!text) fail("no text is selected in Zed");

	const workspace = canonicalPath(workspaceInput);
	const file = canonicalPath(fileInput);
	if (!isInsideOrEqual(workspace, file)) fail("selected file is outside the Zed worktree");
	const cursorRow = rowInput !== undefined && Number.isFinite(Number(rowInput)) ? Number(rowInput) : undefined;
	const bounded = boundSelection(text);
	const capture = {
		version: 1,
		id: randomUUID(),
		workspace,
		file,
		text: bounded.text,
		lineCount: countSelectedLines(text),
		cursorRow,
		capturedAt: Date.now(),
		source: "task",
		truncated: bounded.truncated || undefined,
	};
	const directory = stateDirectory();
	ensurePrivateStateDirectory(directory);
	const key = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
	const destination = resolve(directory, `${key}.json`);
	const temporary = resolve(directory, `.${key}.${process.pid}.${randomUUID()}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(capture)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try {
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}

	const staleBefore = capture.capturedAt - 24 * 60 * 60 * 1_000;
	try {
		for (const entry of readdirSync(directory)) {
			if (!entry.endsWith(".json")) continue;
			const path = resolve(directory, entry);
			try {
				if (lstatSync(path).mtimeMs < staleBefore) rmSync(path, { force: true });
			} catch {
				// Best-effort cleanup only.
			}
		}
	} catch {
		// Capturing succeeded; cleanup failures are irrelevant.
	}

	process.stdout.write(`Captured ${capture.lineCount} selected ${capture.lineCount === 1 ? "line" : "lines"}.\n`);
}
