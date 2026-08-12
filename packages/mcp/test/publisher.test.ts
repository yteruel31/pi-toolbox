import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpAppController } from "../src/apps/controller.js";
import { AppPublisher, appHeartbeatInterval } from "../src/apps/publisher.js";
import { appStatusText } from "../src/apps/status.js";
import { DEFAULT_UI_SETTINGS } from "../src/config.js";
import { GatewayClient } from "../src/gateway/client.js";
import { startGatewayServer } from "../src/gateway/server.js";
import type { McpServerManager } from "../src/mcp/manager.js";
import { McpRuntime } from "../src/runtime.js";

const app = (id = "abcdefghijklmnopqrstuvwx", label = "Example") => ({
	id,
	label,
	route: `apps/${id}/`,
	server: "example-server",
	state: "active" as const,
});
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function freePort(): Promise<number> {
	const server = createServer();
	await listen(server);
	const port = (server.address() as { port: number }).port;
	await stop(server);
	return port;
}

async function listen(server: Server): Promise<void> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function stop(server: Server): Promise<void> {
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

function localUrl(port: number, externalUrl: string, suffix = ""): string {
	return `http://127.0.0.1:${port}${new URL(externalUrl).pathname}${suffix}`;
}

const identity = { "tailscale-user-login": "tester@example.com" };

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	throw new Error("Timed out waiting for publisher state");
}

test("publisher verifies route, owns one lease, updates and unregisters", async () => {
	const calls: string[] = [];
	const statuses: Array<string | undefined> = [];
	const session = { sessionId: "s", capability: "c", leaseSecret: "l", externalUrl: "https://tail.test:8443/mcp-ui/s/c/" };
	const publisher = new AppPublisher({
		settings: { ...DEFAULT_UI_SETTINGS },
		heartbeatMs: 100_000,
		exposure: { verify: async () => { calls.push("verify"); } },
		gateway: {
			register: async (value) => { calls.push(`register:${value.label}`); return session; },
			update: async (_session, label) => { calls.push(`update:${label}`); return session; },
			heartbeat: async () => session,
			unregister: async () => { calls.push("unregister"); },
		},
		backend: () => ({ origin: "http://127.0.0.1:1234", secret: "never-visible" }),
		onStatus: (status) => statuses.push(status?.url),
	});
	assert.equal((await publisher.reconcile([app()])).state, "available");
	assert.equal((await publisher.reconcile([app()])).state, "available");
	assert.equal((await publisher.reconcile([app(), app("zyxwvutsrqponmlkjihgfedc", "Second")])).count, 2);
	await publisher.reconcile([]);
	await publisher.close();
	assert.equal(calls.filter((call) => call.startsWith("register:")).length, 1);
	assert.deepEqual(calls.map((call) => call.split(":")[0]), ["verify", "register", "update", "unregister"]);
	assert.ok(statuses.includes(session.externalUrl));
	assert.equal(statuses.at(-1), undefined);
});

test("publisher refuses unsafe routes, retries registration, and recovers a failed heartbeat", async () => {
	let route: "absent" | "matching" = "absent";
	let registrations = 0;
	let heartbeats = 0;
	let unregisters = 0;
	const session = { sessionId: "s", capability: "c", leaseSecret: "l", externalUrl: "https://tail.test/mcp-ui/s/c/" };
	const publisher = new AppPublisher({
		settings: { ...DEFAULT_UI_SETTINGS },
		heartbeatMs: 10,
		tailscale: { status: async () => ({ state: route, target: "x" }) },
		gateway: {
			register: async () => { registrations++; return session; },
			update: async () => session,
			heartbeat: async () => {
				heartbeats++;
				if (heartbeats === 1) throw new Error("transient");
				return session;
			},
			unregister: async () => { unregisters++; },
		},
		backend: () => ({ origin: "http://127.0.0.1:1", secret: "secret" }),
	});
	assert.equal((await publisher.reconcile([app()])).state, "unavailable");
	assert.equal(registrations, 0);
	route = "matching";
	assert.equal((await publisher.reconcile([app()])).state, "available");
	await waitUntil(() => registrations >= 2 && heartbeats >= 2);
	assert.ok(unregisters >= 1);
	assert.equal((await publisher.reconcile([app()])).state, "available");
	await publisher.close();
});

