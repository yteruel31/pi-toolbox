import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export const CAPTURE_VERSION = 1;
export const STATE_DIR_ENV = "PI_ZED_CONTEXT_STATE_DIR";
export const MAX_CONTEXT_BYTES = 50 * 1024;
export const MAX_CONTEXT_LINES = 2_000;
export const MAX_CAPTURE_AGE_MS = 24 * 60 * 60 * 1_000;
const PRODUCER_LEASE_MAX_AGE_MS = 15_000;

export interface ZedCapture {
	version: typeof CAPTURE_VERSION;
	id: string;
	workspace: string;
	file: string;
	text: string;
	lineCount: number;
	cursorRow?: number;
	capturedAt: number;
	source?: "lsp" | "task";
	producerPid?: number;
	producerId?: string;
	truncated?: boolean;
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
		(candidate.lineCount ?? -1) < 0 ||
		!Number.isFinite(candidate.capturedAt)
	) return undefined;
	if ((candidate.lineCount === 0) !== (candidate.text.length === 0)) return undefined;
	if (candidate.cursorRow !== undefined && !Number.isFinite(candidate.cursorRow)) return undefined;
	if (candidate.source !== undefined && candidate.source !== "lsp" && candidate.source !== "task") return undefined;
	if (candidate.producerPid !== undefined && (!Number.isInteger(candidate.producerPid) || candidate.producerPid < 1)) return undefined;
	if (candidate.producerId !== undefined && !isString(candidate.producerId)) return undefined;
	if (candidate.source === "lsp" && (candidate.producerPid === undefined || candidate.producerId === undefined)) return undefined;
	if (candidate.truncated !== undefined && typeof candidate.truncated !== "boolean") return undefined;
	return candidate as ZedCapture;
}

function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function isInsideOrEqual(parent: string, child: string): boolean {
	const path = relative(canonicalPath(parent), canonicalPath(child));
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
	if (root) {
		const relatedWorkspace = isInsideOrEqual(capture.workspace, root) || isInsideOrEqual(root, capture.workspace);
		return relatedWorkspace && isInsideOrEqual(root, capture.file);
	}
	return canonicalPath(cwd) === canonicalPath(capture.workspace) || isInsideOrEqual(cwd, capture.file);
}

function ensurePrivateStateDirectory(directory: string): void {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const metadata = lstatSync(directory);
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new Error(`Unsafe Zed context state directory: ${directory}`);
	}
	if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
		throw new Error(`Zed context state directory is owned by another user: ${directory}`);
	}
	chmodSync(directory, 0o700);
}

function privateStateDirectory(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const directory = stateDirectory(env);
	try {
		const metadata = lstatSync(directory);
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) return undefined;
		if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) return undefined;
		if ((metadata.mode & 0o077) !== 0) return undefined;
		return directory;
	} catch {
		return undefined;
	}
}

