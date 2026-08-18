#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

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

function stateDirectory() {
	const override = process.env.PI_ZED_CONTEXT_STATE_DIR?.trim();
	if (override) return resolve(override);
	return resolve(tmpdir(), `pi-zed-context-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

if ((process.argv[2] ?? "capture") !== "capture") fail("usage: pi-zed-context capture --workspace PATH --file PATH [--row NUMBER]");

const workspaceInput = option("--workspace") ?? process.env.ZED_WORKTREE_ROOT;
const fileInput = option("--file") ?? process.env.ZED_FILE;
const rowInput = option("--row") ?? process.env.ZED_ROW;
const text = process.env.PI_ZED_SELECTED_TEXT ?? process.env.ZED_SELECTED_TEXT ?? "";
if (!workspaceInput) fail("missing ZED_WORKTREE_ROOT / --workspace");
if (!fileInput) fail("missing ZED_FILE / --file");
if (!text) fail("no text is selected in Zed");

const workspace = resolve(workspaceInput);
const file = resolve(fileInput);
const cursorRow = rowInput !== undefined && Number.isFinite(Number(rowInput)) ? Number(rowInput) : undefined;
const capture = {
	version: 1,
	id: randomUUID(),
	workspace,
	file,
	text,
	lineCount: countSelectedLines(text),
	cursorRow,
	capturedAt: Date.now(),
};
const directory = stateDirectory();
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const key = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
const destination = resolve(directory, `${key}.json`);
const temporary = resolve(directory, `.${key}.${process.pid}.${randomUUID()}.tmp`);
writeFileSync(temporary, `${JSON.stringify(capture)}\n`, { encoding: "utf8", mode: 0o600 });
renameSync(temporary, destination);

const staleBefore = capture.capturedAt - 24 * 60 * 60 * 1_000;
try {
	for (const entry of readdirSync(directory)) {
		if (!entry.endsWith(".json")) continue;
		const path = resolve(directory, entry);
		try {
			if (statSync(path).mtimeMs < staleBefore) rmSync(path, { force: true });
		} catch {
			// Best-effort cleanup only.
		}
	}
} catch {
	// Capturing succeeded; cleanup failures are irrelevant.
}

process.stdout.write(`Captured ${capture.lineCount} selected ${capture.lineCount === 1 ? "line" : "lines"}.\n`);
