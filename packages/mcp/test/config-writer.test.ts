import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { afterEach } from "node:test";
import { writeMcpGatewaySettings, writeMcpServerControls } from "../src/config-writer.js";

const execFileAsync = promisify(execFile);
const child = fileURLToPath(new URL("./fixtures/config-writer-child.ts", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function temporaryHome(): string { const home = mkdtempSync(join(tmpdir(), "pi-mcp-writer-")); homes.push(home); return home; }

test("writer preserves unknown data and existing permissions while changing only controls", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify({ custom: { keep: true }, mcpServers: { local: { command: "node", args: ["server.js"], unknown: "keep" } } }), { mode: 0o640 });
	await writeMcpServerControls({ local: { disabled: true, directTools: ["read"] } }, { path });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		custom: { keep: true },
		mcpServers: { local: { command: "node", args: ["server.js"], unknown: "keep", disabled: true, directTools: ["read"] } },
	});
	assert.equal(statSync(path).mode & 0o777, 0o640);
});

test("gateway writer narrowly replaces and removes settings.gateway", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify({ keep: { value: true }, settings: { directTools: true, unknown: "keep", gateway: { mode: "tailscale" } }, mcpServers: { local: { command: "node" } } }), { mode: 0o640 });
	await writeMcpGatewaySettings({ mode: "custom", externalUrl: "https://mcp.example.test/apps", listenAddress: "127.0.0.1" }, { path });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		keep: { value: true },
		settings: { directTools: true, unknown: "keep", gateway: { mode: "custom", externalUrl: "https://mcp.example.test/apps", listenAddress: "127.0.0.1" } },
		mcpServers: { local: { command: "node" } },
	});
	assert.equal(statSync(path).mode & 0o777, 0o640);
	await writeMcpGatewaySettings({ externalUrl: "https://mcp.example.test/canonical/", listenAddress: "127.0.0.1", mode: "custom" } as never, { path });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).settings.gateway, {
		mode: "custom", externalUrl: "https://mcp.example.test/canonical", listenAddress: "127.0.0.1",
	});
	await writeMcpGatewaySettings(undefined, { path });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).settings, { directTools: true, unknown: "keep" });
});

test("gateway writer validates candidates and composes with queued server updates", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	await assert.rejects(writeMcpGatewaySettings({ mode: "custom", externalUrl: "http://unsafe.test", listenAddress: "127.0.0.1" } as never, { path }), /invalid/);
	await Promise.all([
		writeMcpGatewaySettings({ mode: "tailscale" }, { path }),
		writeMcpServerControls({ one: { disabled: true } }, { path }),
	]);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { settings: { gateway: { mode: "tailscale" } }, mcpServers: { one: { disabled: true } } });
});

test("writer creates bounded control-only overlays in private mode", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	await writeMcpServerControls({ shared: { disabled: false, directTools: false } }, { homeDir: home });
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { mcpServers: { shared: { disabled: false, directTools: false } } });
	assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("writer refuses malformed files and leaves them unchanged", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "{broken", { mode: 0o600 });
	await assert.rejects(writeMcpServerControls({ shared: { disabled: true } }, { path }), /not valid JSON/);
	assert.equal(readFileSync(path, "utf8"), "{broken");
});

test("writer rejects unsafe controls and non-finite unknown numbers without changing the file", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, '{"unknown":1e400}');
	await assert.rejects(writeMcpServerControls({ safe: { disabled: true } }, { path }), /unsafe number/);
	writeFileSync(path, '{"unknown":9007199254740993}');
	await assert.rejects(writeMcpServerControls({ safe: { disabled: true } }, { path }), /unsafe number/);
	await assert.rejects(writeMcpServerControls({ prototype: { disabled: true } }, { path }), /name is invalid/);
	await assert.rejects(writeMcpServerControls({ safe: { disabled: true, extra: true } as never }, { path }), /controls are invalid/);
	assert.equal(readFileSync(path, "utf8"), '{"unknown":9007199254740993}');
});