function persistCapture(capture: ZedCapture, env: NodeJS.ProcessEnv): ZedCapture {
	const directory = stateDirectory(env);
	ensurePrivateStateDirectory(directory);
	const key = createHash("sha256").update(capture.workspace).digest("hex").slice(0, 24);
	const destination = resolve(directory, `${key}.json`);
	const temporary = resolve(directory, `.${key}.${process.pid}.${randomUUID()}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(capture)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	try {
		renameSync(temporary, destination);
	} finally {
		rmSync(temporary, { force: true });
	}
	removeStaleCaptures(directory, capture.capturedAt);
	return capture;
}

export function writeCapture(
	input: { workspace: string; file: string; text: string; cursorRow?: number },
	env: NodeJS.ProcessEnv = process.env,
): ZedCapture {
	const workspace = canonicalPath(input.workspace);
	const file = canonicalPath(input.file);
	if (!input.text) throw new Error("Zed did not provide selected text");
	if (!isInsideOrEqual(workspace, file)) throw new Error("Selected file is outside the Zed worktree");
	const bounded = boundSelection(input.text);

	return persistCapture({
		version: CAPTURE_VERSION,
		id: randomUUID(),
		workspace,
		file,
		text: bounded.text,
		lineCount: countSelectedLines(input.text),
		cursorRow: input.cursorRow,
		capturedAt: Date.now(),
		source: "task",
		truncated: bounded.truncated || undefined,
	}, env);
}

export function writeClearCapture(
	input: { workspace: string; file: string },
	env: NodeJS.ProcessEnv = process.env,
): ZedCapture {
	const workspace = canonicalPath(input.workspace);
	const file = canonicalPath(input.file);
	if (!isInsideOrEqual(workspace, file)) throw new Error("Selected file is outside the Zed worktree");
	return persistCapture({
		version: CAPTURE_VERSION,
		id: randomUUID(),
		workspace,
		file,
		text: "",
		lineCount: 0,
		capturedAt: Date.now(),
		source: "task",
	}, env);
}

function removeStaleCaptures(directory: string, now: number): void {
	const staleBefore = now - 24 * 60 * 60 * 1_000;
	try {
		for (const entry of readdirSync(directory)) {
			if (!entry.endsWith(".json")) continue;
			const path = resolve(directory, entry);
			try {
				if (lstatSync(path).mtimeMs < staleBefore) rmSync(path, { force: true });
			} catch {
				// Another capture may be replacing the file concurrently.
			}
		}
	} catch {
		// Cleanup is best effort and must not fail a capture.
	}
}

export function isLiveLspCapture(capture: ZedCapture, env: NodeJS.ProcessEnv = process.env): boolean {
	if (capture.source !== "lsp" || capture.producerPid === undefined || capture.producerId === undefined) return false;
	const directory = privateStateDirectory(env);
	if (!directory) return false;
	const key = createHash("sha256").update(capture.producerId).digest("hex").slice(0, 32);
	const leasePath = resolve(directory, `.lease-${key}.json`);
	try {
		const metadata = lstatSync(leasePath);
		if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o077) !== 0) return false;
		if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) return false;
		const lease = JSON.parse(readFileSync(leasePath, "utf8")) as Record<string, unknown>;
		if (
			lease.producerId !== capture.producerId ||
			lease.producerPid !== capture.producerPid ||
			typeof lease.updatedAt !== "number" ||
			lease.updatedAt < Date.now() - PRODUCER_LEASE_MAX_AGE_MS
		) return false;
		process.kill(capture.producerPid, 0);
		return true;
	} catch {
		return false;
	}
}

export function latestCapture(
	cwd: string,
	options: { after?: number; allowLiveBeforeAfter?: boolean; excludeIds?: ReadonlySet<string>; env?: NodeJS.ProcessEnv } = {},
): ZedCapture | undefined {
	const directory = privateStateDirectory(options.env);
	if (!directory) return undefined;
	let newest: ZedCapture | undefined;

	try {
		for (const entry of readdirSync(directory)) {
			if (!entry.endsWith(".json")) continue;
			try {
				const path = resolve(directory, entry);
				const metadata = lstatSync(path);
				if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > 2 * 1024 * 1024) continue;
				if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) continue;
				if ((metadata.mode & 0o077) !== 0) continue;
				const parsed = parseCapture(JSON.parse(readFileSync(path, "utf8")));
				if (!parsed) continue;
				if (parsed.capturedAt < Date.now() - MAX_CAPTURE_AGE_MS) {
					rmSync(path, { force: true });
					continue;
				}
				if (!captureMatchesCwd(parsed, cwd)) continue;
				if (
					!newest ||
					parsed.capturedAt > newest.capturedAt ||
					(parsed.capturedAt === newest.capturedAt && parsed.lineCount === 0 && newest.lineCount > 0)
				) newest = parsed;
			} catch {
				// Ignore incomplete, stale, or foreign state files.
			}
		}
	} catch {
		return undefined;
	}

	if (!newest || options.excludeIds?.has(newest.id)) return undefined;
	if (options.after !== undefined && newest.capturedAt <= options.after) {
		if (options.allowLiveBeforeAfter && isLiveLspCapture(newest, options.env)) return newest;
		return undefined;
	}
	return newest;
}

export function captureLabel(capture: ZedCapture): string {
	const lines = `${capture.lineCount} ${capture.lineCount === 1 ? "ligne" : "lignes"}`;
	return `${basename(capture.file)} · ${lines}`;
}
