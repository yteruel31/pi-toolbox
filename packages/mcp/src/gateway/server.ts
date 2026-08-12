import { randomBytes, timingSafeEqual } from "node:crypto";
import { stat, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { McpUiSettings } from "../config.js";
import { renderDashboard } from "../ui/dashboard.js";
import { INTERNAL_SECRET_HEADER, PROTOCOL_VERSION, isLoopbackOrigin, settingsSignature, type GatewayDaemonSettings, type Registration, type Session } from "./protocol.js";

interface StoredSession extends Session {
	label: string;
	backendOrigin: string;
	backendSecret: string;
	touchedAt: number;
}

const SECURITY_HEADERS = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
};
const DASHBOARD_CSP = "default-src 'none'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const MAX_DESCRIPTORS_BYTES = 64 * 1024;
const MAX_PROXY_REQUEST_BYTES = 1024 * 1024;
const PUBLIC_REQUEST_TIMEOUT_MS = 30_000;
const PUBLIC_HEADERS_TIMEOUT_MS = 10_000;
const PUBLIC_KEEP_ALIVE_TIMEOUT_MS = 1_000;
const PUBLIC_MAX_CONNECTIONS = 64;
const IDENTITY_HEADER = "tailscale-user-login";
const HOP_HEADERS = new Set(["connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "trailer", "te"]);
class UpstreamStatusError extends Error {
	constructor(readonly status: number) { super(`Upstream status ${status}`); }
}

const token = (): string => randomBytes(32).toString("base64url");
const equalSecret = (left: string, right: string): boolean => {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
};
export interface GatewayServerOptions {
	settings: McpUiSettings | GatewayDaemonSettings;
	hostname?: string;
	externalUrl?: string;
	listenAddress?: string;
	socketPath: string;
	pidPath?: string;
	now?: () => number;
	onIdle?: () => void | Promise<void>;
}

export async function startGatewayServer(options: GatewayServerOptions) {
	const settings = resolveServerSettings(options);
	const sessions = new Map<string, StoredSession>();
	const capabilities = new Map<string, StoredSession>();
	const now = options.now ?? Date.now;
	let closePromise: Promise<void> | undefined;
	let resolveClosed!: () => void;
	let rejectClosed!: (error: unknown) => void;
	const closed = new Promise<void>((resolve, reject) => {
		resolveClosed = resolve;
		rejectClosed = reject;
	});
	let idleSince: number | undefined = now();
	let stopping = false;

	const controlServer = createServer((request, response) => void handleControl(request, response));
	const publicServer = createServer((request, response) => void handlePublic(request, response).catch(() => gatewayError(response)));

	async function handleControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const reply = (status: number, value?: unknown): void => {
			response.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
			response.end(value === undefined ? undefined : JSON.stringify(value));
		};
		try {
			const body = await readJson(request);
			if (request.url === "/hello") return reply(200, { protocol: PROTOCOL_VERSION, signature: settingsSignature(settings) });
			if (request.url === "/shutdown" && request.method === "POST") {
				if (sessions.size > 0) return reply(409, { error: "Gateway has active sessions" });
				stopping = true;
				reply(202, { stopping: true });
				setImmediate(() => { void close(); });
				return;
			}
			if (request.url === "/register" && request.method === "POST") {
				if (stopping) return reply(503, { error: "Gateway is stopping" });
				const registration = body as Registration;
				if (!validRegistration(registration)) return reply(400, { error: "invalid registration" });
				const capability = token();
				const stored: StoredSession = {
					sessionId: token(), capability, leaseSecret: token(), label: registration.label,
					backendOrigin: registration.backendOrigin, backendSecret: registration.backendSecret ?? token(), touchedAt: now(),
					externalUrl: `${settings.externalUrl}/s/${capability}/`,
				};
				sessions.set(stored.sessionId, stored);
				capabilities.set(capability, stored);
				idleSince = undefined;
				return reply(201, publicSession(stored));
			}
			const match = request.url?.match(/^\/session\/([^/]+)\/(heartbeat|update|unregister)$/);
			if (!match || request.method !== "POST") return reply(404, { error: "not found" });
			const stored = sessions.get(match[1]);
			if (!stored || typeof body?.leaseSecret !== "string" || !equalSecret(stored.leaseSecret, body.leaseSecret)) return reply(404, { error: "not found" });
			if (match[2] === "unregister") {
				sessions.delete(stored.sessionId);
				capabilities.delete(stored.capability);
				if (sessions.size === 0) idleSince = now();
				return reply(204);
			}
			if (match[2] === "update" && body.label !== undefined) {
				if (!validLabel(body.label)) return reply(400, { error: "invalid update" });
				stored.label = body.label;
			}
			stored.touchedAt = now();
			return reply(200, publicSession(stored));
		} catch {
			reply(400, { error: "bad request" });
		}
	}

	async function handlePublic(request: IncomingMessage, response: ServerResponse): Promise<void> {
		applySecurity(response);
		let parsed: URL;
		try { parsed = new URL(request.url ?? "/", "http://127.0.0.1"); } catch { return notFound(request, response); }
		const mounted = settings.basePath !== "/" && parsed.pathname.startsWith(`${settings.basePath}/s/`);
		if (settings.requireTailscaleIdentity && !validIdentity(request.headers[IDENTITY_HEADER])) return notFound(request, response);
		const route = mounted ? parsed.pathname.slice(settings.basePath.length) : parsed.pathname;
		const match = route.match(/^\/s\/([^/]+)(?:\/(.*))?$/);
		const stored = match ? capabilities.get(match[1]) : undefined;
		if (!stored) return notFound(request, response);
		if (match![2] === undefined) {
			response.writeHead(308, { ...SECURITY_HEADERS, location: `${parsed.pathname}/${parsed.search}` });
			response.end();
			return;
		}
		if (match![2] === "") return dashboard(response, stored);
		if (!match![2].startsWith("proxy/")) return notFound(request, response);
		const rawPath = rawProxyPath(request.url ?? "", mounted, settings.basePath, stored.capability);
		if (!rawPath) return notFound(request, response);
		proxy(request, response, stored, rawPath);
	}

	function proxy(incoming: IncomingMessage, response: ServerResponse, session: StoredSession, rawPath: string): void {
		const target = new URL(rawPath, `${session.backendOrigin}/`);
		const headers: Record<string, string | string[]> = {};
		const hopHeaders = dynamicHopHeaders(incoming.headers);
		for (const [name, value] of Object.entries(incoming.headers)) {
			if (!hopHeaders.has(name) && name !== "host" && name !== IDENTITY_HEADER && value !== undefined) headers[name] = value;
		}
		headers[INTERNAL_SECRET_HEADER] = session.backendSecret;
		let upstream: IncomingMessage | undefined;
		let completed = false;
		let requestBytes = 0;
		const abort = (): void => {
			if (completed) return;
			outgoing.destroy();
			upstream?.destroy();
		};
		const fail = (): void => {
			if (completed) return;
			outgoing.destroy();
			upstream?.destroy();
			completed = true;
			if (!response.headersSent) gatewayError(response);
			else response.destroy();
		};
		const outgoing = httpRequest(target, { method: incoming.method, headers }, (received) => {
			upstream = received;
			const safe = stripResponseHeaders(received.headers);
			response.writeHead(received.statusCode ?? 502, { ...safe, ...SECURITY_HEADERS });
			received.on("aborted", fail);
			received.on("error", fail);
			received.on("end", () => { completed = true; });
			received.pipe(response);
		});
		outgoing.on("error", fail);
		incoming.on("data", (chunk: Buffer) => {
			requestBytes += chunk.length;
			if (requestBytes <= MAX_PROXY_REQUEST_BYTES) return;
			const responseCompleted = completed;
			completed = true;
			outgoing.destroy();
			upstream?.destroy();
			if (responseCompleted) {
				incoming.destroy();
				return;
			}
			if (response.headersSent) {
				response.destroy();
				incoming.destroy();
			} else {
				response.writeHead(413, { ...SECURITY_HEADERS, connection: "close" });
				response.end("Request too large", () => incoming.destroy());
			}
		});
		incoming.on("aborted", abort);
		incoming.on("error", abort);
		response.on("close", abort);
		incoming.pipe(outgoing);
	}

	async function dashboard(response: ServerResponse, session: StoredSession): Promise<void> {
		let descriptors: unknown;
		try {
			try {
				descriptors = await backendJson(session, "/apps/v2");
				if (!validDescriptors(descriptors, true)) throw new Error("invalid descriptors");
			} catch (error) {
				if (!(error instanceof UpstreamStatusError) || error.status !== 404) throw error;
				descriptors = await backendJson(session, "/apps");
				if (!validDescriptors(descriptors, false)) throw new Error("invalid descriptors");
			}
		} catch { return gatewayError(response); }
		const apps = descriptors as Array<{ id: string; label: string; route: string; server?: string }>;
		response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": DASHBOARD_CSP });
		response.end(renderDashboard(apps));
	}

	function backendJson(session: StoredSession, path: string): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error, value?: unknown): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				error ? reject(error) : resolve(value);
			};
			const outgoing = httpRequest(new URL(path, `${session.backendOrigin}/`), { headers: { [INTERNAL_SECRET_HEADER]: session.backendSecret } }, (upstream) => {
				if (upstream.statusCode !== 200) {
					upstream.resume();
					return finish(new UpstreamStatusError(upstream.statusCode ?? 0));
				}
				const chunks: Buffer[] = [];
				let size = 0;
				upstream.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_DESCRIPTORS_BYTES) {
						upstream.destroy();
						finish(new Error("upstream"));
					} else chunks.push(chunk);
				});
				upstream.on("aborted", () => finish(new Error("upstream")));
				upstream.on("error", () => finish(new Error("upstream")));
				upstream.on("end", () => {
					try { finish(undefined, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
					catch { finish(new Error("upstream")); }
				});
			});
			const timeout = setTimeout(() => {
				outgoing.destroy();
				finish(new Error("upstream"));
			}, 2_000);
			outgoing.on("error", () => finish(new Error("upstream")));
			outgoing.end();
		});
	}

	publicServer.maxConnections = PUBLIC_MAX_CONNECTIONS;
	publicServer.maxHeadersCount = 100;
	publicServer.requestTimeout = PUBLIC_REQUEST_TIMEOUT_MS;
	publicServer.headersTimeout = PUBLIC_HEADERS_TIMEOUT_MS;
	publicServer.keepAliveTimeout = PUBLIC_KEEP_ALIVE_TIMEOUT_MS;
	publicServer.maxRequestsPerSocket = 100;

	const sweep = setInterval(() => {
		const time = now();
		for (const [id, session] of sessions) {
			if (time - session.touchedAt >= settings.idleTimeoutMs) {
				sessions.delete(id);
				capabilities.delete(session.capability);
			}
		}
		if (sessions.size === 0) {
			idleSince ??= time;
			if (time - idleSince >= settings.idleTimeoutMs) {
				void close().then(() => options.onIdle?.()).catch(() => undefined);
			}
		} else idleSince = undefined;
	}, Math.min(250, settings.idleTimeoutMs)).unref();

	await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
	await chmod(dirname(options.socketPath), 0o700);
	await new Promise<void>((resolve, reject) => controlServer.once("error", reject).listen(options.socketPath, resolve));
	await chmod(options.socketPath, 0o600);
	const ownedSocket = await stat(options.socketPath);
	try {
		await new Promise<void>((resolve, reject) => publicServer.once("error", reject).listen(settings.gatewayPort, settings.listenAddress, resolve));
		if (options.pidPath) await writeFile(options.pidPath, String(process.pid), { mode: 0o600 });
	} catch (error) {
		controlServer.close();
		await removeOwned(options.socketPath, ownedSocket);
		throw error;
	}

	function close(): Promise<void> {
		closePromise ??= (async () => {
			clearInterval(sweep);
			await Promise.all([closeServer(controlServer, true), closeServer(publicServer, true)]);
			await removeOwned(options.socketPath, ownedSocket);
			if (options.pidPath) {
				try {
					if ((await (await import("node:fs/promises")).readFile(options.pidPath, "utf8")).trim() === String(process.pid)) await rm(options.pidPath);
				} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			}
		})();
		closePromise.then(resolveClosed, rejectClosed);
		return closePromise;
	}
	return { close, closed, sessions };
}

