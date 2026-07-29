import assert from "node:assert/strict";
import test from "node:test";
import { DirectToolRegistry } from "../src/mcp/direct-tools.js";

function harness() {
	const registered: any[] = [];
	let active = ["mcp", "builtin"];
	const pi = {
		registerTool: (tool: any) => { const at = registered.findIndex((item) => item.name === tool.name); at < 0 ? registered.push(tool) : registered.splice(at, 1, tool); },
		getAllTools: () => [{ name: "mcp" }, { name: "builtin" }, { name: "srv_collision" }, ...registered],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
	};
	let listener = () => {};
	let tools: any[] = [
		{ name: "ok", description: "safe", inputSchema: { type: "object", properties: { value: { type: "string" } } } },
		{ name: "collision", inputSchema: { type: "object" } },
		{ name: "app", inputSchema: { type: "object" } },
		{ name: "bad name", inputSchema: { type: "object" } },
	];
	const calls: any[] = [];
	const connects: string[] = [];
	const runtime: any = {
		config: { settings: { directTools: true } }, serverConfigs: new Map([["srv", { name: "srv" }]]),
		manager: {
			onMetadataChange: (fn: () => void) => { listener = fn; }, status: () => [{ name: "srv" }],
			modelTools: () => tools.filter((tool) => tool.name !== "app"),
			modelTool: (_server: string, name: string) => tools.find((tool) => tool.name === name && name !== "app"),
			connect: async (name: string) => { connects.push(name); },
		},
		executeDirect: async (...args: any[]) => { calls.push(args); return { content: [{ type: "text", text: "same path" }], details: { server: args[0] } }; },
	};
	return { pi, runtime, registered, calls, connects, active: () => active, setTools: (next: any[]) => { tools = next; listener(); } };
}

test("registers selected discovered model tools without collisions and deactivates stale aliases", async () => {
	const h = harness(); const registry = new DirectToolRegistry(h.pi as never);
	registry.attach(h.runtime);
	assert.deepEqual(h.registered.map((tool) => tool.name), ["srv_ok"]);
	assert.ok(h.active().includes("mcp") && h.active().includes("builtin") && h.active().includes("srv_ok"));
	const direct = h.registered[0];
	assert.deepEqual(direct.parameters, { type: "object", properties: { value: { type: "string" } } });
	const controller = new AbortController();
	assert.equal((await direct.execute("id", { value: "x" }, controller.signal)).content[0].text, "same path");
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0][3], controller.signal);

	h.setTools([]);
	assert.ok(!h.active().includes("srv_ok"));
	await assert.rejects(() => direct.execute("id", {}, undefined), /no longer available/);
	h.setTools([{ name: "ok", inputSchema: { type: "object" } }]);
	assert.ok(h.active().includes("srv_ok"));
	assert.equal(h.registered.length, 1, "changed fingerprint replaces rather than duplicates alias");
	registry.detach(h.runtime);
	assert.ok(!h.active().includes("srv_ok"));
	await assert.rejects(() => direct.execute("id", {}, undefined), /no longer available/);
	registry.attach(h.runtime);
	assert.ok(h.active().includes("srv_ok"));
	assert.notEqual(h.registered[0].execute, direct.execute, "a new generation replaces stale executors on session restart");
	assert.equal((await h.registered[0].execute("id", {}, undefined)).content[0].text, "same path");
});

test("per-server selection overrides the global setting", () => {
	const h = harness(); h.runtime.serverConfigs.set("srv", { name: "srv", directTools: ["collision"] });
	const registry = new DirectToolRegistry(h.pi as never); registry.attach(h.runtime);
	assert.deepEqual(h.registered, [], "selected alias collides with an existing tool and is not registered");
	h.runtime.serverConfigs.set("srv", { name: "srv", directTools: false });
	registry.startDiscovery(h.runtime);
	assert.deepEqual(h.connects, [], "an explicit false override prevents eager direct-tool discovery");
});

test("direct discovery starts only for non-empty effective selections", async () => {
	const h = harness();
	const registry = new DirectToolRegistry(h.pi as never);
	h.runtime.config.settings.directTools = false;
	h.runtime.serverConfigs.set("srv", { name: "srv", directTools: [] });
	registry.startDiscovery(h.runtime);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(h.connects, []);
	h.runtime.serverConfigs.set("srv", { name: "srv", directTools: ["ok"] });
	registry.startDiscovery(h.runtime);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(h.connects, ["srv"]);
});
