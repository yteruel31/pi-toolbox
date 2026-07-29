import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_UI_SETTINGS } from "../src/config.js";
import { GatewayClient, GatewayIncompatibleError } from "../src/gateway/client.js";
import { INTERNAL_SECRET_HEADER, type Session } from "../src/gateway/protocol.js";
import { startGatewayServer } from "../src/gateway/server.js";

interface HttpResult {
	status: number;
	body: string;
	headers: import("node:http").IncomingHttpHeaders;
}

function http(port: number, path: string, options: { method?: string; body?: string; headers?: Record<string, string> } = {}): Promise<HttpResult> {
	return new Promise((resolve, reject) => {
		const outgoing = request({ host: "127.0.0.1", port, path, method: options.method, headers: options.headers }, (response) => {
			let body = "";
			response.on("data", (chunk) => body += chunk);
			response.on("end", () => resolve({ status: response.statusCode!, body, headers: response.headers }));
		});
		outgoing.on("error", reject);
		outgoing.end(options.body);
	});
}

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
	await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
	return (server.address() as import("node:net").AddressInfo).port;
}

async function freePort(): Promise<number> {
	const server = createServer();
	const port = await listen(server);
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("Timed out waiting for condition");
}

function wrongLease(session: Session): Session {
	return { ...session, leaseSecret: "wrong-lease" };
}

test("capability dashboard is isolated, escaped, mounted/direct equivalent, and secured", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-"));
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 10_000 };
	const client = new GatewayClient({ settings, hostnameResolver: async () => "tail.test", homeDir: home });
	const gateway = await startGatewayServer({ settings, hostname: "tail.test", socketPath: client.socket });
	try {
		const session = await client.register({ label: "<unsafe>", backendOrigin: "http://127.0.0.1:23456" });
		const direct = await http(settings.gatewayPort, `/s/${session.capability}/`);
		const mounted = await http(settings.gatewayPort, `${settings.basePath}/s/${session.capability}/`);
		assert.equal(direct.body, mounted.body);
		assert.match(direct.body, /&lt;unsafe&gt;/);
		assert.equal(direct.headers["cache-control"], "no-store");
		assert.equal(direct.headers["referrer-policy"], "no-referrer");
		assert.equal(direct.headers["x-content-type-options"], "nosniff");
		const unknown = await http(settings.gatewayPort, "/s/unknown/");
		const unrelated = await http(settings.gatewayPort, "/not-an-index");
		assert.deepEqual({ status: unknown.status, body: unknown.body }, { status: unrelated.status, body: unrelated.body });
		await client.unregister(session);
	} finally {
		await gateway.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("two concurrent clients share one launch and register isolated sessions", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-launch-"));
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 10_000 };
	let launches = 0;
	let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
	const spawnDaemon = (configPath: string): void => {
		launches++;
		void (async () => {
			const config = JSON.parse(await readFile(configPath, "utf8"));
			gateway = await startGatewayServer(config);
		})();
	};
	const options = { settings, hostnameResolver: async () => "node.ts.net", homeDir: home, spawnDaemon };
	const first = new GatewayClient(options);
	const second = new GatewayClient(options);
	try {
		const [a, b] = await Promise.all([
			first.register({ label: "first", backendOrigin: "http://127.0.0.1:1" }),
			second.register({ label: "second", backendOrigin: "http://127.0.0.1:2" }),
		]);
		assert.equal(launches, 1);
		assert.notEqual(a.capability, b.capability);
		assert.notEqual(a.leaseSecret, b.leaseSecret);
	} finally {
		await gateway?.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("the production launcher starts the packaged daemon runtime", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-production-launch-"));
	// Leave enough post-hello time for register() when test files run concurrently.
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 1_000 };
	const client = new GatewayClient({ settings, hostnameResolver: async () => "node.ts.net", homeDir: home });
	try {
		const session = await client.register({ label: "production", backendOrigin: "http://127.0.0.1:12345" });
		assert.equal(await exists(client.pid), true);
		await client.unregister(session);
		await waitUntil(async () => !(await exists(client.pid)), 3_000);
		assert.equal(await exists(client.socket), false);
	} finally {
		try {
			const pid = Number(await readFile(client.pid, "utf8"));
			if (Number.isInteger(pid) && pid > 0) process.kill(pid, "SIGTERM");
		} catch { /* The expected idle shutdown already removed the PID. */ }
		await rm(home, { recursive: true, force: true });
	}
});

