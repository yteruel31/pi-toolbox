import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { McpServer, ResourceTemplate as McpResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServerManager } from "../src/mcp/manager.js";
import { McpRuntime } from "../src/runtime.js";

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as { port: number }).port;
}
async function stop(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
function config(port: number, name = "real") {
	return {
		mcpServers: { [name]: { url: `http://127.0.0.1:${port}/mcp` } },
		settings: { ui: {} }, diagnostics: [],
	} as never;
}

async function protocolServer(delayMs = 0, omitResourceTemplates = false) {
	let cancelled = false;
	let unauthorized = false;
	let resolveSlowStarted!: () => void;
	const slowStarted = new Promise<void>((resolve) => resolveSlowStarted = resolve);
	let current: { transport: StreamableHTTPServerTransport; mcp: McpServer };
	const instances: McpServer[] = [];
	const createInstance = async () => {
		const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
		const mcp = new McpServer(
			{ name: "integration", version: "1.0.0" },
			{ instructions: "integration instructions" },
		);
		mcp.registerTool("mixed", { description: "mixed output" }, async () => ({
			content: [
				{ type: "text", text: "hello" },
				{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
			],
			structuredContent: { answer: 42 },
		}));
		mcp.registerTool("failure", {}, async () => ({
			isError: true,
			content: [{ type: "text", text: "bad" }],
		}));
		mcp.registerTool("budget", { _meta: { tokenizedUrl: "https://secret.invalid/?token=MARKER" } }, async () => ({
			content: [
				{ type: "text", text: "é\u0000\"\\\n".repeat(12_000), _meta: { Authorization: "MARKER" } },
				{ type: "image", data: "A".repeat(30_000), mimeType: "image/png" },
			],
			structuredContent: { extra: "B".repeat(30_000) },
		}));
		mcp.registerResource("guide", "test://guide", { description: "safe guide", mimeType: "text/plain" }, async (uri) => ({
			contents: [{ uri: uri.href, text: "resource-text" }],
		}));
		mcp.registerResource("large", "test://large", {}, async (uri) => ({
			contents: [{ uri: uri.href, text: "é".repeat(60_000) }],
		}));
		mcp.registerResource("hidden", "https://resource.invalid/item?token=RESOURCE_MARKER", {}, async (uri) => ({
			contents: [{ uri: uri.href, text: "hidden" }],
		}));
		mcp.registerResource("entry", new McpResourceTemplate("test://entries/{id}", { list: undefined }), { description: "entry template" }, async (uri) => ({
			contents: [{ uri: uri.href, text: "template-text" }],
		}));
		mcp.registerPrompt("welcome", { description: "welcome prompt" }, async () => ({
			messages: [{ role: "user", content: { type: "text", text: "prompt-text" } }],
		}));
		mcp.registerTool("client-features", {}, async () => {
			const sampled = await mcp.server.createMessage({
				messages: [{ role: "user", content: { type: "text", text: "sample this" } }],
				maxTokens: 32,
			});
			const elicited = await mcp.server.elicitInput({
				mode: "form",
				message: "Your name",
				requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
			});
			return { content: [{ type: "text", text: JSON.stringify({ sampled, elicited }) }] };
		});
		mcp.registerTool("client-url-capability", {}, async () => {
			try {
				await mcp.server.elicitInput({ mode: "url", message: "Open", url: "https://example.test", elicitationId: "url-1" });
				return { content: [{ type: "text", text: "unexpected-url-support" }] };
			} catch {
				return { content: [{ type: "text", text: "url-not-advertised" }] };
			}
		});
		mcp.registerTool("slow", {}, async (extra) => new Promise((resolve) => {
			resolveSlowStarted();
			extra.signal.addEventListener("abort", () => {
				cancelled = true;
				resolve({ content: [{ type: "text", text: "cancelled" }] });
			}, { once: true });
		}));
		if (omitResourceTemplates) mcp.server.removeRequestHandler("resources/templates/list");
		await mcp.connect(transport);
		instances.push(mcp);
		return { transport, mcp };
	};
	current = await createInstance();
	const http = createServer(async (request, response) => {
		if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
		if (unauthorized) {
			response.writeHead(401, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: "RESOURCE_AUTH_MARKER" }));
			return;
		}
		if (!request.headers["mcp-session-id"] && current.transport.sessionId !== undefined) {
			void createInstance().then((instance) => {
				current = instance;
				return current.transport.handleRequest(request, response);
			});
			return;
		}
		void current.transport.handleRequest(request, response);
	});
	const port = await listen(http);
	return {
		http,
		port,
		cancelled: () => cancelled,
		setUnauthorized: (value: boolean) => { unauthorized = value; },
		disconnectCurrent: async () => { await current.mcp.close(); },
		addDynamicTool: async (name: string) => {
			current.mcp.registerTool(name, {}, async () => ({ content: [{ type: "text", text: `dynamic-${name}` }] }));
			await current.mcp.server.sendToolListChanged();
		},
		notifyResourceListChanged: () => current.mcp.server.sendResourceListChanged(),
		waitForSlowStart: () => slowStarted,
		close: async () => Promise.all(instances.map((instance) => instance.close())).then(() => undefined),
	};
}

