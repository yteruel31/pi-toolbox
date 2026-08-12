import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { OAuthCoordinator } from "../src/auth/coordinator.js";
import { StoredOAuthProvider } from "../src/auth/provider.js";
import { OAuthStore } from "../src/auth/store.js";
import { DEFAULT_UI_SETTINGS } from "../src/config.js";
import { GatewayClient } from "../src/gateway/client.js";
import { startGatewayServer } from "../src/gateway/server.js";
import type { HttpServerConfig } from "../src/mcp/config.js";
import { McpServerManager } from "../src/mcp/manager.js";
import { McpRuntime } from "../src/runtime.js";

const temporaryDirectories: string[] = [];
async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}
afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
	return (server.address() as { port: number }).port;
}

async function stop(server: Server): Promise<void> {
	if (!server.listening) return;
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function freePort(): Promise<number> {
	const server = createServer();
	const port = await listen(server);
	await stop(server);
	return port;
}

async function body(request_: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request_) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString();
}

function json(response: import("node:http").ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
	response.end(JSON.stringify(value));
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const outgoing = request({ host: "127.0.0.1", port, path, headers }, (response) => {
			let responseBody = "";
			response.on("data", (chunk) => responseBody += chunk);
			response.on("end", () => resolve({ status: response.statusCode!, body: responseBody, headers: response.headers }));
		});
		outgoing.on("error", reject);
		outgoing.end();
	});
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for condition");
}

async function oauthMcpFixture() {
	const marker = "OAUTH_MARKER_SECRET";
	let origin = "";
	let registeredRedirect = "";
	let expectedChallenge = "";
	let acceptedAccess = new Set<string>(["access-1", "access-2"]);
	let registrations = 0;
	let authorizationExchanges = 0;
	let refreshes = 0;
	let lastVerifier = "";
	const mcpInstances: McpServer[] = [];
	let current: { transport: StreamableHTTPServerTransport; mcp: McpServer };

	const createMcp = async () => {
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
		const mcp = new McpServer({ name: "oauth-fixture", version: "1.0.0" });
		mcp.registerTool("protected_echo", {}, async () => ({ content: [{ type: "text", text: "authorized" }] }));
		await mcp.connect(transport);
		mcpInstances.push(mcp);
		return { transport, mcp };
	};
	current = await createMcp();

	const http = createServer(async (request_, response) => {
		const url = new URL(request_.url ?? "/", origin);
		if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
			json(response, 200, { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["openid"] });
			return;
		}
		if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
			json(response, 200, {
				issuer: origin,
				authorization_endpoint: `${origin}/authorize`,
				token_endpoint: `${origin}/token`,
				registration_endpoint: `${origin}/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
				scopes_supported: ["openid"],
			});
			return;
		}
		if (url.pathname === "/register" && request_.method === "POST") {
			registrations++;
			const metadata = JSON.parse(await body(request_));
			registeredRedirect = metadata.redirect_uris?.[0] ?? "";
			json(response, 201, { ...metadata, client_id: `client-${registrations}`, client_id_issued_at: Math.floor(Date.now() / 1_000) });
			return;
		}
		if (url.pathname === "/token" && request_.method === "POST") {
			const params = new URLSearchParams(await body(request_));
			if (params.get("grant_type") === "authorization_code") {
				authorizationExchanges++;
				lastVerifier = params.get("code_verifier") ?? "";
				const challenge = createHash("sha256").update(lastVerifier).digest("base64url");
				if (params.get("code") !== "valid-code" || params.get("redirect_uri") !== registeredRedirect || challenge !== expectedChallenge) {
					json(response, 400, { error: "invalid_grant", error_description: marker });
					return;
				}
				json(response, 200, { access_token: "access-1", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 });
				return;
			}
			if (params.get("grant_type") === "refresh_token" && params.get("refresh_token") === "refresh-1") {
				refreshes++;
				json(response, 200, { access_token: "access-2", token_type: "Bearer", refresh_token: "refresh-1", expires_in: 3600 });
				return;
			}
			json(response, 400, { error: "invalid_grant", error_description: marker });
			return;
		}
		if (url.pathname === "/mcp") {
			const token = request_.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
			if (!acceptedAccess.has(token)) {
				response.writeHead(401, {
					"content-type": "application/json",
					"www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", error_description="${marker}"`,
				});
				response.end(JSON.stringify({ error: marker }));
				return;
			}
			if (!request_.headers["mcp-session-id"] && current.transport.sessionId !== undefined) current = await createMcp();
			await current.transport.handleRequest(request_, response);
			return;
		}
		response.writeHead(404).end();
	});
	const port = await listen(http);
	origin = `http://127.0.0.1:${port}`;
	return {
		marker,
		origin,
		port,
		http,
		setChallenge(value: string) { expectedChallenge = value; },
		rejectFirstAccess() { acceptedAccess = new Set(["access-2"]); },
		registrations: () => registrations,
		authorizationExchanges: () => authorizationExchanges,
		refreshes: () => refreshes,
		lastVerifier: () => lastVerifier,
		registeredRedirect: () => registeredRedirect,
		close: async () => {
			await Promise.allSettled(mcpInstances.map((instance) => instance.close()));
			await stop(http);
		},
	};
}

