import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext } from "playwright-core";
import { assertRedditRequestUrl, createRedditNetworkGate, RedditBrowserError, requestRedditJson, type RedditBrowserDependencies } from "../src/reddit-browser.js";
import { redditProfileLockPath, type ValidatedRedditConfig } from "../src/reddit-config.js";
import { buildRedditSearchUrl } from "../src/reddit-parser.js";

const TEST_URL = buildRedditSearchUrl({ q: "x" });

async function fixture(t: test.TestContext): Promise<ValidatedRedditConfig> {
  const root = await mkdtemp(join(tmpdir(), "reddit-browser-")); t.after(() => import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })));
  const stateDir = join(root, "state"), profileDir = join(root, "profile"); await mkdir(stateDir, { mode: 0o700 }); await mkdir(profileDir, { mode: 0o700 });
  return { profileDir, executablePath: "/opt/google/chrome/chrome", stateDir, identity: "identity" };
}
function harness(launchWait?: Promise<void>, overrides: Partial<RedditBrowserDependencies> = {}, closeWait?: Promise<void>, sandbox = "PID namespaces Yes\nNetwork namespaces Yes\nSeccomp-BPF sandbox Yes", evaluateWait?: Promise<void>) {
  const events: string[] = []; let closes = 0, launchOptions: any;
  const restored = { close: async () => { events.push("restored-close"); } };
  const controlledPage = {
    goto: async (url: string) => { events.push(url === "chrome://sandbox" ? `goto:${url}` : "goto:root"); },
    locator: () => ({ innerText: async () => sandbox }),
    evaluate: async () => { await evaluateWait; return { status: 200, body: "{}" }; },
    close: async () => {},
  };
  let pages = 0; const browserEvents = new Map<string, () => void>();
  const context = {
    pages: () => [restored, ...(pages ? [controlledPage] : [])], route: async () => events.push("route"), routeWebSocket: async () => events.push("ws"),
    newPage: async () => { pages++; return controlledPage; }, on: () => {},
    browser: () => ({ once: (name: string, callback: () => void) => browserEvents.set(name, callback) }),
    close: async () => { closes++; await closeWait; },
  } as unknown as BrowserContext;
  const deps: RedditBrowserDependencies = {
    createGate: async () => ({ port: 3210, enable: () => { events.push("enable"); }, disable: () => { events.push("disable"); }, close: async () => { events.push("gate-close"); } }),
    resolveAddress: async () => "8.8.8.8",
    startDisplay: async () => { events.push("display-start"); return { value: ":123", socketPath: "/x", authPath: "/auth", close: async () => { events.push("display-close"); } }; },
    loadEngine: async () => ({ launchPersistentContext: async (_dir, options) => { launchOptions = options; if (launchWait) await launchWait; return context; } }),
    ...overrides,
  };
  return { deps, events, closes: () => closes, pages: () => pages, launchOptions: () => launchOptions, disconnect: () => browserEvents.get("disconnected")?.() };
}
async function tcpExchange(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => { const socket = createConnection(port, "127.0.0.1"); let data = ""; socket.on("connect", () => socket.write(request)); socket.on("data", (chunk) => { data += chunk; if (data.includes("\r\n\r\n")) { socket.destroy(); resolve(data); } }); socket.on("close", () => resolve(data)); socket.on("error", reject); });
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("condition was not reached");
}

test("transport rejects arbitrary origins and paths before acquiring profile resources", () => {
  for (const value of ["https://evil.test/search.json", "http://www.reddit.com/search.json", "https://www.reddit.com/user/me", "https://127.0.0.1/search.json", "https://www.reddit.com/comments/abc123.json/extra", "https://www.reddit.com/search.json#x"]) assert.throws(() => assertRedditRequestUrl(value));
  assert.doesNotThrow(() => assertRedditRequestUrl(TEST_URL));
  assert.throws(() => assertRedditRequestUrl(`${TEST_URL}&limit=2`));
});

