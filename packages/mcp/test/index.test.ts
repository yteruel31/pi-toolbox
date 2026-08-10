import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import mcpExtension from "../src/index.js";

test("extension lifecycle stays network-idle until an MCP operation needs a connection", async () => {
	const commands: unknown[][] = [];
	const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
	const events = new Map<string, (...args: any[]) => Promise<void>>();
	let activeTools = ["mcp"];
	const statuses: Array<{ id: string; value: string | undefined }> = [];
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
	} as never);

	assert.equal(commands.length, 2);
	assert.deepEqual(commands.map((command) => command[0]), ["mcp-gateway", "mcp"]);
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
	} finally {
		globalThis.fetch = originalFetch;
		if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
		rmSync(home, { recursive: true, force: true });
	}
});
