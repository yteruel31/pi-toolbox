import assert from "node:assert/strict";
import test from "node:test";
import { parseHttpServerConfigs } from "../src/mcp/config.js";

test("HTTP parser preserves valid siblings and emits value-free diagnostics", () => {
	const parsed = parseHttpServerConfigs({
		mcpServers: {
			mobbin: { url: "https://api.mobbin.com/mcp" },
			local: { url: "http://127.0.0.1:1234/mcp", headers: { Authorization: "secret" } },
			bad: { url: "http://example.test/mcp?token=secret" },
			stdio: { url: "https://safe.test", transport: "stdio" },
			header: { url: "https://safe.test", headers: { Connection: "secret" } },
		},
	} as never);
	assert.deepEqual([...parsed.servers.keys()], ["mobbin", "local"]);
	assert.equal(parsed.servers.get("local")?.headers.Authorization, "secret");
	const diagnostics = JSON.stringify(parsed.diagnostics);
	assert.doesNotMatch(diagnostics, /token|secret|example\.test/);
	assert.equal(parsed.diagnostics.length, 3);
});

test("HTTP parser rejects credentials, fragments and unsafe names", () => {
	const parsed = parseHttpServerConfigs({
		mcpServers: {
			"bad name": { url: "https://safe.test" },
			credentials: { url: "https://user:pass@safe.test" },
			fragment: { url: "https://safe.test/#x" },
			ipv6: { url: "http://[::1]:1234/mcp" },
		},
	} as never);
	assert.deepEqual([...parsed.servers.keys()], ["ipv6"]);
	assert.equal(parsed.diagnostics.length, 3);
});

test("HTTP parser rejects sensitive query variants and duplicate header casing", () => {
	const parsed = parseHttpServerConfigs({
		mcpServers: {
			query: { url: "https://safe.test/mcp?api_key=MARKER" },
			headers: { url: "https://safe.test/mcp", headers: { Authorization: "one", authorization: "two" } },
			sibling: { url: "https://safe.test/mcp?mode=read" },
		},
	} as never);
	assert.deepEqual([...parsed.servers.keys()], ["sibling"]);
	assert.equal(parsed.diagnostics.length, 2);
	assert.doesNotMatch(JSON.stringify(parsed.diagnostics), /MARKER|api_key|Authorization/);
});
