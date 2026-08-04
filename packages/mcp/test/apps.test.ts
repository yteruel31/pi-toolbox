import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import test from "node:test";
import { App } from "@modelcontextprotocol/ext-apps";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { McpAppController } from "../src/apps/controller.js";
import { hostHtml, hostScript } from "../src/apps/host-template.js";
import { appResourceUri, selectAppResource } from "../src/apps/resource.js";
import { normalizeMeta } from "../src/apps/security.js";
import type { McpServerManager } from "../src/mcp/manager.js";
import { McpRuntime } from "../src/runtime.js";

const backendHeader = "x-pi-mcp-backend-secret";
const uiUri = "ui://weather/app";
const tool = (meta: Record<string, unknown>, name = "weather"): Tool => ({
	name,
	title: `<Weather & ${name}>`,
	inputSchema: { type: "object" },
	_meta: meta,
});
const appTool = (name = "weather"): Tool => tool({ ui: { resourceUri: uiUri } }, name);
const result: CallToolResult = { content: [{ type: "text", text: "sun" }] };
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

function appManager(overrides: Partial<McpServerManager> = {}): McpServerManager {
	return {
		readResource: async () => ({
			contents: [{ uri: uiUri, mimeType: "text/html", text: "<b>view</b>" }],
		}),
		callFromApp: async (_server: string, name: string) => ({
			content: [{ type: "text", text: `called ${name}` }],
		}),
		...overrides,
	} as unknown as McpServerManager;
}

async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as { port: number }).port;
}

