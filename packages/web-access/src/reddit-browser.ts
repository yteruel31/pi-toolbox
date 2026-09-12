import { createServer as createHttpServer } from "node:http";
import { Socket, createConnection } from "node:net";
import { lookup } from "node:dns/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { access, chmod, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ipaddr from "ipaddr.js";
import type { BrowserContext, BrowserType, Page, Route } from "playwright-core";
import { acquireRedditProfileLock, type RedditProfileLock, type ValidatedRedditConfig } from "./reddit-config.js";
import { buildRedditPostUrl, buildRedditSearchUrl } from "./reddit-parser.js";

export type RedditBrowserFailureCode = "profile_busy" | "browser_unavailable" | "access_denied" | "cancelled" | "timeout";
export class RedditBrowserError extends Error {
  constructor(readonly code: RedditBrowserFailureCode) {
    super(code === "profile_busy" ? "The configured Reddit profile is in use; close its browser or remove only a lock you have verified is stale."
      : code === "access_denied" ? "Reddit denied the authenticated browser request (HTTP 403). Verify Reddit access in the configured profile."
      : code === "cancelled" ? "Reddit browser validation was cancelled."
      : code === "timeout" ? "Reddit browser request timed out."
      : "The dedicated Reddit browser could not be started. Verify the executable, Xvfb, and native Chromium sandbox support.");
    this.name = "RedditBrowserError";
  }
}

const allowedUrl = (value: string): boolean => {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== "https:" || url.hostname !== "www.reddit.com" || url.port || url.username || url.password || url.hash || url.toString() !== value) return false;
  try {
    const search = /^\/(?:r\/([A-Za-z0-9_]+)\/)?search\.json$/.exec(url.pathname);
    if (search) {
      const keys = [...url.searchParams.keys()];
      if (new Set(keys).size !== keys.length || ![6, 7].includes(keys.length)) return false;
      return buildRedditSearchUrl({ q: url.searchParams.get("q") ?? "", ...(search[1] ? { subreddit: search[1] } : {}), sort: url.searchParams.get("sort") ?? "", time: url.searchParams.get("t") ?? "", limit: Number(url.searchParams.get("limit")), ...(url.searchParams.has("after") ? { after: url.searchParams.get("after") ?? "" } : {}) }) === value;
    }
    const post = /^\/comments\/([a-z0-9]{5,10})\.json$/i.exec(url.pathname);
    if (post) {
      const keys = [...url.searchParams.keys()];
      if (new Set(keys).size !== keys.length || keys.length !== 4) return false;
      return buildRedditPostUrl(`https://www.reddit.com/comments/${post[1]}`, { sort: url.searchParams.get("sort") ?? "", limit: Number(url.searchParams.get("limit")), depth: Number(url.searchParams.get("depth")) }) === value;
    }
  } catch { return false; }
  return false;
};
export function assertRedditRequestUrl(value: string): void { if (!allowedUrl(value)) throw new Error("Reddit transport accepts only bounded Reddit JSON paths"); }

export interface RedditNetworkGate { port: number; enable(address: string): void; disable(): void; close(): Promise<void> }
/** Local TCP CONNECT gate. It starts disabled and can reach only one DNS-pinned Reddit address. */
export async function createRedditNetworkGate(upstreamPort = 443): Promise<RedditNetworkGate> {
  let address: string | undefined;
  const sockets = new Set<Socket>();
  const server = createHttpServer((_request, response) => response.destroy());
  server.on("connection", (socket) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("connect", (request, client, head) => {
    if (!address || request.method !== "CONNECT" || request.url !== "www.reddit.com:443" || request.headers.host !== "www.reddit.com:443") { client.destroy(); return; }
    const upstream = createConnection({ host: address, port: upstreamPort });
    sockets.add(upstream); upstream.once("close", () => sockets.delete(upstream));
    upstream.once("error", () => client.destroy()); client.once("error", () => upstream.destroy());
    upstream.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
  });
  try { await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); }
  catch { throw new RedditBrowserError("browser_unavailable"); }
  const bound = server.address();
  if (!bound || typeof bound === "string") { server.close(); throw new RedditBrowserError("browser_unavailable"); }
  let closed = false;
  return {
    port: bound.port,
    enable: (value) => { if (!closed) address = value; },
    disable: () => {
      address = undefined;
      for (const socket of sockets) socket.destroy();
    },
    close: async () => {
      if (closed) return; closed = true; address = undefined;
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await Promise.race([stopped, delay(500)]);
    },
  };
}
async function redditAddress(): Promise<string> {
  const answers = await lookup("www.reddit.com", { all: true, verbatim: true });
  const isPublic = ({ address }: { address: string }) => { try { return ipaddr.parse(address).range() === "unicast"; } catch { return false; } };
  if (!answers.length || !answers.every(isPublic)) throw new RedditBrowserError("browser_unavailable");
  return answers[0]!.address;
}

