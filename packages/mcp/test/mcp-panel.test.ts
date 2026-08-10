import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { McpPanel, type McpPanelResult } from "../src/tui/mcp-panel.js";
import type { McpStatusServer } from "../src/mcp/status.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;
const servers: McpStatusServer[] = [{
	name: "linear",
	state: "disconnected",
	transport: "http",
	directTools: false,
	tools: [
		{ name: "read", description: "Read an issue", selected: false },
		{ name: "search", description: "Search issues", selected: false },
	],
	counts: { tools: 2, resources: 0, resourceTemplates: 0, prompts: 1 },
}];

function panel() {
	let result: McpPanelResult | null | undefined;
	const subject = new McpPanel({
		theme,
		servers,
		onRender: () => undefined,
		onDone: (value) => { result = value; },
		onReconnect: async () => undefined,
		onAuthenticate: async () => "copied",
	});
	return { subject, result: () => result };
}

test("panel stages per-server disabled and direct-tool controls", () => {
	const { subject, result } = panel();
	subject.handleInput("\r"); // expand
	subject.handleInput("\x1b[B"); // first tool
	subject.handleInput(" ");
	subject.handleInput("d");
	subject.handleInput("\x13"); // ctrl+s
	assert.deepEqual(result(), { updates: { linear: { disabled: true, directTools: ["read"] } } });
});

test("tool toggles preserve configured selections absent from current metadata", () => {
	let result: McpPanelResult | null | undefined;
	const configured = [{ ...servers[0]!, directTools: ["read", "temporarily-absent"] }] as McpStatusServer[];
	const subject = new McpPanel({ theme, servers: configured, onRender: () => undefined, onDone: (value) => { result = value; }, onReconnect: async () => undefined, onAuthenticate: async () => "copied" });
	subject.handleInput("\r");
	subject.handleInput("\x1b[B");
	subject.handleInput("\x1b[B");
	subject.handleInput(" ");
	subject.handleInput("\x13");
	assert.deepEqual(result, { updates: { linear: { directTools: ["read", "search", "temporarily-absent"] } } });
});

test("server-level space toggles all direct tools", () => {
	const { subject, result } = panel();
	subject.handleInput(" ");
	subject.handleInput("\x13");
	assert.deepEqual(result(), { updates: { linear: { directTools: true } } });
});

test("panel search filters tool rows and every rendered line respects width", () => {
	const { subject } = panel();
	subject.handleInput("/");
	for (const character of "search") subject.handleInput(character);
	subject.handleInput("\r");
	const lines = subject.render(42);
	assert.match(lines.join("\n"), /search/);
	assert.doesNotMatch(lines.join("\n"), /Read an issue/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 42));
});

test("panel strips terminal control sequences from remote metadata", () => {
	const hostile: McpStatusServer[] = [{ ...servers[0]!, tools: [{ name: "read\u001b[2J", description: "safe\u001b]8;;https://evil.test\u0007link", selected: false }] }];
	const subject = new McpPanel({ theme, servers: hostile, onRender: () => undefined, onDone: () => undefined, onReconnect: async () => undefined, onAuthenticate: async () => "copied" });
	subject.handleInput("\r");
	const output = subject.render(100).join("\n");
	assert.doesNotMatch(output, /\u001b\[2J|\u001b\]8|\u0007/);
});
