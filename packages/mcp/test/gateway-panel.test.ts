import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GatewayPanel, type GatewayPanelResult } from "../src/tui/gateway-panel.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

function subject(gateway?: any) {
	let result: GatewayPanelResult | null | undefined;
	const panel = new GatewayPanel({ theme, gateway, onRender: () => undefined, onDone: (value) => { result = value; } });
	return { panel, result: () => result };
}

test("gateway panel exposes configure, diagnose, remove, and cancel actions", () => {
	for (const [key, expected] of [["t", "tailscale"], ["c", "custom"], ["d", "diagnose"], ["x", "remove"]] as const) {
		const current = subject(); current.panel.handleInput(key); assert.deepEqual(current.result(), { action: expected });
	}
	const cancelled = subject(); cancelled.panel.handleInput("\x1b"); assert.equal(cancelled.result(), null);
	const selected = subject(); selected.panel.handleInput("\x1b[B"); selected.panel.handleInput("\r"); assert.deepEqual(selected.result(), { action: "custom" });
});

test("gateway panel sanitizes configured text and bounds every rendered line", () => {
	const current = subject({ mode: "custom", externalUrl: "https://safe.test/\u001b]52;c;bad\u0007\u202e", listenAddress: "127.0.0.1\u0007" });
	const output = current.panel.render(48);
	assert.ok(output.every((line) => visibleWidth(line) <= 48));
	assert.doesNotMatch(output.join("\n"), /\u001b\]52|\u0007|\u202e/);
});
