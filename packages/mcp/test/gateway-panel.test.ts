import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GatewayPanel, type GatewayPanelResult } from "../src/tui/gateway-panel.js";
import { ConfigurationPanel } from "../src/tui/configuration-panel.js";
import { gatewayDiagnostic } from "../src/gateway/diagnostics.js";

const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
function subject() {
	let result: GatewayPanelResult | null | undefined;
	const panel = new GatewayPanel({ theme, report: { mode: "unconfigured", state: "unconfigured" }, onRender() {}, onDone: (value) => { result = value; } });
	return { panel, result: () => result };
}
test("gateway section exposes configuration, validation, repair and deactivation", () => {
	for (const [key, expected] of [["t", "tailscale"], ["c", "custom"], ["d", "diagnose"], ["f", "repair"], ["x", "remove"]] as const) {
		const current = subject(); current.panel.handleInput(key); assert.deepEqual(current.result(), { action: expected });
	}
	const selected = subject(); selected.panel.handleInput("\x1b[B"); selected.panel.handleInput("\r"); assert.deepEqual(selected.result(), { action: "custom" });
});
test("gateway section keeps selected actions visible within compact dimensions", () => {
	const current = subject();
	for (const width of [1, 24, 48, 80]) for (const height of [5, 9, 14]) {
		for (let index = 0; index < 5; index++) {
			const output = current.panel.render(width, height);
			assert.ok(output.length <= height);
			assert.ok(output.every((line) => visibleWidth(line) <= width));
			current.panel.handleInput("\x1b[B");
		}
	}
});
function unified(options: { configured?: boolean; maxRows?: number; servers?: any[]; validate?: () => Promise<any> } = {}) {
	let result: unknown;
	let disposed = 0;
	const panel = new ConfigurationPanel({ theme, report: { mode: options.configured ? "tailscale" : "unconfigured", state: "configured" },
		servers: options.servers ?? [], gatewayConfigured: options.configured, maxRows: () => options.maxRows ?? 24,
		onReconnect: async () => {}, onAuthenticate: async () => "done", onRender() {}, onDone: (value) => { result = value; }, onDispose: () => { disposed++; },
		onValidate: options.validate ?? (async () => ({ mode: "tailscale", state: "failed", diagnostic: gatewayDiagnostic("tailscale-route", "route-conflict") })),
	});
	return { panel, result: () => result, disposed: () => disposed };
}
test("unified panel always offers Gateway and Diagnostics and closes only on explicit handoff", async () => {
	for (const configured of [false, true]) {
		const current = unified({ configured });
		current.panel.handleInput("g");
		assert.match(current.panel.render(80).join("\n"), /Tailscale/);
		assert.equal(current.result(), undefined);
		current.panel.handleInput("c");
		assert.deepEqual(current.result(), { action: "custom" });
		assert.equal(current.disposed(), 1);
		current.panel.dispose();
		current.panel.handleInput("f");
		assert.equal(current.disposed(), 1);
	}
});
test("diagnostic validation stays in the unified modal; repair is explicit", async () => {
	const current = unified();
	current.panel.handleInput("\t");
	current.panel.handleInput("d");
	await new Promise((resolve) => setImmediate(resolve));
	const rendered = current.panel.render(80).join("\n");
	assert.match(rendered, /route-conflict/);
	assert.match(rendered, /Another handler/);
	assert.equal(current.result(), undefined);
	current.panel.handleInput("f");
	assert.deepEqual(current.result(), { action: "repair" });
});
test("unified panel preserves staged server edits across tabs and blocks accidental handoff", () => {
	const current = unified({ servers: [{ name: "example", state: "connected", transport: "stdio", directTools: false, counts: { tools: 0, resources: 0, resourceTemplates: 0, prompts: 0 }, tools: [] }] });
	current.panel.handleInput("d");
	current.panel.handleInput("/");
	current.panel.handleInput("\t");
	current.panel.handleInput("c");
	assert.equal(current.result(), undefined);
	assert.match(current.panel.render(80).join("\n"), /Save server changes/);
	current.panel.handleInput("\x13");
	assert.deepEqual(current.result(), { updates: { example: { disabled: true } } });
});
test("g is nonterminal: staged edits can save and Servers remains responsive after returning", () => {
	const current = unified({ servers: [{ name: "example", state: "connected", transport: "stdio", directTools: false, counts: { tools: 0, resources: 0, resourceTemplates: 0, prompts: 0 }, tools: [] }] });
	current.panel.handleInput("d");
	current.panel.handleInput("g");
	current.panel.handleInput("\x13");
	assert.deepEqual(current.result(), { updates: { example: { disabled: true } } });
	const returned = unified();
	returned.panel.handleInput("g");
	returned.panel.handleInput("\x1b[Z");
	returned.panel.handleInput("\x1b");
	assert.equal(returned.result(), null);
});

test("compact modal bounds lines and rows across sections and terminal resizing", async () => {
	for (const maxRows of [8, 14, 24, 26]) {
		const current = unified({ maxRows });
		for (let tab = 0; tab < 3; tab++) {
			for (const width of [1, 24, 48, 80, 120]) {
				const lines = current.panel.render(width);
				assert.ok(lines.length <= maxRows, `${lines.length} > ${maxRows}`);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
			}
			current.panel.handleInput("\t");
		}
	}
});