async function stop(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function streamUntil(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	pattern: RegExp,
): Promise<string> {
	let text = "";
	for (let reads = 0; reads < 20; reads++) {
		const next = await Promise.race([
			reader.read(),
			sleep(1_000).then(() => { throw new Error("Timed out waiting for SSE data"); }),
		]);
		if (next.done) break;
		text += new TextDecoder().decode(next.value, { stream: true });
		if (pattern.test(text)) return text;
	}
	throw new Error(`SSE stream ended before ${String(pattern)}`);
}

function request(
	origin: string,
	route: string,
	secret: string,
	init: RequestInit = {},
): Promise<Response> {
	return fetch(`${origin}/${route}`, {
		...init,
		headers: { [backendHeader]: secret, ...init.headers },
	});
}

test("extracts preferred and legacy App resource URIs and rejects malformed values", () => {
	assert.equal(
		appResourceUri(tool({ ui: { resourceUri: "ui://preferred/app" }, "ui/resourceUri": "ui://legacy/app" })),
		"ui://preferred/app",
	);
	assert.equal(appResourceUri(tool({ "ui/resourceUri": "ui://legacy/app" })), "ui://legacy/app");
	assert.equal(appResourceUri(tool({ ui: { resourceUri: "https://bad/app" } })), undefined);
	assert.equal(appResourceUri(tool({ ui: { resourceUri: 2 } })), undefined);
});

test("selects exact bounded text/blob resources with strict MIME and UTF-8", () => {
	const selected = selectAppResource({
		contents: [
			{ uri: "ui://other", mimeType: "text/html", text: "wrong" },
			{
				uri: uiUri,
				mimeType: "Text/HTML; Charset=UTF-8; Profile=MCP-App",
				blob: Buffer.from("<h1>right</h1>").toString("base64"),
			},
		],
	}, uiUri);
	assert.equal(selected.html, "<h1>right</h1>");
	assert.throws(() => selectAppResource({ contents: [{ uri: uiUri, mimeType: "text/plain", text: "x" }] }, uiUri));
	assert.throws(() => selectAppResource({ contents: [{ uri: uiUri, mimeType: "text/html", text: "" }] }, uiUri));
	assert.throws(() => selectAppResource({ contents: [{ uri: uiUri, mimeType: "text/html", blob: "!!!" }] }, uiUri));
	assert.throws(() => selectAppResource({ contents: [{ uri: uiUri, mimeType: "text/html", blob: "/w==" }] }, uiUri));
	assert.throws(() => selectAppResource({
		contents: [{ uri: uiUri, mimeType: "text/html", text: "x".repeat(512 * 1024 + 1) }],
	}, uiUri));
});

test("canonical CSP wins over legacy metadata and only safe origins and permissions survive", () => {
	const safe = normalizeMeta({
		ui: {
			csp: {
				connectDomains: ["https://api.example", "https://bad.example/path"],
				resourceDomains: ["https://*.assets.example"],
				frameDomains: ["https://frames.example"],
				baseUriDomains: ["https://base.example"],
			},
			permissions: { microphone: {}, clipboardWrite: {}, unknown: {}, camera: [] },
			domain: "https://app.example",
			prefersBorder: true,
		},
		"openai/widgetCSP": { connect_domains: ["https://legacy.example"] },
	});
	assert.match(safe.csp, /connect-src 'self' https:\/\/api\.example/);
	assert.match(safe.csp, /script-src 'self' 'unsafe-inline' https:\/\/\*\.assets\.example/);
	assert.match(safe.csp, /frame-src https:\/\/frames\.example/);
	assert.match(safe.csp, /base-uri https:\/\/base\.example/);
	assert.match(safe.csp, /frame-ancestors 'self'/);
	assert.doesNotMatch(safe.csp, /legacy|\/path/);
	assert.match(safe.allow, /microphone/);
	assert.match(safe.allow, /clipboard-write/);
	assert.doesNotMatch(safe.allow, /unknown|camera/);
	assert.equal(safe.domain, "https://app.example");
	assert.equal(safe.prefersBorder, true);

	const malformedCanonical = normalizeMeta({
		ui: { csp: "invalid" },
		"openai/widgetCSP": { connect_domains: ["https://legacy.example"] },
	});
	assert.doesNotMatch(malformedCanonical.csp, /legacy/);
	assert.match(malformedCanonical.csp, /connect-src 'self'/);
	for (const attack of [
		"javascript:alert(1)",
		"https://good.example; script-src *",
		"https://user:pass@example.com",
		"https://newline.example\n",
		"\thttps://tab.example",
		"https://*",
		"http://*",
		"https://%2A",
		"https://foo.*",
	]) {
		assert.doesNotMatch(normalizeMeta({ ui: { csp: { resourceDomains: [attack] } } }).csp, /good\.example|javascript|user:pass|newline\.example|tab\.example|https:\/\/\*|http:\/\/\*|foo\.\*/);
	}
});

test("host template renders a secure full-viewport dark shell and wires lifecycle UX", () => {
	const html = hostHtml(`</title><script>alert(1)</script>`, "microphone");
	assert.doesNotMatch(html, /<script>alert/);
	assert.match(html, /&lt;\/title&gt;/);
	assert.match(html, /name="viewport" content="width=device-width, initial-scale=1"/);
	assert.match(html, /href="\.\.\/\.\.\/styles\.css"/);
	assert.match(html, /href="\.\.\/\.\.\/\.\.\/"/);
	assert.match(html, /Pi \/ terminal/);
	assert.match(html, /aria-live="polite"/);
	assert.match(html, /id="loading"[^>]*aria-label="Loading App"/);
	assert.match(html, /h-dvh min-h-screen overflow-hidden/);
	assert.match(html, /id="app" class="min-h-0 w-full flex-1 border-0 bg-pi-bg" hidden/);
	assert.match(html, /referrerpolicy="no-referrer"/);
	assert.match(html, /sandbox="(?![^"]*allow-same-origin)/);
	assert.match(html, /allow="microphone"/);
	assert.doesNotMatch(html, /style=|https?:\/\//);

	const script = hostScript();
	assert.ok(script.indexOf("await bridge.connect") < script.indexOf("frame.src = './view'"));
	assert.match(script, /theme: 'dark'/);
	assert.match(script, /loading\.remove\(\)/);
	assert.match(script, /setStatus\('connecting', 'Connecting'\)/);
	assert.match(script, /setStatus\('connected', 'Connected'\)/);
	assert.match(script, /setStatus\('reconnecting', 'Reconnecting'\)/);
	assert.match(script, /setStatus\('ended', 'Ended'\)/);
	assert.match(script, /bridge\.onsizechange = \(\) => \{\}/);
	assert.doesNotMatch(script, /frame\.style|\.width \+|\.height \+/);
	assert.match(script, /window\.confirm/);
	assert.match(script, /bridge\.oncalltool/);
	assert.match(script, /extra\.signal/);
	assert.match(script, /bridge\.onmessage/);
	assert.match(script, /bridge\.onupdatemodelcontext/);
	assert.match(script, /bridge\.onrequestdisplaymode/);
	assert.match(script, /bridge\.onopenlink/);
	assert.match(script, /bridge\.onrequestteardown/);
	assert.match(script, /bridge\.teardownResource/);
	assert.match(script, /EventSource\('\.\/events'\)/);
	assert.doesNotMatch(script, /https?:\/\//);
});

test("host lifecycle detaches locally on pagehide and only explicitly completes once", () => {
	const script = hostScript();
	assert.match(script, /bridge\.onrequestteardown = \(\) => void teardown\(true\);/);
	assert.match(script, /events\.addEventListener\('cancelled', \(\) => teardown\(false\)\);/);
	assert.match(script, /events\.addEventListener\('complete', \(\) => teardown\(false\)\);/);
	assert.match(script, /addEventListener\('pagehide', \(\) => void teardown\(false\), \{ once: true \}\);/);

	const teardown = script.match(/async function teardown\(notify\) \{([^}]|\}(?!\n))*\}/)?.[0];
	assert.ok(teardown, "generated host script must contain the teardown implementation");
	assert.match(teardown, /if \(done\) return; done = true;/, "teardown must claim completion before awaiting");
	assert.equal((teardown.match(/post\('\.\/complete'\)/g) ?? []).length, 1);
	assert.match(teardown, /events\.close\(\); clearInterval\(heartbeat\);/);
	assert.match(teardown, /bridge\.teardownResource\(\{\}\)/);
	assert.match(teardown, /transport\.close\(\)/);
});

