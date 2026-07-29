import assert from "node:assert/strict";
import test from "node:test";
import { parseServerConfigs } from "../src/mcp/config.js";

test("server parser preserves valid URL siblings and emits value-free diagnostics", () => {
	const parsed = parseServerConfigs({
		mcpServers: {
			mobbin: { url: "https://api.mobbin.com/mcp" },
			local: { url: "http://127.0.0.1:1234/mcp", headers: { Authorization: "secret" } },
			bad: { url: "http://example.test/mcp?token=secret" },
			stdio: { url: "https://safe.test", transport: "stdio" },
			header: { url: "https://safe.test", headers: { Connection: "secret" } },
		},
	} as never);
	assert.deepEqual([...parsed.servers.keys()], ["mobbin", "local"]);
	const local = parsed.servers.get("local");
	assert.ok(local && local.transport !== "stdio");
	assert.equal(local.headers.Authorization, "secret");
	const diagnostics = JSON.stringify(parsed.diagnostics);
	assert.doesNotMatch(diagnostics, /token|secret|example\.test/);
	assert.equal(parsed.diagnostics.length, 3);
});

test("parser accepts stdio and SSE while isolating malformed or ambiguous siblings", () => {
	const parsed = parseServerConfigs({ mcpServers: {
		stdio: { command: "node", args: ["fixture.js"], env: { TOKEN: "MARKER" }, cwd: "/tmp", transport: "stdio" },
		sse: { url: "https://safe.test/sse", transport: "sse" },
		auto: { url: "https://safe.test/mcp" },
		ambiguous: { command: "node", url: "https://safe.test" },
		badArgs: { command: "node", args: [1] },
		unknown: { command: "node", shell: true },
	} } as never);
	assert.deepEqual([...parsed.servers.keys()], ["stdio", "sse", "auto"]);
	assert.equal(parsed.servers.get("stdio")?.transport, "stdio");
	assert.equal(parsed.servers.get("sse")?.transport, "sse");
	assert.equal(parsed.servers.get("auto")?.transport, "auto");
	assert.equal(parsed.diagnostics.length, 3);
	assert.doesNotMatch(JSON.stringify(parsed.diagnostics), /MARKER|node|fixture|\/tmp/);
});

test("server parser rejects URL credentials, fragments and unsafe names", () => {
	const parsed = parseServerConfigs({
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

test("server parser rejects sensitive query variants and duplicate header casing", () => {
	const parsed = parseServerConfigs({
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
