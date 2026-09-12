import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { parseConfig, type WebConfig } from "../src/config.js";
import { RedditBrowserError } from "../src/reddit-browser.js";
import { REDDIT_CONTENT_TOOL_NAMES, REDDIT_TOOL_NAMES, registerRedditTools, type RedditToolDependencies } from "../src/reddit-tools.js";
import type { RedditDiagnostic } from "../src/reddit-service.js";
import { WebService } from "../src/service.js";

const diagnostic = (status: RedditDiagnostic["status"], eligible = status === "ready"): RedditDiagnostic => ({ status, eligible, message: `status ${status}` });
const context = { cwd: "/tmp", hasUI: false } as ExtensionContext;
function harness() {
  const tools = new Map<string, ToolDefinition>();
  return { tools, pi: { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI };
}
async function fixture(t: test.TestContext, status: RedditDiagnostic["status"] = "ready") {
  const directory = await mkdtemp(join(tmpdir(), "reddit-tools-")); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = parseConfig({ cache: { inlineChars: 100 } }, directory), web = new WebService(config), h = harness(), lifetime = new AbortController();
  let current = diagnostic(status), searchCalls = 0, fetchCalls = 0, testCalls = 0;
  const service = {
    inspect: async () => current,
    test: async () => { testCalls++; current = diagnostic("ready"); return current; },
    search: async (_params: unknown, signal?: AbortSignal) => {
      searchCalls++; signal?.throwIfAborted();
      return { items: [{ id: "t3_abc123", title: "A title", url: "https://www.reddit.com/comments/abc123", excerpt: "x".repeat(1000), score: 4, numComments: 2 }], after: "t3_def456" };
    },
    fetchPost: async (_url: string, _options: unknown, signal?: AbortSignal) => {
      fetchCalls++; signal?.throwIfAborted();
      return { post: { id: "t3_abc123", title: "A title", url: "https://www.reddit.com/comments/abc123", excerpt: "", score: 4, numComments: 20, body: "p".repeat(1000), author: "author" }, comments: [{ id: "t1_def456", author: "commenter", body: "comment body", score: 2, depth: 0, replies: [] }], more: { placeholders: 2, children: 9 }, truncated: true };
    },
  };
  let loadedConfig: WebConfig = config;
  const dependencies: RedditToolDependencies = { loadConfig: async () => loadedConfig, createService: () => service };
  registerRedditTools(h.pi, config, web, service, current, lifetime.signal, dependencies);
  return { ...h, config, web, service, lifetime, dependencies, setDiagnostic: (value: RedditDiagnostic) => { current = value; }, setConfig: (value: WebConfig) => { loadedConfig = value; }, calls: () => ({ searchCalls, fetchCalls, testCalls }) };
}
async function execute(f: Awaited<ReturnType<typeof fixture>>, name: string, params: unknown, signal?: AbortSignal) {
  return f.tools.get(name)!.execute("call", params, signal, undefined, context);
}

test("diagnostic is always registered while content tools use the startup eligibility snapshot", async (t) => {
  for (const status of ["not_configured", "untested", "access_denied", "profile_busy"] as const) {
    const f = await fixture(t, status);
    assert.deepEqual([...f.tools.keys()], ["reddit_profile_diagnostic"]);
    const inspected = await execute(f, "reddit_profile_diagnostic", {});
    assert.match((inspected.content[0] as { text: string }).text, new RegExp(status));
  }
  const ready = await fixture(t);
  assert.deepEqual([...ready.tools.keys()], ["reddit_profile_diagnostic", ...REDDIT_CONTENT_TOOL_NAMES]);
});

test("diagnostic test does not mutate tools and directs newly-ready sessions to reload", async (t) => {
  const f = await fixture(t, "untested"), names = [...f.tools.keys()];
  const value = await execute(f, "reddit_profile_diagnostic", { action: "test" });
  assert.deepEqual([...f.tools.keys()], names); assert.equal(f.calls().testCalls, 1);
  assert.match((value.content[0] as { text: string }).text, /\/reload/);
});

test("stale diagnostic stays visible but does not test when runtime configuration is disabled", async (t) => {
  const f = await fixture(t);
  f.setConfig(parseConfig({ enabled: false }, join(f.config.cache.directory, "disabled-agent")));
  await assert.rejects(execute(f, "reddit_profile_diagnostic", { action: "test" }), /disabled.*\/reload/i);
  assert.ok(f.tools.has("reddit_profile_diagnostic")); assert.equal(f.calls().testCalls, 0);
});

test("strict schemas reject hook-mutated arguments before service calls", async (t) => {
  const f = await fixture(t);
  await assert.rejects(execute(f, "reddit_search", { q: "ok", sort: "invalid" }), /Invalid reddit_search/);
  await assert.rejects(execute(f, "reddit_search", { q: "ok", extra: true }), /Invalid reddit_search/);
  await assert.rejects(execute(f, "reddit_fetch_content", { url: "https://redd.it/abc123", depth: 11 }), /Invalid reddit_fetch_content/);
  await assert.rejects(execute(f, "reddit_profile_diagnostic", { action: "probe" }), /Invalid reddit_profile_diagnostic/);
  assert.deepEqual(f.calls(), { searchCalls: 0, fetchCalls: 0, testCalls: 0 });
});

test("search and fetch store full parsed text with bounded inline previews and safe details", async (t) => {
  const f = await fixture(t);
  const searched = await execute(f, "reddit_search", { q: "typescript", limit: 1 });
  const searchText = (searched.content[0] as { text: string }).text;
  assert.ok(Buffer.byteLength(searchText) < 40_000); assert.match(searchText, /Preview truncated/);
  assert.match(searchText, /after=t3_def456/); assert.match(searchText, /not fetched automatically/);
  assert.deepEqual(Object.keys(searched.details!).sort(), ["responseId", "summary"]);
  const searchStored = await f.web.store.get((searched.details as { responseId: string }).responseId);
  assert.ok(searchStored[0]!.content.length > 100); assert.match(searchStored[0]!.content, /^Pagination: after=t3_def456/);
  const fetched = await execute(f, "reddit_fetch_content", { url: "https://redd.it/abc123", sort: "top", limit: 10, depth: 2 });
  const fetchText = (fetched.content[0] as { text: string }).text;
  assert.match(fetchText, /returned=1/); assert.match(fetchText, /more placeholders=2/); assert.match(fetchText, /omitted child IDs=9/); assert.match(fetchText, /truncated=yes/);
  assert.match((await f.web.store.get((fetched.details as { responseId: string }).responseId))[0]!.content, /^Comment coverage \(partial\):.*comment body/s);
  assert.match(f.tools.get("reddit_search")!.description, /never fetches additional pages automatically/);
  assert.match(f.tools.get("reddit_fetch_content")!.description, /counts may be partial.*never fetched automatically/);
  assert.deepEqual(f.calls(), { searchCalls: 1, fetchCalls: 1, testCalls: 0 });
});

test("runtime config/readiness changes keep names visible and return actionable errors", async (t) => {
  const f = await fixture(t), names = [...f.tools.keys()];
  f.setConfig(parseConfig({}, join(f.config.cache.directory, "changed-agent")));
  f.setDiagnostic(diagnostic("untested", false));
  await assert.rejects(execute(f, "reddit_search", { q: "q" }), /diagnostic.*test.*\/reload/i);
  assert.deepEqual([...f.tools.keys()], names); assert.equal(f.calls().searchCalls, 0);
  f.setConfig(f.config); f.setDiagnostic(diagnostic("ready"));
  f.service.search = async () => { f.setDiagnostic(diagnostic("access_denied", false)); throw new Error("HTTP 403"); };
  await assert.rejects(execute(f, "reddit_search", { q: "q" }), /access_denied.*diagnostic.*\/reload/i);
  assert.deepEqual([...f.tools.keys()], names);
});

test("session lifetime abort preserves a late browser cancellation without unregistering tools", async (t) => {
  const f = await fixture(t); let started!: () => void;
  const waiting = new Promise<void>((resolve) => { started = resolve; });
  f.service.search = async (_params: unknown, signal?: AbortSignal) => {
    started();
    return new Promise((resolve, reject) => signal!.addEventListener("abort", () => {
      f.setDiagnostic(diagnostic("profile_busy", false)); reject(new RedditBrowserError("cancelled"));
    }, { once: true }));
  };
  const pending = execute(f, "reddit_search", { q: "q" }); await waiting; f.lifetime.abort();
  await assert.rejects(pending, (error: RedditBrowserError) => error instanceof RedditBrowserError && error.name === "RedditBrowserError" && error.code === "cancelled");
  assert.deepEqual(new Set(f.tools.keys()), new Set(REDDIT_TOOL_NAMES));
});