test("real localhost CONNECT gate rejects disabled, wrong-host and non-CONNECT requests", async (t) => {
  const upstream = createServer((socket) => socket.on("data", (data) => socket.write(data)));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve)); t.after(() => upstream.close());
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const gate = await createRedditNetworkGate(address.port); t.after(() => gate.close());
  assert.equal(await tcpExchange(gate.port, "CONNECT www.reddit.com:443 HTTP/1.1\r\nHost: www.reddit.com:443\r\n\r\n"), "");
  gate.enable("127.0.0.1");
  assert.equal(await tcpExchange(gate.port, "CONNECT evil.test:443 HTTP/1.1\r\nHost: evil.test:443\r\n\r\n"), "");
  assert.equal(await tcpExchange(gate.port, "GET http://www.reddit.com/ HTTP/1.1\r\nHost: www.reddit.com\r\n\r\n"), "");
  assert.match(await tcpExchange(gate.port, "CONNECT www.reddit.com:443 HTTP/1.1\r\nHost: www.reddit.com:443\r\n\r\n"), /^HTTP\/1\.1 200/);
  const tunnel = createConnection(gate.port, "127.0.0.1");
  const tunnelClosed = new Promise<void>((resolve, reject) => { tunnel.once("close", () => resolve()); tunnel.once("error", reject); });
  await new Promise<void>((resolve) => tunnel.once("connect", resolve));
  tunnel.write("CONNECT www.reddit.com:443 HTTP/1.1\r\nHost: www.reddit.com:443\r\n\r\n");
  await new Promise<void>((resolve, reject) => { tunnel.once("data", () => resolve()); tunnel.once("error", reject); });
  gate.disable(); await tunnelClosed;
  assert.equal(await tcpExchange(gate.port, "CONNECT www.reddit.com:443 HTTP/1.1\r\nHost: www.reddit.com:443\r\n\r\n"), "");
});

test("native sandbox browser installs controls, verifies sandbox, then enables gate", async (t) => {
  const config = await fixture(t), h = harness();
  assert.deepEqual(await requestRedditJson(config, TEST_URL, {}, h.deps), { status: 200, body: "{}" });
  assert.ok(h.events.indexOf("route") < h.events.indexOf("restored-close")); assert.ok(h.events.indexOf("goto:chrome://sandbox") < h.events.indexOf("enable"));
  assert.equal(h.pages(), 1); assert.ok(h.events.indexOf("enable") < h.events.indexOf("goto:root"));
  assert.equal(h.launchOptions().executablePath, config.executablePath); assert.equal(h.launchOptions().headless, false); assert.equal(h.launchOptions().chromiumSandbox, true);
  assert.equal(h.launchOptions().env.DISPLAY, ":123"); assert.equal(h.launchOptions().env.XAUTHORITY, "/auth"); assert.equal(h.launchOptions().env.HOME, process.env.HOME);
  assert.ok(h.launchOptions().args.includes("--proxy-server=http://127.0.0.1:3210"));
  assert.ok(!h.launchOptions().args.some((arg: string) => /no-sandbox|disable-setuid-sandbox|bwrap/.test(arg)));
  assert.ok(h.closes() > 0); await assert.rejects(access(redditProfileLockPath(config)));
});

test("inactive sandbox fails closed without enabling the gate", async (t) => {
  const config = await fixture(t), h = harness(undefined, {}, undefined, "PID namespaces No\nNetwork namespaces Yes\nSeccomp-BPF sandbox Yes");
  await assert.rejects(requestRedditJson(config, TEST_URL, {}, h.deps), (error: RedditBrowserError) => error.code === "browser_unavailable");
  assert.ok(!h.events.includes("enable")); assert.ok(h.events.includes("gate-close"));
});

test("cancellation returns promptly during unresolved DNS and releases lock after late completion cleanup", async (t) => {
  const config = await fixture(t); let resolveDns!: (value: string) => void; const dns = new Promise<string>((resolve) => { resolveDns = resolve; });
  const h = harness(undefined, { resolveAddress: () => dns }); const controller = new AbortController();
  const request = requestRedditJson(config, TEST_URL, { signal: controller.signal }, h.deps);
  await waitFor(() => h.events.includes("display-start")); controller.abort();
  await assert.rejects(request, (error: RedditBrowserError) => error.code === "cancelled");
  assert.ok(await access(redditProfileLockPath(config)).then(() => true, () => false)); resolveDns("8.8.8.8");
  await waitFor(() => access(redditProfileLockPath(config)).then(() => false, () => true)); assert.ok(h.events.includes("gate-close")); assert.ok(h.events.includes("display-close"));
});

test("cancellation during late display closes it before releasing the retained lock", async (t) => {
  const config = await fixture(t); let resolveDisplay!: (display: Awaited<ReturnType<RedditBrowserDependencies["startDisplay"]>>) => void;
  const pending = new Promise<Awaited<ReturnType<RedditBrowserDependencies["startDisplay"]>>>((resolve) => { resolveDisplay = resolve; });
  const h = harness(undefined, { startDisplay: () => { h.events.push("late-display-start"); return pending; } }); const controller = new AbortController();
  const request = requestRedditJson(config, TEST_URL, { signal: controller.signal }, h.deps);
  await waitFor(() => h.events.includes("late-display-start")); controller.abort(); await assert.rejects(request, (error: RedditBrowserError) => error.code === "cancelled");
  resolveDisplay({ value: ":8", socketPath: "/x", authPath: "/auth", close: async () => { h.events.push("late-display-close"); } });
  await waitFor(() => access(redditProfileLockPath(config)).then(() => false, () => true)); assert.ok(h.events.includes("late-display-close"));
});