test("writer refuses symlink targets and parent directories", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	const outside = join(home, "outside.json");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(outside, JSON.stringify({ keep: true }));
	symlinkSync(outside, path);
	await assert.rejects(writeMcpServerControls({ shared: { disabled: true } }, { path }), /unsafe/);
	assert.deepEqual(JSON.parse(readFileSync(outside, "utf8")), { keep: true });

	const symlinkedHome = temporaryHome();
	const realAgent = join(symlinkedHome, "real-agent");
	mkdirSync(realAgent);
	mkdirSync(join(symlinkedHome, ".pi"));
	symlinkSync(realAgent, join(symlinkedHome, ".pi", "agent"));
	await assert.rejects(writeMcpServerControls({ shared: { disabled: true } }, { homeDir: symlinkedHome }), /directory is unsafe/);
	assert.equal(existsSync(join(realAgent, "agent")), false, "rejected symlink must not create directories in its target");

	const symlinkedPiHome = temporaryHome();
	const realPi = join(symlinkedPiHome, "real-pi");
	mkdirSync(join(realPi, "agent"), { recursive: true });
	symlinkSync(realPi, join(symlinkedPiHome, ".pi"));
	await assert.rejects(writeMcpServerControls({ shared: { disabled: true } }, { homeDir: symlinkedPiHome }), /directory is unsafe/);
	assert.equal(existsSync(join(realPi, "agent", "mcp.json")), false, "a symlinked ancestor must not receive the configuration file");
});

test("non-cooperating writes are detected and merged on retry", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify({ padding: "x".repeat(900_000), mcpServers: {} }));
	let timer: NodeJS.Timeout;
	const external = new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + 5_000;
		timer = setInterval(() => {
			try {
				const temporaryExists = readdirSync(join(path, "..")).some((name) => name.startsWith("mcp.json.") && name.endsWith(".tmp"));
				if (temporaryExists) {
					clearInterval(timer);
					writeFileSync(path, JSON.stringify({ external: { keep: true }, mcpServers: { remote: { url: "https://safe.test", headers: { Authorization: "Bearer REDACTED_NEW" } } } }));
					resolve();
				} else if (Date.now() >= deadline) { clearInterval(timer); reject(new Error("temporary file was not observed")); }
			} catch (error) { clearInterval(timer); reject(error); }
		}, 1);
	});
	await Promise.all([writeMcpServerControls({ panel: { disabled: true } }, { path }), external]);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		external: { keep: true },
		mcpServers: {
			remote: { url: "https://safe.test", headers: { Authorization: "Bearer REDACTED_NEW" } },
			panel: { disabled: true },
		},
	});
});

test("pre-existing lock files fail closed instead of unsafe stale reclamation", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, JSON.stringify({ keep: true }));
	writeFileSync(`${path}.lock`, JSON.stringify({ pid: 999_999_999, token: "stale" }), { mode: 0o600 });
	await assert.rejects(writeMcpServerControls({ safe: { disabled: true } }, { path }), /busy/);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { keep: true });
});

test("queued updates compose instead of overwriting each other", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	await Promise.all([
		writeMcpServerControls({ one: { disabled: true } }, { path }),
		writeMcpServerControls({ two: { directTools: ["search"] } }, { path }),
	]);
	assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), {
		mcpServers: { one: { disabled: true }, two: { directTools: ["search"] } },
	});
});

test("separate processes serialize control updates", async () => {
	const home = temporaryHome();
	const path = join(home, ".pi", "agent", "mcp.json");
	await Promise.all(Array.from({ length: 8 }, (_, index) =>
		execFileAsync(process.execPath, ["--import", "tsx", child, path, `server-${index}`], { cwd: join(import.meta.dirname, "..") })));
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(path, "utf8")).mcpServers).sort(),
		Array.from({ length: 8 }, (_, index) => `server-${index}`).sort());
});