test("hung route and heartbeat operations are bounded without retry queue growth", async () => {
	let statusCalls = 0;
	const never = new Promise<never>(() => undefined);
	const routePublisher = new AppPublisher({
		settings: { ...DEFAULT_UI_SETTINGS },
		heartbeatMs: 1,
		operationTimeoutMs: 20,
		tailscale: { status: async () => { statusCalls++; return never; } },
		gateway: {
			register: async () => { throw new Error("unreachable"); },
			update: async () => { throw new Error("unreachable"); },
			heartbeat: async () => { throw new Error("unreachable"); },
			unregister: async () => undefined,
		},
		backend: () => ({ origin: "http://127.0.0.1:1", secret: "secret" }),
	});
	assert.equal((await routePublisher.reconcile([app()])).state, "unavailable");
	await sleep(5);
	const routeCloseStarted = Date.now();
	await routePublisher.close();
	assert.ok(Date.now() - routeCloseStarted < 100);
	assert.ok(statusCalls <= 2, `single-shot retry must not queue status calls: ${statusCalls}`);

	let heartbeatCalls = 0;
	const session = { sessionId: "s", capability: "c", leaseSecret: "l", externalUrl: "https://tail.test/mcp-ui/s/c/" };
	const heartbeatPublisher = new AppPublisher({
		settings: { ...DEFAULT_UI_SETTINGS },
		heartbeatMs: 1,
		operationTimeoutMs: 20,
		tailscale: { status: async () => ({ state: "matching", target: "x" }) },
		gateway: {
			register: async () => session,
			update: async () => session,
			heartbeat: async () => { heartbeatCalls++; return never; },
			unregister: async () => undefined,
		},
		backend: () => ({ origin: "http://127.0.0.1:1", secret: "secret" }),
	});
	assert.equal((await heartbeatPublisher.reconcile([app()])).state, "available");
	await waitUntil(() => heartbeatCalls === 1);
	const heartbeatCloseStarted = Date.now();
	await heartbeatPublisher.close();
	assert.ok(Date.now() - heartbeatCloseStarted < 100);
	assert.equal(heartbeatCalls, 1);
});

