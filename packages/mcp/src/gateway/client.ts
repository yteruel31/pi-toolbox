import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer, request } from "node:http";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpUiSettings } from "../config.js";
import { gatewayControlEndpoint, isFilesystemControlEndpoint } from "./control-endpoint.js";
import { INTERNAL_SECRET_HEADER, PROTOCOL_VERSION, settingsSignature, type GatewayDaemonSettings, type Registration, type Session } from "./protocol.js";

export interface GatewayClientOptions {
	settings: McpUiSettings;
	hostnameResolver?: () => Promise<string>;
	externalUrlResolver?: () => Promise<string>;
	listenAddress?: string;
	homeDir?: string;
	spawnDaemon?: (config: string) => void;
}

export class GatewayUnavailableError extends Error {}
export class GatewayIncompatibleError extends Error {}

export class GatewayClient {
	readonly dir: string;
	readonly socket: string;
	readonly pid: string;
	private resolved?: Promise<GatewayDaemonSettings>;

	constructor(private readonly options: GatewayClientOptions) {
		this.dir = join(options.homeDir ?? homedir(), ".pi", "agent", "pi-mcp");
		this.socket = gatewayControlEndpoint(this.dir);
		this.pid = join(this.dir, "daemon.pid");
	}

	async ensure(): Promise<void> {
		await mkdir(this.dir, { recursive: true, mode: 0o700 });
		await chmod(this.dir, 0o700);
		try { await this.hello(); return; }
		catch (error) { if (!(error instanceof GatewayUnavailableError)) throw error; }

		const lockPath = join(this.dir, "launch.lock");
		let lock: Awaited<ReturnType<typeof open>> | undefined;
		for (let attempt = 0; attempt < 100 && !lock; attempt++) {
			try {
				lock = await open(lockPath, "wx", 0o600);
				await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try { await this.hello(); return; }
				catch (helloError) { if (!(helloError instanceof GatewayUnavailableError)) throw helloError; }
				if (await staleOwner(lockPath)) await rm(lockPath, { force: true });
				else await delay(50);
			}
		}
		if (!lock) throw new GatewayUnavailableError("Gateway launch timed out");

		let configPath: string | undefined;
		try {
			try { await this.hello(); return; }
			catch (error) { if (!(error instanceof GatewayUnavailableError)) throw error; }
			await this.recoverStale();
			const settings = await this.resolveSettings();
			configPath = join(this.dir, `launch-${randomBytes(8).toString("hex")}.json`);
			await writeFile(configPath, JSON.stringify({ settings, socketPath: this.socket, pidPath: this.pid }), { mode: 0o600 });
			(this.options.spawnDaemon ?? spawnDaemon)(configPath);
			for (let attempt = 0; attempt < 100; attempt++) {
				await delay(50);
				try { await this.hello(); return; }
				catch (error) { if (!(error instanceof GatewayUnavailableError)) throw error; }
			}
			throw new GatewayUnavailableError("Gateway failed to start");
		} finally {
			if (configPath) await rm(configPath, { force: true });
			await lock.close();
			await rm(lockPath, { force: true });
		}
	}

	async hello(): Promise<void> {
		let hello: any;
		try { hello = await call(this.socket, "/hello", {}); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (["ENOENT", "ENOTSOCK", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code ?? "")) throw new GatewayUnavailableError("Gateway unavailable");
			throw error;
		}
		if (hello.protocol !== PROTOCOL_VERSION || hello.signature !== settingsSignature(await this.resolveSettings())) {
			throw new GatewayIncompatibleError("A reachable gateway uses incompatible protocol or settings");
		}
	}

