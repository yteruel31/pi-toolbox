import assert from "node:assert/strict";
import test from "node:test";
import { access, chmod, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, type WebConfig } from "../src/config.js";
import { RedditBrowserError, requestRedditJson, type RedditBrowserDependencies } from "../src/reddit-browser.js";
import { RedditService } from "../src/reddit-service.js";

const listing = (children: unknown[]) => ({ kind: "Listing", data: { children, after: null } });
const post = { kind: "t3", data: { id: "abc123", title: "title", permalink: "/r/typescript/comments/abc123/title/", selftext: "body", score: 1, num_comments: 0 } };
async function configFixture(t: test.TestContext): Promise<{ config: WebConfig; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "reddit-service-")); t.after(() => import("node:fs/promises").then((fs) => fs.rm(root, { recursive: true, force: true })));
  const profile = join(root, "profile"); await mkdir(profile, { mode: 0o700 });
  return { root, config: parseConfig({ reddit: { profileDir: profile, executablePath: "/bin/true" } }, root) };
}
async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await predicate()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.fail("condition was not reached");
}
function lateLaunchBrowser(closeWait: Promise<void>) {
  let finishLaunch!: () => void, closes = 0, launchStarted = false;
  const launchWait = new Promise<void>((resolve) => { finishLaunch = resolve; });
  const context = { browser: () => undefined, on: () => {}, close: async () => { closes++; await closeWait; } } as any;
  const browser: RedditBrowserDependencies = {
    createGate: async () => ({ port: 3210, enable: () => {}, disable: () => {}, close: async () => {} }),
    startDisplay: async () => ({ value: ":1", socketPath: "/x", authPath: "/auth", close: async () => {} }),
    resolveAddress: async () => "8.8.8.8",
    loadEngine: async () => ({ launchPersistentContext: async () => { launchStarted = true; await launchWait; return context; } }),
  };
  return { browser, finishLaunch, launchStarted: () => launchStarted, closes: () => closes };
}

test("inspection is local and reports not configured, untested, busy and invalid permissions", async (t) => {
  let calls = 0; const dep = { request: async () => { calls++; throw new Error("must not launch"); }, now: () => new Date(0) };
  assert.equal((await new RedditService(parseConfig({}, "/agent"), dep).inspect()).status, "not_configured");
  const { config } = await configFixture(t), service = new RedditService(config, dep); assert.equal((await service.inspect()).status, "untested"); assert.equal(calls, 0);
  await assert.rejects(access(config.reddit.stateDir)); // strict inspection does not create state
  await symlink("remote-pid", join(config.reddit.profileDir!, "SingletonLock")); assert.equal((await service.inspect()).status, "profile_busy");
  await import("node:fs/promises").then((fs) => fs.unlink(join(config.reddit.profileDir!, "SingletonLock")));
  await chmod(config.reddit.profileDir!, 0o755); assert.equal((await service.inspect()).status, "profile_unsafe"); assert.equal(calls, 0);
});

test("explicit diagnostic makes exactly one search and one post request, persists safe ready metadata and invalidates identity changes", async (t) => {
  const { config, root } = await configFixture(t); const urls: string[] = [];
  const service = new RedditService(config, { now: () => new Date("2026-01-02T03:04:05Z"), request: async (_config, url) => { urls.push(url); return { status: 200, body: JSON.stringify(url.includes("search.json") ? listing([post]) : [listing([post]), listing([])]) }; } });
  const result = await service.test(); assert.equal(result.status, "ready"); assert.equal(result.eligible, true); assert.equal(urls.length, 2); assert.match(urls[0]!, /search\.json/); assert.match(urls[1]!, /comments\/abc123\.json/);
  const inspected = await service.inspect(); assert.equal(inspected.status, "ready"); assert.equal(inspected.lastValidatedAt, "2026-01-02T03:04:05.000Z");
  const metadata = await readFile(join(config.reddit.stateDir, "validation.json"), "utf8"); assert.doesNotMatch(metadata, /profile|chrome|cookie|typescript/);
  const changed = parseConfig({ reddit: { profileDir: config.reddit.profileDir, executablePath: "/bin/false" } }, root);
  assert.equal((await new RedditService(changed).inspect()).status, "untested");
});