test("reachable incompatible gateway is terminal and is not replaced", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-mismatch-"));
	const client = new GatewayClient({ settings: DEFAULT_UI_SETTINGS, hostnameResolver: async () => "node.ts.net", homeDir: home, spawnDaemon: () => assert.fail("must not spawn") });
	await mkdir(client.dir, { recursive: true });
	const incompatible = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ protocol: 999, signature: "other" }));
	});
	await new Promise<void>((resolve, reject) => incompatible.once("error", reject).listen(client.socket, resolve));
	try {
		await assert.rejects(client.ensure(), GatewayIncompatibleError);
		assert.ok((await stat(client.socket)).isSocket());
	} finally {
		await new Promise<void>((resolve) => incompatible.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	}
});

test("real proxy preserves query/body, enforces headers, injects secret, and rejects path escape", async () => {
	let received: { url?: string; body?: string; headers?: import("node:http").IncomingHttpHeaders } = {};
	const backend = createServer((incoming, response) => {
		let body = "";
		incoming.on("data", (chunk) => body += chunk);
		incoming.on("end", () => {
			received = { url: incoming.url, body, headers: incoming.headers };
			response.setHeader("cache-control", "public");
			response.setHeader("connection", "x-upstream-hop");
			response.setHeader("x-upstream-hop", "must-not-leak");
			response.end("backend-ok");
		});
	});
	const backendPort = await listen(backend);
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-proxy-"));
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 10_000 };
	const client = new GatewayClient({ settings, hostnameResolver: async () => "tail.test", homeDir: home });
	const gateway = await startGatewayServer({ settings, hostname: "tail.test", socketPath: client.socket });
	try {
		const session = await client.register({ label: "proxy", backendOrigin: `http://127.0.0.1:${backendPort}`, backendSecret: "private-value" });
		const response = await http(settings.gatewayPort, `/s/${session.capability}/proxy/api?q=a%20b`, {
			method: "POST",
			body: "payload",
			headers: { connection: "x-client-hop", "x-client-hop": "must-not-reach-backend", "content-type": "text/plain" },
		});
		assert.equal(response.status, 200);
		assert.equal(response.body, "backend-ok");
		assert.equal(received.url, "/api?q=a%20b");
		assert.equal(received.body, "payload");
		assert.equal(received.headers?.[INTERNAL_SECRET_HEADER], "private-value");
		assert.equal(received.headers?.["x-client-hop"], undefined);
		assert.equal(response.headers["cache-control"], "no-store");
		assert.equal(response.headers["x-upstream-hop"], undefined);
		assert.equal(response.headers[INTERNAL_SECRET_HEADER], undefined);
		for (const path of ["//host", "%2fhost", "%5chost", "../escape", "%2e%2e/escape"]) {
			assert.equal((await http(settings.gatewayPort, `/s/${session.capability}/proxy/${path}`)).status, 404);
		}
	} finally {
		await gateway.close();
		await new Promise<void>((resolve) => backend.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	}
});