export interface RedditDisplay { value: string; socketPath: string; authPath: string; close(): Promise<void> }
async function run(command: string, args: string[], signal: AbortSignal, timeoutMs = 2_000): Promise<void> {
  if (signal.aborted) signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C" } });
    let settled = false, stoppingError: unknown, timer: NodeJS.Timeout | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; if (timer) clearTimeout(timer); signal.removeEventListener("abort", abort);
      error === undefined ? resolve() : reject(error);
    };
    const stop = (error: unknown) => {
      if (settled || stoppingError !== undefined) return;
      stoppingError = error; child.kill("SIGKILL"); void waitClose(child).then(() => finish(error));
    };
    const abort = () => stop(signal.reason);
    timer = setTimeout(() => stop(new Error("command timed out")), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", finish);
    child.once("close", (code, exitSignal) => stoppingError !== undefined ? finish(stoppingError) : code === 0 && exitSignal === null ? finish() : finish(new Error("command failed")));
    if (signal.aborted) abort();
  });
}
export async function startRedditDisplay(signal: AbortSignal): Promise<RedditDisplay> {
  if (process.platform !== "linux") throw new RedditBrowserError("browser_unavailable");
  await Promise.all([access("/usr/bin/Xvfb", constants.X_OK), access("/usr/bin/xauth", constants.X_OK)]).catch(() => { throw new RedditBrowserError("browser_unavailable"); });
  const directory = await mkdtemp(join(tmpdir(), "reddit-x11-")), authPath = join(directory, "Xauthority");
  const number = 1000 + randomBytes(2).readUInt16BE(0) % 30_000, value = `:${number}`, socketPath = `/tmp/.X11-unix/X${number}`;
  if (await access(socketPath).then(() => true, () => false)) { await rm(directory, { recursive: true, force: true }); throw new RedditBrowserError("browser_unavailable"); }
  try { await run("/usr/bin/xauth", ["-f", authPath, "add", value, ".", randomBytes(16).toString("hex")], signal); }
  catch { await rm(directory, { recursive: true, force: true }); if (signal.aborted) signal.throwIfAborted(); throw new RedditBrowserError("browser_unavailable"); }
  await chmod(authPath, 0o600);
  const child = spawn("/usr/bin/Xvfb", [value, "-screen", "0", "1280x720x24", "-nolisten", "tcp", "-noreset", "-auth", authPath], { detached: true, stdio: "ignore", env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  child.once("error", () => {});
  const kill = () => { if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {} };
  const abort = () => kill(); signal.addEventListener("abort", abort, { once: true });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || child.signalCode !== null || signal.aborted) break;
    if (await access(socketPath).then(() => true, () => false)) return { value, socketPath, authPath, close: async () => { signal.removeEventListener("abort", abort); kill(); await waitClose(child); await rm(directory, { recursive: true, force: true }); } };
    await delay(20);
  }
  signal.removeEventListener("abort", abort); kill(); await waitClose(child); await rm(directory, { recursive: true, force: true });
  if (signal.aborted) signal.throwIfAborted();
  throw new RedditBrowserError("browser_unavailable");
}
function waitClose(child: ChildProcess): Promise<void> { return child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : Promise.race([new Promise<void>((resolve) => child.once("close", () => resolve())), delay(2_000)]); }
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface RedditBrowserDependencies {
  loadEngine(): Promise<Pick<BrowserType, "launchPersistentContext">>;
  createGate(): Promise<RedditNetworkGate>;
  resolveAddress(): Promise<string>;
  startDisplay(signal: AbortSignal): Promise<RedditDisplay>;
}
const defaults: RedditBrowserDependencies = { loadEngine: async () => (await import("playwright-core")).chromium, createGate: createRedditNetworkGate, resolveAddress: redditAddress, startDisplay: startRedditDisplay };
export interface RedditBrowserResponse { status: number; body: string }
export interface RedditBrowserRequestOptions { signal?: AbortSignal; timeoutMs?: number; profileLock?: RedditProfileLock }

const sandboxActive = (report: string): boolean => ["PID namespaces", "Network namespaces", "Seccomp-BPF sandbox"].every((label) => new RegExp(`${label}\\s+(?:Yes|Enabled)`, "i").test(report));

