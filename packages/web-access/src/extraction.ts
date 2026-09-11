import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { Worker } from "node:worker_threads";

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export interface ExtractionResult { title: string; content: string; method: string }

/** Bound UTF-8 without introducing a partial final code point. All output is untrusted. */
export function boundText(text: string, limit = MAX_TEXT_BYTES): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function extractHtml(html: string, url: string): ExtractionResult {
  if (Buffer.byteLength(html) > MAX_TEXT_BYTES) throw new Error("HTML exceeds the 5 MiB extraction limit");
  const { document } = parseHTML(/<html[\s>]/i.test(html) ? html : `<html><head></head><body>${html}</body></html>`);
  // Linkedom parses inertly: neither scripts nor event handlers are evaluated.
  const embedded: string[] = [];
  for (const script of document.querySelectorAll('script#__NEXT_DATA__, script[type="application/json"]')) {
    try {
      const value: unknown = JSON.parse(script.textContent ?? "");
      embedded.push(JSON.stringify(value));
    } catch { /* Never interpret JavaScript / Flight push expressions as JSON. */ }
  }
  const title = boundText(document.title ?? "", 4096);
  for (const node of document.querySelectorAll("script, style, noscript, iframe, object, embed, template")) node.remove();
  // Resolve only ordinary web links. Remove executable/local URLs before Markdown conversion.
  for (const node of document.querySelectorAll("[href], [src]")) {
    for (const attr of ["href", "src"]) {
      const value = node.getAttribute(attr);
      if (value === null) continue;
      try {
        const target = new URL(value, url);
        if (!["http:", "https:"].includes(target.protocol)) node.removeAttribute(attr);
        else node.setAttribute(attr, target.href);
      } catch { node.removeAttribute(attr); }
    }
  }
  let article: ReturnType<Readability["parse"]> = null;
  try { article = new Readability(document.cloneNode(true) as unknown as Document).parse(); } catch { /* Plain document fallback. */ }
  const converter = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const content = converter.turndown(article?.content || document.querySelector("body")?.innerHTML || "").trim();
  if (content) return { title: boundText(article?.title || title, 4096), content: boundText(content), method: article ? "readability" : "html" };
  return { title, content: boundText(embedded.join("\n\n")), method: embedded.length ? "next-json" : "html" };
}

export function extractPdf(bytes: Buffer, options: { maxPages: number; timeoutMs: number; signal?: AbortSignal }): Promise<ExtractionResult> {
  if (!Number.isSafeInteger(options.maxPages) || options.maxPages < 1) return Promise.reject(new Error("maxPages must be a positive integer"));
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) return Promise.reject(new Error("timeoutMs must be positive"));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? new Error("PDF extraction aborted"));
  // Bound input too; worker memory limits alone do not bound external ArrayBuffers.
  if (bytes.length > 50 * 1024 * 1024) return Promise.reject(new Error("PDF exceeds the 50 MiB input limit"));
  return new Promise((resolve, reject) => {
    const data = Uint8Array.from(bytes);
    const worker = new Worker(new URL("./pdf-worker.mjs", import.meta.url), {
      workerData: { bytes: data, maxPages: options.maxPages, maxTextBytes: MAX_TEXT_BYTES },
      transferList: [data.buffer],
      resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
      // Do not inherit tsx/custom application loaders in this plain ESM worker.
      execArgv: [], stdout: true, stderr: true,
    });
    // PDF diagnostics may contain document-controlled text; never print it to the terminal.
    worker.stdout.resume();
    worker.stderr.resume();
    let settled = false;
    const finish = (error?: unknown, result?: ExtractionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // Await termination on success, timeout, abort and malformed messages alike.
      void worker.terminate().then(() => {
        if (result === undefined) reject(error); else resolve(result);
      }, reject);
    };
    const abort = () => finish(options.signal?.reason ?? new Error("PDF extraction aborted"));
    const timer = setTimeout(() => finish(new Error("PDF extraction timed out")), Math.min(options.timeoutMs, 2_147_483_647));
    options.signal?.addEventListener("abort", abort, { once: true });
    worker.once("error", finish);
    worker.once("exit", (code) => finish(new Error(`PDF worker exited without a result (${code})`)));
    worker.once("message", (message: unknown) => {
      const result = message as Record<string, unknown> | null;
      if (result && typeof result.error === "string") return finish(new Error(result.error));
      if (!result || typeof result.title !== "string" || typeof result.content !== "string" || result.method !== "pdf") return finish(new Error("Invalid PDF worker result"));
      finish(undefined, { title: boundText(result.title, 4096), content: boundText(result.content), method: "pdf" });
    });
    if (options.signal?.aborted) abort();
  });
}
