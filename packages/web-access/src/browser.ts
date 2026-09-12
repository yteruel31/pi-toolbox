import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { BrowserFailure, classifyBrowserLaunch, inspectBrowserRuntime } from "./browser-environment.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser, BrowserContext, BrowserType, Route } from "playwright-core";

export interface RenderOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  request: (url: string, options?: { method?: string; body?: Buffer; headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ url: string; status: number; headers: Record<string, string>; body: Buffer }>;
}
const MAX_REQUESTS = 100;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;


function webUrl(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser requests require HTTP(S) URLs without credentials");
  return url.href;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Testable launch plan. Only system runtime files are mounted, never home/run sockets. */
export function browserIsolationPlan(bwrap: string, chromium: string): string {
  if (!chromium.startsWith("/usr/") && !chromium.startsWith("/opt/")) throw new Error("Chromium must be installed under /usr or /opt");
  const args = [
    "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts",
    "--die-with-parent", "--new-session", "--cap-drop", "ALL",
    "--ro-bind", "/usr", "/usr", "--ro-bind-try", "/opt", "/opt",
    "--ro-bind-try", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/etc/ld.so.cache", "/etc/ld.so.cache",
    "--ro-bind-try", "/etc/fonts", "/etc/fonts",
    "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--dir", "/tmp/home",
    "--chdir", "/tmp", "--clearenv", "--setenv", "HOME", "/tmp/home",
    "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "LANG", "C.UTF-8",
    "--", chromium,
  ];
  // Bubblewrap passes inherited descriptors to the payload. Playwright's pipe uses
  // fd 3/4, not a TCP debugging port; do not repurpose these for bwrap status FDs.
  return `#!/bin/sh\nexec ${[bwrap, ...args].map(quote).join(" ")} "$@"\n`;
}

/** Never continue/fallback a route: every HTTP byte must come from the safe parent. */
export function createBrowserRouteHandler(request: RenderOptions["request"], signal: AbortSignal, fail: (error: Error) => void): (route: Route) => Promise<void> {
  let requests = 0;
  let bytes = 0;
  return async (route) => {
    try {
      signal.throwIfAborted();
      if (++requests > MAX_REQUESTS) throw new Error("Browser request limit exceeded (100)");
      const incoming = route.request();
      const method = incoming.method().toUpperCase();
      if (method !== "GET" && method !== "HEAD") { await route.abort("blockedbyclient"); return; }
      const url = webUrl(incoming.url());
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(incoming.headers())) {
        if (["accept", "accept-language", "range", "if-range"].includes(name.toLowerCase())) headers[name.toLowerCase()] = value;
      }
      const response = await request(url, { method, headers, signal });
      signal.throwIfAborted();
      bytes += response.body.length;
      if (bytes > MAX_RESPONSE_BYTES || response.body.length > MAX_DOCUMENT_BYTES) throw new Error("Browser response byte limit exceeded");
      const finalUrl = webUrl(response.url);
      // If the safe client follows redirects, make Chromium navigate to the final
      // origin instead of granting the final body the original origin's authority.
      if (finalUrl !== url) { await route.fulfill({ status: 302, headers: { location: finalUrl }, body: "" }); return; }
      const safeHeaders: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.headers)) {
        const key = name.toLowerCase();
        if (["content-type", "content-language", "cache-control", "etag", "last-modified", "content-security-policy", "x-content-type-options"].includes(key)) safeHeaders[key] = value;
        if (key === "location") safeHeaders.location = webUrl(new URL(value, url).href);
      }
      await route.fulfill({ status: response.status, headers: safeHeaders, body: method === "HEAD" ? Buffer.alloc(0) : response.body });
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      await route.abort("blockedbyclient").catch(() => {});
    }
  };
}