test("SSE proxy forwards the first event before the backend completes", async () => {
	let backendEnded = false;
	let backendRequestHeaders: import("node:http").IncomingHttpHeaders | undefined;
	const backend = createServer((incoming, response) => {
		backendRequestHeaders = incoming.headers;
		response.writeHead(200, {
			"content-type": "text/event-stream",
			connection: "x-upstream-hop",
			"x-upstream-hop": "remove-me",
		});
		response.write("data: first\n\n");
		setTimeout(() => {
			backendEnded = true;
			response.end("data: second\n\n");
		}, 80);
	});
	const backendPort = await listen(backend);
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-sse-"));
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 10_000 };
	const client = new GatewayClient({ settings, hostnameResolver: async () => "tail.test", homeDir: home });
	const gateway = await startGatewayServer({ settings, hostname: "tail.test", socketPath: client.socket });
	try {
		const session = await client.register({ label: "sse", backendOrigin: `http://127.0.0.1:${backendPort}` });
		let resolveFirst!: (value: { chunk: string; backendEnded: boolean; headers: import("node:http").IncomingHttpHeaders }) => void;
		const first = new Promise<{ chunk: string; backendEnded: boolean; headers: import("node:http").IncomingHttpHeaders }>((resolve) => resolveFirst = resolve);
		const completed = new Promise<string>((resolve, reject) => {
			const outgoing = request({
				host: "127.0.0.1",
				port: settings.gatewayPort,
				path: `/s/${session.capability}/proxy/events`,
				headers: { connection: "x-client-hop", "x-client-hop": "remove-me" },
			}, (response) => {
				let body = "";
				let sawFirst = false;
				response.on("data", (chunk) => {
					body += chunk;
					if (!sawFirst) {
						sawFirst = true;
						resolveFirst({ chunk: String(chunk), backendEnded, headers: response.headers });
					}
				});
				response.on("end", () => resolve(body));
			});
			outgoing.on("error", reject);
			outgoing.end();
		});
		const observed = await first;
		assert.equal(observed.backendEnded, false);
		assert.match(observed.chunk, /data: first/);
		assert.equal(observed.headers["x-upstream-hop"], undefined);
		assert.equal(backendRequestHeaders?.["x-client-hop"], undefined);
		assert.equal(await completed, "data: first\n\ndata: second\n\n");
	} finally {
		await gateway.close();
		await new Promise<void>((resolve) => backend.close(() => resolve()));
		await rm(home, { recursive: true, force: true });
	}
});

test("lease authentication protects updates and unregister revokes the capability", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-lease-"));
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 10_000 };
	const client = new GatewayClient({ settings, hostnameResolver: async () => "tail.test", homeDir: home });
	const gateway = await startGatewayServer({ settings, hostname: "tail.test", socketPath: client.socket });
	try {
		const session = await client.register({ label: "original", backendOrigin: "http://127.0.0.1:12345" });
		await assert.rejects(client.heartbeat(wrongLease(session)), /not found/);
		await assert.rejects(client.update(wrongLease(session), "attacker"), /not found/);
		await assert.rejects(client.unregister(wrongLease(session)), /not found/);
		await client.heartbeat(session);
		await client.update(session, "updated");
		assert.match((await http(settings.gatewayPort, `/s/${session.capability}/`)).body, /updated/);
		await client.unregister(session);
		assert.equal((await http(settings.gatewayPort, `/s/${session.capability}/`)).status, 404);
	} finally {
		await gateway.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("expired sessions lose their capability", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-mcp-expiry-"));
	let now = 0;
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 1_000 };
	const client = new GatewayClient({ settings, hostnameResolver: async () => "tail.test", homeDir: home });
	const gateway = await startGatewayServer({ settings, hostname: "tail.test", socketPath: client.socket, now: () => now });
	try {
		const session = await client.register({ label: "expires", backendOrigin: "http://127.0.0.1:12345" });
		now = 1_001;
		await waitUntil(async () => (await http(settings.gatewayPort, `/s/${session.capability}/`)).status === 404);
	} finally {
		await gateway.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("the real daemon removes its owned socket and PID before idle exit", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-mcp-daemon-idle-"));
	const socketPath = join(directory, "control.sock");
	const pidPath = join(directory, "daemon.pid");
	const configPath = join(directory, "launch.json");
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 100 };
	await writeFile(configPath, JSON.stringify({ settings, hostname: "node.ts.net", socketPath, pidPath }), { mode: 0o600 });
	const daemonPath = fileURLToPath(new URL("../src/gateway/daemon.ts", import.meta.url));
	const child = spawn(process.execPath, ["--import", "tsx", daemonPath, configPath], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr?.on("data", (chunk) => stderr += chunk);
	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
	try {
		await waitUntil(() => exists(pidPath));
		const exit = await Promise.race([
			exitPromise,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("daemon idle exit timed out")), 3_000)),
		]);
		assert.deepEqual(exit, { code: 0, signal: null }, stderr);
		assert.equal(await exists(socketPath), false);
		assert.equal(await exists(pidPath), false);
		assert.equal(await exists(configPath), false);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await rm(directory, { recursive: true, force: true });
	}
});