test("close racing registration revokes the newly created capability", async () => {
	let release!: () => void;
	let started!: () => void;
	let unregisters = 0;
	const didStart = new Promise<void>((resolve) => { started = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const session = { sessionId: "s", capability: "c", leaseSecret: "l", externalUrl: "https://tail.test/mcp-ui/s/c/" };
	const publisher = new AppPublisher({
		settings: { ...DEFAULT_UI_SETTINGS },
		tailscale: { status: async () => ({ state: "matching", target: "x" }) },
		gateway: {
			register: async () => { started(); await gate; return session; },
			update: async () => session,
			heartbeat: async () => session,
			unregister: async () => { unregisters++; },
		},
		backend: () => ({ origin: "http://127.0.0.1:1", secret: "secret" }),
	});
	const opening = publisher.reconcile([app()]);
	await didStart;
	const closing = publisher.close();
	release();
	assert.equal((await opening).state, "unavailable");
	await closing;
	assert.equal(unregisters, 1);
});

test("runtime close attempts every cleanup before surfacing failures", async () => {
	const calls: string[] = [];
	const manager = { close: async () => { calls.push("manager"); throw new Error("manager failed"); } } as unknown as McpServerManager;
	const coordinator = { close: async () => { calls.push("coordinator"); } };
	const apps = { close: async () => { calls.push("apps"); throw new Error("apps failed"); } };
	const publisher = { close: async () => { calls.push("publisher"); } };
	const runtime = new McpRuntime(
		{ mcpServers: {}, settings: { ui: { ...DEFAULT_UI_SETTINGS } }, diagnostics: [] } as never,
		manager,
		coordinator as never,
		apps as never,
		{ publisher: publisher as never },
	);
	await assert.rejects(runtime.close(), /cleanup failed/);
	assert.deepEqual(new Set(calls), new Set(["apps", "publisher", "coordinator", "manager"]));
});

test("status text emits safe OSC 8 and plain fallbacks", () => {
	assert.equal(appHeartbeatInterval({ ...DEFAULT_UI_SETTINGS, idleTimeoutMs: 15_000 }), 5_000);
	assert.ok(appHeartbeatInterval({ ...DEFAULT_UI_SETTINGS, idleTimeoutMs: 15_000 }) < 15_000);
	const status = { state: "available" as const, count: 2, url: "https://tail.test/apps" };
	assert.match(appStatusText(status, true)!, /^\x1b]8;;https:\/\/tail\.test\/apps/);
	assert.equal(appStatusText(status, false), "MCP UI ↗ 2 https://tail.test/apps");
	assert.equal(appStatusText({ state: "available", count: 1, url: "javascript:bad" }, true), undefined);
	assert.equal(appStatusText({ state: "available", count: 0, url: status.url }, true), undefined);
});

test("route refusal preserves the normal runtime tool result without gateway registration", async () => {
	const metadata: Tool = {
		name: "forecast",
		inputSchema: { type: "object" },
		_meta: { ui: { resourceUri: "ui://forecast/app" } },
	};
	const server = { name: "real", state: "connected" as const, tools: [metadata] };
	const manager = {
		status: () => [server],
		get: () => server,
		connect: async () => server,
		modelTools: () => [metadata],
		modelTool: () => metadata,
		callFromModel: async () => ({ content: [{ type: "text", text: "forecast remains visible" }] }),
		readResource: async () => ({ contents: [{ uri: "ui://forecast/app", mimeType: "text/html", text: "<h1>App</h1>" }] }),
		close: async () => undefined,
	} as unknown as McpServerManager;
	const apps = new McpAppController(manager);
	let registrations = 0;
	const publisher = new AppPublisher({
		settings: { ...DEFAULT_UI_SETTINGS },
		tailscale: { status: async () => ({ state: "conflicting", target: "other" }) },
		gateway: {
			register: async () => { registrations++; throw new Error("must not register"); },
			update: async () => { throw new Error("must not update"); },
			heartbeat: async () => { throw new Error("must not heartbeat"); },
			unregister: async () => undefined,
		},
		backend: () => apps.backend(),
		heartbeatMs: 100_000,
	});
	const runtime = new McpRuntime(
		{ mcpServers: {}, settings: { ui: {} }, diagnostics: [] } as never,
		manager,
		undefined,
		apps,
		{ publisher },
	);
	try {
		const output = await runtime.execute({ server: "real", tool: "forecast" });
		assert.match(JSON.stringify(output.content), /forecast remains visible/);
		assert.deepEqual(output.details.ui, { state: "unavailable" });
		assert.doesNotMatch(JSON.stringify(output), /ui:\/\/|127\.0\.0\.1|secret/);
		assert.equal(registrations, 0);
	} finally {
		await runtime.close();
	}
});

test("real controller publishes a private dashboard and complete App proxy through the gateway", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-publisher-"));
	const settings = {
		...DEFAULT_UI_SETTINGS,
		gatewayPort: await freePort(),
		idleTimeoutMs: 10_000,
	};
	const gatewayClient = new GatewayClient({ settings, hostnameResolver: async () => "tail.test", homeDir: home });
	const gateway = await startGatewayServer({ settings, hostname: "tail.test", socketPath: gatewayClient.socket });
	const calls: Array<{ server: string; tool: string }> = [];
	const manager = {
		readResource: async (_server: string, uri: string) => ({
			contents: [{
				uri,
				mimeType: "text/html;profile=mcp-app",
				text: "<!doctype html><h1>Remote App</h1>",
				_meta: { ui: { csp: { connectDomains: ["https://api.example"] } } },
			}],
		}),
		callFromApp: async (server: string, tool: string) => {
			calls.push({ server, tool });
			return { content: [{ type: "text", text: "called" }] };
		},
	} as unknown as McpServerManager;
	let publisher: AppPublisher | undefined;
	const apps = new McpAppController(manager, {
		onChange: (current) => { void publisher?.reconcile(current); },
	});
	const statuses: Array<string | undefined> = [];
	publisher = new AppPublisher({
		settings,
		gateway: gatewayClient,
		tailscale: { status: async () => ({ state: "matching", target: `http://127.0.0.1:${settings.gatewayPort}` }) },
		backend: () => apps.backend(),
		onStatus: (status) => statuses.push(status?.url),
		heartbeatMs: 100_000,
	});
	const tool = (name: string): Tool => ({
		name,
		title: `<${name}>`,
		inputSchema: { type: "object" },
		_meta: { ui: { resourceUri: `ui://${name}/app` } },
	});
	const result: CallToolResult = { content: [{ type: "text", text: "result" }] };
	try {
		const first = (await apps.open("one", tool("first"), { city: "Paris" }, result))!;
		const second = (await apps.open("two", tool("second"), { city: "Oslo" }, result))!;
		const publication = await publisher.reconcile(apps.list());
		assert.equal(publication.state, "available");
		assert.equal(publication.count, 2);
		assert.ok(publication.url);
		assert.equal(gateway.sessions.size, 1);

		const dashboard = await fetch(localUrl(settings.gatewayPort, publication.url!), { headers: identity });
		assert.equal(dashboard.status, 200);
		const dashboardHtml = await dashboard.text();
		assert.match(dashboardHtml, /Pi MCP Apps \(2\)/);
		assert.match(dashboardHtml, /&lt;first&gt;|&lt;second&gt;/);
		assert.doesNotMatch(dashboardHtml, /Paris|Oslo|result|127\.0\.0\.1/);

		const firstBase = localUrl(settings.gatewayPort, publication.url!, `proxy/${first.route}`);
		const host = await fetch(firstBase, { headers: identity });
		assert.equal(host.status, 200);
		assert.match(await host.text(), /sandbox=/);
		const view = await fetch(`${firstBase}view`, { headers: identity });
		assert.equal(await view.text(), "<!doctype html><h1>Remote App</h1>");
		assert.match(view.headers.get("content-security-policy") ?? "", /frame-ancestors 'self'/);
		assert.match(view.headers.get("content-security-policy") ?? "", /https:\/\/api\.example/);
		const bridge = await fetch(`${firstBase}bridge.js`, { headers: identity });
		assert.match(await bridge.text(), /AppBridge/);

		const events = await fetch(`${firstBase}events`, { headers: identity });
		assert.equal(events.status, 200);
		const reader = events.body!.getReader();
		const eventChunk = new TextDecoder().decode((await reader.read()).value);
		assert.match(eventChunk, /event: input|event: result/);
		await reader.cancel();

		const call = await fetch(`${firstBase}tool-call`, {
			method: "POST",
			headers: { ...identity, "content-type": "application/json" },
			body: JSON.stringify({ name: "lookup", arguments: {} }),
		});
		assert.equal(call.status, 200);
		assert.deepEqual(calls, [{ server: "one", tool: "lookup" }]);

		assert.equal((await fetch(`${firstBase}complete`, {
			method: "POST", headers: { ...identity, "content-type": "application/json" }, body: "{}",
		})).status, 200);
		assert.equal((await publisher.reconcile(apps.list())).count, 1);
		const secondBase = localUrl(settings.gatewayPort, publication.url!, `proxy/${second.route}`);
		assert.equal((await fetch(`${secondBase}complete`, {
			method: "POST", headers: { ...identity, "content-type": "application/json" }, body: "{}",
		})).status, 200);
		await publisher.reconcile(apps.list());
		assert.equal(gateway.sessions.size, 0);
		assert.equal((await fetch(localUrl(settings.gatewayPort, publication.url!), { headers: identity })).status, 404);
		assert.equal(statuses.at(-1), undefined);
	} finally {
		await apps.close();
		await publisher.close();
		await gateway.close();
		await rm(home, { recursive: true, force: true });
	}
});
