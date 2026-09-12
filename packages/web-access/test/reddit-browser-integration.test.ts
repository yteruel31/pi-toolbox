import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page, type Route } from "playwright-core";
import { parseConfig } from "../src/config.js";
import { createRedditNetworkGate, requestRedditJson, startRedditDisplay, type RedditBrowserDependencies } from "../src/reddit-browser.js";
import { buildRedditPostUrl, buildRedditSearchUrl } from "../src/reddit-parser.js";
import { RedditService } from "../src/reddit-service.js";

const enabled = process.env.REDDIT_BROWSER_INTEGRATION === "1";
const listing = (children: unknown[]) => ({ kind: "Listing", data: { children, after: null } });
const post = { kind: "t3", data: { id: "abc123", title: "title", permalink: "/r/typescript/comments/abc123/title/", selftext: "body", score: 1, num_comments: 0 } };

async function profileProcesses(profileDir: string): Promise<string[]> {
  const entries = await readdir("/proc", { withFileTypes: true });
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const command = await readFile(`/proc/${entry.name}/cmdline`, "utf8").catch(() => "");
    if (command.includes(profileDir)) matches.push(entry.name);
  }
  return matches;
}

/**
 * Offline native-engine smoke (Linux host with /opt/google/chrome/chrome, Xvfb,
 * xauth and Chromium sandbox support):
 * REDDIT_BROWSER_INTEGRATION=1 npm test -- --test-name-pattern='offline native Reddit browser'
 * Exact search/post JSON requests are fulfilled in-process; no Reddit request is made.
 */
test("offline native Reddit browser exercises sandbox, pages, routes, evaluation and cleanup", { skip: !enabled, timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "reddit-browser-native-"));
  const profileDir = join(root, "profile");
  await mkdir(profileDir, { mode: 0o700 });
  const events: string[] = [];
  const searchBody = JSON.stringify(listing([post]));
  const postBody = JSON.stringify([listing([post]), listing([])]);
  const fixtures = new Map([
    [buildRedditSearchUrl({ q: "typescript", sort: "relevance", time: "all", limit: 5 }), searchBody],
    [buildRedditPostUrl("https://www.reddit.com/r/typescript/comments/abc123/title/", { sort: "confidence", limit: 10, depth: 2 }), postBody],
  ]);

  const browser: RedditBrowserDependencies = {
    createGate: createRedditNetworkGate,
    startDisplay: startRedditDisplay,
    resolveAddress: async () => "8.8.8.8",
    loadEngine: async () => ({
      launchPersistentContext: async (directory, options) => {
        events.push("launch");
        assert.ok(options);
        assert.equal(options.chromiumSandbox, true);
        assert.equal(options.headless, false);
        assert.ok(!options.args?.some((arg) => /no-sandbox|disable-setuid-sandbox|bwrap/.test(arg)));
        const context = await chromium.launchPersistentContext(directory, options);
        events.push("launched");
        context.on("close", () => events.push("context:event-close"));
        const instrumentPage = (page: Page): Page => {
          for (const property of ["goto", "evaluate", "close"] as const) {
            const original = page[property].bind(page) as (...args: unknown[]) => Promise<unknown>;
            (page[property] as (...args: unknown[]) => Promise<unknown>) = async (...args: unknown[]) => {
              events.push(`page:${property}`);
              try { return await original(...args); }
              catch (error) { events.push(`page:${property}:error:${error instanceof Error ? error.name : "unknown"}`); throw error; }
            };
          }
          return page;
        };
        return new Proxy(context, {
          get(target, property, receiver) {
            if (property === "newPage") return async () => {
              events.push("context:newPage");
              try { return instrumentPage(await target.newPage()); }
              catch (error) { events.push(`newPage:error:${error instanceof Error ? error.name : "unknown"}`); throw error; }
            };
            if (property === "pages") return () => { const pages = target.pages(); events.push(`context:pages:${pages.length}`); return pages; };
            if (property === "close") return async () => {
              events.push("context:close");
              try { await target.close(); events.push("context:closed"); }
              catch (error) { events.push(`close:error:${error instanceof Error ? error.name : "unknown"}`); throw error; }
            };
            if (property === "route") return async (pattern: string, handler: (route: Route) => Promise<void>) => { events.push("context:route"); return target.route(pattern, async (route) => {
              const body = fixtures.get(route.request().url());
              const controlled = body === undefined ? route : new Proxy(route, {
                get(routeTarget, routeProperty, routeReceiver) {
                  if (routeProperty === "continue") return async () => { events.push("fixture:fulfill"); await routeTarget.fulfill({ status: 200, contentType: "application/json", body }); };
                  const value = Reflect.get(routeTarget, routeProperty, routeReceiver);
                  return typeof value === "function" ? value.bind(routeTarget) : value;
                },
              });
              await handler(controlled);
            }); };
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }) as BrowserContext;
      },
    }),
  };

  try {
    const config = parseConfig({ reddit: { profileDir, executablePath: "/opt/google/chrome/chrome" } }, root);
    const result = await new RedditService(config, { request: requestRedditJson, now: () => new Date(), browser }).test(AbortSignal.timeout(75_000));
    assert.equal(result.status, "ready", `native phases: ${events.join(",")}`);
    assert.equal(events.filter((event) => event === "fixture:fulfill").length, 2);
    assert.equal(events.filter((event) => event === "page:goto").length, 4);
    assert.equal(events.filter((event) => event === "page:evaluate").length, 2);
    assert.equal(events.filter((event) => event === "context:closed").length, 2);
    assert.deepEqual((await readdir(profileDir)).filter((name) => name === ".pi-web-access-reddit.lock" || name.startsWith("Singleton")), []);
    assert.deepEqual(await profileProcesses(profileDir), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