test("late browser close retains lock until close completes and failed close retains it", async (t) => {
  const config = await fixture(t); let finishLaunch!: () => void, finishClose!: () => void;
  const launchWait = new Promise<void>((resolve) => { finishLaunch = resolve; }), closeWait = new Promise<void>((resolve) => { finishClose = resolve; });
  const h = harness(launchWait, {}, closeWait), controller = new AbortController();
  const request = requestRedditJson(config, TEST_URL, { signal: controller.signal }, h.deps);
  await waitFor(() => !!h.launchOptions()); controller.abort(); await assert.rejects(request, (error: RedditBrowserError) => error.code === "cancelled"); finishLaunch();
  await waitFor(() => h.closes() > 0); assert.ok(await access(redditProfileLockPath(config)).then(() => true, () => false)); finishClose();
  await waitFor(() => access(redditProfileLockPath(config)).then(() => false, () => true));

  const second = await fixture(t); let launch!: () => void, fail!: (error: Error) => void;
  const h2 = harness(new Promise<void>((resolve) => { launch = resolve; }), {}, new Promise<void>((_resolve, reject) => { fail = reject; })); const c2 = new AbortController();
  const r2 = requestRedditJson(second, TEST_URL, { signal: c2.signal }, h2.deps);
  await waitFor(() => !!h2.launchOptions()); c2.abort(); await assert.rejects(r2); launch(); await waitFor(() => h2.closes() > 0); fail(new Error("unknown process state"));
  await new Promise((resolve) => setTimeout(resolve, 20)); assert.ok(await access(redditProfileLockPath(second)).then(() => true, () => false));
});

test("cancellation destroys an existing tunnel before a pending browser close settles", async (t) => {
  const config = await fixture(t), upstream = createServer((socket) => socket.on("data", (data) => socket.write(data)));
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve)); t.after(() => upstream.close());
  const bound = upstream.address(); assert.ok(bound && typeof bound !== "string");
  let gate!: Awaited<ReturnType<typeof createRedditNetworkGate>>, enabled = false, finishEvaluate!: () => void, finishClose!: () => void;
  const evaluateWait = new Promise<void>((resolve) => { finishEvaluate = resolve; }), closeWait = new Promise<void>((resolve) => { finishClose = resolve; });
  const h = harness(undefined, { resolveAddress: async () => "127.0.0.1", createGate: async () => {
    gate = await createRedditNetworkGate(bound.port);
    return { port: gate.port, enable: (address) => { enabled = true; gate.enable(address); }, disable: () => gate.disable(), close: () => gate.close() };
  } }, closeWait, undefined, evaluateWait);
  const controller = new AbortController(), request = requestRedditJson(config, TEST_URL, { signal: controller.signal }, h.deps);
  await waitFor(() => enabled);
  const tunnel = createConnection(gate.port, "127.0.0.1"), tunnelClosed = new Promise<void>((resolve) => { tunnel.once("close", () => resolve()); tunnel.once("error", () => resolve()); });
  await new Promise<void>((resolve) => tunnel.once("connect", resolve)); tunnel.write("CONNECT www.reddit.com:443 HTTP/1.1\r\nHost: www.reddit.com:443\r\n\r\n");
  await new Promise<void>((resolve, reject) => { tunnel.once("data", () => resolve()); tunnel.once("error", reject); });
  controller.abort(); await assert.rejects(request, (error: RedditBrowserError) => error.code === "cancelled");
  await Promise.race([tunnelClosed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("tunnel stayed open")), 500))]);
  assert.ok(h.closes() > 0); finishEvaluate(); finishClose();
  await waitFor(() => access(redditProfileLockPath(config)).then(() => false, () => true));
});

test("display failure closes gate and timeout differs from cancellation", async (t) => {
  const config = await fixture(t), h = harness(undefined, { startDisplay: async () => { throw new Error("secret launch detail"); } });
  await assert.rejects(requestRedditJson(config, TEST_URL, {}, h.deps), (error: RedditBrowserError) => error.code === "browser_unavailable" && !error.message.includes("secret"));
  assert.ok(h.events.includes("gate-close"));
  let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; }); const late = harness(wait);
  await assert.rejects(requestRedditJson(config, TEST_URL, { timeoutMs: 1000 }, late.deps), (error: RedditBrowserError) => error.code === "timeout"); release();
});
