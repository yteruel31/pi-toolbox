import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("tsx remains a root and MCP runtime dependency", async () => {
	const root = new URL("../../..", import.meta.url);
	const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
	const mcpManifest = JSON.parse(await readFile(new URL("packages/mcp/package.json", root), "utf8")) as { dependencies?: Record<string, string> };
	const lock = JSON.parse(await readFile(new URL("package-lock.json", root), "utf8")) as { packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; dev?: boolean }> };
	assert.ok(manifest.dependencies?.tsx, "root package must declare tsx as a runtime dependency");
	assert.equal(manifest.devDependencies?.tsx, undefined, "root package must not duplicate tsx as a dev dependency");
	assert.ok(mcpManifest.dependencies?.tsx, "MCP package must declare tsx as a runtime dependency");
	assert.ok(lock.packages?.[""]?.dependencies?.tsx, "lock root must record tsx as a runtime dependency");
	assert.equal(lock.packages?.[""]?.devDependencies?.tsx, undefined, "lock root must not record tsx as a dev dependency");
	assert.equal(lock.packages?.["node_modules/tsx"]?.dev, undefined, "locked tsx package must not be dev-only");
});

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
