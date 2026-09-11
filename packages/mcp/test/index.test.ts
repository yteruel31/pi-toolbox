import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import mcpExtension from "../src/index.js";
import { createServer } from "node:http";
import { GatewayClient } from "../src/gateway/client.js";
import { DEFAULT_UI_SETTINGS } from "../src/config.js";

test("extension lifecycle stays network-idle until an MCP operation needs a connection", async () => {
	const commands: unknown[][] = [];
	const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
	const events = new Map<string, (...args: any[]) => Promise<void>>();
	let activeTools = ["mcp"];
	const statuses: Array<{ id: string; value: string | undefined }> = [];
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const context = { ui: {
		setStatus: (id: string, value: string | undefined) => statuses.push({ id, value }),
		theme: { fg: (_color: string, value: string) => value },
	} };
	mcpExtension({
		registerCommand: (...args: unknown[]) => commands.push(args),
		registerTool: (tool: typeof tools[number]) => tools.push(tool),
		on: (name: string, handler: (...args: any[]) => Promise<void>) => events.set(name, handler),
		getAllTools: () => tools,
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => { activeTools = names; },
		events: { emit: (channel: string, data: unknown) => emitted.push({ channel, data }), on: () => () => {} },
	} as never);

	assert.equal(commands.length, 1);
	assert.deepEqual(commands.map((command) => command[0]), ["mcp"]);
	const tool = tools.find((candidate) => candidate.name === "mcp");
	assert.ok(tool);
	assert.deepEqual([...events.keys()], ["session_start", "session_shutdown"]);
	assert.match(JSON.stringify(await tool.execute("before", {}, undefined)), /before session start/);

	const originalFetch = globalThis.fetch;
	const originalHome = process.env.HOME;
	const home = mkdtempSync(join(tmpdir(), "pi-mcp-index-"));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "mcp.json"), JSON.stringify({ mcpServers: { paused: { command: "node", disabled: true } } }));
	process.env.HOME = home;
	let requests = 0;
	globalThis.fetch = (async () => {
		requests++;
		throw new Error("unexpected eager network request");
	}) as typeof fetch;
	try {
		await events.get("session_start")!({}, context);
		assert.doesNotMatch(JSON.stringify(await tool.execute("status", {}, undefined)), /before session start/);
		await events.get("session_start")!({}, context);
		await events.get("session_shutdown")!({}, context);
		await events.get("session_shutdown")!({}, context);
		await Promise.all([events.get("session_start")!({}, context), events.get("session_shutdown")!({}, context)]);
		assert.match(JSON.stringify(await tool.execute("after-overlap", {}, undefined)), /before session start/);
		assert.equal(requests, 0);
		assert.ok(statuses.length >= 8);
		assert.ok(statuses.every((status) => ["mcp-ui", "mcp-status"].includes(status.id)));
		assert.ok(statuses.filter((status) => status.id === "mcp-ui").every((status) => status.value === undefined));
		assert.ok(statuses.some((status) => status.id === "mcp-status" && status.value === "MCP 0/0 · 1 off"));
		assert.equal(statuses.at(-1)?.id, "mcp-status");
		assert.equal(statuses.at(-1)?.value, undefined);
		assert.ok(emitted.every((event) => event.channel === "pi-toolbox:mcp:status"));
		assert.deepEqual(emitted[0]?.data, { v: 1, counts: null }, "session start clears stale counts before the new runtime exists");
		assert.deepEqual(emitted[1]?.data, { v: 1, counts: { total: 1, enabled: 0, connected: 0, authRequired: 0, errors: 0, disabled: 1 } });
		assert.deepEqual(emitted.at(-1)?.data, { v: 1, counts: null }, "shutdown clears counts");
	} finally {
		globalThis.fetch = originalFetch;
		if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
		rmSync(home, { recursive: true, force: true });
	}
});

test("agent gateway configuration restores the real MCP runtime without reloading the agent session", async () => {
	const home = mkdtempSync(join(tmpdir(), "pi-mcp-runtime-restore-"));
	const reserve = createServer();
	await new Promise<void>((resolve) => reserve.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (reserve.address() as { port: number }).port;
	await new Promise<void>((resolve) => reserve.close(() => resolve()));
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	writeFileSync(join(home, ".pi", "agent", "mcp.json"), JSON.stringify({ settings: { ui: { gatewayPort } } }));
	const originalHome = process.env.HOME;
	const originalFetch = globalThis.fetch;
	process.env.HOME = home;
	const candidate = { mode: "custom", externalUrl: "https://gateway.example.test/mcp-ui", listenAddress: "127.0.0.1" };
	const client = new GatewayClient({ homeDir: home, settings: { ...DEFAULT_UI_SETTINGS, gatewayPort, requireTailscaleIdentity: false }, externalUrlResolver: async () => candidate.externalUrl });
	const events = new Map<string, (...args: any[]) => Promise<void>>();
	const tools: any[] = [];
	let active = ["mcp", "read"];
	const context = { hasUI: true, ui: {
		async confirm() { return true; }, setStatus() {}, theme: { fg: (_color: string, value: string) => value },
	} };
	globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		assert.equal(url.origin, "https://gateway.example.test");
		return originalFetch(`http://127.0.0.1:${gatewayPort}${url.pathname}`, init);
	}) as typeof fetch;
	try {
		mcpExtension({ registerCommand() {}, registerTool: (tool: unknown) => tools.push(tool),
			on: (name: string, handler: (...args: any[]) => Promise<void>) => events.set(name, handler),
			getAllTools: () => tools, getActiveTools: () => active, setActiveTools: (names: string[]) => { active = names; },
			events: { emit() {} },
		} as never);
		await events.get("session_start")!({}, context);
		const tool = tools.find((tool) => tool.name === "mcp");
		const result = await tool.execute("configure", { action: "gateway-configure", args: candidate }, undefined, undefined, context);
		assert.equal(result.details.gateway.persisted, true, JSON.stringify(result));
		assert.equal(result.details.gateway.restoreDiagnostic, undefined);
		assert.doesNotMatch(JSON.stringify(await tool.execute("servers", {}, undefined)), /before session start/);
		assert.equal((await tool.execute("gateway", { action: "gateway-status" })).details.gateway.mode, "custom");
		assert.ok(active.includes("mcp") && active.includes("read"));
		const removed = await tool.execute("remove", { action: "gateway-deactivate" }, undefined, undefined, context);
		assert.equal(removed.details.gateway.state, "deactivated");
		assert.doesNotMatch(JSON.stringify(await tool.execute("servers-again", {}, undefined)), /before session start/);
	} finally {
		await events.get("session_shutdown")?.({}, context);
		await client.shutdown();
		globalThis.fetch = originalFetch;
		if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
		rmSync(home, { recursive: true, force: true });
	}
});