function resolveServerSettings(options: GatewayServerOptions): GatewayDaemonSettings {
	if ("externalUrl" in options.settings) return { ...options.settings };
	const hostname = options.hostname;
	if (!hostname) throw new Error("Missing gateway hostname");
	const basePath = options.settings.basePath;
	return {
		externalUrl: options.externalUrl?.replace(/\/+$/, "") ?? `https://${hostname}:${options.settings.httpsPort}${basePath === "/" ? "" : basePath}`,
		listenAddress: options.listenAddress ?? "127.0.0.1",
		gatewayPort: options.settings.gatewayPort,
		basePath,
		requireTailscaleIdentity: options.settings.requireTailscaleIdentity,
		idleTimeoutMs: options.settings.idleTimeoutMs,
	};
}
function validLabel(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value); }
function validRegistration(value: unknown): value is Registration {
	return !!value && typeof value === "object" && validLabel((value as Registration).label) &&
		isLoopbackOrigin((value as Registration).backendOrigin) &&
		((value as Registration).backendSecret === undefined || (typeof (value as Registration).backendSecret === "string" && (value as Registration).backendSecret!.length <= 4096));
}
function publicSession({ sessionId, capability, leaseSecret, externalUrl }: StoredSession): Session { return { sessionId, capability, leaseSecret, externalUrl }; }
function applySecurity(response: ServerResponse): void { for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value); }
function notFound(request: IncomingMessage, response: ServerResponse): void {
	response.writeHead(404, { ...SECURITY_HEADERS, "content-security-policy": "default-src 'none'", connection: "close" });
	response.end("Not found", () => request.destroy());
}
function gatewayError(response: ServerResponse): void { if (!response.headersSent) response.writeHead(502, { ...SECURITY_HEADERS, "content-security-policy": "default-src 'none'" }); response.end("Gateway error"); }
function validIdentity(value: string | string[] | undefined): boolean { return typeof value === "string" && value.length > 0 && value.length <= 256 && /^[\x20-\x7e]+$/.test(value); }
function validDescriptors(value: unknown, enriched: boolean): boolean {
	const keys = enriched ? "id,label,route,server,state" : "id,label,route,state";
	return Array.isArray(value) && value.length <= 16 && value.every((item) => {
		if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).sort().join(",") !== keys) return false;
		const app = item as Record<string, unknown>;
		return typeof app.id === "string" && /^[A-Za-z0-9_-]{24}$/.test(app.id) && typeof app.label === "string" &&
			app.label.length > 0 && Buffer.byteLength(app.label, "utf8") <= 512 && !/[\u0000-\u001f\u007f]/u.test(app.label) &&
			app.route === `apps/${app.id}/` && app.state === "active" &&
			(!enriched || (typeof app.server === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(app.server)));
	});
}
function rawProxyPath(url: string, mounted: boolean, basePath: string, capability: string): string | undefined {
	const question = url.indexOf("?");
	const raw = question < 0 ? url : url.slice(0, question);
	const query = question < 0 ? "" : url.slice(question);
	const prefix = `${mounted ? basePath : ""}/s/${capability}/proxy/`;
	if (!raw.startsWith(prefix)) return undefined;
	const remainder = raw.slice(prefix.length);
	if (remainder.startsWith("/") || /%(?:2f|5c)/i.test(remainder)) return undefined;
	try {
		const segments = remainder.split("/").map(decodeURIComponent);
		if (segments.some((part) => part === "." || part === ".." || part.includes("\\") || part.includes("/"))) return undefined;
	} catch { return undefined; }
	return `/${remainder}${query}`;
}
function dynamicHopHeaders(input: IncomingHttpHeaders): Set<string> {
	const result = new Set(HOP_HEADERS);
	const connection = input.connection;
	const values = Array.isArray(connection) ? connection : connection === undefined ? [] : [connection];
	for (const value of values) for (const name of value.split(",")) {
		const normalized = name.trim().toLowerCase();
		if (normalized) result.add(normalized);
	}
	return result;
}
function stripResponseHeaders(input: IncomingHttpHeaders): Record<string, string | string[]> {
	const result: Record<string, string | string[]> = {};
	const hopHeaders = dynamicHopHeaders(input);
	for (const [name, value] of Object.entries(input)) if (!hopHeaders.has(name) && name !== INTERNAL_SECRET_HEADER && value !== undefined) result[name] = value;
	return result;
}
async function readJson(request: IncomingMessage): Promise<any> {
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		size += (chunk as Buffer).length;
		if (size > 1024 * 1024) throw new Error("body too large");
		chunks.push(chunk as Buffer);
	}
	return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}
function closeServer(server: ReturnType<typeof createServer>, force = false): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
		if (force) server.closeAllConnections();
	});
}
async function removeOwned(path: string, owned: Awaited<ReturnType<typeof stat>>): Promise<void> {
	try { const current = await stat(path); if (current.dev === owned.dev && current.ino === owned.ino) await rm(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