test("403 is persisted and reported as access_denied rather than missing profile or logout", async (t) => {
  const { config } = await configFixture(t); let calls = 0;
  const service = new RedditService(config, { now: () => new Date(0), request: async () => { calls++; throw new RedditBrowserError("access_denied"); } });
  const result = await service.test(); assert.equal(result.status, "access_denied"); assert.equal(calls, 1); assert.match(result.message, /403/); assert.doesNotMatch(result.message, /logged out|missing profile/i);
  assert.equal((await service.inspect()).status, "access_denied");
});

test("timeout and cancellation diagnostics remain honest and runtime failures invalidate ready", async (t) => {
  const { config } = await configFixture(t);
  const timeout = await new RedditService(config, { now: () => new Date(0), request: async () => { throw new RedditBrowserError("timeout"); } }).test();
  assert.equal(timeout.status, "timeout"); assert.equal((await new RedditService(config).inspect()).status, "browser_unavailable");
  const cancelled = await new RedditService(config, { now: () => new Date(1), request: async () => { throw new RedditBrowserError("cancelled"); } }).test();
  assert.equal(cancelled.status, "cancelled"); assert.equal((await new RedditService(config).inspect()).status, "browser_unavailable");
});

test("pre-cancelled diagnostic creates no state, profile lock, or browser work", async (t) => {
  const { config } = await configFixture(t); let calls = 0; const controller = new AbortController(); controller.abort();
  const result = await new RedditService(config, { now: () => new Date(0), request: async () => { calls++; throw new Error("must not launch"); } }).test(controller.signal);
  assert.equal(result.status, "cancelled"); assert.equal(calls, 0);
  await assert.rejects(access(config.reddit.stateDir)); await assert.rejects(access(join(config.reddit.profileDir!, ".pi-web-access-reddit.lock")));
});

test("invalid runtime arguments preserve previously ready validation", async (t) => {
  const { config } = await configFixture(t);
  const ready = new RedditService(config, { now: () => new Date(0), request: async (_config, url) => ({ status: 200, body: JSON.stringify(url.includes("search.json") ? listing([post]) : [listing([post]), listing([])]) }) });
  assert.equal((await ready.test()).status, "ready");
  await assert.rejects(ready.search({ q: "", limit: 100 }));
  await assert.rejects(ready.fetchPost("https://evil.test/comments/abc123"));
  assert.equal((await ready.inspect()).status, "ready");
});

test("service cancellation during a real mocked launch retains its borrowed lock through pending close", async (t) => {
  const { config } = await configFixture(t); let finishClose!: () => void;
  const h = lateLaunchBrowser(new Promise<void>((resolve) => { finishClose = resolve; }));
  const service = new RedditService(config, { now: () => new Date(0), request: requestRedditJson, browser: h.browser });
  const controller = new AbortController(), result = service.test(controller.signal);
  await waitFor(h.launchStarted); controller.abort(); assert.equal((await result).status, "cancelled");
  assert.ok(await access(join(config.reddit.profileDir!, ".pi-web-access-reddit.lock")).then(() => true, () => false));
  h.finishLaunch(); await waitFor(() => h.closes() > 0);
  assert.ok(await access(join(config.reddit.profileDir!, ".pi-web-access-reddit.lock")).then(() => true, () => false));
  finishClose(); await waitFor(() => access(join(config.reddit.profileDir!, ".pi-web-access-reddit.lock")).then(() => false, () => true));
});

test("service cancellation retains its borrowed lock indefinitely when late browser close rejects", async (t) => {
  const { config } = await configFixture(t); let rejectClose!: (error: Error) => void;
  const h = lateLaunchBrowser(new Promise<void>((_resolve, reject) => { rejectClose = reject; }));
  const service = new RedditService(config, { now: () => new Date(0), request: requestRedditJson, browser: h.browser });
  const controller = new AbortController(), result = service.test(controller.signal);
  await waitFor(h.launchStarted); controller.abort(); assert.equal((await result).status, "cancelled"); h.finishLaunch();
  await waitFor(() => h.closes() > 0); rejectClose(new Error("unknown process state"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(await access(join(config.reddit.profileDir!, ".pi-web-access-reddit.lock")).then(() => true, () => false));
});
