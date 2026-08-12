import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { getMcpConfigPaths, parseDirectTools, parseGatewaySettings, type McpGatewaySettings, type McpServerControls } from "./config.js";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const JSON_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_ATTEMPTS = 5;
const LOCK_ATTEMPTS = 80;

interface Revision {
	exists: boolean;
	hash?: string;
	ino?: number;
	dev?: number;
	mode: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

function hasUnsafeValue(value: unknown): boolean {
	if (typeof value === "number") return !Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value);
	if (!isPlainObject(value) && !Array.isArray(value)) return false;
	return Object.keys(value).some((key) => UNSAFE_KEYS.has(key) || hasUnsafeValue((value as Record<string, unknown>)[key]));
}

function validateJsonNumbers(text: string): void {
	let quoted = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index]!;
		if (quoted) {
			if (escaped) escaped = false;
			else if (character === "\\") escaped = true;
			else if (character === '"') quoted = false;
			continue;
		}
		if (character === '"') { quoted = true; continue; }
		if (character !== "-" && (character < "0" || character > "9")) continue;
		const token = text.slice(index).match(JSON_NUMBER)?.[0];
		if (!token) continue;
		const value = Number(token);
		if (!Number.isFinite(value) || Number.isInteger(value) && !Number.isSafeInteger(value)) {
			throw new Error("Pi MCP configuration contains an unsafe number");
		}
		index += token.length - 1;
	}
}

function validateControls(name: string, controls: McpServerControls): void {
	if (!SAFE_NAME.test(name) || UNSAFE_KEYS.has(name)) throw new Error("MCP server name is invalid");
	if (!isPlainObject(controls) || Object.keys(controls).some((key) => !["disabled", "directTools"].includes(key))) throw new Error("MCP server controls are invalid");
	if (controls.disabled !== undefined && typeof controls.disabled !== "boolean") throw new Error("MCP disabled setting is invalid");
	if (controls.directTools !== undefined && parseDirectTools(controls.directTools) === undefined) throw new Error("MCP direct tools setting is invalid");
	if (controls.disabled === undefined && controls.directTools === undefined) throw new Error("MCP server update is empty");
}

async function readText(path: string): Promise<{ text?: string; revision: Revision }> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_CONFIG_BYTES) throw new Error("Pi MCP configuration file is unsafe");
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const opened = await handle.stat();
			if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || opened.size > MAX_CONFIG_BYTES) {
				throw new Error("Pi MCP configuration file changed while reading");
			}
			const text = await handle.readFile("utf8");
			return {
				text,
				revision: { exists: true, hash: createHash("sha256").update(text).digest("hex"), ino: opened.ino, dev: opened.dev, mode: opened.mode & 0o777 },
			};
		} finally { await handle.close(); }
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: { exists: false, mode: 0o600 } };
		throw error;
	}
}

async function readRoot(path: string): Promise<{ root: Record<string, unknown>; revision: Revision }> {
	const { text, revision } = await readText(path);
	if (text === undefined) return { root: {}, revision };
	validateJsonNumbers(text);
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error("Pi MCP configuration is not valid JSON"); }
	if (!isPlainObject(value) || hasUnsafeValue(value)) throw new Error("Pi MCP configuration root is unsafe");
	return { root: value, revision };
}

function sameRevision(left: Revision, right: Revision): boolean {
	return left.exists === right.exists && (!left.exists || left.hash === right.hash && left.ino === right.ino && left.dev === right.dev && left.mode === right.mode);
}

async function prepareSafeParent(path: string): Promise<void> {
	const directories: string[] = [];
	let current = dirname(path);
	for (;;) {
		directories.push(current);
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}
	for (const directory of directories.reverse()) {
		try {
			const info = await lstat(directory);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Pi MCP configuration directory is unsafe");
			continue;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		try { await mkdir(directory, { mode: 0o700 }); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
		const info = await lstat(directory);
		if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Pi MCP configuration directory is unsafe");
	}
}

async function acquireLock(path: string): Promise<{ close(): Promise<void> }> {
	const lockPath = `${path}.lock`;
	const token = randomBytes(24).toString("hex");
	for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
		try {
			const handle = await open(lockPath, "wx", 0o600);
			let identity: { ino: number; dev: number };
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: Date.now() }));
				await handle.sync();
				const info = await handle.stat();
				identity = { ino: info.ino, dev: info.dev };
			} catch (error) {
				await handle.close().catch(() => undefined);
				await rm(lockPath, { force: true }).catch(() => undefined);
				throw error;
			}
			return { close: async () => {
				await handle.close();
				try {
					const current = await open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
					let owned = false;
					try {
						const info = await current.stat();
						if (info.isFile() && info.ino === identity.ino && info.dev === identity.dev) {
							const owner = JSON.parse(await current.readFile("utf8")) as { token?: unknown };
							owned = owner.token === token;
						}
					} finally { await current.close(); }
					if (owned) await rm(lockPath);
				} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			} };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const info = await lstat(lockPath).catch((statError) => {
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				throw statError;
			});
			if (!info) continue;
			if (!info.isFile() || info.isSymbolicLink()) throw new Error("Pi MCP configuration lock is unsafe");
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	throw new Error("Pi MCP configuration is busy; remove its .lock file only if no Pi process is editing it");
}

