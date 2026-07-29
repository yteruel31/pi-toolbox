import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
function config(port: number, name = "real") {
	return {
		mcpServers: { [name]: { url: `http://127.0.0.1:${port}/mcp` } },
		settings: { ui: {} }, diagnostics: [],
	} as never;
}

async function protocolServer(delayMs = 0) {
	let cancelled = false;
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
		mcp.registerTool("slow", {}, async (extra) => new Promise((resolve) => {
			resolveSlowStarted();
			extra.signal.addEventListener("abort", () => {
				cancelled = true;
				resolve({ content: [{ type: "text", text: "cancelled" }] });
			}, { once: true });
		}));
		await mcp.connect(transport);
		instances.push(mcp);
		return { transport, mcp };
	};
	current = await createInstance();
	const http = createServer(async (request, response) => {
		if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
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

test("401 errors are classified and marker secrets never escape", async () => {
	const marker = "MARKER-secret-token";
	const http = createServer((_request, response) => {
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
	} finally {
		await manager.close();
		await stop(http);
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
