import { createHash, randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "./config.js";

const VERSION = 1;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_FILE_BYTES = 768 * 1024;
const MAX_ITEMS = 500;
export type CacheStatus = "fresh" | "stale" | "missing";
export interface CachedMetadata { tools: Tool[]; prompts: Prompt[]; instructions?: string; counts: { tools: number; resources: number; resourceTemplates: number; prompts: number }; }
interface RecordFile extends CachedMetadata { version: number; fingerprint: string; writtenAt: number; }

function stable(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stable);
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
	return value;
}
export function configFingerprint(config: ServerConfig): string {
	const source = config.transport === "stdio"
		? { transport: "stdio", command: config.command, args: config.args, env: config.env, cwd: config.cwd }
		: { transport: config.transport, url: config.url.href, headers: config.headers };
	return createHash("sha256").update(JSON.stringify(stable(source))).digest("hex");
}
function safeName(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/.test(value); }
function safeSchema(value: unknown): boolean {
	try { const text = JSON.stringify(value); return !!value && typeof value === "object" && !Array.isArray(value) && text.length <= 64 * 1024; } catch { return false; }
}
function validate(raw: unknown, fingerprint: string): RecordFile | undefined {
	if (!raw || typeof raw !== "object") return;
	const value = raw as Record<string, unknown>;
	if (value.version !== VERSION || value.fingerprint !== fingerprint || typeof value.writtenAt !== "number" || !Number.isFinite(value.writtenAt) || value.writtenAt < 0 || !Array.isArray(value.tools) || !Array.isArray(value.prompts) || value.tools.length > MAX_ITEMS || value.prompts.length > MAX_ITEMS) return;
	const tools = value.tools.filter((item): item is Tool => !!item && typeof item === "object" && safeName((item as Tool).name) && safeSchema((item as Tool).inputSchema));
	const prompts = value.prompts.filter((item): item is Prompt => !!item && typeof item === "object" && safeName((item as Prompt).name));
	if (tools.length !== value.tools.length || prompts.length !== value.prompts.length) return;
	const counts = value.counts as Record<string, unknown> | undefined;
	if (!counts || ["tools", "resources", "resourceTemplates", "prompts"].some((key) => !Number.isInteger(counts[key]) || (counts[key] as number) < 0 || (counts[key] as number) > MAX_ITEMS)) return;
	if (value.instructions !== undefined && (typeof value.instructions !== "string" || Buffer.byteLength(value.instructions) > 16 * 1024)) return;
	return value as unknown as RecordFile;
}
function assertPrivateDirectory(path: string): void {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	const stat = lstatSync(path); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("unsafe metadata cache directory");
	chmodSync(path, 0o700);
}

export class MetadataCache {
	readonly directory: string;
	constructor(directory = join(homedir(), ".pi", "agent", "pi-mcp", "metadata"), private readonly now = () => Date.now()) { this.directory = directory; }
	private path(name: string): string { return join(this.directory, `${createHash("sha256").update(name).digest("hex")}.json`); }
	load(config: ServerConfig): { status: CacheStatus; metadata?: CachedMetadata } {
		const path = this.path(config.name);
		try {
			const uid = process.getuid?.();
			const parent = lstatSync(this.directory); if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || uid !== undefined && parent.uid !== uid) return { status: "missing" };
			const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES || (stat.mode & 0o077) !== 0 || uid !== undefined && stat.uid !== uid) return { status: "missing" };
			const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); let text: string; try {
				const opened = fstatSync(fd); if (!opened.isFile() || opened.size > MAX_FILE_BYTES || opened.ino !== stat.ino || opened.dev !== stat.dev) return { status: "missing" };
				text = readFileSync(fd, "utf8");
			} finally { closeSync(fd); }
			const record = validate(JSON.parse(text), configFingerprint(config));
			if (!record) return { status: "missing" };
			const { tools, prompts, instructions, counts } = record;
			const age = this.now() - record.writtenAt;
			return { status: age >= -60_000 && age <= MAX_AGE_MS ? "fresh" : "stale", metadata: { tools, prompts, instructions, counts } };
		} catch { return { status: "missing" }; }
	}
	async save(config: ServerConfig, metadata: CachedMetadata): Promise<boolean> {
		let temporary: string | undefined;
		try {
			assertPrivateDirectory(dirname(this.path(config.name)));
			const path = this.path(config.name);
			try { const stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile()) return false; } catch { /* absent */ }
			const tools = metadata.tools.slice(0, MAX_ITEMS).map(({ name, description, inputSchema, annotations }) => ({ name, ...(description ? { description: description.slice(0, 2_000) } : {}), inputSchema, ...(annotations ? { annotations } : {}) }));
			const prompts = metadata.prompts.slice(0, MAX_ITEMS).map(({ name, description, arguments: args }) => ({ name, ...(description ? { description: description.slice(0, 2_000) } : {}), ...(args ? { arguments: args.slice(0, 100) } : {}) }));
			const record: RecordFile = { version: VERSION, fingerprint: configFingerprint(config), writtenAt: this.now(), tools, prompts, instructions: metadata.instructions?.slice(0, 16_000), counts: metadata.counts };
			const encoded = JSON.stringify(record); if (Buffer.byteLength(encoded) > MAX_FILE_BYTES) return false;
			temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
			writeFileSync(temporary, encoded, { mode: 0o600, flag: "wx" }); chmodSync(temporary, 0o600); renameSync(temporary, path); chmodSync(path, 0o600); return true;
		} catch { return false; } finally { if (temporary) try { rmSync(temporary, { force: true }); } catch { /* best effort */ } }
	}
}
