import { apiJson, remoteUrl } from "./network.js";
import type { RequestOptions } from "./network.js";

export type Api = (url: string, options: RequestOptions) => Promise<unknown>;
export type Provider = "gemini" | "openai" | "brave";
export type ResearchProvider = "gemini" | "openai";
export interface Source { title: string; url: string; snippet?: string }
export interface ResearchSnapshot {
  upstreamId: string; status: string; report: string; citations: Source[];
  usage?: unknown; progress?: string; error?: string;
}
export interface SearchOptions {
  apiKey: string; model?: string; numResults?: number; domainFilter?: string[];
  recencyFilter?: "day" | "week" | "month" | "year"; signal?: AbortSignal; api?: Api;
}
export interface ResearchOptions { apiKey: string; model: string; signal?: AbortSignal; api?: Api }
type ObjectValue = Record<string, unknown>;
const GEMINI = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI = "https://api.openai.com/v1/responses";
const STATUSES = new Set(["queued", "in_progress", "completed", "failed", "cancelled", "incomplete", "budget_exceeded", "requires_action"]);
function invalid(field: string): never { throw new Error(`Invalid provider response: ${field}`); }
function object(value: unknown, field: string): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as ObjectValue;
}
function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}
function optionalArray(value: unknown, field: string): unknown[] { return value === undefined ? [] : array(value, field); }
function text(value: unknown, field: string): string { if (typeof value !== "string") invalid(field); return value; }
function providerCheck(provider: string, research = false): void {
  if (provider !== "gemini" && provider !== "openai" && (research || provider !== "brave")) throw new Error("Unsupported provider");
}
function identifier(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-][a-zA-Z0-9_.:-]{0,511}$/.test(value)) throw new Error(`Invalid ${label}`);
  return encodeURIComponent(value);
}
function inputCheck(value: string): void {
  if (typeof value !== "string" || !value.trim() || value.length > 200_000) throw new Error("Input must be nonempty text of at most 200000 characters");
}
// Do not surface upstream bodies, exception messages, credentials or request URLs.
async function call(provider: Provider, url: string, method: string, body: unknown, options: SearchOptions): Promise<unknown> {
  if (typeof options.apiKey !== "string" || !options.apiKey.trim() || /[\r\n]/.test(options.apiKey)) throw new Error(`${provider}: a valid API key is required`);
  if (options.signal?.aborted) throw new Error(`${provider}: request cancelled; request was not retried`);
  const headers: Record<string, string> = { accept: "application/json" };
  if (provider === "gemini") headers["x-goog-api-key"] = options.apiKey;
  else if (provider === "brave") headers["X-Subscription-Token"] = options.apiKey;
  else headers.Authorization = `Bearer ${options.apiKey}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  try {
    return await (options.api ?? apiJson)(url, {
      method, headers, ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)) }),
      signal: options.signal, timeoutMs: 120_000,
    });
  } catch (error) {
    if (options.signal?.aborted) throw new Error(`${provider}: request cancelled; request was not retried`);
    const status = error instanceof Error ? /^Provider HTTP ([1-5]\d{2});/.exec(error.message)?.[1] : undefined;
    throw new Error(`${provider}: ${status ? `HTTP ${status}` : "API request failed"}; check credentials, quota and availability. Request was not retried.`);
  }
}
// Clone only bounded JSON; never persist arbitrary provider objects or prototypes.
function usage(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  object(value, "usage");
  let nodes = 0, bytes = 0;
  function visit(v: unknown, depth: number): unknown {
    if (++nodes > 4096 || depth > 12) invalid("usage exceeds limits");
    if (v === null || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") { bytes += Buffer.byteLength(v); if (bytes > 65536) invalid("usage exceeds limits"); return v; }
    if (Array.isArray(v)) return v.map((entry) => visit(entry, depth + 1));
    const obj = object(v, "usage JSON");
    if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) invalid("usage JSON");
    return Object.fromEntries(Object.entries(obj).map(([key, entry]) => {
      bytes += Buffer.byteLength(key);
      if (bytes > 65536 || ["__proto__", "constructor", "prototype"].includes(key)) invalid("usage JSON");
      return [key, visit(entry, depth + 1)];
    }));
  }
  return visit(value, 0);
}
function source(value: unknown): Source | undefined {
  const item = object(value, "citation");
  if (typeof item.url !== "string") invalid("citation URL");
  let url: string;
  try { url = remoteUrl(item.url).href; } catch { return undefined; }
  if (item.title !== undefined && typeof item.title !== "string") invalid("citation title");
  if (item.snippet !== undefined && typeof item.snippet !== "string") invalid("citation snippet");
  return { url, title: ((item.title as string | undefined) || url).slice(0, 512),
    ...(typeof item.snippet === "string" ? { snippet: item.snippet.slice(0, 2000) } : {}) };
}
function addSource(sources: Source[], value: unknown): void {
  const parsed = source(value);
  if (parsed && !sources.some((s) => s.url === parsed.url)) {
    if (sources.length >= 1000) invalid("too many citations");
    sources.push(parsed);
  }
}
function annotations(block: ObjectValue, sources: Source[]): void {
  for (const raw of optionalArray(block.annotations, "annotations")) {
    const annotation = object(raw, "annotation");
    if (annotation.type === "url_citation") addSource(sources, annotation);
  }
}
function openaiOutput(raw: ObjectValue): { report: string; citations: Source[]; summaries: string[]; count: number } {
  const output = optionalArray(raw.output, "output"), parts: string[] = [], citations: Source[] = [], summaries: string[] = [];
  for (const entry of output) {
    const item = object(entry, "output item");
    if (item.type === "message" && item.role === "assistant") {
      for (const entry of array(item.content, "message content")) {
        const block = object(entry, "message block");
        if (block.type === "output_text") { parts.push(text(block.text, "output text")); annotations(block, citations); }
      }
    } else if (item.type === "reasoning") {
      for (const entry of optionalArray(item.summary, "reasoning summary")) {
        const summary = object(entry, "summary");
        if (summary.type === "summary_text") summaries.push(text(summary.text, "summary text"));
      }
    }
  }
  return { report: parts.join("\n\n"), citations, summaries, count: output.length };
}
export function parseResearch(provider: ResearchProvider, raw: unknown): ResearchSnapshot {
  providerCheck(provider, true);
  const data = object(raw, "research");
  const upstreamId = text(data.id, "research ID"); identifier(upstreamId, "research ID");
  const status = text(data.status, "research status");
  if (!STATUSES.has(status) || (provider === "openai" && ["budget_exceeded", "requires_action"].includes(status))) invalid("unknown research status");
  let report = "", citations: Source[] = [], summaries: string[] = [], count = 0;
  if (provider === "openai") ({ report, citations, summaries, count } = openaiOutput(data));
  else {
    const parts: string[] = [];
    const blocks = (entries: unknown[]) => {
      for (const entry of entries) {
        const block = object(entry, "content block");
        if (block.type === "text") { parts.push(text(block.text, "report text")); annotations(block, citations); }
      }
    };
    if (data.steps !== undefined) {
      const steps = array(data.steps, "steps"); count = steps.length;
      for (const entry of steps) {
        const step = object(entry, "step");
        if (step.type === "model_output") blocks(optionalArray(step.content, "model output content"));
        else if (step.type === "thought") {
          for (const entry of optionalArray(step.summary, "thought summary")) {
            const summary = object(entry, "thought summary block");
            if (summary.type === "text") summaries.push(text(summary.text, "summary text"));
          }
        }
      }
    } else if (data.outputs !== undefined) {
      // Explicit compatibility with the earlier Interactions text-output schema.
      const outputs = array(data.outputs, "legacy outputs"); count = outputs.length; blocks(outputs);
    }
    report = parts.join("\n\n");
  }
  if (status === "completed" && !report.trim()) invalid("completed research has no report");
  const snapshot: ResearchSnapshot = { upstreamId, status, report, citations };
  const validatedUsage = usage(data.usage);
  if (validatedUsage !== undefined) snapshot.usage = validatedUsage;
  snapshot.progress = `${count} steps; ${status}${summaries.length ? `: ${summaries.slice(-3).map((s) => s.slice(0, 500)).join("; ")}` : ""}`;
  if (["failed", "incomplete", "budget_exceeded", "requires_action"].includes(status)) snapshot.error = `${provider}: research ${status}; inspect provider account or retry explicitly`;
  return snapshot;
}
export async function startResearch(provider: ResearchProvider, input: string, options: ResearchOptions): Promise<ResearchSnapshot> {
  providerCheck(provider, true); inputCheck(input); identifier(options.model, "research model");
  const body = provider === "gemini"
    ? { input, agent: options.model, background: true, store: true, tools: [{ type: "google_search" }, { type: "url_context" }] }
    : { model: options.model, input, background: true, store: true, tools: [{ type: "web_search_preview" }] };
  return parseResearch(provider, await call(provider, provider === "gemini" ? `${GEMINI}/interactions` : OPENAI, "POST", body, options));
}
async function researchAction(provider: ResearchProvider, id: string, options: ResearchOptions, cancel: boolean): Promise<ResearchSnapshot> {
  providerCheck(provider, true);
  const encoded = identifier(id, "research ID");
  const url = `${provider === "gemini" ? `${GEMINI}/interactions` : OPENAI}/${encoded}${cancel ? "/cancel" : ""}`;
  const snapshot = parseResearch(provider, await call(provider, url, cancel ? "POST" : "GET", undefined, options));
  if (snapshot.upstreamId !== id) invalid("research ID mismatch");
  return snapshot;
}
export function getResearch(provider: ResearchProvider, id: string, options: ResearchOptions): Promise<ResearchSnapshot> { return researchAction(provider, id, options, false); }
export function cancelResearch(provider: ResearchProvider, id: string, options: ResearchOptions): Promise<ResearchSnapshot> { return researchAction(provider, id, options, true); }

export async function search(provider: Provider, query: string, options: SearchOptions): Promise<{ query: string; provider: Provider; answer: string; sources: Source[]; usage?: unknown }> {
  providerCheck(provider); inputCheck(query);
  const count = options.numResults ?? 5;
  if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error("numResults must be between 1 and 20");
  const domains = options.domainFilter ?? [];
  if (!Array.isArray(domains) || domains.length > 100 || domains.some((d) => typeof d !== "string" || !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(d))) throw new Error("domainFilter must contain at most 100 bare public domain names");
  for (const domain of domains) { try { remoteUrl(`https://${domain}`); } catch { throw new Error("domainFilter contains a nonpublic domain"); } }
  const freshness = { day: "pd", week: "pw", month: "pm", year: "py" };
  if (options.recencyFilter !== undefined && !Object.hasOwn(freshness, options.recencyFilter)) throw new Error("Invalid recencyFilter");
  // Responses web_search has no native date filter. Do not replace it with a prompt hint.
  if (options.recencyFilter && provider === "openai") throw new Error("openai: recencyFilter is unsupported; use brave or gemini for date-filtered search");
  const scopedQuery = domains.length ? `${query} (${domains.map((d) => `site:${d}`).join(" OR ")})` : query;
  let answer = "", sources: Source[] = [], validatedUsage: unknown;
  if (provider === "brave") {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", scopedQuery); url.searchParams.set("count", String(count));
    if (options.recencyFilter) url.searchParams.set("freshness", freshness[options.recencyFilter]);
    const data = object(await call(provider, url.href, "GET", undefined, options), "Brave search");
    const web = object(data.web, "Brave web results");
    for (const entry of array(web.results, "Brave results")) {
      const result = object(entry, "Brave result");
      addSource(sources, { title: result.title, url: result.url, snippet: result.description });
    }
  } else if (provider === "gemini") {
    const model = identifier(options.model ?? "gemini-2.5-flash", "search model");
    const end = new Date();
    const days = options.recencyFilter ? { day: 1, week: 7, month: 30, year: 365 }[options.recencyFilter] : undefined;
    const googleSearch = days === undefined ? {} : { timeRangeFilter: {
      startTime: new Date(end.getTime() - days * 86_400_000).toISOString(), endTime: end.toISOString(),
    } };
    const data = object(await call(provider, `${GEMINI}/models/${model}:generateContent`, "POST", {
      contents: [{ role: "user", parts: [{ text: `Search the web and answer with up to ${count} sources.\n${scopedQuery}` }] }], tools: [{ google_search: googleSearch }],
    }, options), "Gemini search");
    const candidate = object(array(data.candidates, "Gemini candidates")[0], "Gemini candidate");
    if (candidate.finishReason !== undefined && candidate.finishReason !== "STOP") invalid("Gemini search did not complete normally");
    const content = object(candidate.content, "Gemini content");
    answer = array(content.parts, "Gemini parts").map((entry) => {
      const part = object(entry, "Gemini part");
      return part.thought === true || part.text === undefined ? "" : text(part.text, "Gemini text");
    }).filter(Boolean).join("\n\n");
    const grounding = object(candidate.groundingMetadata, "Gemini Google Search grounding metadata");
    for (const entry of optionalArray(grounding.groundingChunks, "grounding chunks")) {
      const chunk = object(entry, "grounding chunk");
      if (chunk.web !== undefined) { const web = object(chunk.web, "grounding web source"); addSource(sources, { url: web.uri, title: web.title }); }
    }
    if (!answer.trim()) invalid("Gemini search has no answer");
    validatedUsage = usage(data.usageMetadata);
  } else {
    const model = options.model ?? "gpt-4.1-mini"; identifier(model, "search model");
    const data = object(await call(provider, OPENAI, "POST", {
      model, input: `Search the web and answer with up to ${count} sources.\n${query}`,
      tools: [{ type: "web_search", ...(domains.length ? { filters: { allowed_domains: domains } } : {}) }], tool_choice: "required",
    }, options), "OpenAI search");
    if (data.status !== "completed") invalid("OpenAI search did not complete");
    const parsed = openaiOutput(data); answer = parsed.report; sources = parsed.citations;
    if (!answer.trim()) invalid("OpenAI search has no answer");
    validatedUsage = usage(data.usage);
  }
  sources = sources.filter((s) => !domains.length || domains.some((d) => {
    const host = new URL(s.url).hostname.toLowerCase(); return host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`);
  })).slice(0, count);
  if (provider === "brave") answer = sources.map((s) => `${s.title}\n${s.url}${s.snippet ? `\n${s.snippet}` : ""}`).join("\n\n");
  return { query, provider, answer, sources, ...(validatedUsage === undefined ? {} : { usage: validatedUsage }) };
}