function encodeRoot(root: Record<string, unknown>): string {
	const encoded = `${JSON.stringify(root, null, 2)}\n`;
	if (Buffer.byteLength(encoded) > MAX_CONFIG_BYTES) throw new Error("Pi MCP configuration is too large");
	return encoded;
}

function applyUpdates(root: Record<string, unknown>, updates: Readonly<Record<string, McpServerControls>>): string {
	const existingServers = root.mcpServers;
	if (existingServers !== undefined && (!isPlainObject(existingServers) || hasUnsafeValue(existingServers))) {
		throw new Error("Pi MCP mcpServers configuration is unsafe");
	}
	const servers = existingServers ?? {};
	for (const [name, controls] of Object.entries(updates)) {
		const current = servers[name];
		if (current !== undefined && (!isPlainObject(current) || hasUnsafeValue(current))) throw new Error("Pi MCP server configuration is unsafe");
		servers[name] = { ...(current ?? {}), ...controls };
	}
	root.mcpServers = servers;
	return encodeRoot(root);
}

function applyGateway(root: Record<string, unknown>, gateway: McpGatewaySettings | undefined): string {
	const existing = root.settings;
	if (existing !== undefined && (!isPlainObject(existing) || hasUnsafeValue(existing))) throw new Error("Pi MCP settings configuration is unsafe");
	if (gateway === undefined) {
		if (isPlainObject(existing)) delete existing.gateway;
	} else {
		const parsed = parseGatewaySettings(gateway);
		if (!parsed) throw new Error("MCP gateway settings are invalid");
		const settings = existing ?? {};
		settings.gateway = { ...parsed };
		root.settings = settings;
	}
	return encodeRoot(root);
}

async function writeMcpConfig(
	mutate: (root: Record<string, unknown>) => string,
	options: { homeDir?: string; path?: string },
): Promise<string> {
	const path = options.path ?? getMcpConfigPaths(options.homeDir ?? homedir())[1];
	return withFileMutationQueue(path, async () => {
		await prepareSafeParent(path);
		const lock = await acquireLock(path);
		try {
			for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
				const { root, revision } = await readRoot(path);
				const encoded = mutate(root);
				const encodedHash = createHash("sha256").update(encoded).digest("hex");
				const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
				try {
					const handle = await open(temporary, "wx", revision.mode);
					try { await handle.writeFile(encoded); await handle.sync(); } finally { await handle.close(); }
					await chmod(temporary, revision.mode);
					if (!sameRevision(revision, (await readText(path)).revision)) continue;
					await rename(temporary, path);
					await chmod(path, revision.mode);
					const committed = await readText(path);
					if (committed.revision.hash === encodedHash) return path;
				} finally {
					await rm(temporary, { force: true }).catch(() => undefined);
				}
			}
			throw new Error("Pi MCP configuration changed concurrently; retry the save");
		} finally { await lock.close(); }
	});
}

/** Atomically updates only panel-managed fields in the Pi-owned global MCP config. */
export async function writeMcpServerControls(
	updates: Readonly<Record<string, McpServerControls>>,
	options: { homeDir?: string; path?: string } = {},
): Promise<string> {
	for (const [name, controls] of Object.entries(updates)) validateControls(name, controls);
	if (!Object.keys(updates).length) throw new Error("No MCP server updates were provided");
	return writeMcpConfig((root) => applyUpdates(root, updates), options);
}

/** Atomically replaces or removes only settings.gateway in the Pi-owned global MCP config. */
export async function writeMcpGatewaySettings(
	gateway: McpGatewaySettings | undefined,
	options: { homeDir?: string; path?: string } = {},
): Promise<string> {
	if (gateway !== undefined && !parseGatewaySettings(gateway)) throw new Error("MCP gateway settings are invalid");
	return writeMcpConfig((root) => applyGateway(root, gateway), options);
}
