import assert from "node:assert/strict";
import test from "node:test";
import { registerMcpCommand } from "../src/mcp-command.js";
import { DEFAULT_UI_SETTINGS } from "../src/config.js";
import { McpRuntime } from "../src/runtime.js";

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

test("/mcp closes its overlay before handing off to the gateway panel", async () => {
	const runtime = new McpRuntime({ mcpServers: {}, settings: { ui: { ...DEFAULT_UI_SETTINGS } }, diagnostics: [] });
	let handler: ((args: string, context: any) => Promise<void>) | undefined;
	let activeOverlays = 0;
	let gatewayOpened = 0;
	registerMcpCommand({
		registerCommand(_name: string, definition: { handler: typeof handler }) { handler = definition.handler; },
	} as never, () => runtime, async () => {
		assert.equal(activeOverlays, 0, "the MCP overlay must be disposed before gateway setup opens");
		gatewayOpened++;
	});
	const context = {
		mode: "tui",
		ui: {
			theme,
			custom(factory: any) {
				activeOverlays++;
				return new Promise((resolve) => {
					const panel = factory({ requestRender() {} }, theme, {}, (value: unknown) => {
						activeOverlays--;
						resolve(value);
					});
					panel.handleInput("g");
				});
			},
			notify() {},
		},
	};
	try {
		assert.ok(handler);
		await handler("", context);
		assert.equal(gatewayOpened, 1);
		assert.equal(activeOverlays, 0);
	} finally {
		await runtime.close();
	}
});
