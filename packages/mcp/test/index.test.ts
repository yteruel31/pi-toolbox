import assert from "node:assert/strict";
import test from "node:test";
import mcpExtension from "../src/index.js";

test("extension registers one lazy command without starting resources", () => {
	const calls: unknown[][] = [];
	mcpExtension({ registerCommand: (...arguments_: unknown[]) => calls.push(arguments_) } as never);
	assert.equal(calls.length, 1);
	assert.equal(calls[0]?.[0], "mcp-gateway");
});
