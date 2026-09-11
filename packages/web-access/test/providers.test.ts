import assert from "node:assert/strict";
import test from "node:test";
import { search, startResearch, getResearch, cancelResearch, parseResearch } from "../src/providers.js";
import type { Api, ResearchProvider } from "../src/providers.js";
import type { RequestOptions } from "../src/network.js";

function mock(raw: unknown) {
  const calls: { url: string; options: RequestOptions; body: unknown }[] = [];
  const api: Api = async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body.toString()) : undefined }); return raw;
  };
  return { api, calls };
}
const citation = { type: "url_citation", url: "https://example.com/report", title: "Report", start_index: 0, end_index: 6 };
function completed(provider: ResearchProvider, report = "Final report") {
  return provider === "gemini"
    ? { id: "job_123", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: report, annotations: [citation] }] }], usage: { total_tokens: 42 } }
    : { id: "job_123", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: report, annotations: [citation] }] }], usage: { total_tokens: 42 } };
}
for (const provider of ["gemini", "openai"] as const) {
  test(`${provider}: research start sends exact native background request and API-key auth`, async () => {
    const { api, calls } = mock({ id: "job_123", status: "queued" });
    const signal = new AbortController().signal;
    const model = provider === "gemini" ? "deep-research-preview-04-2026" : "o4-mini-deep-research";
    const snapshot = await startResearch(provider, "Research this", { apiKey: "test-secret", model, signal, api });
    assert.equal(snapshot.status, "queued"); assert.equal(snapshot.report, ""); assert.deepEqual(snapshot.citations, []);
    assert.equal(calls.length, 1);
    const request = calls[0]!;
    assert.equal(request.url, provider === "gemini" ? "https://generativelanguage.googleapis.com/v1beta/interactions" : "https://api.openai.com/v1/responses");
    assert.equal(request.options.method, "POST"); assert.equal(request.options.signal, signal);
    assert.equal(request.options.headers?.[provider === "gemini" ? "x-goog-api-key" : "Authorization"], provider === "gemini" ? "test-secret" : "Bearer test-secret");
    assert.equal(request.url.includes("test-secret"), false);
    assert.equal(request.options.headers?.["content-type"], "application/json");
    assert.deepEqual(request.body, provider === "gemini"
      ? { input: "Research this", agent: model, background: true, store: true, tools: [{ type: "google_search" }, { type: "url_context" }] }
      : { input: "Research this", model, background: true, store: true, tools: [{ type: "web_search_preview" }] });
  });
  test(`${provider}: get preserves full Unicode report and bounded usage, cancel uses POST`, async () => {
    const report = "Résumé 🌍 — citations use bytes, not JS offsets.\n".repeat(6000);
    const get = mock(completed(provider, report));
    const options = { apiKey: "secret", model: "model", api: get.api };
    const result = await getResearch(provider, "job_123", options);
    assert.equal(result.report, report); assert.deepEqual(result.usage, { total_tokens: 42 });
    assert.deepEqual(result.citations, [{ title: "Report", url: citation.url }]);
    assert.equal(get.calls[0]!.options.method, "GET"); assert.equal(get.calls[0]!.body, undefined);
    assert.match(get.calls[0]!.url, /\/(interactions|responses)\/job_123$/);
    const cancel = mock({ id: "job_123", status: "cancelled" });
    assert.equal((await cancelResearch(provider, "job_123", { ...options, api: cancel.api })).status, "cancelled");
    assert.equal(cancel.calls[0]!.options.method, "POST"); assert.match(cancel.calls[0]!.url, /\/job_123\/cancel$/);
    assert.equal(cancel.calls[0]!.body, undefined);
  });
  test(`${provider}: malformed/empty completed responses and unknown statuses fail`, () => {
    for (const raw of [null, [], {}, { id: "job_123", status: "mystery" }, { id: "job_123", status: "completed" }, { id: "../bad", status: "queued" }, { id: "job_123", status: "completed", output: "oops", steps: "oops" }]) {
      assert.throws(() => parseResearch(provider, raw), /Invalid/);
    }
    for (const status of ["queued", "in_progress", "cancelled", "failed", "incomplete"]) {
      const result = parseResearch(provider, { id: "job_123", status, error: { message: "secret-key" } });
      assert.equal(result.status, status); assert.equal(result.report, ""); assert.equal(JSON.stringify(result).includes("secret-key"), false);
    }
  });
  test(`${provider}: no retry or secret disclosure on failed start`, async () => {
    let calls = 0;
    const api: Api = async () => { calls++; throw new Error("secret-key https://private.example/request?key=secret-key"); };
    await assert.rejects(startResearch(provider, "Input", { apiKey: "secret-key", model: "model", api }), (e: Error) => {
      assert.match(e.message, /not retried/); assert.equal(e.message.includes("secret-key"), false); assert.equal(e.message.includes("private.example"), false); return true;
    });
    assert.equal(calls, 1);
  });
  test(`${provider}: get rejects mismatched IDs and refuses path injection before network`, async () => {
    const { api, calls } = mock({ id: "different", status: "queued" });
    await assert.rejects(getResearch(provider, "job_123", { apiKey: "key", model: "model", api }), /ID mismatch/);
    await assert.rejects(cancelResearch(provider, "../job", { apiKey: "key", model: "model", api }), /Invalid research ID/);
    assert.equal(calls.length, 1);
  });
}
test("Gemini uses model_output steps, ignores user/tool/reasoning content and explicitly supports legacy outputs", () => {
  const raw = { id: "job_123", status: "completed", steps: [
    { type: "user_input", content: [{ type: "text", text: "PRIVATE INPUT" }] },
    { type: "thought", text: "PRIVATE REASONING", signature: "PRIVATE SIGNATURE", summary: [{ type: "text", text: "Checking sources" }] },
    { type: "google_search_result", content: [{ type: "text", text: "RAW TOOL" }] },
    { type: "model_output", content: [{ type: "text", text: "Final", annotations: [citation, citation] }] },
  ], outputs: [{ type: "text", text: "OBSOLETE" }] };
  const result = parseResearch("gemini", raw);
  assert.equal(result.report, "Final"); assert.equal(result.citations.length, 1);
  assert.equal(result.progress, "4 steps; completed: Checking sources");
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|RAW TOOL|OBSOLETE/);
  assert.equal(parseResearch("gemini", { id: "job", status: "completed", outputs: [{ type: "thought", text: "hidden" }, { type: "text", text: "Legacy", annotations: [citation] }] }).report, "Legacy");
  for (const status of ["requires_action", "budget_exceeded"]) assert.match(parseResearch("gemini", { id: "job", status }).error!, new RegExp(status));
});
test("OpenAI exposes only assistant output_text and explicit summaries", () => {
  const result = parseResearch("openai", { id: "job", status: "completed", output: [
    { type: "reasoning", content: [{ type: "reasoning_text", text: "PRIVATE" }], encrypted_content: "PRIVATE", summary: [{ type: "summary_text", text: "Reading sources" }] },
    { type: "message", role: "user", content: [{ type: "output_text", text: "PRIVATE" }] },
    { type: "web_search_call", action: { query: "PRIVATE" } },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "One", annotations: [citation] }, { type: "output_text", text: "Two" }] },
  ] });
  assert.equal(result.report, "One\n\nTwo"); assert.match(result.progress!, /Reading sources/); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
});
test("citations drop nonpublic or non-HTTP URLs, deduplicate, and reject malformed fields", () => {
  const raw = { id: "job", status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: "Report", annotations: [
    ...["http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/", "https://localhost/", "https://host.internal/", "https://user:pass@example.com/", "javascript:alert(1)", "file:///etc/passwd", "https://example.com:8443/"].map((url) => ({ ...citation, url })),
    { ...citation, title: "x".repeat(1000) }, citation,
  ] }] }] };
  const parsed = parseResearch("gemini", raw); assert.equal(parsed.citations.length, 1); assert.equal(parsed.citations[0]!.title.length, 512);
  raw.steps[0]!.content[0]!.annotations = [{ ...citation, url: 42 as unknown as string }];
  assert.throws(() => parseResearch("gemini", raw), /citation URL/);
});
test("usage is cloned JSON with depth, node, byte and prototype limits", () => {
  const usage = { total_tokens: 5, modalities: [{ modality: "text", tokens: 2 }], cached: null };
  const result = parseResearch("openai", { ...completed("openai"), usage });
  assert.deepEqual(result.usage, usage); assert.notEqual(result.usage, usage);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  for (const bad of ["not object", { value: Infinity }, { value: undefined }, { value: "x".repeat(65537) }, { value: Array(5000).fill(1) }, { value: new Date() }, cyclic, JSON.parse('{"__proto__":{}}')]) {
    assert.throws(() => parseResearch("openai", { ...completed("openai"), usage: bad }), /usage/);
  }
});
test("Brave sends encoded query, domain operators, count and freshness; bounds snippets", async () => {
  const { api, calls } = mock({ web: { results: [
    { title: "Example", url: "https://example.com/page", description: "s".repeat(4000) },
    { title: "Private", url: "http://10.0.0.1/page", description: "no" },
    { title: "Other", url: "https://other.com/page" },
  ] } });
  const result = await search("brave", "hello & world", { apiKey: "secret", numResults: 2, domainFilter: ["example.com"], recencyFilter: "week", api });
  const url = new URL(calls[0]!.url);
  assert.equal(url.origin + url.pathname, "https://api.search.brave.com/res/v1/web/search");
  assert.equal(url.searchParams.get("q"), "hello & world (site:example.com)");
  assert.equal(url.searchParams.get("count"), "2"); assert.equal(url.searchParams.get("freshness"), "pw");
  assert.equal(calls[0]!.options.headers?.["X-Subscription-Token"], "secret"); assert.equal(calls[0]!.options.method, "GET");
  assert.equal(result.sources.length, 1); assert.equal(result.sources[0]!.snippet!.length, 2000); assert.equal(result.query, "hello & world");
  assert.match(result.answer, /https:\/\/example.com\/page/);
});
test("Brave accepts explicit zero results, rejects missing or malformed results", async () => {
  assert.deepEqual((await search("brave", "q", { apiKey: "key", api: mock({ web: { results: [] } }).api })).sources, []);
  for (const raw of [{}, { web: {} }, { web: { results: "bad" } }, { web: { results: [{ url: "https://example.com", title: 42 }] } }]) {
    await assert.rejects(search("brave", "q", { apiKey: "key", api: mock(raw).api }), /Invalid provider response/);
  }
});
test("Gemini ordinary search uses generateContent and Google Search grounding", async () => {
  const { api, calls } = mock({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "hidden", thought: true }, { text: "Grounded answer" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: citation.url, title: citation.title } }] } }], usageMetadata: { totalTokenCount: 10 } });
  const result = await search("gemini", "Question", { apiKey: "secret", model: "gemini-test", api });
  assert.equal(calls[0]!.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent");
  assert.deepEqual((calls[0]!.body as { tools: unknown }).tools, [{ google_search: {} }]);
  assert.equal(calls[0]!.options.headers?.["x-goog-api-key"], "secret");
  assert.equal(result.answer, "Grounded answer"); assert.deepEqual(result.sources, [{ title: citation.title, url: citation.url }]);
  assert.deepEqual(result.usage, { totalTokenCount: 10 });
});
test("OpenAI ordinary search uses web_search (not preview) and native domain filters", async () => {
  const { api, calls } = mock(completed("openai"));
  const result = await search("openai", "Question", { apiKey: "secret", model: "gpt-test", domainFilter: ["example.com"], api });
  assert.equal(calls[0]!.url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0]!.options.headers?.Authorization, "Bearer secret");
  assert.deepEqual((calls[0]!.body as { tools: unknown }).tools, [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }]);
  assert.equal((calls[0]!.body as { model: string }).model, "gpt-test");
  assert.equal(result.answer, "Final report"); assert.equal(result.sources.length, 1);
});
test("ordinary search rejects malformed responses, failed statuses and unsupported filters without fallback", async () => {
  for (const provider of ["gemini", "openai"] as const) {
    for (const raw of [{}, { status: "failed" }, { status: "completed", output: [] }, { candidates: [{ finishReason: "SAFETY" }] }]) {
      const { api, calls } = mock(raw);
      await assert.rejects(search(provider, "q", { apiKey: "key", api }), /Invalid provider response/); assert.equal(calls.length, 1);
    }
    if (provider === "openai") {
      const { api, calls } = mock({});
      await assert.rejects(search(provider, "q", { apiKey: "key", recencyFilter: "day", api }), /unsupported/); assert.equal(calls.length, 0);
    }
  }
});
test("Gemini recency uses documented GoogleSearch timeRangeFilter", async () => {
  const { api, calls } = mock({ candidates: [{ content: { parts: [{ text: "Answer" }] }, groundingMetadata: { groundingChunks: [] } }] });
  const before = Date.now();
  await search("gemini", "q", { apiKey: "key", recencyFilter: "week", api });
  const body = calls[0]!.body as { tools: { google_search: { timeRangeFilter: { startTime: string; endTime: string } } }[] };
  const range = body.tools[0]!.google_search.timeRangeFilter;
  assert.equal(Date.parse(range.endTime) - Date.parse(range.startTime), 7 * 86400000);
  assert.ok(Date.parse(range.endTime) >= before && Date.parse(range.endTime) <= Date.now());
});
test("pre-aborted requests never invoke the API and do not disclose abort reasons", async () => {
  const { api, calls } = mock({});
  const controller = new AbortController(); controller.abort(new Error("secret reason"));
  await assert.rejects(startResearch("openai", "q", { apiKey: "key", model: "model", signal: controller.signal, api }), (e: Error) => {
    assert.match(e.message, /cancelled/); assert.doesNotMatch(e.message, /secret reason/); return true;
  });
  assert.equal(calls.length, 0);
});
test("input validation prevents requests; safe HTTP errors keep status only", async () => {
  const { api, calls } = mock({});
  for (const options of [{ numResults: 0 }, { numResults: 21 }, { numResults: NaN }, { domainFilter: ["example.com/path"] }, { domainFilter: ["host.internal"] }, { apiKey: "bad\nkey" }]) {
    await assert.rejects(search("brave", "q", { apiKey: "key", api, ...options }));
  }
  await assert.rejects(startResearch("gemini", "", { apiKey: "key", model: "model", api }));
  await assert.rejects(startResearch("gemini", "q", { apiKey: "key", model: "../model", api }));
  assert.equal(calls.length, 0);
  await assert.rejects(search("brave", "q", { apiKey: "key", api: async () => { throw new Error("Provider HTTP 429; secret"); } }), (e: Error) => {
    assert.match(e.message, /HTTP 429/); assert.doesNotMatch(e.message, /secret/); return true;
  });
});
