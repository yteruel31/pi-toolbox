import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_UI_SETTINGS } from "../src/config.js";
import { TailscaleAdapter } from "../src/tailscale.js";

const settings = { ...DEFAULT_UI_SETTINGS };
function serveStatus(proxy?: string, extra: Record<string, unknown> = {}) {
	return {
		Web: {
			"node.ts.net:8443": {
				Handlers: {
					"/nutritrack/": { Path: "/srv/nutritrack-builds" },
					...(proxy === undefined ? {} : { "/mcp-ui": { Proxy: proxy } }),
					...extra,
				},
			},
		},
	};
}

test("realistic Serve status distinguishes absent, matching, and conflicting exact routes", async () => {
	for (const [proxy, expected] of [[undefined, "absent"], ["http://127.0.0.1:19877", "matching"], ["http://127.0.0.1:9", "conflicting"]] as const) {
		const adapter = new TailscaleAdapter(async () => ({ stdout: JSON.stringify(serveStatus(proxy)) }));
		assert.equal((await adapter.status(settings)).state, expected);
	}
});

test("normalized route forms must resolve to the same proxy target", async () => {
	for (const [extra, expected] of [
		[{ "/mcp-ui/": { Proxy: "http://127.0.0.1:19877" } }, "matching"],
		[{ "/mcp-ui/": { Proxy: "http://127.0.0.1:9" } }, "conflicting"],
		[{ "/mcp-ui/": { Path: "/srv/not-a-proxy" } }, "conflicting"],
	] as const) {
		const adapter = new TailscaleAdapter(async () => ({
			stdout: JSON.stringify(serveStatus("http://127.0.0.1:19877", extra)),
		}));
		assert.equal((await adapter.status(settings)).state, expected);
	}
});

test("duplicate handlers on the selected HTTPS port cannot hide a conflict", async () => {
	const base = serveStatus("http://127.0.0.1:19877");
	const status = {
		...base,
		Web: {
			...base.Web,
			"other.ts.net:8443": { Handlers: { "/mcp-ui/": { Proxy: "http://127.0.0.1:9" } } },
		},
	};
	const adapter = new TailscaleAdapter(async () => ({ stdout: JSON.stringify(status) }));
	assert.equal((await adapter.status(settings)).state, "conflicting");
});

test("setup preserves unrelated handlers and uses exact non-destructive argv", async () => {
	const calls: string[][] = [];
	const adapter = new TailscaleAdapter(async (args) => {
		calls.push([...args]);
		return { stdout: JSON.stringify(serveStatus()) };
	});
	assert.equal(await adapter.setup(settings), "absent");
	assert.deepEqual(calls, [
		["serve", "status", "--json"],
		["serve", "--bg", "--https=8443", "--set-path=/mcp-ui", "http://127.0.0.1:19877"],
	]);
	assert.ok(calls.flat().every((argument) => !["reset", "clear", "funnel"].includes(argument)));
});

test("matching setup is idempotent and exact removal uses off", async () => {
	const calls: string[][] = [];
	const adapter = new TailscaleAdapter(async (args) => {
		calls.push([...args]);
		return { stdout: JSON.stringify(serveStatus("http://127.0.0.1:19877")) };
	});
	assert.equal(await adapter.setup(settings), "matching");
	assert.equal(await adapter.remove(settings), "matching");
	assert.deepEqual(calls.at(-1), ["serve", "--https=8443", "--set-path=/mcp-ui", "off"]);
});

test("conflicts, malformed status, and binary failures never mutate", async () => {
	const calls: string[][] = [];
	const conflict = new TailscaleAdapter(async (args) => {
		calls.push([...args]);
		return { stdout: JSON.stringify(serveStatus("http://127.0.0.1:9")) };
	});
	await assert.rejects(conflict.setup(settings), /owned/);
	await assert.rejects(conflict.remove(settings), /Refusing/);
	assert.ok(calls.every((call) => call.join(" ") === "serve status --json"));
	await assert.rejects(new TailscaleAdapter(async () => ({ stdout: "{" })).status(settings), /Malformed/);
	await assert.rejects(new TailscaleAdapter(async () => { throw new Error("secret command output"); }).status(settings), /unavailable/);
});
