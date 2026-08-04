import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpServerManager } from "../mcp/manager.js";
import { hostHtml, hostScript } from "./host-template.js";
import { appResourceUri, selectAppResource } from "./resource.js";
import {
	boundedJson,
	MAX_CONTROL_BYTES,
	MAX_SESSION_DATA_BYTES,
	MAX_SESSION_MESSAGES_BYTES,
	securityHeaders,
} from "./security.js";

const bridgeAsset = readFileSync(new URL("./generated/app-bridge.js", import.meta.url), "utf8");
const uiStylesheet = readFileSync(new URL("../ui/generated/mcp-ui.css", import.meta.url), "utf8");
const MAX_EVENTS = 64;
const MAX_EVENT_BYTES = MAX_SESSION_DATA_BYTES + MAX_SESSION_MESSAGES_BYTES;
const MAX_MESSAGES = 50;
const APP_ROUTE = /^\/apps\/([A-Za-z0-9_-]{24})\/(|view|bridge\.js|app-bridge\.js|events|heartbeat|complete|tool-call|message|context|display-mode|open-link)$/;

interface EventRecord {
	id: number;
	wire: string;
	bytes: number;
}

interface Session {
	id: string;
	server: string;
	tool: string;
	label: string;
	html: string;
	meta: ReturnType<typeof selectAppResource>["meta"];
	input: unknown;
	result: unknown;
	lastHeartbeat: number;
	messages: unknown[];
	messageBytes: number;
	context?: unknown;
	closed: boolean;
	nextEvent: number;
	events: EventRecord[];
	eventBytes: number;
	clients: Set<ServerResponse>;
	calls: Set<AbortController>;
}

export interface OpenedApp {
	id: string;
	route: string;
}

export interface LocalAppDescriptor {
	id: string;
	label: string;
	route: string;
	server: string;
	state: "active";
}

export interface McpAppControllerOptions {
	ttlMs?: number;
	heartbeatMs?: number;
	loadTimeoutMs?: number;
	maxSessions?: number;
	maxSseClients?: number;
	maxSseClientsPerSession?: number;
	maxCalls?: number;
	maxCallsPerSession?: number;
	onChange?: (apps: readonly LocalAppDescriptor[]) => void;
}

export class McpAppController {
	private server?: Server;
	private listenPromise?: Promise<void>;
	private port?: number;
	private readonly secret = randomBytes(32).toString("base64url");
	private readonly sessions = new Map<string, Session>();
	private opening = 0;
	private activeSseClients = 0;
	private readonly replayingSseClients = new WeakSet<ServerResponse>();
	private activeCalls = 0;
	private timer?: NodeJS.Timeout;
	private closed = false;

	constructor(
		private readonly manager: McpServerManager,
		private readonly options: McpAppControllerOptions = {},
	) {}

	get count(): number {
		return this.sessions.size;
	}

	list(): LocalAppDescriptor[] {
		return [...this.sessions.values()].map((session) => ({
			id: session.id,
			label: session.label,
			route: `apps/${session.id}/`,
			server: session.server,
			state: "active",
		}));
	}

	consumeMessages(id: string): unknown[] {
		const session = this.sessions.get(id);
		if (!session) return [];
		const messages = session.messages.splice(0);
		if (session.context !== undefined) messages.push({ type: "context", value: session.context });
		session.context = undefined;
		session.messageBytes = 0;
		return messages;
	}

	async open(
		server: string,
		tool: Tool,
		input: unknown,
		result: CallToolResult,
		signal?: AbortSignal,
	): Promise<OpenedApp | undefined> {
		const uri = appResourceUri(tool);
		if (!uri) return undefined;
		if (this.sessions.size + this.opening >= limit(this.options.maxSessions, 16)) {
			throw new Error("App session capacity reached");
		}
		this.opening++;
		try {
			const resource = selectAppResource(await this.loadResource(server, uri, signal), uri);
			const safeInput = boundedJson(input, MAX_SESSION_DATA_BYTES);
			const safeResult = boundedJson(result, MAX_SESSION_DATA_BYTES);
			await this.listen();

			const id = randomBytes(18).toString("base64url");
			const session: Session = {
				id,
				server,
				tool: tool.name,
				label: (tool.title ?? tool.name).slice(0, 256),
				html: resource.html,
				meta: resource.meta,
				input: safeInput,
				result: safeResult,
				lastHeartbeat: Date.now(),
				messages: [],
				messageBytes: 0,
				closed: false,
				nextEvent: 1,
				events: [],
				eventBytes: 0,
				clients: new Set(),
				calls: new Set(),
			};
			this.sessions.set(id, session);
			this.emit(session, "input", { arguments: session.input }, MAX_SESSION_DATA_BYTES);
			this.emit(session, "result", session.result, MAX_SESSION_DATA_BYTES);
			this.startTimer();
			this.changed();
			return { id, route: `apps/${id}/` };
		} finally {
			this.opening--;
		}
	}