	async shutdown(): Promise<void> {
		let hello: any;
		try { hello = await call(this.socket, "/hello", {}); }
		catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (["ENOENT", "ENOTSOCK", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code ?? "")) return;
			throw error;
		}
		if (hello.protocol !== PROTOCOL_VERSION) throw new GatewayIncompatibleError("A reachable gateway uses an incompatible protocol");
		await call(this.socket, "/shutdown", {});
		for (let attempt = 0; attempt < 100; attempt++) {
			await delay(25);
			try { await call(this.socket, "/hello", {}); }
			catch (error) {
				const code = (error as NodeJS.ErrnoException).code;
				if (["ENOENT", "ENOTSOCK", "ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(code ?? "")) return;
			}
		}
		throw new GatewayUnavailableError("Gateway shutdown timed out");
	}

	async verify(): Promise<void> {
		const nonce = randomBytes(32).toString("base64url");
		const secret = randomBytes(32).toString("base64url");
		const backend = createServer((request, response) => {
			if (request.method !== "GET" || request.url !== "/probe" || request.headers[INTERNAL_SECRET_HEADER] !== secret) {
				response.writeHead(404, { "cache-control": "no-store" }); response.end(); return;
			}
			response.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
			response.end(nonce);
		});
		let session: Session | undefined;
		try {
			await new Promise<void>((resolve, reject) => backend.once("error", reject).listen(0, "127.0.0.1", resolve));
			const port = (backend.address() as { port: number }).port;
			session = await this.register({ label: "Gateway validation", backendOrigin: `http://127.0.0.1:${port}`, backendSecret: secret });
			const response = await fetch(`${session.externalUrl}proxy/probe`, { redirect: "error", signal: AbortSignal.timeout(5_000), headers: { accept: "text/plain" } });
			if (response.status !== 200 || await readBounded(response, 1_024) !== nonce) throw new Error("Gateway external validation failed");
		} catch {
			throw new Error("Gateway external validation failed");
		} finally {
			if (session) await this.unregister(session).catch(() => undefined);
			await new Promise<void>((resolve) => backend.close(() => resolve())).catch(() => undefined);
		}
	}

	async register(registration: Registration): Promise<Session> { await this.ensure(); return call(this.socket, "/register", registration); }
	async heartbeat(session: Session): Promise<Session> { return call(this.socket, `/session/${session.sessionId}/heartbeat`, { leaseSecret: session.leaseSecret }); }
	async update(session: Session, label: string): Promise<Session> { return call(this.socket, `/session/${session.sessionId}/update`, { leaseSecret: session.leaseSecret, label }); }
	async unregister(session: Session): Promise<void> { await call(this.socket, `/session/${session.sessionId}/unregister`, { leaseSecret: session.leaseSecret }); }

	private resolveSettings(): Promise<GatewayDaemonSettings> {
		this.resolved ??= (async () => {
			let externalUrl: string;
			if (this.options.externalUrlResolver) externalUrl = normalizeExternalUrl(await this.options.externalUrlResolver());
			else {
				if (!this.options.hostnameResolver) throw new Error("Gateway external URL is unavailable");
				const hostname = validateHostname(await this.options.hostnameResolver());
				externalUrl = `https://${hostname}:${this.options.settings.httpsPort}${this.options.settings.basePath === "/" ? "" : this.options.settings.basePath}`;
			}
			const listenAddress = this.options.listenAddress ?? "127.0.0.1";
			if (isIP(listenAddress) === 0) throw new Error("Invalid gateway listen address");
			return {
				externalUrl,
				listenAddress,
				gatewayPort: this.options.settings.gatewayPort,
				basePath: new URL(externalUrl).pathname === "/" ? "/" : new URL(externalUrl).pathname.replace(/\/+$/, ""),
				requireTailscaleIdentity: this.options.settings.requireTailscaleIdentity,
				idleTimeoutMs: this.options.settings.idleTimeoutMs,
			};
		})();
		return this.resolved;
	}

	private async recoverStale(): Promise<void> {
		try { await this.hello(); return; }
		catch (error) { if (!(error instanceof GatewayUnavailableError)) throw error; }
		let recordedPid: number | undefined;
		try { recordedPid = Number((await readFile(this.pid, "utf8")).trim()); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (recordedPid && pidIsLive(recordedPid)) throw new GatewayUnavailableError("Recorded gateway owner is still alive; refusing recovery");
		try { await this.hello(); return; }
		catch (error) { if (!(error instanceof GatewayUnavailableError)) throw error; }
		if (isFilesystemControlEndpoint(this.socket)) await rm(this.socket, { force: true });
		await rm(this.pid, { force: true });
	}
}

const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
const MAX_CONTROL_RESPONSE_BYTES = 64 * 1024;
function call(socketPath: string, path: string, body: unknown): Promise<any> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const finish = (error?: Error, value?: unknown): void => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			error ? reject(error) : resolve(value);
		};
		const outgoing = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json" } }, (response) => {
			const chunks: Buffer[] = [];
			let size = 0;
			response.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_CONTROL_RESPONSE_BYTES) {
					finish(new Error("Gateway response is too large"));
					response.destroy();
				} else chunks.push(chunk);
			});
			response.on("aborted", () => finish(new Error("Gateway response was interrupted")));
			response.on("error", (error) => finish(error));
			response.on("end", () => {
				let value: any;
				try { value = JSON.parse(Buffer.concat(chunks).toString() || "null"); }
				catch { return finish(new Error("Invalid gateway response")); }
				if ((response.statusCode ?? 500) < 300) finish(undefined, value);
				else finish(new Error(typeof value?.error === "string" ? value.error : "Gateway request failed"));
			});
		});
		const deadline = setTimeout(() => {
			outgoing.destroy();
			finish(new Error("Gateway request timed out"));
		}, CONTROL_REQUEST_TIMEOUT_MS);
		outgoing.setTimeout(CONTROL_REQUEST_TIMEOUT_MS, () => {
			outgoing.destroy();
			finish(new Error("Gateway request timed out"));
		});
		outgoing.on("error", (error) => finish(error));
		outgoing.end(JSON.stringify(body));
	});
}
function spawnDaemon(configPath: string): void {
	const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("./daemon.ts", import.meta.url)), configPath], { detached: true, stdio: "ignore" });
	child.once("error", () => { /* Readiness polling surfaces a safe startup failure. */ });
	child.unref();
}
function pidIsLive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
async function staleOwner(lockPath: string): Promise<boolean> {
	try {
		const value = JSON.parse(await readFile(lockPath, "utf8"));
		return typeof value.pid === "number" && !pidIsLive(value.pid);
	} catch { return false; }
}
async function readBounded(response: Response, limit: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) throw new Error("Gateway response is too large");
			chunks.push(value);
		}
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		throw error;
	} finally { reader.releaseLock(); }
	return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
function normalizeExternalUrl(value: string): string {
	if (!value || value.length > 2_048) throw new Error("Invalid gateway external URL");
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("Invalid gateway external URL"); }
	if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error("Invalid gateway external URL");
	const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
	if (pathname && (!/^\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(pathname) || pathname.split("/").some((segment) => segment === "." || segment === ".."))) {
		throw new Error("Invalid gateway external URL");
	}
	return `${url.origin}${pathname}`;
}
function validateHostname(value: string): string {
	const hostname = value.replace(/\.$/, "");
	if (!hostname || hostname.length > 253 || !hostname.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) throw new Error("Invalid Tailscale hostname");
	return hostname;
}
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