test("OAuth DCR/PKCE completes through the real gateway and stored tokens reconnect and refresh", async () => {
	const fixture = await oauthMcpFixture();
	const home = await temporaryDirectory("pi-oauth-integration-");
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 10_000 };
	const gateway = new GatewayClient({ settings, hostnameResolver: async () => "node.ts.net", homeDir: home });
	const gatewayServer = await startGatewayServer({ settings, hostname: "node.ts.net", socketPath: gateway.socket, pidPath: gateway.pid });
	const store = new OAuthStore(home);
	const serverConfig: HttpServerConfig = { name: "protected", url: new URL(`${fixture.origin}/mcp`), headers: {} };
	const servers = new Map([[serverConfig.name, serverConfig]]);
	const manager = new McpServerManager(servers.values(), () => StoredOAuthProvider.passive(serverConfig.url.href, store));
	const tailscale = { async status() { return { state: "matching" as const, target: `http://127.0.0.1:${settings.gatewayPort}` }; } };
	const coordinator = new OAuthCoordinator(manager, servers, settings, gateway, tailscale, store, { heartbeatMs: 50, timeoutMs: 5_000 });
	const runtime = new McpRuntime({ mcpServers: {}, settings: { ui: settings }, diagnostics: [] } as never, manager, coordinator);
	try {
		const [first, second] = await Promise.all([
			runtime.execute({ action: "auth-start", server: "protected" }),
			runtime.execute({ action: "auth-start", server: "protected" }),
		]);
		assert.equal(first.details.authorizationUrl, second.details.authorizationUrl);
		assert.equal(fixture.registrations(), 1);
		assert.doesNotMatch(JSON.stringify(first), new RegExp(fixture.marker));
		const authorization = new URL(String(first.details.authorizationUrl));
		const redirect = new URL(authorization.searchParams.get("redirect_uri")!);
		assert.equal(redirect.href, fixture.registeredRedirect());
		fixture.setChallenge(authorization.searchParams.get("code_challenge")!);
		const state = authorization.searchParams.get("state")!;
		assert.match(state, /^[A-Za-z0-9_-]{24}$/);

		const storedAttempt = [...gatewayServer.sessions.values()][0] as unknown as { backendOrigin: string };
		const directCallback = new URL(storedAttempt.backendOrigin);
		assert.equal((await get(Number(directCallback.port), "/oauth/callback?code=valid-code&state=" + encodeURIComponent(state))).status, 404);

		const callback = await get(settings.gatewayPort, `${redirect.pathname}?code=valid-code&state=${encodeURIComponent(state)}`, { "tailscale-user-login": "tester@example.com" });
		assert.equal(callback.status, 200);
		assert.match(callback.body, /Authentication complete/);
		assert.equal(callback.headers["cache-control"], "no-store");
		assert.equal(callback.headers["referrer-policy"], "no-referrer");
		await waitUntil(() => gatewayServer.sessions.size === 0);
		assert.equal(fixture.authorizationExchanges(), 1);
		assert.ok(fixture.lastVerifier());
		const authorizedRecord = await store.read(serverConfig.url.href);
		assert.equal(authorizedRecord?.state, undefined);
		assert.equal(authorizedRecord?.verifier, undefined);
		assert.equal(manager.get("protected")?.state, "connected");
		assert.match(JSON.stringify(await runtime.execute({ server: "protected", tool: "protected_echo" })), /authorized/);

		await coordinator.close();
		await manager.close();
		const registrationsBeforeReconnect = fixture.registrations();
		const fresh = new McpServerManager(servers.values(), () => StoredOAuthProvider.passive(serverConfig.url.href, store));
		try {
			await fresh.connect("protected");
			assert.equal(fixture.registrations(), registrationsBeforeReconnect);
			fixture.rejectFirstAccess();
			await fresh.connect("protected", true);
			assert.equal(fixture.refreshes(), 1);
			assert.equal((await store.read(serverConfig.url.href))?.tokens?.access_token, "access-2");
		} finally {
			await fresh.close();
		}
	} finally {
		await coordinator.close();
		await manager.close();
		await gatewayServer.close();
		await fixture.close();
		await rm(home, { recursive: true, force: true });
	}
});

interface FakeAuthHarness {
	coordinator: OAuthCoordinator;
	redirect: string;
	state: string;
	finished: string[];
	unregistered: number;
}

