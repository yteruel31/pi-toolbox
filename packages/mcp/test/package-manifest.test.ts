import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("package ships runtime and conformance surfaces but excludes tests", () => {
	const packed = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: new URL("..", import.meta.url),
		encoding: "utf8",
	});
	assert.equal(packed.status, 0, packed.stderr);
	const report = JSON.parse(packed.stdout) as Array<{ files: Array<{ path: string; size: number }> }>;
	const files = report[0]?.files ?? [];
	const paths = files.map(({ path }) => path);
	for (const required of [
		"package.json",
		"README.md",
		"PARITY.md",
		"scripts/check-conformance.mjs",
		"scripts/build-mcp-ui-css.mjs",
		"src/index.ts",
		"src/mcp/manager.ts",
		"src/ui/mcp-ui.css",
		"src/ui/generated/mcp-ui.css",
	]) assert.ok(paths.includes(required), `package is missing ${required}`);
	assert.equal(paths.some((path) => path === "test" || path.startsWith("test/")), false);
	assert.ok(files.length < 100, `package file count is unexpectedly large: ${files.length}`);
	assert.ok(files.reduce((total, file) => total + file.size, 0) < 2_000_000, "package exceeds 2 MB unpacked");
});

test("committed MCP UI stylesheet is reproducible and fresh", () => {
	const checked = spawnSync("npm", ["run", "check:ui-css"], {
		cwd: new URL("..", import.meta.url),
		encoding: "utf8",
	});
	assert.equal(checked.status, 0, checked.stderr || checked.stdout);
});
