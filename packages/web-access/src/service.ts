import { join, resolve } from "node:path";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { WebConfig } from "./config.js";
import { resolveKey } from "./config.js";
import { request } from "./network.js";
import { ContentStore, type Document } from "./store.js";
import { search, type Provider } from "./providers.js";
import { extractHtml, extractPdf } from "./extraction.js";
import { renderPage } from "./browser.js";
import { cloneRepository, isGitHubRepository, cleanupRepository } from "./github.js";
import { extractFrames } from "./video.js";

export interface Fetched extends Document { images?: ImageContent[]; path?: string; status?: number; warning?: string }
export interface FetchInput { url: string; mode?: "readable" | "raw" | "answer"; render?: "auto" | "never" | "always"; timestamp?: string; frames?: number }
export async function mapBounded<T, R>(values: T[], action: (value: T, index: number) => Promise<R>, concurrency = 3): Promise<R[]> {
  const results = new Array<R>(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) { const index = next++; results[index] = await action(values[index]!, index); }
  }));
  return results;
}
export class WebService {
  readonly store: ContentStore;
  private readonly repositories = new Set<string>();
  private clonesInFlight = 0;
  async close(): Promise<void> {
    for (const path of this.repositories) await cleanupRepository(path);
    this.repositories.clear();
  }
  constructor(readonly config: WebConfig) { this.store = new ContentStore(config.cache); }
  provider(provider?: Provider): Provider {
    const selected = provider ?? this.config.search.provider;
    if (!selected) throw new Error("Select provider: gemini, brave or openai, or set search.provider in web-access.json. No automatic billable fallback.");
    return selected;
  }
  async search(queries: string[], options: { provider?: Provider; numResults?: number; domainFilter?: string[]; recencyFilter?: "day" | "week" | "month" | "year" }, signal?: AbortSignal) {
    const provider = this.provider(options.provider); const apiKey = await resolveKey(this.config, provider, process.env, signal);
    return mapBounded(queries, (query) => search(provider, query, {
      ...options, apiKey, signal,
      model: provider === "gemini" ? this.config.search.geminiModel : this.config.search.openaiModel,
    }));
  }
  async fetch(input: FetchInput, cwd: string, signal?: AbortSignal): Promise<Fetched> {
    const timeoutMs = this.config.fetch.timeoutMs;
    const budget = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    const local = !/^https?:\/\//i.test(input.url);
    const youtube = /^https:\/\/(?:www\.)?(?:youtube\.com\/watch\?|youtu\.be\/)/i.test(input.url);
    if (local || youtube) {
      if (input.mode === "raw" || input.mode === "answer") throw new Error("Video frame extraction supports readable mode only; no audio transcription or video model call");
      const result = await extractFrames(local ? resolve(cwd, input.url.replace(/^@/, "")) : input.url, { cwd, cacheDir: join(this.config.cache.directory, "media"), timeoutMs, signal: budget, timestamp: input.timestamp, frames: input.frames });
      return { ...result, url: input.url, images: result.images.map((image) => ({ type: "image", ...image })) };
    }
    if (input.timestamp || input.frames) throw new Error("Frame options require a local video or YouTube URL");
    if (input.mode !== "raw" && isGitHubRepository(input.url)) {
      if (this.repositories.size + this.clonesInFlight >= 4) throw new Error("Session repository limit reached (4); use git manually for further repositories");
      this.clonesInFlight++;
      try {
        const result = await cloneRepository(input.url, { cacheDir: join(this.config.cache.directory, "repos"), timeoutMs, signal: budget });
        this.repositories.add(result.path);
        return { ...result, url: input.url };
      } finally { this.clonesInFlight--; }
    }
    const response = await request(input.url, { timeoutMs, signal: budget, maxBytes: this.config.fetch.maxBytes });
    const mime = response.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() ?? "";
    const base = { url: response.url, title: response.url, status: response.status };
    if (input.mode === "raw") {
      if (!textual(mime)) throw new Error("Raw mode supports textual HTTP bodies only");
      return { ...base, content: response.body.toString("utf8"), method: "raw" };
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}; no authenticated or hosted extraction fallback`);
    if (mime === "application/pdf" || response.body.subarray(0, 5).toString() === "%PDF-") {
      return { ...base, ...await extractPdf(response.body, { maxPages: this.config.fetch.maxPdfPages, timeoutMs, signal: budget }) };
    }
    if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) {
      const resized = await resizeImage(response.body, mime, { maxWidth: 1280, maxHeight: 1280 });
      if (!resized) throw new Error("Image could not be decoded within image limits");
      return { ...base, method: "image", content: `Image from ${response.url}`, images: [{ type: "image", data: resized.data, mimeType: resized.mimeType }] };
    }
    if (!textual(mime)) throw new Error(`Unsupported content type: ${mime || "missing"}; expected HTML, text, JSON, Markdown, PDF or image`);
    const body = response.body.toString("utf8");
    if (!["text/html", "application/xhtml+xml"].includes(mime)) return { ...base, content: body, method: "text" };
    const extracted = extractHtml(body, response.url);
    const render = input.render ?? this.config.fetch.javascript;
    if (render === "always" || (render === "auto" && extracted.content.trim().length < 200)) {
      const html = await renderPage(response.url, { timeoutMs, signal: budget, request: (url, opts) => request(url, { ...opts, timeoutMs, signal: budget, maxBytes: this.config.fetch.maxBytes }) });
      const rendered = extractHtml(html, response.url);
      return { ...base, ...rendered, method: "chromium", warning: rendered.content.length < 200 ? "Rendered page still contains little text" : undefined };
    }
    return { ...base, ...extracted };
  }
}
function textual(mime: string): boolean { return mime.startsWith("text/") || ["application/json", "application/ld+json", "application/xml", "application/xhtml+xml"].includes(mime) || mime.endsWith("+json"); }
