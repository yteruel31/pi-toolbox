import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { McpUiSettings } from "../config.js";
import { INTERNAL_SECRET_HEADER, type Registration, type Session } from "../gateway/protocol.js";
import type { ServerConfig } from "../mcp/config.js";
import { McpServerManager } from "../mcp/manager.js";
import type { GatewayExposure } from "../gateway/exposure.js";
import type { RouteState } from "../tailscale.js";
import { StoredOAuthProvider } from "./provider.js";
import { OAuthStore } from "./store.js";

interface OAuthGateway {
	register(registration: Registration): Promise<Session>;
	heartbeat(session: Session): Promise<unknown>;
	unregister(session: Session): Promise<unknown>;
}

interface LegacyOAuthTailscale {
	status(settings: McpUiSettings): Promise<{ state: RouteState; target: string }>;
}

interface Attempt {
	provider: StoredOAuthProvider;
	session: Session;
	secret: string;
	state: string;
	redirect: string;
	authorization: string;
	server: ReturnType<typeof createServer>;
	heartbeat: NodeJS.Timeout;
	timeout: NodeJS.Timeout;
	completing?: Promise<void>;
}

export interface OAuthCoordinatorOptions {
	heartbeatMs?: number;
	timeoutMs?: number;
}

const SECURITY_HEADERS = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
	"content-security-policy": "default-src 'none'; frame-ancestors 'none'",
	connection: "close",
};

export function safeAuthorizationUrl(value: string): string {
	if (!value || value.length > 4_096 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("OAuth authorization URL is unsafe");
	let url: URL;
	try { url = new URL(value); } catch { throw new Error("OAuth authorization URL is unsafe"); }
	const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
	if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
		throw new Error("OAuth authorization URL is unsafe");
	}
	return url.href;
}

function equal(left: string, right: string): boolean {
	const first = Buffer.from(left);
	const second = Buffer.from(right);
	return first.length === second.length && timingSafeEqual(first, second);
}

export class OAuthCoordinator {
	private readonly attempts = new Map<string, Attempt>();
	private readonly starts = new Map<string, Promise<{ authorizationUrl: string }>>();
	private readonly heartbeatMs: number;
	private readonly timeoutMs: number;
	private closed = false;
	private closePromise?: Promise<void>;

	constructor(
		private readonly manager: McpServerManager,
		private readonly servers: Map<string, ServerConfig>,
		private readonly settings: McpUiSettings,
		private readonly gateway: OAuthGateway,
		private readonly exposure: GatewayExposure | LegacyOAuthTailscale,
		private readonly store = new OAuthStore(),
		options: OAuthCoordinatorOptions = {},
	) {
		this.heartbeatMs = options.heartbeatMs ?? 30_000;
		this.timeoutMs = options.timeoutMs ?? 10 * 60_000;
	}

	async passiveProvider(name: string): Promise<StoredOAuthProvider | undefined> {
		const config = this.servers.get(name);
		return config && config.transport !== "stdio" ? StoredOAuthProvider.passive(config.url.href, this.store) : undefined;
	}

	async begin(name: string): Promise<{ authorizationUrl: string }> {
		if (this.closed) throw new Error("OAuth coordinator is closed");
		const existing = this.attempts.get(name);
		if (existing?.authorization) return { authorizationUrl: existing.authorization };
		const current = this.starts.get(name);
		if (current) return current;
		const start = this.start(name);
		this.starts.set(name, start);
		try {
			return await start;
		} finally {
			if (this.starts.get(name) === start) this.starts.delete(name);
		}
	}

	private async start(name: string): Promise<{ authorizationUrl: string }> {
		const config = this.servers.get(name);
		if (!config) throw new Error(`Unknown MCP server: ${name}`);
		if (config.transport === "stdio") throw new Error(`OAuth is unavailable for MCP server ${name}`);
		if ("verify" in this.exposure) await this.exposure.verify();
		else if ((await this.exposure.status(this.settings)).state !== "matching") throw new Error("MCP gateway is not configured");
		if (this.closed) throw new Error("OAuth coordinator is closed");

		const secret = randomBytes(32).toString("base64url");
		// Mobbin's Supabase OAuth server truncates state values longer than 25 characters.
		// Eighteen random bytes retain 144 bits of entropy in 24 base64url characters.
		const state = randomBytes(18).toString("base64url");
		let attempt: Attempt | undefined;
		const backend = createServer((request, response) => {
			if (!attempt || request.method !== "GET" || (request.url?.length ?? 0) > 4_096) {
				this.page(response, 404, false);
				return;
			}
			const suppliedSecret = request.headers[INTERNAL_SECRET_HEADER];
			if (typeof suppliedSecret !== "string" || !equal(suppliedSecret, secret)) {
				this.page(response, 404, false);
				return;
			}
			let callback: URL;
			try {
				callback = new URL(request.url ?? "", "http://127.0.0.1");
			} catch {
				this.page(response, 400, false);
				return;
			}
			if (callback.pathname !== "/oauth/callback") {
				this.page(response, 404, false);
				return;
			}
			const externalCallback = `${attempt.redirect}${callback.search}`;
			void this.finish(name, externalCallback).then(
				() => this.pageThenCleanup(name, response, 200, true),
				() => this.pageThenCleanup(name, response, 400, false),
			);
		});
		await new Promise<void>((resolve, reject) => backend.once("error", reject).listen(0, "127.0.0.1", resolve));

		try {
			const port = (backend.address() as { port: number }).port;
			const session = await this.gateway.register({
				label: `OAuth: ${name}`,
				backendOrigin: `http://127.0.0.1:${port}`,
				backendSecret: secret,
			});
			const redirect = `${session.externalUrl}proxy/oauth/callback`;
			const provider = new StoredOAuthProvider(config.url.href, this.store, redirect, state);
			attempt = {
				provider,
				session,
				secret,
				state,
				redirect,
				authorization: "",
				server: backend,
				heartbeat: setInterval(() => {
					void this.gateway.heartbeat(session).catch(() => this.cleanup(name).catch(() => undefined));
				}, this.heartbeatMs).unref(),
				timeout: setTimeout(() => {
					void this.cleanup(name).catch(() => undefined);
				}, this.timeoutMs).unref(),
			};
			this.attempts.set(name, attempt);
			await this.manager.beginAuth(name, provider);
			const authorization = provider.takeAuthorizationUrl();
			if (!authorization) throw new Error("OAuth server did not provide an authorization URL");
			if (this.closed) throw new Error("OAuth coordinator is closed");
			attempt.authorization = safeAuthorizationUrl(authorization.href);
			return { authorizationUrl: attempt.authorization };
		} catch {
			await this.cleanup(name, backend);
			throw new Error(`OAuth could not start for MCP server ${name}`);
		}
	}

