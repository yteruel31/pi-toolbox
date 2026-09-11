import assert from "node:assert/strict";
import test from "node:test";
import { registerMcpCommand } from "../src/mcp-command.js";
import { DEFAULT_UI_SETTINGS } from "../src/config.js";
import { McpRuntime } from "../src/runtime.js";
import { GatewayConfiguration } from "../src/commands.js";
import { GatewayDiagnosticError } from "../src/gateway/diagnostics.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

test("runtime enables publication only for explicit Tailscale and custom modes", async () => {
	for (const gateway of [
		undefined,
		{ mode: "tailscale" } as const,
		{ mode: "custom", externalUrl: "https://mcp.example.test", listenAddress: "127.0.0.1" } as const,
	]) {
		const runtime = new McpRuntime(
			{ mcpServers: {}, settings: { ui: { ...DEFAULT_UI_SETTINGS }, gateway }, diagnostics: [] },
			undefined, undefined, undefined,
			{
				publishApps: false,
				gateway: { verify: async () => undefined } as never,
				tailscale: { status: async () => ({ state: "matching", target: "loopback" }), hostname: async () => "node.ts.net" } as never,
			},
		);
		try {
			assert.equal(runtime.gatewayConfigured, gateway !== undefined);
			assert.equal(runtime.coordinator !== undefined, gateway !== undefined);
			assert.equal(runtime.publisher, undefined);
		} finally { await runtime.close(); }
	}
});

test("/mcp closes its overlay before sending Custom setup to the current agent", async () => {
	const runtime = new McpRuntime({ mcpServers: {}, settings: { ui: { ...DEFAULT_UI_SETTINGS } }, diagnostics: [] });
	let handler: ((args: string, context: any) => Promise<void>) | undefined;
	let activeOverlays = 0;
	let sent = 0;
	registerMcpCommand({
		registerCommand(_name: string, definition: { handler: typeof handler }) { handler = definition.handler; },
		sendUserMessage(prompt: string, options: unknown) {
			assert.equal(activeOverlays, 0, "the modal must be disposed before message injection");
			assert.match(prompt, /Traefik or another proxy/);
			assert.deepEqual(options, { deliverAs: "followUp" });
			sent++;
		},
	} as never, () => runtime, new GatewayConfiguration({ configLoader: () => runtime.config }));
	const context = {
		mode: "tui",
		ui: {
			theme,
			custom(factory: any) {
				activeOverlays++;
				return new Promise((resolve) => {
					const panel = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, (value: unknown) => {
						activeOverlays--;
						resolve(value);
					});
					panel.handleInput("g");
					assert.equal(activeOverlays, 1);
					panel.handleInput("c");
				});
			},
			notify() {},
		},
	};
	try {
		assert.ok(handler);
		await handler("", context);
		assert.equal(sent, 1);
		assert.equal(activeOverlays, 0);
	} finally {
		await runtime.close();
	}
});

test("/mcp sends an explicit sanitized repair prompt only after the modal closes", async () => {
	const runtime = new McpRuntime({ mcpServers: {}, settings: { ui: { ...DEFAULT_UI_SETTINGS } }, diagnostics: [] });
	const gateway = new GatewayConfiguration({
		configLoader: () => ({ ...runtime.config, settings: { ...runtime.config.settings, gateway: { mode: "custom", externalUrl: "https://PRIVATE.example/s/SECRET", listenAddress: "127.0.0.1" } } }),
		clientFactory: () => ({ async ensure() {}, async hello() {}, async shutdown() {}, async verify() { throw new GatewayDiagnosticError("tls-failed"); } }),
	});
	await gateway.validate();
	let handler: any;
	let active = false;
	let sent = 0;
	let action = "f";
	registerMcpCommand({
		registerCommand(_name: string, definition: any) { handler = definition.handler; },
		sendUserMessage(prompt: string) {
			assert.equal(active, false);
			assert.match(prompt, /tls-failed/);
			assert.match(prompt, /explicit agreement/);
			assert.doesNotMatch(prompt, /PRIVATE|SECRET/);
			sent++;
		},
	} as never, () => runtime, gateway);
	const context = { mode: "tui", ui: { notify() {}, custom(factory: any) {
		active = true;
		return new Promise((resolve) => {
			const panel = factory({ requestRender() {}, terminal: { rows: 30 } }, theme, {}, (value: unknown) => { active = false; resolve(value); });
			panel.handleInput("g");
			panel.handleInput(action);
		});
	} } };
	try {
		await handler("", context);
		assert.equal(sent, 1);
		action = "\x1b";
		await handler("", context);
		assert.equal(sent, 1, "closing the modal must not request a repair");
	} finally { await runtime.close(); }
});
