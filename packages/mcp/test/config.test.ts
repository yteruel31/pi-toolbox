import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_UI_SETTINGS, getMcpConfigPaths, loadMcpConfig } from "../src/config.js";

function homeWith(xdg: unknown, pi?: unknown): string {
	const home = mkdtempSync(join(tmpdir(), "pi-mcp-"));
	const [xdgPath, piPath] = getMcpConfigPaths(home);
	mkdirSync(join(xdgPath, ".."), { recursive: true });
	writeFileSync(xdgPath, typeof xdg === "string" ? xdg : JSON.stringify(xdg));
	if (pi !== undefined) {
		mkdirSync(join(piPath, ".."), { recursive: true });
		writeFileSync(piPath, typeof pi === "string" ? pi : JSON.stringify(pi));
	}
	return home;
}

test("uses defaults when files are missing", () => {
	const result = loadMcpConfig({ homeDir: join(tmpdir(), "definitely-missing-pi-mcp") });
	assert.deepEqual(result.settings.ui, DEFAULT_UI_SETTINGS);
	assert.deepEqual(result.diagnostics, []);
});

test("merges server maps and lets Pi replace matching names and augment UI", () => {
	const home = homeWith(
		{ mcpServers: { shared: { command: "lower", secret: "lower-secret" }, lower: { url: "https://lower" } }, settings: { ui: { hostname: "gateway.example", httpsPort: 9443 } } },
		{ mcpServers: { shared: { url: "https://upper" }, upper: { transport: "future" } }, settings: { ui: { gatewayPort: 20000 } } },
	);
	const result = loadMcpConfig({ homeDir: home });
	assert.deepEqual({ ...result.mcpServers }, { shared: { url: "https://upper" }, lower: { url: "https://lower" }, upper: { transport: "future" } });
	assert.equal(result.settings.ui.hostname, "gateway.example");
	assert.equal(result.settings.ui.httpsPort, 9443);
	assert.equal(result.settings.ui.gatewayPort, 20000);
});

test("normalizes safe paths and treats path text literally without expansion", () => {
	const home = homeWith({ settings: { ui: { basePath: "/apps/mcp/" } } });
	assert.equal(loadMcpConfig({ homeDir: home }).settings.ui.basePath, "/apps/mcp");
	const paths = getMcpConfigPaths("/tmp/home;touch PWNED/$HOME");
	assert.equal(paths[0], "/tmp/home;touch PWNED/$HOME/.config/mcp/mcp.json");
});

test("invalid upper UI does not discard servers or valid lower UI", () => {
	const home = homeWith(
		{ mcpServers: { lower: { token: "do-not-leak" } }, settings: { ui: { hostname: "safe.example", basePath: "/safe" } } },
		{ mcpServers: { upper: { token: "another-secret" } }, settings: { ui: { httpsPort: 70000, basePath: "/../bad" } } },
	);
	const result = loadMcpConfig({ homeDir: home });
	assert.equal(result.settings.ui.hostname, "safe.example");
	assert.equal(result.settings.ui.basePath, "/safe");
	assert.deepEqual(Object.keys(result.mcpServers).sort(), ["lower", "upper"]);
	assert.equal(result.diagnostics[0]?.code, "invalid-ui");
	assert.doesNotMatch(JSON.stringify(result.diagnostics), /do-not-leak|another-secret|70000/);
});

test("isolates invalid servers while retaining valid definitions", () => {
	const result = loadMcpConfig({ homeDir: homeWith({ mcpServers: { good: { command: "opaque" }, bad: "nope", alsoBad: [] } }) });
	assert.deepEqual(Object.keys(result.mcpServers), ["good"]);
	assert.equal(result.diagnostics.filter((item) => item.code === "invalid-server").length, 2);
});

test("malformed JSON and invalid roots are diagnostic, not fatal", () => {
	assert.equal(loadMcpConfig({ homeDir: homeWith("{oops") }).diagnostics[0]?.code, "invalid-json");
	assert.equal(loadMcpConfig({ homeDir: homeWith([]) }).diagnostics[0]?.code, "invalid-top-level");
});

test("rejects prototype-pollution keys recursively without exposing values", () => {
	const raw = '{"mcpServers":{"safe":{"url":"ok"},"poison":{"nested":{"__proto__":{"token":"SUPERSECRET"}}}},"settings":{"ui":{"constructor":"SUPERSECRET"}}}';
	const result = loadMcpConfig({ homeDir: homeWith(raw) });
	assert.deepEqual(Object.keys(result.mcpServers), ["safe"]);
	assert.equal(result.settings.ui.hostname, "auto");
	assert.ok(result.diagnostics.some((item) => item.code === "unsafe-key"));
	assert.doesNotMatch(JSON.stringify(result.diagnostics), /SUPERSECRET|"url":"ok"/);
	assert.equal(({} as { token?: string }).token, undefined);
});

test("validates every UI field", () => {
	const invalid = [
		{ hostname: "bad host" }, { httpsPort: 0 }, { gatewayPort: 65536 }, { basePath: "relative" },
		{ requireTailscaleIdentity: "true" }, { idleTimeoutMs: 0 }, { idleTimeoutMs: 86_400_001 }, { unknown: true },
	];
	for (const ui of invalid) {
		const result = loadMcpConfig({ homeDir: homeWith({ settings: { ui } }) });
		assert.deepEqual(result.settings.ui, DEFAULT_UI_SETTINGS);
		assert.equal(result.diagnostics[0]?.code, "invalid-ui");
	}
});