	private async loadResource(server: string, uri: string, signal?: AbortSignal) {
		const controller = new AbortController();
		const abort = (): void => controller.abort(signal?.reason);
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
		let rejectTimeout!: (error: Error) => void;
		const timeoutFailure = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
		const timeout = setTimeout(() => {
			controller.abort(new Error("App resource load timed out"));
			rejectTimeout(new Error("App resource load timed out"));
		}, this.options.loadTimeoutMs ?? 5_000);
		try {
			return await Promise.race([
				this.manager.readResource(server, uri, controller.signal),
				timeoutFailure,
			]);
		} finally {
			clearTimeout(timeout);
			signal?.removeEventListener("abort", abort);
		}
	}

	private async listen(): Promise<void> {
		if (this.closed) throw new Error("App controller is closed");
		if (this.listenPromise) return this.listenPromise;

		const server = createServer((request, response) => {
			void this.handle(request, response).catch(() => {
				if (!response.headersSent) this.send(response, 500, "App host unavailable");
				else response.destroy();
			});
		});
		this.server = server;
		this.listenPromise = new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				server.off("listening", onListening);
				this.server = undefined;
				this.listenPromise = undefined;
				reject(error);
			};
			const onListening = (): void => {
				server.off("error", onError);
				this.port = (server.address() as { port: number }).port;
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(0, "127.0.0.1");
		});
		return this.listenPromise;
	}

	private startTimer(): void {
		if (this.timer) return;
		const ttl = this.options.ttlMs ?? 300_000;
		const interval = Math.max(10, Math.min(this.options.heartbeatMs ?? 15_000, ttl));
		this.timer = setInterval(() => this.sweep(), interval);
		this.timer.unref();
	}

	private sweep(): void {
		const now = Date.now();
		const ttl = this.options.ttlMs ?? 300_000;
		for (const session of this.sessions.values()) {
			if (now - session.lastHeartbeat >= ttl) this.remove(session, "cancelled");
		}
	}

	private authorized(request: IncomingMessage): boolean {
		const raw = request.headers["x-pi-mcp-backend-secret"];
		if (typeof raw !== "string") return false;
		const received = Buffer.from(raw);
		const expected = Buffer.from(this.secret);
		return received.length === expected.length && timingSafeEqual(received, expected);
	}

	private send(
		response: ServerResponse,
		status: number,
		body = "Not found",
		type = "text/plain; charset=utf-8",
		csp = "default-src 'none'",
	): void {
		response.writeHead(status, {
			...securityHeaders,
			"content-type": type,
			"content-security-policy": csp,
		});
		response.end(body);
	}

	private async body(request: IncomingMessage): Promise<Record<string, unknown>> {
		const parts: Buffer[] = [];
		let size = 0;
		for await (const part of request) {
			const buffer = Buffer.isBuffer(part) ? part : Buffer.from(part);
			size += buffer.length;
			if (size > MAX_CONTROL_BYTES) throw new Error("Request is too large");
			parts.push(buffer);
		}
		const value: unknown = parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {};
		if (!isRecord(value)) throw new Error("Invalid request shape");
		return value;
	}

	private emit(session: Session, name: string, data: unknown, max = MAX_CONTROL_BYTES): void {
		const value = boundedJson(data, max);
		const wire = `id: ${session.nextEvent++}\nevent: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
		const event = { id: session.nextEvent - 1, wire, bytes: Buffer.byteLength(wire) };
		session.events.push(event);
		session.eventBytes += event.bytes;
		while (session.events.length > MAX_EVENTS || session.eventBytes > MAX_EVENT_BYTES) {
			const removed = session.events.shift();
			if (removed) session.eventBytes -= removed.bytes;
		}
		for (const client of session.clients) {
			if (this.replayingSseClients.has(client)) continue;
			void this.writeSse(client, wire).then((written) => {
				if (!written) client.end();
			});
		}
	}

	private async writeSse(response: ServerResponse, data: string): Promise<boolean> {
		if (response.write(data)) return true;
		return new Promise<boolean>((resolve) => {
			const finish = (written: boolean): void => {
				clearTimeout(timeout);
				response.off("drain", onDrain);
				response.off("close", onClose);
				resolve(written);
			};
			const onDrain = (): void => finish(true);
			const onClose = (): void => finish(false);
			const timeout = setTimeout(() => finish(false), 1_000);
			response.once("drain", onDrain);
			response.once("close", onClose);
		});
	}

	private async eventStream(request: IncomingMessage, response: ServerResponse, session: Session): Promise<void> {
		if (
			session.clients.size >= limit(this.options.maxSseClientsPerSession, 4) ||
			this.activeSseClients >= limit(this.options.maxSseClients, 32)
		) {
			return this.send(response, 429, "Capacity exceeded");
		}
		session.lastHeartbeat = Date.now();
		response.writeHead(200, {
			...securityHeaders,
			"content-type": "text/event-stream",
			"content-security-policy": "default-src 'none'",
			connection: "keep-alive",
		});

		let heartbeat: NodeJS.Timeout | undefined;
		let cleaned = false;
		const cleanup = (): void => {
			if (cleaned) return;
			cleaned = true;
			if (heartbeat) clearInterval(heartbeat);
			this.replayingSseClients.delete(response);
			session.clients.delete(response);
			this.activeSseClients--;
		};
		session.clients.add(response);
		this.replayingSseClients.add(response);
		this.activeSseClients++;
		request.once("aborted", cleanup);
		response.once("close", cleanup);

		if (cleaned || session.closed || !(await this.writeSse(response, ": connected\n\n"))) {
			response.end();
			cleanup();
			return;
		}
		const parsedLast = Number(request.headers["last-event-id"] ?? 0);
		let delivered = Number.isSafeInteger(parsedLast) && parsedLast > 0 ? parsedLast : 0;
		while (!cleaned && !session.closed) {
			const pending = session.events.filter((event) => event.id > delivered);
			if (!pending.length) break;
			for (const event of pending) {
				if (!(await this.writeSse(response, event.wire))) {
					response.end();
					cleanup();
					return;
				}
				delivered = event.id;
				if (cleaned || session.closed) break;
			}
		}
		if (cleaned || session.closed) {
			response.end();
			cleanup();
			return;
		}
		this.replayingSseClients.delete(response);

		let heartbeatWriting = false;
		heartbeat = setInterval(() => {
			if (heartbeatWriting) return response.end();
			heartbeatWriting = true;
			void this.writeSse(response, ": keepalive\n\n").then((written) => {
				heartbeatWriting = false;
				if (!written) response.end();
			});
		}, this.options.heartbeatMs ?? 15_000);
		heartbeat.unref();
	}

	private record(session: Session, route: string, body: unknown): void {
		const value = boundedJson(body);
		const message = { type: route, value };
		const bytes = Buffer.byteLength(JSON.stringify(message));
		session.messages.push(message);
		session.messageBytes += bytes;
		while (session.messages.length > MAX_MESSAGES || session.messageBytes > MAX_SESSION_MESSAGES_BYTES) {
			const removed = session.messages.shift();
			if (removed) session.messageBytes -= Buffer.byteLength(JSON.stringify(removed));
		}
		this.emit(session, route, value);
	}

	private recordContext(session: Session, body: unknown): void {
		const value = boundedJson(body);
		session.context = value;
		this.emit(session, "context", value);
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		if (!this.authorized(request)) return this.send(response, 404);
		const url = request.url ?? "";
		if (url === "/apps" && request.method === "GET") {
			const legacy = this.list().map(({ server: _server, ...descriptor }) => descriptor);
			return this.send(response, 200, JSON.stringify(legacy), "application/json");
		}
		if (url === "/apps/v2" && request.method === "GET") {
			return this.send(response, 200, JSON.stringify(this.list()), "application/json");
		}
		if (url === "/styles.css" && request.method === "GET") {
			return this.send(response, 200, uiStylesheet, "text/css; charset=utf-8");
		}

		const match = APP_ROUTE.exec(url);
		const session = match ? this.sessions.get(match[1]!) : undefined;
		if (!match || !session || session.closed) return this.send(response, 404);
		const route = match[2]!;

		if (request.method === "GET" && route === "") {
			return this.send(
				response,
				200,
				hostHtml(session.label, session.meta.allow),
				"text/html; charset=utf-8",
				"default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'",
			);
		}
		if (request.method === "GET" && route === "view") {
			return this.send(response, 200, session.html, "text/html; charset=utf-8", session.meta.csp);
		}
		if (request.method === "GET" && route === "bridge.js") {
			return this.send(response, 200, hostScript(), "text/javascript; charset=utf-8");
		}
		if (request.method === "GET" && route === "app-bridge.js") {
			return this.send(response, 200, bridgeAsset, "text/javascript; charset=utf-8");
		}
		if (request.method === "GET" && route === "events") {
			return this.eventStream(request, response, session);
		}
		if (request.method !== "POST") return this.send(response, 404);

		try {
			const body = await this.body(request);
			if (route === "heartbeat") {
				session.lastHeartbeat = Date.now();
				return this.send(response, 200, "{}", "application/json");
			}
			if (route === "complete") {
				this.remove(session, "complete");
				return this.send(response, 200, "{}", "application/json");
			}
			if (route === "tool-call") {
				if (!onlyKeys(body, ["name", "arguments"])) throw new Error("Invalid tool call");
				if (typeof body.name !== "string" || !body.name || body.name.length > 256) throw new Error("Invalid tool name");
				const args = body.arguments === undefined ? {} : body.arguments;
				if (!isRecord(args)) throw new Error("Invalid tool arguments");
				if (
					session.calls.size >= limit(this.options.maxCallsPerSession, 4) ||
					this.activeCalls >= limit(this.options.maxCalls, 32)
				) {
					return this.send(response, 429, "Capacity exceeded");
				}
				const abort = new AbortController();
				const abortRequest = (): void => abort.abort();
				request.once("aborted", abortRequest);
				response.once("close", abortRequest);
				session.calls.add(abort);
				this.activeCalls++;
				try {
					const result = await this.manager.callFromApp(session.server, body.name, args, abort.signal);
					return this.send(
						response,
						200,
						JSON.stringify(boundedJson(result, MAX_SESSION_DATA_BYTES)),
						"application/json",
					);
				} finally {
					request.off("aborted", abortRequest);
					response.off("close", abortRequest);
					session.calls.delete(abort);
					this.activeCalls--;
				}
			}
			if (route === "open-link") {
				if (!onlyKeys(body, ["url"]) || typeof body.url !== "string" || body.url.length > 2_048) throw new Error("Invalid URL");
				const parsed = new URL(body.url);
				if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error("Invalid URL");
				this.record(session, route, { url: parsed.href });
				return this.send(response, 200, '{"accepted":true}', "application/json");
			}
			if (route === "display-mode") {
				if (!onlyKeys(body, ["mode"]) || !["inline", "fullscreen"].includes(String(body.mode))) throw new Error("Invalid display mode");
				this.record(session, route, body);
				return this.send(response, 200, "{}", "application/json");
			}
			if (route === "context") {
				this.recordContext(session, body);
				return this.send(response, 200, "{}", "application/json");
			}
			if (route === "message") {
				this.record(session, route, body);
				return this.send(response, 200, "{}", "application/json");
			}
		} catch {
			return this.send(response, 400, "Invalid request");
		}
		return this.send(response, 404);
	}

	private remove(session: Session, event: "complete" | "cancelled"): void {
		if (session.closed) return;
		this.emit(session, event, {});
		session.closed = true;
		for (const call of session.calls) call.abort();
		for (const client of session.clients) client.end();
		session.clients.clear();
		this.sessions.delete(session.id);
		if (!this.sessions.size && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.changed();
	}

	private changed(): void {
		this.options.onChange?.(this.list());
	}

	backend(): { origin: string; secret: string } | undefined {
		return this.port ? { origin: `http://127.0.0.1:${this.port}`, secret: this.secret } : undefined;
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		for (const session of [...this.sessions.values()]) this.remove(session, "cancelled");
		const server = this.server;
		this.server = undefined;
		this.listenPromise = undefined;
		this.port = undefined;
		if (server) {
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}

function limit(value: number | undefined, fallback: number): number {
	return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
