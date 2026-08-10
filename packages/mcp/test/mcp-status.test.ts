import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_UI_SETTINGS } from "../src/config.js";
import { mcpStatusSnapshot, mcpStatusText } from "../src/mcp/status.js";

function runtime() {
	const states = [
		{ name: "connected", state: "connected", tools: [{ name: "read", inputSchema: { type: "object" } }], resources: [], resourceTemplates: [], prompts: [] },
		{ name: "auth", state: "auth-required", tools: [], resources: [], resourceTemplates: [], prompts: [] },
		{ name: "malformed", state: "connected", tools: [{ name: "read", inputSchema: { type: "object" } }], resources: [], resourceTemplates: [], prompts: [] },
	];
	return {
		config: {
			mcpServers: {
				connected: { url: "https://safe.test", directTools: ["read"] },
				auth: { url: "https://auth.test" },
				disabled: { command: "node", disabled: true },
				broken: { url: 42 },
				malformed: { url: "https://safe.test", directTools: ["duplicate", "duplicate"] },
			},
			settings: { ui: { ...DEFAULT_UI_SETTINGS }, directTools: true }, diagnostics: [],
		},
		serverConfigs: new Map([
			["connected", { directTools: ["read"] }],
			["auth", {}],
			["malformed", { directTools: false }],
		]),
		disabledServers: new Set(["disabled"]),
		diagnostics: [{ server: "broken", code: "invalid-definition", message: "rejected" }],
		manager: {
			status: () => states,
			modelTools: (name: string) => states.find((server) => server.name === name)?.tools ?? [],
		},
	} as never;
}

test("snapshot includes connected, auth, disabled, invalid, metadata, and direct selection", () => {
	const snapshot = mcpStatusSnapshot(runtime());
	assert.deepEqual(snapshot.map(({ name, state }) => ({ name, state })), [
		{ name: "auth", state: "auth-required" },
		{ name: "broken", state: "invalid" },
		{ name: "connected", state: "connected" },
		{ name: "disabled", state: "disabled" },
		{ name: "malformed", state: "connected" },
	]);
	assert.equal(snapshot.find((server) => server.name === "connected")?.tools[0]?.selected, true);
	assert.equal(snapshot.find((server) => server.name === "malformed")?.tools[0]?.selected, false, "invalid per-server directTools fails closed instead of inheriting global true");
	assert.equal(mcpStatusText(snapshot), "MCP 2/4 · 1 auth · 1 err · 1 off");
});

test("empty configuration clears the footer status", () => {
	assert.equal(mcpStatusText([]), undefined);
});
