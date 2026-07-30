import assert from "node:assert/strict";
import test from "node:test";
import mcpExtension from "../src/index.js";

test("extension lifecycle stays network-idle until an MCP operation needs a connection", async () => {
	const commands: unknown[][] = [];
	const tools: Array<{ name: string; execute: (...args: any[]) => Promise<any> }> = [];
	const events = new Map<string, (...args: any[]) => Promise<void>>();
	let activeTools = ["mcp"];
	const statuses: Array<{ id: string; value: string | undefined }> = [];
	const context = { ui: { setStatus: (id: string, value: string | undefined) => statuses.push({ id, value }) } };
	mcpExtension({
		registerCommand: (...args: unknown[]) => commands.push(args),
		registerTool: (tool: typeof tools[number]) => tools.push(tool),
		on: (name: string, handler: (...args: any[]) => Promise<void>) => events.set(name, handler),
		getAllTools: () => tools,
		getActiveTools: () => activeTools,
		setActiveTools: (names: string[]) => { activeTools = names; },
	} as never);

	assert.equal(commands.length, 1);
	assert.equal(commands[0]?.[0], "mcp-gateway");
	const tool = tools.find((candidate) => candidate.name === "mcp");
	assert.ok(tool);
	assert.deepEqual([...events.keys()], ["session_start", "session_shutdown"]);
	assert.match(JSON.stringify(await tool.execute("before", {}, undefined)), /before session start/);

	const originalFetch = globalThis.fetch;
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
		assert.equal(requests, 0);
		assert.ok(statuses.length >= 4);
		assert.ok(statuses.every((status) => status.id === "mcp-ui" && status.value === undefined));
	} finally {
		globalThis.fetch = originalFetch;
	}
});
