import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GatewayConfiguration } from "../src/commands.js";
import { DEFAULT_UI_SETTINGS, loadMcpConfig } from "../src/config.js";
import { writeMcpGatewaySettings } from "../src/config-writer.js";
import { GatewayClient } from "../src/gateway/client.js";
import { startGatewayServer } from "../src/gateway/server.js";
import { registerMcpTool } from "../src/runtime.js";

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

test("agent custom configuration verifies a real capability before protected persistence and preserves unrelated data", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-validated-config-"));
	const path = join(home, ".pi", "agent", "mcp.json");
	await mkdir(join(path, ".."), { recursive: true });
	const gatewayPort = await freePort();
	const initial = { keep: "unrelated", settings: { ui: { gatewayPort } }, mcpServers: { paused: { command: "node", disabled: true, env: { SECRET: "never-return" } } } };
	await writeFile(path, JSON.stringify(initial));
	const candidate = { mode: "custom", externalUrl: "https://proxy.example.test/apps", listenAddress: "127.0.0.1" } as const;
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort, basePath: "/apps", requireTailscaleIdentity: false };
	const realClient = new GatewayClient({ settings, homeDir: home, externalUrlResolver: async () => candidate.externalUrl });
	let daemon: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
	let correctChallenge = false;
	let verified = false;
	const calls: string[] = [];
	const service = new GatewayConfiguration({
		configLoader: () => loadMcpConfig({ homeDir: home }),
		writer: async (gateway, expected, beforeCommit) => { assert.equal(verified, true); calls.push("write"); return writeMcpGatewaySettings(gateway, { path, homeDir: home, expected, beforeCommit }); },
		quiesce: async () => { calls.push("quiesce"); }, resume: async () => { calls.push("resume"); },
		clientFactory: () => ({
			async shutdown() { calls.push("shutdown"); await daemon?.close(); daemon = undefined; },
			async ensure() { calls.push("ensure"); daemon = await startGatewayServer({ settings, externalUrl: candidate.externalUrl, hostname: "proxy.example.test", socketPath: realClient.socket }); },
			hello: () => realClient.hello(),
			async verify() {
				calls.push("verify");
				assert.equal(JSON.parse(await readFile(path, "utf8")).settings.gateway, undefined);
				await realClient.verify();
				assert.equal(daemon?.sessions.size, 0);
				verified = true;
			},
		}),
		tailscale: { async status() { throw new Error("Tailscale must not run"); }, async hostname() { throw new Error("Tailscale must not run"); }, async setup() { throw new Error("Tailscale must not run"); }, async remove() { throw new Error("Tailscale must not run"); } },
	});
	let tool: any;
	registerMcpTool({ registerTool: (value: unknown) => { tool = value; } } as never, () => ({}) as never, service);
	const context = { hasUI: true, ui: { async confirm() { calls.push("confirm"); return true; } } };
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input.toString());
		assert.equal(url.origin, "https://proxy.example.test");
		assert.match(url.pathname, /^\/apps\/s\/[^/]+\/proxy\/probe$/);
		assert.equal(init?.redirect, "error");
		return correctChallenge ? originalFetch(`http://127.0.0.1:${gatewayPort}${url.pathname}`, init) : new Response("wrong challenge SECRET");
	}) as typeof fetch;
	try {
		const run = () => tool.execute("setup", { action: "gateway-configure", args: candidate }, undefined, undefined, context);
		const failed = await run();
		assert.equal(failed.details.gateway.persisted, false);
		assert.equal(failed.details.gateway.rollback, "completed");
		assert.equal(failed.details.gateway.diagnostic.code, "challenge-mismatch");
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), initial);
		assert.equal(daemon, undefined);
		correctChallenge = true;
		const result = await run();
		assert.equal(result.details.gateway.persisted, true);
		assert.doesNotMatch(JSON.stringify(result), /never-return|\/s\/|proxy.example.test/);
		assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...initial, settings: { ...initial.settings, gateway: candidate } });
		assert.ok(calls.lastIndexOf("verify") < calls.indexOf("write"));
	} finally {
		globalThis.fetch = originalFetch;
		await daemon?.close();
		await rm(home, { recursive: true, force: true });
	}
});