async function fakeAuthHarness(
	routeState: "matching" | "absent" | "conflicting" = "matching",
	options: { heartbeatMs?: number; timeoutMs?: number; finishError?: Error; cancelError?: Error } = {},
): Promise<FakeAuthHarness> {
	const settings = { ...DEFAULT_UI_SETTINGS };
	const serverConfig: HttpServerConfig = { name: "server", url: new URL("https://server.invalid/mcp"), headers: {} };
	const servers = new Map([[serverConfig.name, serverConfig]]);
	const finished: string[] = [];
	let unregistered = 0;
	let state = "";
	const manager = {
		async beginAuth(_name: string, provider: OAuthClientProvider) {
			state = await provider.state!();
			await provider.redirectToAuthorization(new URL(`https://auth.invalid/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(String(provider.redirectUrl))}`));
		},
		async finishAuth(_name: string, code: string) {
			if (options.finishError) throw options.finishError;
			finished.push(code);
			return {} as never;
		},
		async cancelAuth() { if (options.cancelError) throw options.cancelError; },
	} as unknown as McpServerManager;
	const gateway = {
		async register() {
			return { sessionId: "session", capability: "cap", leaseSecret: "lease", externalUrl: "https://node.ts.net:8443/mcp-ui/s/cap/" };
		},
		async heartbeat() {},
		async unregister() { unregistered++; },
	};
	const exposure = { async verify() { if (routeState !== "matching") throw new Error("MCP gateway is not configured"); } };
	const store = new OAuthStore(await temporaryDirectory("pi-oauth-validation-"));
	const coordinator = new OAuthCoordinator(manager, servers, settings, gateway, exposure, store, { timeoutMs: 5_000, ...options });
	const started = routeState === "matching" ? await coordinator.begin("server") : undefined;
	return {
		coordinator,
		redirect: started ? new URL(started.authorizationUrl).searchParams.get("redirect_uri")! : "",
		state,
		finished,
		get unregistered() { return unregistered; },
	};
}

test("manual OAuth completion validates the exact callback and rejects malformed variants", async () => {
	const valid = await fakeAuthHarness();
	await valid.coordinator.complete("server", `${valid.redirect}?code=ok&state=${encodeURIComponent(valid.state)}`);
	assert.deepEqual(valid.finished, ["ok"]);
	assert.equal(valid.unregistered, 1);
	await valid.coordinator.close();

	for (const callback of [
		(redirect: string, state: string) => `${redirect}?state=${state}`,
		(redirect: string, state: string) => `${redirect}?code=one&code=two&state=${state}`,
		(redirect: string) => `${redirect}?code=one&state=wrong`,
		(redirect: string, state: string) => `${redirect}?code=one&state=${state}&error=MARKER`,
		(redirect: string, state: string) => `${redirect}?code=one&state=${state}#fragment`,
		(redirect: string, state: string) => redirect.replace("https://", "https://user@") + `?code=one&state=${state}`,
	]) {
		const harness = await fakeAuthHarness();
		await assert.rejects(harness.coordinator.complete("server", callback(harness.redirect, harness.state)), /Invalid|validation/);
		assert.deepEqual(harness.finished, []);
		assert.equal(harness.unregistered, 1);
		await harness.coordinator.close();
	}
});

test("OAuth completion redacts lower-level token exchange errors", async () => {
	const marker = "TOKEN_ENDPOINT_MARKER_SECRET";
	const harness = await fakeAuthHarness("matching", { finishError: new Error(marker) });
	await assert.rejects(
		harness.coordinator.complete("server", `${harness.redirect}?code=ok&state=${encodeURIComponent(harness.state)}`),
		(error: Error) => {
			assert.match(error.message, /could not complete/);
			assert.doesNotMatch(error.message, new RegExp(marker));
			return true;
		},
	);
	assert.equal(harness.unregistered, 1);
	await harness.coordinator.close();
});

test("OAuth coordinator shutdown cleans an active attempt and is terminal", async () => {
	const harness = await fakeAuthHarness();
	await harness.coordinator.close();
	await harness.coordinator.close();
	assert.equal(harness.unregistered, 1);
	await assert.rejects(harness.coordinator.begin("server"), /closed/);
});

test("OAuth shutdown still unregisters its callback lease when manager cancellation fails", async () => {
	const harness = await fakeAuthHarness("matching", { cancelError: new Error("CANCEL_SECRET") });
	await assert.rejects(harness.coordinator.close(), /cleanup failed/);
	assert.equal(harness.unregistered, 1);
});

test("OAuth attempt timeout unregisters its callback lease", async () => {
	const harness = await fakeAuthHarness("matching", { timeoutMs: 20 });
	await waitUntil(() => harness.unregistered === 1);
	await assert.rejects(harness.coordinator.complete("server", `${harness.redirect}?code=ok&state=${harness.state}`), /No active/);
	await harness.coordinator.close();
});

test("OAuth start refuses unverified gateway exposure without gateway registration", async () => {
	for (const routeState of ["absent", "conflicting"] as const) {
		const settings = { ...DEFAULT_UI_SETTINGS };
		const config: HttpServerConfig = { name: "server", url: new URL("https://server.invalid/mcp"), headers: {} };
		let registrations = 0;
		const gateway = { async register() { registrations++; throw new Error("must not register"); }, async heartbeat() {}, async unregister() {} };
		const exposure = { async verify() { throw new Error("MCP gateway is not configured"); } };
		const coordinator = new OAuthCoordinator({} as McpServerManager, new Map([["server", config]]), settings, gateway, exposure, new OAuthStore(await temporaryDirectory("pi-oauth-route-")));
		await assert.rejects(coordinator.begin("server"), /not configured/);
		assert.equal(registrations, 0);
		await coordinator.close();
	}
});