test("official App and AppBridge complete a postMessage handshake and same-server tool call", async (context) => {
	context.mock.method(console, "log", () => undefined);
	context.mock.method(console, "debug", () => undefined);
	class FakeWindow extends EventTarget {
		peer?: FakeWindow;
		postMessage(data: unknown): void {
			const event = new Event("message");
			Object.defineProperties(event, {
				data: { value: data },
				source: { value: this.peer },
			});
			queueMicrotask(() => this.dispatchEvent(event));
		}
	}
	const hostWindow = new FakeWindow();
	const viewWindow = new FakeWindow();
	hostWindow.peer = viewWindow;
	viewWindow.peer = hostWindow;
	const globals = globalThis as unknown as { window?: unknown };
	const previousWindow = globals.window;
	const bridge = new AppBridge(
		null,
		{ name: "Pi", version: "0.1.0" },
		{ serverTools: {}, openLinks: {} },
		{ hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"] } },
	);
	bridge.oncalltool = async ({ name, arguments: args }) => ({
		content: [{ type: "text", text: `${name}:${String(args?.city)}` }],
	});
	const app = new App({ name: "fixture", version: "1.0.0" }, {}, { autoResize: false });
	const bridgeTransport = new PostMessageTransport(viewWindow as unknown as Window, viewWindow as unknown as Window);
	const appTransport = new PostMessageTransport(hostWindow as unknown as Window, hostWindow as unknown as Window);
	try {
		globals.window = hostWindow;
		await bridge.connect(bridgeTransport);
		globals.window = viewWindow;
		await app.connect(appTransport);
		assert.equal(app.getHostVersion()?.name, "Pi");
		assert.equal(app.getHostContext()?.displayMode, "inline");
		const called = await app.callServerTool({ name: "lookup", arguments: { city: "Paris" } });
		assert.match(JSON.stringify(called), /lookup:Paris/);
	} finally {
		await appTransport.close();
		await bridgeTransport.close();
		if (previousWindow === undefined) delete globals.window;
		else globals.window = previousWindow;
	}
});

test("loopback host keeps SSE open, replays events, isolates Apps, and validates APIs", async () => {
	const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
	const changes: number[] = [];
	const manager = appManager({
		callFromApp: async (server, name, args) => {
			calls.push({ server, tool: name, args });
			return { content: [{ type: "text", text: "called" }] };
		},
	});
	const apps = new McpAppController(manager, {
		maxSseClients: 1,
		maxSseClientsPerSession: 1,
		onChange: (descriptors) => changes.push(descriptors.length),
	});
	assert.equal(apps.backend(), undefined);
	const first = await apps.open("one", appTool("first"), { city: "Paris" }, result);
	const second = await apps.open("two", appTool("second"), { city: "Oslo" }, result);
	assert.ok(first && second);
	const backend = apps.backend()!;
	const headers = { [backendHeader]: backend.secret, "content-type": "application/json" };

	assert.equal((await fetch(`${backend.origin}/${first.route}`)).status, 404);
	assert.equal((await fetch(`${backend.origin}/styles.css`)).status, 404);
	assert.equal((await request(backend.origin, "styles.css", backend.secret, { method: "POST" })).status, 404);
	assert.equal((await request(backend.origin, "unknown.css", backend.secret)).status, 404);
	const stylesheet = await request(backend.origin, "styles.css", backend.secret);
	assert.equal(stylesheet.status, 200);
	assert.equal(stylesheet.headers.get("content-type"), "text/css; charset=utf-8");
	assert.equal(stylesheet.headers.get("cache-control"), "no-store");
	assert.equal(stylesheet.headers.get("referrer-policy"), "no-referrer");
	assert.equal(stylesheet.headers.get("x-content-type-options"), "nosniff");
	assert.equal(stylesheet.headers.get("content-security-policy"), "default-src 'none'");
	assert.match(await stylesheet.text(), /color-scheme:dark/);
	assert.equal((await request(backend.origin, `${first.route}?secret=${backend.secret}`, backend.secret)).status, 404);
	assert.equal((await request(backend.origin, "apps", backend.secret)).status, 200);
	const descriptors = await (await request(backend.origin, "apps", backend.secret)).json() as Array<Record<string, unknown>>;
	assert.deepEqual(descriptors.map((item) => item.label), ["<Weather & first>", "<Weather & second>"]);
	assert.doesNotMatch(JSON.stringify(descriptors), /Paris|Oslo|sun|127\.0\.0\.1|secret/);

	const host = await request(backend.origin, first.route, backend.secret);
	assert.equal(host.status, 200);
	assert.equal(host.headers.get("cache-control"), "no-store");
	assert.equal(host.headers.get("referrer-policy"), "no-referrer");
	assert.equal(host.headers.get("content-security-policy"), "default-src 'none'; script-src 'self'; style-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'");
	assert.match(await host.text(), /&lt;Weather &amp; first&gt;/);
	assert.equal(await (await request(backend.origin, `${first.route}view`, backend.secret)).text(), "<b>view</b>");

	const events = await request(backend.origin, `${first.route}events`, backend.secret);
	const reader = events.body!.getReader();
	const initial = await streamUntil(reader, /event: result/);
	assert.equal((await request(backend.origin, `${first.route}events`, backend.secret)).status, 429);
	assert.match(initial, /event: input/);
	assert.match(initial, /Paris/);
	assert.match(initial, /sun/);
	assert.equal(events.bodyUsed, true);

	const message = await request(backend.origin, `${first.route}message`, backend.secret, {
		method: "POST", headers, body: JSON.stringify({ content: [{ type: "text", text: "choose A" }] }),
	});
	assert.equal(message.status, 200);
	assert.match(await streamUntil(reader, /event: message/), /choose A/);
	await reader.cancel();
	await sleep(20);

	const replay = await fetch(`${backend.origin}/${first.route}events`, {
		headers: { [backendHeader]: backend.secret, "last-event-id": "2" },
	});
	assert.equal(replay.status, 200);
	const replayReader = replay.body!.getReader();
	const replayed = await streamUntil(replayReader, /event: message/);
	assert.doesNotMatch(replayed, /event: input|event: result/);
	await replayReader.cancel();

	const toolCall = await request(backend.origin, `${first.route}tool-call`, backend.secret, {
		method: "POST", headers, body: JSON.stringify({ name: "lookup", arguments: { city: "Paris" } }),
	});
	assert.equal(toolCall.status, 200);
	assert.deepEqual(calls, [{ server: "one", tool: "lookup", args: { city: "Paris" } }]);
	assert.equal((await request(backend.origin, `${first.route}tool-call`, backend.secret, {
		method: "POST", headers, body: JSON.stringify({ server: "two", name: "lookup", arguments: {} }),
	})).status, 400);
	assert.equal((await request(backend.origin, `${first.route}open-link`, backend.secret, {
		method: "POST", headers, body: JSON.stringify({ url: "https://user:pass@example.com" }),
	})).status, 400);
	assert.equal((await request(backend.origin, `${first.route}open-link`, backend.secret, {
		method: "POST", headers, body: JSON.stringify({ url: "https://example.com/path" }),
	})).status, 200);
	assert.equal((await request(backend.origin, `${first.route}display-mode`, backend.secret, {
		method: "POST", headers, body: JSON.stringify({ mode: "pip" }),
	})).status, 400);
	assert.equal((await request(backend.origin, `${first.route}context`, backend.secret, {
		method: "POST", headers, body: JSON.stringify({ structuredContent: { selection: 1 } }),
	})).status, 200);
	assert.equal((await request(backend.origin, `${first.route}context`, backend.secret, {
		method: "POST", headers, body: JSON.stringify({ structuredContent: { selection: 2 } }),
	})).status, 200);
	const consumed = JSON.stringify(apps.consumeMessages(first.id));
	assert.match(consumed, /choose A|example\.com|selection/);
	assert.match(consumed, /\"selection\":2/);
	assert.doesNotMatch(consumed, /\"selection\":1/);
	assert.deepEqual(apps.consumeMessages(first.id), []);

	assert.equal((await request(backend.origin, `${first.route}complete`, backend.secret, {
		method: "POST", headers, body: "{}",
	})).status, 200);
	assert.equal((await request(backend.origin, first.route, backend.secret)).status, 404);
	assert.equal((await request(backend.origin, second.route, backend.secret)).status, 200);
	assert.deepEqual(changes, [1, 2, 1]);
	await apps.close();
	await apps.close();
	assert.deepEqual(changes, [1, 2, 1, 0]);
});

test("SSE capacity is reserved before a backpressured replay and released on completion", async () => {
	const apps = new McpAppController(appManager(), { maxSseClients: 1, maxSseClientsPerSession: 1 });
	try {
		const largeResult: CallToolResult = { content: [{ type: "text", text: "x".repeat(1024 * 1024) }] };
		const opened = (await apps.open("one", appTool(), {}, largeResult))!;
		const backend = apps.backend()!;
		const firstStream = await request(backend.origin, `${opened.route}events`, backend.secret);
		assert.equal(firstStream.status, 200);
		const excess = await request(backend.origin, `${opened.route}events`, backend.secret);
		assert.equal(excess.status, 429);
		await excess.text();
		await request(backend.origin, `${opened.route}complete`, backend.secret, { method: "POST", body: "{}" });
		await firstStream.body?.cancel();
		await sleep(20);

		const replacement = (await apps.open("two", appTool(), {}, result))!;
		const replacementStream = await request(backend.origin, `${replacement.route}events`, backend.secret);
		assert.equal(replacementStream.status, 200);
		await replacementStream.body?.cancel();
	} finally {
		await apps.close();
	}
});

test("heartbeats extend the lease and expiration closes an App without another request", async (context) => {
	context.mock.timers.enable({ apis: ["Date", "setInterval"] });
	const apps = new McpAppController(appManager(), { ttlMs: 40, heartbeatMs: 10 });
	try {
		const opened = (await apps.open("one", appTool(), {}, result))!;
		const backend = apps.backend()!;
		context.mock.timers.tick(25);
		assert.equal((await request(backend.origin, `${opened.route}heartbeat`, backend.secret, {
			method: "POST", body: "{}",
		})).status, 200);
		context.mock.timers.tick(25);
		assert.equal(apps.count, 1, "heartbeat must extend the lease past the creation deadline");
		context.mock.timers.tick(50);
		assert.equal(apps.count, 0, "timer must expire the App without a follow-up request");
		assert.equal((await request(backend.origin, opened.route, backend.secret)).status, 404);
	} finally {
		await apps.close();
	}
});

test("concurrent App opens honor the global session reservation and recover capacity", async () => {
	let release!: () => void;
	let started!: () => void;
	let reads = 0;
	const didStart = new Promise<void>((resolve) => { started = resolve; });
	const firstRead = new Promise<void>((resolve) => { release = resolve; });
	const manager = appManager({
		readResource: async () => {
			reads++;
			if (reads === 1) {
				started();
				await firstRead;
			}
			return { contents: [{ uri: uiUri, mimeType: "text/html", text: "<b>view</b>" }] };
		},
	});
	const apps = new McpAppController(manager, { maxSessions: 1 });
	const first = apps.open("one", appTool("first"), {}, result);
	await didStart;
	await assert.rejects(apps.open("two", appTool("second"), {}, result), /capacity/);
	assert.equal(reads, 1, "capacity must be reserved before resources/read");
	release();
	const opened = (await first)!;
	const backend = apps.backend()!;
	await request(backend.origin, `${opened.route}complete`, backend.secret, { method: "POST", body: "{}" });
	assert.ok(await apps.open("two", appTool("second"), {}, result));
	assert.equal(reads, 2);
	await apps.close();
});

test("real SDK tool metadata and resources/read open an App while preserving the tool result", async () => {
	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
	const mcp = new McpServer({ name: "apps-integration", version: "1.0.0" });
	mcp.registerTool("forecast", {
		description: "forecast with App",
		_meta: { ui: { resourceUri: uiUri } },
	}, async () => ({
		content: [{ type: "text", text: "forecast result remains visible" }],
		structuredContent: { temperature: 21 },
	}));
	mcp.registerTool("app-only", {
		_meta: { ui: { visibility: ["app"] } },
	}, async () => ({ content: [{ type: "text", text: "app-only result" }] }));
	mcp.registerTool("model-only", {
		_meta: { ui: { visibility: ["model"] } },
	}, async () => ({ content: [{ type: "text", text: "model-only result" }] }));
	mcp.registerResource("forecast-app", uiUri, { mimeType: "text/html;profile=mcp-app" }, async () => ({
		contents: [{
			uri: uiUri,
			mimeType: "text/html;profile=mcp-app",
			blob: Buffer.from("<!doctype html><h1>SDK App</h1>").toString("base64"),
			_meta: { ui: { csp: { connectDomains: ["https://api.example"] } } },
		}],
	}));
	await mcp.connect(transport);
	const http = createServer((request, response) => {
		void transport.handleRequest(request, response);
	});
	const port = await listen(http);
	const runtime = new McpRuntime({
		mcpServers: { real: { url: `http://127.0.0.1:${port}/mcp` } },
		settings: { ui: {} },
		diagnostics: [],
	} as never, undefined, undefined, undefined, { publishApps: false });
	try {
		const listing = await runtime.execute({ connect: "real" });
		assert.match(JSON.stringify(listing), /real_model-only/);
		assert.doesNotMatch(JSON.stringify(listing), /app-only/);
		await assert.rejects(runtime.execute({ server: "real", tool: "app-only" }), /Unknown MCP tool/);
		await assert.rejects(runtime.manager.callFromApp("real", "model-only", {}), /Unknown same-server MCP tool/);
		assert.match(JSON.stringify(await runtime.manager.callFromApp("real", "app-only", {})), /app-only result/);
		const output = await runtime.execute({ server: "real", tool: "forecast" });
		assert.match(JSON.stringify(output.content), /forecast result remains visible|temperature/);
		assert.deepEqual(output.details.ui, { state: "available" });
		assert.doesNotMatch(JSON.stringify(output.details), /apps\/|127\.0\.0\.1|secret/);
		assert.equal(runtime.apps.count, 1);
		const descriptor = runtime.apps.list()[0]!;
		assert.equal(descriptor.server, "real");
		const backend = runtime.apps.backend()!;
		const legacy = await request(backend.origin, "apps", backend.secret);
		assert.deepEqual(await legacy.json(), [{ id: descriptor.id, label: descriptor.label, route: descriptor.route, state: "active" }]);
		const enriched = await request(backend.origin, "apps/v2", backend.secret);
		assert.deepEqual(await enriched.json(), [descriptor]);
		const view = await request(backend.origin, `${descriptor.route}view`, backend.secret);
		assert.equal(await view.text(), "<!doctype html><h1>SDK App</h1>");
		assert.match(view.headers.get("content-security-policy") ?? "", /https:\/\/api\.example/);
	} finally {
		await runtime.close();
		await mcp.close();
		await stop(http);
	}
});

test("a stalled App resource times out without withholding the completed tool result", async () => {
	const metadata = appTool("slow-resource");
	const server = { name: "slow", state: "connected" as const, tools: [metadata] };
	const manager = {
		status: () => [server],
		get: () => server,
		connect: async () => server,
		modelTools: () => [metadata],
		modelTool: () => metadata,
		callFromModel: async () => ({ content: [{ type: "text", text: "tool completed" }] }),
		readResource: async () => new Promise<never>(() => undefined),
		close: async () => undefined,
	} as unknown as McpServerManager;
	const apps = new McpAppController(manager, { loadTimeoutMs: 20 });
	const runtime = new McpRuntime(
		{ mcpServers: {}, settings: { ui: {} }, diagnostics: [] } as never,
		manager,
		undefined,
		apps,
	);
	try {
		const started = Date.now();
		const output = await runtime.execute({ server: "slow", tool: "slow-resource" });
		assert.ok(Date.now() - started < 500);
		assert.match(JSON.stringify(output.content), /tool completed/);
		assert.deepEqual(output.details.ui, { state: "unavailable" });
	} finally {
		await runtime.close();
	}
});

test("App tool-call caps reject excess work and recover after request cancellation", async () => {
	let started!: () => void;
	let cancelled!: () => void;
	let calls = 0;
	const didStart = new Promise<void>((resolve) => { started = resolve; });
	const didCancel = new Promise<void>((resolve) => { cancelled = resolve; });
	const manager = appManager({
		callFromApp: async (_server, _tool, _args, signal) => {
			calls++;
			if (calls > 1) return { content: [{ type: "text", text: "recovered" }] };
			return new Promise<CallToolResult>((resolve) => {
				started();
				signal?.addEventListener("abort", () => {
					cancelled();
					resolve({ isError: true, content: [{ type: "text", text: "cancelled" }] });
				}, { once: true });
			});
		},
	});
	const apps = new McpAppController(manager, { maxCalls: 1, maxCallsPerSession: 1 });
	const opened = (await apps.open("one", appTool(), {}, result))!;
	const backend = apps.backend()!;
	const body = JSON.stringify({ name: "slow", arguments: {} });
	const controller = new AbortController();
	const pending = request(backend.origin, `${opened.route}tool-call`, backend.secret, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body,
		signal: controller.signal,
	});
	await didStart;
	assert.equal((await request(backend.origin, `${opened.route}tool-call`, backend.secret, {
		method: "POST", headers: { "content-type": "application/json" }, body,
	})).status, 429);
	controller.abort();
	await pending.catch(() => undefined);
	await didCancel;
	await sleep(0);
	assert.equal((await request(backend.origin, `${opened.route}tool-call`, backend.secret, {
		method: "POST", headers: { "content-type": "application/json" }, body,
	})).status, 200);
	assert.equal(calls, 2);
	assert.equal(apps.count, 1);
	await apps.close();
});

test("controller close aborts in-flight App tool calls and removes all sessions", async () => {
	let aborted = false;
	let started!: () => void;
	const didStart = new Promise<void>((resolve) => { started = resolve; });
	const manager = appManager({
		callFromApp: async (_server, _tool, _args, signal) => new Promise<CallToolResult>((resolve) => {
			started();
			signal?.addEventListener("abort", () => {
				aborted = true;
				resolve({ isError: true, content: [{ type: "text", text: "cancelled" }] });
			}, { once: true });
		}),
	});
	const apps = new McpAppController(manager);
	const opened = (await apps.open("one", appTool(), {}, result))!;
	const backend = apps.backend()!;
	const pending = request(backend.origin, `${opened.route}tool-call`, backend.secret, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "slow", arguments: {} }),
	});
	await didStart;
	await apps.close();
	await pending.catch(() => undefined);
	assert.equal(aborted, true);
	assert.equal(apps.count, 0);
});
