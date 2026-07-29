import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { chmod, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpUiSettings } from "../config.js";
import { PROTOCOL_VERSION, settingsSignature, type Registration, type Session } from "./protocol.js";

export interface GatewayClientOptions {
	settings: McpUiSettings;
	hostnameResolver: () => Promise<string>;
	homeDir?: string;
	spawnDaemon?: (config: string) => void;
}

export class GatewayUnavailableError extends Error {}
export class GatewayIncompatibleError extends Error {}

export class GatewayClient {
	readonly dir: string;
	readonly socket: string;
	readonly pid: string;

	constructor(private readonly options: GatewayClientOptions) {
		this.dir = join(options.homeDir ?? homedir(), ".pi", "agent", "pi-mcp");
		this.socket = join(this.dir, "control.sock");
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
			const hostname = validateHostname(await this.options.hostnameResolver());
			configPath = join(this.dir, `launch-${randomBytes(8).toString("hex")}.json`);
			await writeFile(configPath, JSON.stringify({ settings: this.options.settings, hostname, socketPath: this.socket, pidPath: this.pid }), { mode: 0o600 });
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
		if (hello.protocol !== PROTOCOL_VERSION || hello.signature !== settingsSignature(this.options.settings)) {
			throw new GatewayIncompatibleError("A reachable gateway uses incompatible protocol or settings");
		}
	}

	async register(registration: Registration): Promise<Session> { await this.ensure(); return call(this.socket, "/register", registration); }
	async heartbeat(session: Session): Promise<Session> { return call(this.socket, `/session/${session.sessionId}/heartbeat`, { leaseSecret: session.leaseSecret }); }
	async update(session: Session, label: string): Promise<Session> { return call(this.socket, `/session/${session.sessionId}/update`, { leaseSecret: session.leaseSecret, label }); }
	async unregister(session: Session): Promise<void> { await call(this.socket, `/session/${session.sessionId}/unregister`, { leaseSecret: session.leaseSecret }); }

	private async recoverStale(): Promise<void> {
		try { await this.hello(); return; }
		catch (error) { if (!(error instanceof GatewayUnavailableError)) throw error; }
		let recordedPid: number | undefined;
		try { recordedPid = Number((await readFile(this.pid, "utf8")).trim()); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (recordedPid && pidIsLive(recordedPid)) throw new GatewayUnavailableError("Recorded gateway owner is still alive; refusing recovery");
		try { await this.hello(); return; }
		catch (error) { if (!(error instanceof GatewayUnavailableError)) throw error; }
		await rm(this.socket, { force: true });
		await rm(this.pid, { force: true });
	}
}

const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
function call(socketPath: string, path: string, body: unknown): Promise<any> {
	return new Promise((resolve, reject) => {
		const outgoing = request({ socketPath, path, method: "POST", headers: { "content-type": "application/json" } }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk) => chunks.push(chunk));
			response.on("end", () => {
				let value: any;
				try { value = JSON.parse(Buffer.concat(chunks).toString() || "null"); }
				catch { return reject(new Error("Invalid gateway response")); }
				if ((response.statusCode ?? 500) < 300) resolve(value);
				else reject(new Error(typeof value?.error === "string" ? value.error : "Gateway request failed"));
			});
		});
		outgoing.setTimeout(CONTROL_REQUEST_TIMEOUT_MS, () => outgoing.destroy(new Error("Gateway request timed out")));
		outgoing.on("error", reject);
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
function validateHostname(value: string): string {
	const hostname = value.replace(/\.$/, "");
	if (!hostname || hostname.length > 253 || !hostname.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))) throw new Error("Invalid Tailscale hostname");
	return hostname;
}
const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