test("status and OAuth validation perform no MCP network requests", async () => {
	const fixture = await protocolServer();
	let requests = 0;
	fixture.http.on("request", () => { requests++; });
	const runtime = new McpRuntime(config(fixture.port));
	try {
		const status = await runtime.execute({});
		assert.match(JSON.stringify(status), /disconnected/);
		await assert.rejects(runtime.execute({ action: "auth-start" }), /require server/);
		assert.equal(requests, 0);
	} finally {
		await runtime.manager.close();
		await fixture.close();
		await stop(fixture.http);
	}
});

test("real stdio initializes, lists, calls, and terminates children on refresh and close", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-mcp-stdio-"));
	const fixture = new URL("./fixtures/stdio-server.mjs", import.meta.url).pathname;
	const firstPid = join(directory, "first.pid"); const firstExit = join(directory, "first.exit");
	const manager = new McpServerManager([{
		name: "local",
		transport: "stdio",
		command: process.execPath,
		args: [fixture, firstPid, firstExit],
		env: { PI_MCP_TEST: "configured" },
	}]);
	try {
		assert.equal((await manager.connect("local")).state, "connected");
		assert.equal(manager.tool("local", "echo")?.name, "echo");
		assert.match(JSON.stringify(await manager.callFromModel("local", "echo", {})), /stdio-ok:configured:has-path/);
		const initialPid = Number(readFileSync(firstPid, "utf8"));
		assert.ok(initialPid > 0);
		await manager.connect("local", true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.throws(() => process.kill(initialPid, 0));
		const secondPid = Number(readFileSync(firstPid, "utf8"));
		await manager.close();
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.throws(() => process.kill(secondPid, 0));
	} finally {
		await manager.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

async function legacySseServer() {
	const sessions = new Map<string, { transport: SSEServerTransport; mcp: McpServer }>();
	let modernAttempts = 0;
	let streamStarts = 0;
	let configuredHeaderRequests = 0;
	const http = createServer(async (request, response) => {
		if (request.headers["x-test"] === "configured") configuredHeaderRequests++;
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (request.method === "POST" && url.pathname === "/mcp") {
			modernAttempts++;
			response.writeHead(405).end();
			return;
		}
		if (request.method === "GET" && url.pathname === "/mcp") {
			streamStarts++;
			const transport = new SSEServerTransport("/messages", response);
			const mcp = new McpServer({ name: "legacy-sse", version: "1.0.0" });
			mcp.registerTool("legacy", {}, async () => ({ content: [{ type: "text", text: "sse-ok" }] }));
			sessions.set(transport.sessionId, { transport, mcp });
			transport.onclose = () => { sessions.delete(transport.sessionId); };
			await mcp.connect(transport);
			return;
		}
		if (request.method === "POST" && url.pathname === "/messages") {
			const session = sessions.get(url.searchParams.get("sessionId") ?? "");
			if (!session) { response.writeHead(404).end(); return; }
			await session.transport.handlePostMessage(request, response);
			return;
		}
		response.writeHead(404).end();
	});
	const port = await listen(http);
	return {
		http,
		port,
		modernAttempts: () => modernAttempts,
		streamStarts: () => streamStarts,
		configuredHeaderRequests: () => configuredHeaderRequests,
		activeSessions: () => sessions.size,
		disconnectAll: async () => { await Promise.allSettled([...sessions.values()].map(({ mcp }) => mcp.close())); },
		close: async () => {
			await Promise.allSettled([...sessions.values()].map(({ mcp }) => mcp.close()));
			await stop(http);
		},
	};
}

test("real legacy SSE initializes, lists, calls, closes, and auto-falls back only from unsupported HTTP", async () => {
	const fixture = await legacySseServer();
	const explicit = new McpServerManager([{
		name: "legacy", transport: "sse", url: new URL(`http://127.0.0.1:${fixture.port}/mcp`), headers: { "x-test": "configured" },
	}]);
	const automatic = new McpServerManager([{
		name: "auto", transport: "auto", url: new URL(`http://127.0.0.1:${fixture.port}/mcp`), headers: { "x-test": "configured" },
	}]);
	try {
		assert.equal((await explicit.connect("legacy")).state, "connected");
		assert.match(JSON.stringify(await explicit.callFromModel("legacy", "legacy", {})), /sse-ok/);
		assert.equal(fixture.modernAttempts(), 0);
		await explicit.close();

		assert.equal((await automatic.connect("auto")).state, "connected");
		assert.match(JSON.stringify(await automatic.callFromModel("auto", "legacy", {})), /sse-ok/);
		assert.equal(fixture.modernAttempts(), 1);
		assert.equal(fixture.streamStarts(), 2);
		assert.ok(fixture.configuredHeaderRequests() >= 5);
	} finally {
		await Promise.all([explicit.close(), automatic.close()]);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(fixture.activeSessions(), 0);
		await fixture.close();
	}
});

test("real Streamable HTTP initializes, lists, calls all result forms, refreshes, and closes", async () => {
	const fixture = await protocolServer();
	const runtime = new McpRuntime(config(fixture.port));
	try {
		const connected = await runtime.execute({ connect: "real" });
		assert.match(JSON.stringify(connected), /integration instructions/);
		assert.match(JSON.stringify(connected), /real_mixed/);
		const mixed = await runtime.execute({ tool: "real_mixed" });
		assert.match(JSON.stringify(mixed.content), /hello/);
		assert.match(JSON.stringify(mixed.content), /image\/png/);
		assert.match(JSON.stringify(mixed.content), /answer/);
		const resources = await runtime.execute({ action: "resources-list", server: "real" });
		assert.match(JSON.stringify(resources), /guide.*test:\/\/guide/);
		assert.match(JSON.stringify(resources), /entry.*test:\/\/entries\/\{id\}/);
		assert.match(JSON.stringify(resources), /hidden.*URI hidden/);
		assert.doesNotMatch(JSON.stringify(resources), /RESOURCE_MARKER/);
		const resource = await runtime.execute({ action: "resources-read", server: "real", args: { uri: "test:\/\/guide" } });
		assert.match(JSON.stringify(resource.content), /resource-text/);
		assert.doesNotMatch(JSON.stringify(resource.details), /resource-text|test:\/\/guide/);
		const largeResource = await runtime.execute({ action: "resources-read", server: "real", args: { uri: "test://large" } });
		assert.ok(Buffer.byteLength(JSON.stringify(largeResource)) <= 50 * 1024);
		assert.doesNotMatch(JSON.stringify(largeResource.content), /�/u);
		const prompts = await runtime.execute({ action: "prompts-list", server: "real" });
		assert.match(JSON.stringify(prompts), /welcome/);
		const prompt = await runtime.execute({ action: "prompts-get", server: "real", args: { name: "welcome", arguments: {} } });
		assert.match(JSON.stringify(prompt.content), /prompt-text/);
		assert.doesNotMatch(JSON.stringify(prompt.details), /prompt-text/);
		const failure = await runtime.execute({ server: "real", tool: "failure" });
		assert.equal(failure.details.isError, true);
		assert.match(JSON.stringify(failure.content), /reported an error/);
		const budget = await runtime.execute({ server: "real", tool: "budget" });
		const visibleBytes = Buffer.byteLength(JSON.stringify(budget));
		assert.ok(visibleBytes <= 50 * 1024);
		assert.doesNotMatch(JSON.stringify(budget), /MARKER|Authorization|tokenizedUrl/);
		assert.doesNotMatch(JSON.stringify(budget.content), /�/u);
		assert.match(JSON.stringify(budget.content), /image omitted/);
		assert.equal((await runtime.manager.connect("real", true)).state, "connected");
	} finally {
		await runtime.manager.close();
		assert.equal(runtime.manager.get("real")?.state, "disconnected");
		await runtime.manager.close();
		await fixture.close();
		await stop(fixture.http);
	}
});

test("resource servers without template listing remain connected during discovery and refresh", async () => {
	const fixture = await protocolServer(0, true);
	const manager = new McpServerManager([{
		name: "concrete-only", transport: "http", url: new URL(`http://127.0.0.1:${fixture.port}/mcp`), headers: {},
	}]);
	try {
		const connected = await manager.connect("concrete-only");
		assert.equal(connected.state, "connected");
		assert.ok(connected.resources.some((resource) => resource.uri === "test://guide"));
		assert.deepEqual(connected.resourceTemplates, []);

		await fixture.notifyResourceListChanged();
		await waitUntil(() => manager.diagnosticStatus("concrete-only")[0]?.counters.listRefreshes === 1);
		const refreshed = manager.get("concrete-only");
		assert.equal(refreshed?.state, "connected");
		assert.ok(refreshed?.resources.some((resource) => resource.uri === "test://guide"));
		assert.deepEqual(refreshed?.resourceTemplates, []);
		assert.equal(manager.diagnosticStatus("concrete-only")[0]?.counters.listRefreshFailures, 0);
	} finally {
		await manager.close();
		await fixture.close();
		await stop(fixture.http);
	}
});

test("real SDK advertises and completes sampling plus form-only elicitation handlers", async () => {
	const fixture = await protocolServer();
	const calls: string[] = [];
	const manager = new McpServerManager([{
		name: "features", transport: "http", url: new URL(`http://127.0.0.1:${fixture.port}/mcp`), headers: {},
	}], undefined, {
		sampling: async (server, params, signal) => {
			assert.equal(server, "features"); assert.equal(signal?.aborted, false); assert.equal(params.maxTokens, 32); calls.push("sampling");
			return { role: "assistant", content: { type: "text", text: "sample-response" }, model: "test/model", stopReason: "endTurn" };
		},
		elicitation: async (server, params, signal) => {
			assert.equal(server, "features"); assert.equal(signal?.aborted, false); assert.equal(params.mode, "form"); calls.push("elicitation");
			return { action: "accept", content: { name: "Ada" } };
		},
	});
	try {
		await manager.connect("features");
		const result = await manager.callFromModel("features", "client-features", {});
		assert.match(JSON.stringify(result), /sample-response.*Ada/);
		assert.deepEqual(calls, ["sampling", "elicitation"]);
		const url = await manager.callFromModel("features", "client-url-capability", {});
		assert.match(JSON.stringify(url), /url-not-advertised/);
		assert.doesNotMatch(JSON.stringify(url), /unexpected-url-support/);
	} finally {
		await manager.close();
		await fixture.close();
		await stop(fixture.http);
	}
});

test("stable aliases connect only their server and unqualified ambiguity is deterministic", async () => {
	const first = await protocolServer();
	const second = await protocolServer();
	let secondRequests = 0;
	second.http.on("request", () => { secondRequests++; });
	const runtime = new McpRuntime({
		mcpServers: {
			alpha: { url: `http://127.0.0.1:${first.port}/mcp` },
			beta: { url: `http://127.0.0.1:${second.port}/mcp` },
		},
		settings: { ui: {} }, diagnostics: [],
	} as never);
	try {
		await runtime.execute({ tool: "alpha_mixed" });
		assert.equal(secondRequests, 0);
		await assert.rejects(runtime.execute({ tool: "mixed" }), /Ambiguous MCP tool name/);
	} finally {
		await runtime.manager.close();
		await Promise.all([first.close(), second.close()]);
		await Promise.all([stop(first.http), stop(second.http)]);
	}
});

test("AbortSignal cancels a slow protocol tool call", async () => {
	const fixture = await protocolServer();
	const runtime = new McpRuntime(config(fixture.port));
	try {
		const controller = new AbortController();
		const pending = runtime.execute({ server: "real", tool: "slow" }, controller.signal);
		await fixture.waitForSlowStart();
		controller.abort();
		await assert.rejects(pending, /cancelled/);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(fixture.cancelled(), true);
	} finally {
		await runtime.manager.close();
		await fixture.close();
		await stop(fixture.http);
	}
});

test("401 errors are classified without SSE downgrade and marker secrets never escape", async () => {
	const marker = "MARKER-secret-token";
	let requests = 0;
	let getRequests = 0;
	const http = createServer((request, response) => {
		requests++;
		if (request.method === "GET") getRequests++;
		response.writeHead(401, {
			"content-type": "application/json",
			"www-authenticate": `Bearer resource_metadata=\"https://example.invalid/${marker}\"`,
		});
		response.end(JSON.stringify({ error: marker }));
	});
	const port = await listen(http);
	const manager = new McpServerManager([{
		name: "protected", url: new URL(`http://127.0.0.1:${port}/mcp`), headers: {},
	}]);
	try {
		await assert.rejects(manager.connect("protected"), (error: Error) => {
			assert.match(error.message, /Authentication required/);
			assert.doesNotMatch(JSON.stringify(error), new RegExp(marker));
			return true;
		});
		assert.equal(manager.get("protected")?.state, "auth-required");
		assert.equal(requests, 1);
		assert.equal(getRequests, 0);
	} finally {
		await manager.close();
		await stop(http);
	}
});

test("resource and prompt requests classify post-connect auth failures without leaking server bodies", async () => {
	for (const operation of ["resource", "prompt"] as const) {
		const fixture = await protocolServer();
		const manager = new McpServerManager([{
			name: "protected",
			transport: "http",
			url: new URL(`http://127.0.0.1:${fixture.port}/mcp`),
			headers: {},
		}]);
		try {
			await manager.connect("protected");
			fixture.setUnauthorized(true);
			const pending = operation === "resource"
				? manager.readResource("protected", "test://guide")
				: manager.getPrompt("protected", "welcome");
			await assert.rejects(pending, (error: Error) => {
				assert.match(error.message, /Authentication required/);
				assert.doesNotMatch(JSON.stringify(error), /RESOURCE_AUTH_MARKER/);
				return true;
			});
			assert.equal(manager.get("protected")?.state, "auth-required");
		} finally {
			await manager.close();
			await fixture.close();
			await stop(fixture.http);
		}
	}
});

test("discovery pagination stops on repeated cursors, enforces metadata caps, and observes cancellation", async () => {
	const manager = new McpServerManager([]);
	const paginate = (manager as unknown as {
		paginate<T>(request: (cursor?: string) => Promise<Record<string, unknown>>, key: string, signal?: AbortSignal): Promise<T[]>;
	}).paginate.bind(manager) as <T>(request: (cursor?: string) => Promise<Record<string, unknown>>, key: string, signal?: AbortSignal) => Promise<T[]>;
	let calls = 0;
	const repeated = await paginate<{ name: string }>(async () => ({
		tools: [{ name: `tool-${calls++}` }],
		nextCursor: "same",
	}), "tools");
	assert.equal(calls, 2);
	assert.equal(repeated.length, 2);

	const oversized = await paginate<{ name: string }>(async () => ({
		tools: Array.from({ length: 500 }, (_, index) => ({ name: `${index}-${"x".repeat(2_000)}` })),
	}), "tools");
	assert.ok(oversized.length < 500);
	assert.ok(Buffer.byteLength(JSON.stringify(oversized)) <= 512 * 1024);

	const controller = new AbortController();
	await assert.rejects(paginate(async () => {
		controller.abort();
		return { tools: [{ name: "first" }], nextCursor: "next" };
	}, "tools", controller.signal), /cancelled/);
	await manager.close();
});

test("unexpected close marks only the live connection disconnected and the next operation reconnects", async () => {
	const fixture = await legacySseServer();
	const manager = new McpServerManager([{
		name: "recover", transport: "sse", url: new URL(`http://127.0.0.1:${fixture.port}/mcp`), headers: {},
	}]);
	try {
		await manager.connect("recover");
		await fixture.disconnectAll();
		await waitUntil(() => manager.get("recover")?.state === "disconnected");
		const result = await manager.callFromModel("recover", "legacy", {});
		assert.match(JSON.stringify(result), /sse-ok/);
		assert.equal(manager.get("recover")?.state, "connected");
		assert.equal(manager.diagnosticStatus("recover")[0]?.counters.reconnects, 1);
	} finally {
		await manager.close();
		await fixture.close();
	}
});

test("list-change storms coalesce, preserve metadata on failure, and stop safely at shutdown", async () => {
	const fixture = await protocolServer();
	const manager = new McpServerManager([{
		name: "changed", transport: "http", url: new URL(`http://127.0.0.1:${fixture.port}/mcp`), headers: {},
	}]);
	try {
		await manager.connect("changed");
		await Promise.all([fixture.addDynamicTool("dynamic-one"), fixture.addDynamicTool("dynamic-two"), fixture.addDynamicTool("dynamic-three")]);
		await waitUntil(() => manager.modelTool("changed", "dynamic-three") !== undefined);
		const afterStorm = manager.diagnosticStatus("changed")[0]!;
		assert.ok(afterStorm.counters.listNotifications >= 1);
		assert.ok(afterStorm.counters.listRefreshes >= 1);
		assert.ok(afterStorm.counters.listRefreshes <= afterStorm.counters.listNotifications);

		fixture.setUnauthorized(true);
		await fixture.addDynamicTool("hidden-during-failure");
		await waitUntil(() => manager.diagnosticStatus("changed")[0]!.counters.listRefreshFailures >= 1);
		assert.ok(manager.modelTool("changed", "dynamic-one"), "last good metadata survives a refresh failure");
		assert.equal(manager.modelTool("changed", "hidden-during-failure"), undefined);
		fixture.setUnauthorized(false);
		await fixture.addDynamicTool("after-recovery");
		await waitUntil(() => manager.modelTool("changed", "after-recovery") !== undefined);
		await fixture.addDynamicTool("shutdown-race");
		await manager.close();
		assert.equal(manager.get("changed")?.state, "disconnected");
	} finally {
		await manager.close();
		await fixture.close();
		await stop(fixture.http);
	}
});

test("initial discovery observes its caller AbortSignal and cleans the partial connection", async () => {
	const fixture = await protocolServer(30);
	const manager = new McpServerManager([{
		name: "real", transport: "http", url: new URL(`http://127.0.0.1:${fixture.port}/mcp`), headers: {},
	}]);
	try {
		const controller = new AbortController();
		const opening = manager.connect("real", false, controller.signal);
		setTimeout(() => controller.abort(), 10);
		await assert.rejects(opening, /connection cancelled/);
		assert.equal(manager.get("real")?.state, "disconnected");
	} finally {
		await manager.close();
		await fixture.close();
		await stop(fixture.http);
	}
});

test("close coordinates with an in-flight connection and leaves no connected state", async () => {
	const fixture = await protocolServer(100);
	const manager = new McpServerManager([{
		name: "real", url: new URL(`http://127.0.0.1:${fixture.port}/mcp`), headers: {},
	}]);
	try {
		const opening = manager.connect("real");
		await new Promise((resolve) => setTimeout(resolve, 20));
		const closing = manager.close();
		await assert.rejects(manager.connect("real"), /manager is closed/);
		await closing;
		await assert.rejects(opening, /closed during startup|could not connect/);
		await assert.rejects(manager.connect("real"), /manager is closed/);
		assert.equal(manager.get("real")?.state, "disconnected");
	} finally {
		await manager.close();
		await fixture.close();
		await stop(fixture.http);
	}
});

test("diagnostics are global or per-server, bounded, and redact configured values", async () => {
	const secret = "DIAGNOSTIC_SECRET_MARKER";
	const manager = { diagnosticStatus: (name?: string) => [{ name: name ?? "safe", state: "disconnected", transport: "http", metadata: { tools: 1, resources: 0, resourceTemplates: 0, prompts: 0 }, cache: "fresh", counters: { reconnects: 1, listNotifications: 2, listRefreshes: 1, listRefreshFailures: 0 } }], close: async () => undefined };
	const runtime = new McpRuntime({ mcpServers: { safe: { url: `https://example.invalid/${secret}`, headers: { Authorization: secret } } }, settings: { ui: {} }, diagnostics: [{ source: secret, code: "invalid-server", path: "mcpServers.bad", message: secret }] } as never, manager as never);
	const global = await runtime.execute({ action: "diagnostics" }); const scoped = await runtime.execute({ action: "diagnostics", server: "safe" });
	for (const result of [global, scoped]) { const output = JSON.stringify(result); assert.ok(Buffer.byteLength(output) <= 50 * 1024); assert.doesNotMatch(output, new RegExp(secret)); assert.match(output, /listRefreshes/); }
});

test("listing keeps serialized content and details within the aggregate budget", async () => {
	const tools = Array.from({ length: 100 }, (_, index) => ({
		name: `tool-${index}-${"x".repeat(2_000)}`,
		description: "description".repeat(500),
		inputSchema: {},
		_meta: { tokenizedUrl: "https://secret.invalid/?token=MARKER" },
	}));
	const server = { name: "large", state: "connected" as const, instructions: "i".repeat(20_000), tools };
	const manager = {
		status: () => [server],
		get: () => server,
		connect: async () => server,
		modelTools: () => tools,
		close: async () => undefined,
	};
	const runtime = new McpRuntime({ mcpServers: {}, settings: { ui: {} }, diagnostics: [] } as never, manager as never);
	const result = await runtime.execute({ server: "large" });
	assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 50 * 1024);
	assert.doesNotMatch(JSON.stringify(result.details), /MARKER|tokenizedUrl|inputSchema/);
});

test("concurrent connects deduplicate protocol initialization", async () => {
	let initializeRequests = 0;
	const fixture = await protocolServer();
	fixture.http.on("request", (request) => {
		if (!request.headers["mcp-session-id"]) initializeRequests++;
	});
	const manager = new McpServerManager([{
		name: "real", url: new URL(`http://127.0.0.1:${fixture.port}/mcp`), headers: {},
	}]);
	try {
		const [first, second] = await Promise.all([manager.connect("real"), manager.connect("real")]);
		assert.equal(first.state, "connected");
		assert.equal(second.state, "connected");
		assert.equal(initializeRequests, 1);
	} finally {
		await manager.close();
		await fixture.close();
		await stop(fixture.http);
	}
});
