import { randomBytes, timingSafeEqual } from "node:crypto";
import { stat, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname } from "node:path";
import type { McpUiSettings } from "../config.js";
import { INTERNAL_SECRET_HEADER, PROTOCOL_VERSION, isLoopbackOrigin, settingsSignature, type Registration, type Session } from "./protocol.js";

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
	"content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
};
const HOP_HEADERS = new Set(["connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "trailer", "te"]);
const token = (): string => randomBytes(32).toString("base64url");
const equalSecret = (left: string, right: string): boolean => {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
};
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (character) => ({
	"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

export interface GatewayServerOptions {
	settings: McpUiSettings;
	hostname: string;
	socketPath: string;
	pidPath?: string;
	now?: () => number;
	onIdle?: () => void | Promise<void>;
}

export async function startGatewayServer(options: GatewayServerOptions) {
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

	const controlServer = createServer((request, response) => void handleControl(request, response));
	const publicServer = createServer((request, response) => void handlePublic(request, response));

	async function handleControl(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const reply = (status: number, value?: unknown): void => {
			response.writeHead(status, { "content-type": "application/json", ...SECURITY_HEADERS });
			response.end(value === undefined ? undefined : JSON.stringify(value));
		};
		try {
			const body = await readJson(request);
			if (request.url === "/hello") return reply(200, { protocol: PROTOCOL_VERSION, signature: settingsSignature(options.settings) });
			if (request.url === "/register" && request.method === "POST") {
				const registration = body as Registration;
				if (!validRegistration(registration)) return reply(400, { error: "invalid registration" });
				const capability = token();
				const stored: StoredSession = {
					sessionId: token(), capability, leaseSecret: token(), label: registration.label,
					backendOrigin: registration.backendOrigin, backendSecret: registration.backendSecret ?? token(), touchedAt: now(),
					externalUrl: `https://${options.hostname}:${options.settings.httpsPort}${options.settings.basePath}/s/${capability}/`,
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

	function handlePublic(request: IncomingMessage, response: ServerResponse): void {
		applySecurity(response);
		let parsed: URL;
		try { parsed = new URL(request.url ?? "/", "http://127.0.0.1"); } catch { return notFound(response); }
		const mounted = parsed.pathname.startsWith(`${options.settings.basePath}/s/`);
		const route = mounted ? parsed.pathname.slice(options.settings.basePath.length) : parsed.pathname;
		const match = route.match(/^\/s\/([^/]+)\/(.*)$/);
		const stored = match ? capabilities.get(match[1]) : undefined;
		if (!stored) return notFound(response);
		if (match![2] === "") {
			response.setHeader("content-type", "text/html; charset=utf-8");
			response.end(`<!doctype html><title>Pi MCP</title><h1>${escapeHtml(stored.label)}</h1>`);
			return;
		}
		if (!match![2].startsWith("proxy/")) return notFound(response);
		const rawPath = rawProxyPath(request.url ?? "", mounted, options.settings.basePath, stored.capability);
		if (!rawPath) return notFound(response);
		proxy(request, response, stored, rawPath);
	}

	function proxy(incoming: IncomingMessage, response: ServerResponse, session: StoredSession, rawPath: string): void {
		const target = new URL(rawPath, `${session.backendOrigin}/`);
		const headers: Record<string, string | string[]> = {};
		const hopHeaders = dynamicHopHeaders(incoming.headers);
		for (const [name, value] of Object.entries(incoming.headers)) {
			if (!hopHeaders.has(name) && name !== "host" && value !== undefined) headers[name] = value;
		}
		headers[INTERNAL_SECRET_HEADER] = session.backendSecret;
		const outgoing = httpRequest(target, { method: incoming.method, headers }, (upstream) => {
			const safe = stripResponseHeaders(upstream.headers);
			response.writeHead(upstream.statusCode ?? 502, { ...safe, ...SECURITY_HEADERS });
			upstream.pipe(response);
		});
		outgoing.on("error", () => {
			if (!response.headersSent) response.writeHead(502, SECURITY_HEADERS);
			response.end("Gateway error");
		});
		incoming.on("error", () => outgoing.destroy());
		incoming.pipe(outgoing);
	}

	const sweep = setInterval(() => {
		const time = now();
		for (const [id, session] of sessions) {
			if (time - session.touchedAt >= options.settings.idleTimeoutMs) {
				sessions.delete(id);
				capabilities.delete(session.capability);
			}
		}
		if (sessions.size === 0) {
			idleSince ??= time;
			if (time - idleSince >= options.settings.idleTimeoutMs) {
				void close().then(() => options.onIdle?.());
			}
		} else idleSince = undefined;
	}, Math.min(250, options.settings.idleTimeoutMs)).unref();

	await mkdir(dirname(options.socketPath), { recursive: true, mode: 0o700 });
	await chmod(dirname(options.socketPath), 0o700);
	await new Promise<void>((resolve, reject) => controlServer.once("error", reject).listen(options.socketPath, resolve));
	await chmod(options.socketPath, 0o600);
	const ownedSocket = await stat(options.socketPath);
	try {
		await new Promise<void>((resolve, reject) => publicServer.once("error", reject).listen(options.settings.gatewayPort, "127.0.0.1", resolve));
		if (options.pidPath) await writeFile(options.pidPath, String(process.pid), { mode: 0o600 });
	} catch (error) {
		controlServer.close();
		await removeOwned(options.socketPath, ownedSocket);
		throw error;
	}

	function close(): Promise<void> {
		closePromise ??= (async () => {
			clearInterval(sweep);
			await Promise.all([closeServer(controlServer), closeServer(publicServer)]);
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

function validLabel(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value); }
function validRegistration(value: unknown): value is Registration {
	return !!value && typeof value === "object" && validLabel((value as Registration).label) &&
		isLoopbackOrigin((value as Registration).backendOrigin) &&
		((value as Registration).backendSecret === undefined || (typeof (value as Registration).backendSecret === "string" && (value as Registration).backendSecret!.length <= 4096));
}
function publicSession({ sessionId, capability, leaseSecret, externalUrl }: StoredSession): Session { return { sessionId, capability, leaseSecret, externalUrl }; }
function applySecurity(response: ServerResponse): void { for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value); }
function notFound(response: ServerResponse): void { response.writeHead(404); response.end("Not found"); }
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
function closeServer(server: ReturnType<typeof createServer>): Promise<void> { return new Promise((resolve) => server.close(() => resolve())); }
async function removeOwned(path: string, owned: Awaited<ReturnType<typeof stat>>): Promise<void> {
	try { const current = await stat(path); if (current.dev === owned.dev && current.ino === owned.ino) await rm(path); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}