/** Uses native Chromium sandboxing plus fail-closed application controls; this is not an OS network namespace guarantee. */
export async function requestRedditJson(config: ValidatedRedditConfig, url: string, options: RedditBrowserRequestOptions = {}, dependencies = defaults): Promise<RedditBrowserResponse> {
  assertRedditRequestUrl(url);
  if (options.signal?.aborted) throw new RedditBrowserError("cancelled");
  const ownLock = options.profileLock ? undefined : await acquireRedditProfileLock(config);
  const lock = options.profileLock ?? ownLock;
  if (!lock) throw new RedditBrowserError("profile_busy");
  const profileLease = lock.borrow();
  if (!profileLease) throw new RedditBrowserError("profile_busy");
  if (ownLock) await ownLock.release();
  const controller = new AbortController(), timeoutMs = Math.min(Math.max(options.timeoutMs ?? 30_000, 1000), 120_000);
  const abort = () => controller.abort(new RedditBrowserError("cancelled")); options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new RedditBrowserError("timeout")), timeoutMs);
  let gate: RedditNetworkGate | undefined, display: RedditDisplay | undefined, context: BrowserContext | undefined;
  let contextClose: Promise<unknown> | undefined, gateClose: Promise<unknown> | undefined, displayClose: Promise<unknown> | undefined;
  let browserCloseFailed = false, closing = false;
  const closeKnown = async (): Promise<boolean> => {
    gate?.disable(); closing = true;
    if (context && !contextClose) contextClose = context.close();
    try { await contextClose; } catch { browserCloseFailed = true; }
    if (gate && !gateClose) gateClose = gate.close();
    if (display && !displayClose) displayClose = display.close();
    await Promise.all([gateClose?.catch(() => {}), displayClose?.catch(() => {})]);
    return !browserCloseFailed;
  };
  const cleanup = async () => { const browserClosed = await closeKnown(); if (browserClosed) await profileLease.release(); };
  controller.signal.addEventListener("abort", () => { gate?.disable(); void closeKnown(); }, { once: true });
  const operation = (async (): Promise<RedditBrowserResponse> => {
    try {
      gate = await dependencies.createGate(); controller.signal.throwIfAborted();
      display = await dependencies.startDisplay(controller.signal); controller.signal.throwIfAborted();
      const address = await dependencies.resolveAddress(); controller.signal.throwIfAborted();
      const engine = await dependencies.loadEngine(); controller.signal.throwIfAborted();
      context = await engine.launchPersistentContext(config.profileDir, {
        executablePath: config.executablePath, headless: false, chromiumSandbox: true, serviceWorkers: "block", acceptDownloads: false, permissions: [], timeout: timeoutMs,
        env: { ...process.env, DISPLAY: display.value, XAUTHORITY: display.authPath },
        args: ["--disable-extensions", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", `--proxy-server=http://127.0.0.1:${gate.port}`, "--proxy-bypass-list=<-loopback>"],
      });
      context.browser()?.once("disconnected", () => { if (!closing) controller.abort(new RedditBrowserError("browser_unavailable")); });
      let controlledPage: Page | undefined, acceptingControlledPage = false;
      context.on("page", (opened) => {
        if (acceptingControlledPage && !controlledPage) controlledPage = opened;
        else if (opened !== controlledPage) void opened.close().catch(() => {});
      });
      controller.signal.throwIfAborted();
      const landingUrl = "https://www.reddit.com/";
      const routeHandler = async (route: Route) => {
        const request = route.request();
        if (request.method() === "GET" && request.url() === landingUrl && request.resourceType() === "document") await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><meta charset=utf-8><title>Reddit transport</title>" });
        else if (request.method() === "GET" && request.url() === url && allowedUrl(request.url())) await route.continue();
        else await route.abort("blockedbyclient");
      };
      await context.route("**/*", routeHandler); await context.routeWebSocket("**/*", (socket) => socket.close());
      for (const restored of context.pages()) await restored.close().catch(() => {});
      controller.signal.throwIfAborted(); acceptingControlledPage = true;
      const sandboxPage = await context.newPage(); controlledPage = sandboxPage; acceptingControlledPage = false;
      await sandboxPage.goto("chrome://sandbox", { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const sandboxReport = await sandboxPage.locator("body").innerText();
      await sandboxPage.close();
      if (!sandboxActive(sandboxReport)) throw new RedditBrowserError("browser_unavailable");
      controlledPage = undefined;
      for (const unexpected of context.pages()) await unexpected.close().catch(() => {});
      controller.signal.throwIfAborted(); gate.enable(address); acceptingControlledPage = true;
      const createdPage = await context.newPage(); controlledPage = createdPage; acceptingControlledPage = false;
      await createdPage.goto(landingUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs }); controller.signal.throwIfAborted();
      const result = await createdPage.evaluate(async ({ expectedUrl, maxBytes }) => {
        const response = await fetch(expectedUrl, { method: "GET", credentials: "include", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000) });
        const declared = Number(response.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) throw new Error("response too large");
        if (!response.body) return { status: response.status, body: "" };
        const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0, body = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > maxBytes) { await reader.cancel(); throw new Error("response too large"); }
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
        return { status: response.status, body };
      }, { expectedUrl: url, maxBytes: 5 * 1024 * 1024 });
      controller.signal.throwIfAborted();
      if (result.status === 403) throw new RedditBrowserError("access_denied");
      if (result.status < 200 || result.status >= 300) throw new RedditBrowserError("browser_unavailable");
      return result;
    } finally { await cleanup(); }
  })();
  try {
    const interrupted = new Promise<never>((_, reject) => { const done = () => reject(controller.signal.reason); controller.signal.addEventListener("abort", done, { once: true }); if (controller.signal.aborted) done(); });
    return await Promise.race([operation, interrupted]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof RedditBrowserError) throw error;
    const raw = error instanceof Error ? error.message.slice(0, 32_768) : "";
    if (/ProcessSingleton|SingletonLock|profile[^\n]{0,80}(?:in use|already.*open)/i.test(raw)) throw new RedditBrowserError("profile_busy");
    throw new RedditBrowserError("browser_unavailable");
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", abort);
    if (!controller.signal.aborted) controller.abort(new RedditBrowserError("cancelled"));
    void closeKnown(); void operation.catch(() => {});
  }
}