test("the real daemon handles SIGTERM with owned socket and PID cleanup", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-mcp-daemon-signal-"));
	const socketPath = join(directory, "control.sock");
	const pidPath = join(directory, "daemon.pid");
	const configPath = join(directory, "launch.json");
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 10_000 };
	await writeFile(configPath, JSON.stringify({ settings, hostname: "node.ts.net", socketPath, pidPath }), { mode: 0o600 });
	const daemonPath = fileURLToPath(new URL("../src/gateway/daemon.ts", import.meta.url));
	const child = spawn(process.execPath, ["--import", "tsx", daemonPath, configPath], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
	let stderr = "";
	child.stderr?.on("data", (chunk) => stderr += chunk);
	const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
	try {
		await waitUntil(() => exists(pidPath));
		child.kill("SIGTERM");
		const exit = await Promise.race([
			exitPromise,
			new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("daemon SIGTERM exit timed out")), 3_000)),
		]);
		assert.equal(exit.code, 0, stderr);
		assert.equal(await exists(socketPath), false);
		assert.equal(await exists(pidPath), false);
	} finally {
		if (child.exitCode === null) child.kill("SIGKILL");
		await rm(directory, { recursive: true, force: true });
	}
});

test("dead launch owners are recovered while a live recorded owner is never disturbed", async () => {
	const staleHome = await mkdtemp(join(tmpdir(), "pi-mcp-stale-"));
	const settings = { ...DEFAULT_UI_SETTINGS, gatewayPort: await freePort(), idleTimeoutMs: 10_000 };
	const staleClient = new GatewayClient({ settings, hostnameResolver: async () => "node.ts.net", homeDir: staleHome, spawnDaemon });
	await mkdir(staleClient.dir, { recursive: true, mode: 0o700 });

	const socketFixture = spawn(process.execPath, ["-e", "const net=require('node:net');const s=net.createServer();s.listen(process.argv[1],()=>process.stdout.write('ready\\n'));setInterval(()=>{},1000)", staleClient.socket], { stdio: ["ignore", "pipe", "inherit"] });
	await new Promise<void>((resolve, reject) => {
		socketFixture.once("error", reject);
		socketFixture.stdout?.once("data", () => resolve());
	});
	const deadPid = socketFixture.pid!;
	socketFixture.kill("SIGKILL");
	await new Promise<void>((resolve) => socketFixture.once("exit", () => resolve()));
	assert.equal(await exists(staleClient.socket), true);
	await writeFile(staleClient.pid, String(deadPid));
	await writeFile(join(staleClient.dir, "launch.lock"), JSON.stringify({ pid: deadPid, createdAt: Date.now() }));

	let gateway: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
	async function spawnDaemon(configPath: string): Promise<void> {
		const config = JSON.parse(await readFile(configPath, "utf8"));
		gateway = await startGatewayServer(config);
	}
	try {
		await staleClient.ensure();
		assert.ok(gateway);
	} finally {
		await gateway?.close();
		await rm(staleHome, { recursive: true, force: true });
	}

	const liveHome = await mkdtemp(join(tmpdir(), "pi-mcp-live-"));
	let spawned = false;
	const liveClient = new GatewayClient({ settings: { ...settings, gatewayPort: await freePort() }, hostnameResolver: async () => "node.ts.net", homeDir: liveHome, spawnDaemon: () => { spawned = true; } });
	await mkdir(liveClient.dir, { recursive: true, mode: 0o700 });
	await writeFile(liveClient.pid, String(process.pid));
	await writeFile(liveClient.socket, "owned by live process");
	try {
		await assert.rejects(liveClient.ensure(), /still alive/);
		assert.equal(spawned, false);
		assert.equal(await readFile(liveClient.socket, "utf8"), "owned by live process");
		assert.equal(await readFile(liveClient.pid, "utf8"), String(process.pid));
	} finally {
		await rm(liveHome, { recursive: true, force: true });
	}
});
