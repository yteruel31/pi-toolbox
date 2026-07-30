import assert from "node:assert/strict";
import { chmod, mkdtemp, lstat, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DirectToolRegistry } from "../src/mcp/direct-tools.js";
import { MetadataCache } from "../src/mcp/metadata-cache.js";
import { McpServerManager } from "../src/mcp/manager.js";

const config = { name: "safe", transport: "http" as const, url: new URL("https://user.example/secret-endpoint"), headers: { Authorization: "Bearer top-secret" } };
const metadata = { tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" as const } }], prompts: [], instructions: "bounded", counts: { tools: 1, resources: 2, resourceTemplates: 0, prompts: 0 } };
async function directory() { return mkdtemp(join(tmpdir(), "pi-metadata-")); }

test("metadata cache supports cold/warm loads without storing configuration secrets and uses private modes", async () => {
	const root = await directory(); const path = join(root, "metadata"); const cache = new MetadataCache(path);
	assert.equal(cache.load(config).status, "missing"); await cache.save(config, metadata);
	const loaded = cache.load(config); assert.equal(loaded.status, "fresh"); assert.equal(loaded.metadata?.tools[0]?.name, "echo");
	const files = (await import("node:fs/promises")).readdir(path); const file = (await files)[0]!; const plaintext = await readFile(join(path, file), "utf8");
	assert.doesNotMatch(plaintext, /user\.example|secret-endpoint|top-secret|Authorization/);
	assert.equal((await lstat(path)).mode & 0o777, 0o700); assert.equal((await lstat(join(path, file))).mode & 0o777, 0o600);
});

test("cache rejects fingerprint mismatch, expiry, corruption, and symlinks", async () => {
	const root = await directory(); let now = 1_000; const path = join(root, "metadata"); const cache = new MetadataCache(path, () => now);
	await cache.save(config, metadata); assert.equal(cache.load({ ...config, headers: { Authorization: "changed" } }).status, "missing");
	now += 8 * 24 * 60 * 60 * 1_000; assert.equal(cache.load(config).status, "stale");
	const files = await (await import("node:fs/promises")).readdir(path); const file = join(path, files[0]!);
	await chmod(file, 0o644); assert.equal(cache.load(config).status, "missing"); await chmod(file, 0o600);
	const future = JSON.parse(await readFile(file, "utf8")); future.writtenAt = now + 120_000; await writeFile(file, JSON.stringify(future), { mode: 0o600 }); assert.equal(cache.load(config).status, "stale");
	await writeFile(file, "{"); assert.equal(cache.load(config).status, "missing");
	const unsafe = join(root, "link"); await symlink(path, unsafe); assert.equal(new MetadataCache(unsafe).load(config).status, "missing");
});

test("a warm cache hydrates disconnected direct-tool metadata without network", async () => {
	const cache = new MetadataCache(join(await directory(), "metadata")); await cache.save(config, metadata);
	const manager = new McpServerManager([config], undefined, {}, cache);
	assert.equal(manager.get("safe")?.state, "disconnected"); assert.equal(manager.modelTool("safe", "echo")?.name, "echo");
	await manager.close();
});

test("a warm cache registers configured direct tools without network", async () => {
	const cache = new MetadataCache(join(await directory(), "metadata")); await cache.save(config, metadata);
	const manager = new McpServerManager([{ ...config, directTools: true }], undefined, {}, cache);
	const registered: Array<{ name: string }> = []; let active = ["mcp"];
	const registry = new DirectToolRegistry({
		registerTool: (tool: { name: string }) => { registered.push(tool); },
		getAllTools: () => [{ name: "mcp" }, ...registered],
		getActiveTools: () => active,
		setActiveTools: (names: string[]) => { active = names; },
	} as never);
	const runtime = {
		manager,
		serverConfigs: new Map([["safe", { ...config, directTools: true }]]),
		config: { settings: { directTools: false } },
		executeDirect: async () => ({ content: [{ type: "text", text: "unused" }], details: {} }),
	} as never;
	registry.attach(runtime);
	assert.deepEqual(registered.map((tool) => tool.name), ["safe_echo"]);
	assert.ok(active.includes("safe_echo"));
	registry.detach(runtime);
	await manager.close();
});

test("concurrent atomic writers leave one complete validated record", async () => {
	const path = join(await directory(), "metadata"); const cache = new MetadataCache(path);
	await Promise.all(Array.from({ length: 20 }, (_, index) => cache.save(config, { ...metadata, instructions: `writer-${index}` })));
	const loaded = cache.load(config); assert.equal(loaded.status, "fresh"); assert.match(loaded.metadata?.instructions ?? "", /^writer-\d+$/);
});