	async complete(name: string, redirectUrl: string): Promise<void> {
		try {
			await this.finish(name, redirectUrl);
		} finally {
			await this.cleanup(name);
		}
	}

	private async finish(name: string, redirectUrl: string): Promise<void> {
		const attempt = this.attempts.get(name);
		if (!attempt) throw new Error("No active OAuth attempt");
		if (attempt.completing) return attempt.completing;
		attempt.completing = (async () => {
			let callback: URL;
			try {
				callback = new URL(redirectUrl);
			} catch {
				throw new Error("Invalid OAuth callback URL");
			}
			if (redirectUrl.length > 4_096 || callback.username || callback.password || callback.hash ||
				`${callback.origin}${callback.pathname}` !== attempt.redirect) {
				throw new Error("Invalid OAuth callback URL");
			}
			for (const key of callback.searchParams.keys()) {
				if (key !== "code" && key !== "state") throw new Error("Invalid OAuth callback parameters");
			}
			for (const key of ["code", "state"]) {
				if (callback.searchParams.getAll(key).length !== 1) throw new Error("Invalid OAuth callback parameters");
			}
			const code = callback.searchParams.get("code");
			if (!code || !equal(callback.searchParams.get("state") ?? "", attempt.state)) {
				throw new Error("OAuth callback validation failed");
			}
			try {
				await this.manager.finishAuth(name, code);
			} catch {
				throw new Error(`OAuth could not complete for MCP server ${name}`);
			}
			await attempt.provider.clearFlowMaterial().catch(() => undefined);
		})();
		return attempt.completing;
	}

	private page(response: ServerResponse, status: number, success: boolean): void {
		if (response.headersSent) return;
		response.writeHead(status, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8" });
		response.end(`<!doctype html><title>Pi MCP</title><h1>${success ? "Authentication complete" : "Authentication failed"}</h1>`);
	}

	private pageThenCleanup(name: string, response: ServerResponse, status: number, success: boolean): void {
		response.once("finish", () => {
			void this.cleanup(name).catch(() => undefined);
		});
		this.page(response, status, success);
	}

	private async closeServer(server: ReturnType<typeof createServer>): Promise<void> {
		if (!server.listening) return;
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		server.closeIdleConnections();
		server.closeAllConnections();
		await closed;
	}

	private async cleanup(name: string, fallback?: ReturnType<typeof createServer>): Promise<void> {
		const attempt = this.attempts.get(name);
		if (!attempt) {
			if (fallback) await this.closeServer(fallback);
			return;
		}
		this.attempts.delete(name);
		clearInterval(attempt.heartbeat);
		clearTimeout(attempt.timeout);
		attempt.secret = "";
		const cleanup = await Promise.allSettled([
			this.manager.cancelAuth(name),
			this.gateway.unregister(attempt.session),
			this.closeServer(attempt.server),
			attempt.provider.clearFlowMaterial(),
		]);
		const failures = cleanup.filter((result) => result.status === "rejected");
		if (failures.length) throw new AggregateError(failures.map((result) => (result as PromiseRejectedResult).reason), "OAuth cleanup failed");
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closed = true;
		this.closePromise = (async () => {
			await Promise.allSettled([...this.starts.values()]);
			const cleanup = await Promise.allSettled([...this.attempts.keys()].map((name) => this.cleanup(name)));
			const failures = cleanup.filter((result) => result.status === "rejected");
			if (failures.length) throw new AggregateError(failures.map((result) => (result as PromiseRejectedResult).reason), "OAuth coordinator cleanup failed");
		})();
		return this.closePromise;
	}
}