export interface BrowserDependencies {
  inspect: typeof inspectBrowserRuntime;
  loadEngine: () => Promise<Pick<BrowserType, "launch">>;
}
const browserDependencies: BrowserDependencies = {
  inspect: inspectBrowserRuntime,
  loadEngine: async () => (await import("playwright-core")).chromium,
};
export async function renderPage(url: string, options: RenderOptions, dependencies = browserDependencies): Promise<string> {
  webUrl(url);
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
  options.signal?.throwIfAborted();
  const runtime = await dependencies.inspect();
  if (runtime.failure) throw new BrowserFailure(runtime.failure);
  const { bwrap, chromium } = runtime;
  if (!bwrap || !chromium) throw new BrowserFailure("launch-unknown");
  const directory = await mkdtemp(join(tmpdir(), "web-access-browser-")).catch(() => { throw new BrowserFailure("launch-unknown"); });
  const controller = new AbortController();
  const abort = () => controller.abort(new BrowserFailure(options.signal?.reason?.name === "TimeoutError" ? "timeout" : "cancelled"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new BrowserFailure("timeout")), Math.min(options.timeoutMs, 2_147_483_647));
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let aborted: (() => void) | undefined;
  let operation: Promise<string> | undefined;
  let launched = false;
  try {
    const wrapper = join(directory, "chromium-isolated");
    await writeFile(wrapper, browserIsolationPlan(bwrap, chromium), { mode: 0o700 });
    controller.signal.throwIfAborted();
    operation = (async () => {
      const engine = await dependencies.loadEngine();
      controller.signal.throwIfAborted();
      browser = await engine.launch({
        executablePath: wrapper, chromiumSandbox: true, headless: true,
        timeout: Math.min(options.timeoutMs, 2_147_483_647),
        env: { PATH: "/usr/bin:/bin", HOME: directory, LANG: "C.UTF-8" },
        args: ["--disable-quic", "--disable-background-networking", "--disable-extensions", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
      });
      launched = true;
      if (controller.signal.aborted) { await browser.close(); controller.signal.throwIfAborted(); }
      context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false, permissions: [], storageState: { cookies: [], origins: [] } });
      await context.routeWebSocket("**/*", (socket) => socket.close());
      await context.route("**/*", createBrowserRouteHandler(options.request, controller.signal, () => controller.abort(new BrowserFailure("parent-request"))));
      const page = await context.newPage();
      context.on("page", (popup) => { if (popup !== page) void popup.close().catch(() => {}); });
      page.on("download", (download) => { void download.cancel().catch(() => {}); });
      page.on("dialog", (dialog) => { void dialog.dismiss().catch(() => {}); });
      await page.goto(url, { waitUntil: "networkidle", timeout: options.timeoutMs });
      controller.signal.throwIfAborted();
      // Check inside the renderer before transferring a potentially huge DOM over
      // the pipe. Dynamic rendering intentionally executes page JS, unlike HTML extraction.
      const html = await page.evaluate((limit) => {
        const html = document.documentElement.outerHTML;
        if (new TextEncoder().encode(html).length > limit) throw new Error("Rendered HTML exceeds 5 MiB");
        return html;
      }, MAX_DOCUMENT_BYTES);
      // Page globals/prototypes are untrusted: repeat the bound in the parent.
      if (typeof html !== "string" || Buffer.byteLength(html) > MAX_DOCUMENT_BYTES) throw new Error("Rendered HTML exceeds 5 MiB");
      return html;
    })();
    const interrupted = new Promise<never>((_resolve, reject) => {
      aborted = () => reject(controller.signal.reason ?? new Error("Browser rendering aborted"));
      controller.signal.addEventListener("abort", aborted, { once: true });
      if (controller.signal.aborted) aborted();
    });
    return await Promise.race([operation, interrupted]);
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error instanceof Error && error.name === "TimeoutError") throw new BrowserFailure("timeout");
    throw launched ? new BrowserFailure("render-unknown") : classifyBrowserLaunch(error);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (aborted) controller.signal.removeEventListener("abort", aborted);
    controller.abort(new Error("Browser rendering finished"));
    // Close an active browser to interrupt page work. A launch still in flight is
    // bounded by Playwright's launch timeout and closes itself on late arrival.
    // Join it before deleting the wrapper or reporting completion/cancellation.
    await browser?.close().catch(() => {});
    await operation?.catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => { throw new BrowserFailure("cleanup-failed"); });
  }
}
