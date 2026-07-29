import assert from "node:assert/strict";
import test from "node:test";

import mcpExtension from "../src/index.js";

test("extension entrypoint remains lifecycle-idle", () => {
	const api = new Proxy({}, { get: () => { throw new Error("extension API must remain untouched"); } });
	assert.equal(mcpExtension(api as never), undefined);
});
