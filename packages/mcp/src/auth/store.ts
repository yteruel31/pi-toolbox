import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";

export interface OAuthRecord {
	identity: string;
	tokens?: OAuthTokens;
	client?: OAuthClientInformationMixed;
	/** Redirect URI to which the dynamic client registration is bound. */
	clientRedirectUri?: string;
	/** Client id used when the current tokens were issued. */
	tokenClientId?: string;
	verifier?: string;
	state?: string;
	discovery?: OAuthDiscoveryState;
}

const queues = new Map<string, Promise<unknown>>();
export class OAuthStore {
	readonly dir: string;
	private readonly home: string;
	constructor(home = homedir()) { this.home = home; this.dir = join(home, ".pi", "agent", "pi-mcp", "oauth"); }
	private path(identity: string): string { return join(this.dir, `${createHash("sha256").update(identity).digest("hex")}.json`); }
	private async acquireLock(target: string): Promise<{ close(): Promise<void> }> {
		const lockPath = `${target}.lock`;
		for (let attempt = 0; attempt < 200; attempt++) {
			try {
				const handle = await open(lockPath, "wx", 0o600);
				await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
				return {
					close: async () => {
						await handle.close();
						await rm(lockPath, { force: true });
					},
				};
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				let info;
				try { info = await lstat(lockPath); }
				catch (statError) {
					if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
					throw statError;
				}
				if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe OAuth storage lock");
				let owner: unknown;
				try { owner = JSON.parse(await readFile(lockPath, "utf8")); }
				catch (readError) {
					if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
					await new Promise((resolve) => setTimeout(resolve, 25));
					continue;
				}
				const pid = typeof owner === "object" && owner !== null ? (owner as { pid?: unknown }).pid : undefined;
				if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && !pidIsLive(pid)) {
					await rm(lockPath, { force: true });
					continue;
				}
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
		throw new Error("OAuth storage is busy");
	}
	private async prepare(): Promise<void> {
		let current = this.home;
		for (const segment of [".pi", "agent", "pi-mcp", "oauth"]) {
			current = join(current, segment);
			try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
			const info = await lstat(current);
			if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe OAuth storage directory");
		}
		await chmod(this.dir, 0o700);
	}
	private valid(value: unknown, identity: string): value is OAuthRecord {
		if (!value || typeof value !== "object" || Array.isArray(value) || (value as OAuthRecord).identity !== identity) return false;
		const record = value as OAuthRecord;
		const boundedString = (candidate: unknown, maximum: number): boolean =>
			candidate === undefined || (typeof candidate === "string" && candidate.length <= maximum);
		if (!boundedString(record.clientRedirectUri, 4_096) || !boundedString(record.tokenClientId, 1_024) ||
			!boundedString(record.state, 4_096) || !boundedString(record.verifier, 4_096)) return false;
		if (record.client !== undefined && (typeof record.client !== "object" || record.client === null ||
			typeof record.client.client_id !== "string" || record.client.client_id.length > 1_024)) return false;
		if (record.tokens !== undefined && (typeof record.tokens !== "object" || record.tokens === null ||
			typeof record.tokens.access_token !== "string" || typeof record.tokens.token_type !== "string")) return false;
		if (record.discovery !== undefined && (typeof record.discovery !== "object" || record.discovery === null ||
			typeof record.discovery.authorizationServerUrl !== "string")) return false;
		return true;
	}
	async read(identity: string): Promise<OAuthRecord | undefined> {
		await this.prepare(); const path = this.path(identity);
		try {
			const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Unsafe OAuth storage file");
			let value: unknown; try { value = JSON.parse(await readFile(path, "utf8")); } catch { return undefined; }
			return this.valid(value, identity) ? value : undefined;
		} catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
	}
	async update(identity: string, change: (record: OAuthRecord) => void): Promise<void> {
		const key = this.path(identity); const previous = queues.get(key) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(async () => {
			await this.prepare();
			const target = this.path(identity);
			const lock = await this.acquireLock(target);
			const temp = join(this.dir, `.${randomBytes(16).toString("hex")}.tmp`);
			try {
				const record = await this.read(identity) ?? { identity };
				change(record);
				const handle = await open(temp, "wx", 0o600);
				try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
				try { const old = await lstat(target); if (old.isSymbolicLink() || !old.isFile()) throw new Error("Unsafe OAuth storage file"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
				await rename(temp, target);
			} finally {
				await rm(temp, { force: true }).catch(() => undefined);
				await lock.close();
			}
		});
		queues.set(key, next); try { await next; } finally { if (queues.get(key) === next) queues.delete(key); }
	}
}

function pidIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}
