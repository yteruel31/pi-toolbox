import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const CAPTURE_VERSION = 1;
export const STATE_DIR_ENV = "PI_ZED_CONTEXT_STATE_DIR";
export const MAX_CONTEXT_BYTES = 50 * 1024;
export const MAX_CONTEXT_LINES = 2_000;

export interface ZedCapture {
	version: typeof CAPTURE_VERSION;
	id: string;
	workspace: string;
	file: string;
	text: string;
	lineCount: number;
	cursorRow?: number;
	capturedAt: number;
}

export interface BoundedSelection {
	text: string;
	truncated: boolean;
}

export function stateDirectory(env: NodeJS.ProcessEnv = process.env): string {
	const override = env[STATE_DIR_ENV]?.trim();
	if (override) return resolve(override);
	return resolve(tmpdir(), `pi-zed-context-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
}

export function countSelectedLines(text: string): number {
	if (!text) return 0;
	const newlineCount = text.match(/\n/g)?.length ?? 0;
	return Math.max(1, newlineCount + (text.endsWith("\n") ? 0 : 1));
}

function truncateUtf8(text: string, maxBytes: number): string {
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

export function boundSelection(text: string): BoundedSelection {
	let bounded = text;
	let truncated = false;
	const lines = bounded.split("\n");

	if (lines.length > MAX_CONTEXT_LINES) {
		bounded = lines.slice(0, MAX_CONTEXT_LINES).join("\n");
		truncated = true;
	}

	if (Buffer.byteLength(bounded, "utf8") > MAX_CONTEXT_BYTES) {
		bounded = truncateUtf8(bounded, MAX_CONTEXT_BYTES);
		truncated = true;
	}

	return { text: bounded, truncated };
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function parseCapture(value: unknown): ZedCapture | undefined {
	if (!value || typeof value !== "object") return undefined;
	const candidate = value as Partial<ZedCapture>;
	if (
		candidate.version !== CAPTURE_VERSION ||
		!isString(candidate.id) ||
		!isString(candidate.workspace) ||
		!isString(candidate.file) ||
		typeof candidate.text !== "string" ||
		!Number.isInteger(candidate.lineCount) ||
		(candidate.lineCount ?? 0) < 1 ||
		!Number.isFinite(candidate.capturedAt)
	) return undefined;
	if (candidate.cursorRow !== undefined && !Number.isFinite(candidate.cursorRow)) return undefined;
	return candidate as ZedCapture;
}

function isInsideOrEqual(parent: string, child: string): boolean {
	const path = relative(resolve(parent), resolve(child));
	return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function repositoryRoot(cwd: string): string | undefined {
	let current = resolve(cwd);
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

export function captureMatchesCwd(capture: ZedCapture, cwd: string): boolean {
	const root = repositoryRoot(cwd);
	if (root) return isInsideOrEqual(root, capture.file);
	return resolve(cwd) === resolve(capture.workspace) || isInsideOrEqual(cwd, capture.file);
}

export function writeCapture(
	input: { workspace: string; file: string; text: string; cursorRow?: number },
	env: NodeJS.ProcessEnv = process.env,
): ZedCapture {
	const workspace = resolve(input.workspace);
	const file = resolve(input.file);
	if (!input.text) throw new Error("Zed did not provide selected text");

	const capture: ZedCapture = {
		version: CAPTURE_VERSION,
		id: randomUUID(),
		workspace,
		file,
		text: input.text,
		lineCount: countSelectedLines(input.text),
		cursorRow: input.cursorRow,
		capturedAt: Date.now(),
	};
	const directory = stateDirectory(env);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	chmodSync(directory, 0o700);
	const key = createHash("sha256").update(workspace).digest("hex").slice(0, 24);
	const destination = resolve(directory, `${key}.json`);
	const temporary = resolve(directory, `.${key}.${process.pid}.${randomUUID()}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(capture)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, destination);
	removeStaleCaptures(directory, capture.capturedAt);
	return capture;
}

function removeStaleCaptures(directory: string, now: number): void {
	const staleBefore = now - 24 * 60 * 60 * 1_000;
	try {
		for (const entry of readdirSync(directory)) {
			if (!entry.endsWith(".json")) continue;
			const path = resolve(directory, entry);
			try {
				if (statSync(path).mtimeMs < staleBefore) rmSync(path, { force: true });
			} catch {
				// Another capture may be replacing the file concurrently.
			}
		}
	} catch {
		// Cleanup is best effort and must not fail a capture.
	}
}

export function latestCapture(
	cwd: string,
	options: { after?: number; excludeIds?: ReadonlySet<string>; env?: NodeJS.ProcessEnv } = {},
): ZedCapture | undefined {
	const directory = stateDirectory(options.env);
	let newest: ZedCapture | undefined;

	try {
		for (const entry of readdirSync(directory)) {
			if (!entry.endsWith(".json")) continue;
			try {
				const path = resolve(directory, entry);
				if (statSync(path).size > 2 * 1024 * 1024) continue;
				const parsed = parseCapture(JSON.parse(readFileSync(path, "utf8")));
				if (!parsed || options.excludeIds?.has(parsed.id) || !captureMatchesCwd(parsed, cwd)) continue;
				if (options.after !== undefined && parsed.capturedAt < options.after) continue;
				if (!newest || parsed.capturedAt > newest.capturedAt) newest = parsed;
			} catch {
				// Ignore incomplete, stale, or foreign state files.
			}
		}
	} catch {
		return undefined;
	}

	return newest;
}

export function captureLabel(capture: ZedCapture): string {
	const lines = `${capture.lineCount} ${capture.lineCount === 1 ? "ligne" : "lignes"}`;
	return `${basename(capture.file)} · ${lines}`;
}
