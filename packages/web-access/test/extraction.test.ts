import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { boundText, extractHtml, extractPdf, MAX_TEXT_BYTES } from "../src/extraction.ts";
import { browserIsolationPlan, createBrowserRouteHandler, renderPage } from "../src/browser.ts";
import type { Route } from "playwright-core";

function tinyPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...["First page", "Second page"].map((text) => {
      const stream = `BT /F1 12 Tf 20 250 Td (${text}) Tj ET\n`;
      return `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`;
    }),
    "<< /Title (Tiny test document) >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 8 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test("HTML extracts Markdown, resolves links, and never executes page JavaScript", () => {
  (globalThis as any).__webAccessExecuted = false;
  const result = extractHtml(`<html><head><title>Untrusted title</title></head><body><article><h1>Useful heading</h1><p>${"Useful article text. ".repeat(40)}<a href="/details">Details</a><a href="javascript:globalThis.__webAccessExecuted=true">unsafe</a></p></article><script>globalThis.__webAccessExecuted=true; throw new Error('executed')</script></body></html>`, "https://example.test/story");
  assert.match(result.content, /Useful article text/);
  assert.match(result.content, /https:\/\/example.test\/details/);
  assert.doesNotMatch(result.content, /javascript:|throw new Error/);
  assert.equal((globalThis as any).__webAccessExecuted, false);
  delete (globalThis as any).__webAccessExecuted;
});

test("JSON-only Next data is parsed inertly; Flight JavaScript is not interpreted", () => {
  const result = extractHtml(`<html><head><title>Next</title></head><body><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"title":"Embedded story","text":"Hello"}}}</script><script>self.__next_f.push([1,"SECRET_FLIGHT"]);globalThis.__webAccessExecuted=true</script></body></html>`, "https://example.test");
  assert.equal(result.method, "next-json");
  assert.match(result.content, /Embedded story/);
  assert.doesNotMatch(result.content, /SECRET_FLIGHT/);
  assert.equal((globalThis as any).__webAccessExecuted, undefined);
  const malformed = extractHtml(`<script id="__NEXT_DATA__">(()=>{throw new Error('no')})()</script>`, "https://example.test");
  assert.equal(malformed.content, "");
});

test("HTML input and UTF-8 output have byte bounds", () => {
  assert.throws(() => extractHtml("x".repeat(MAX_TEXT_BYTES + 1), "https://example.test"), /5 MiB/);
  assert.equal(boundText("😀😀", 5), "😀");
  assert.equal(boundText("abc", 2), "ab");
  assert.ok(Buffer.byteLength(boundText("😀".repeat(MAX_TEXT_BYTES / 2))) <= MAX_TEXT_BYTES);
});

test("PDF worker extracts a real tiny PDF and honors the page bound without OCR", async () => {
  const first = await extractPdf(tinyPdf(), { maxPages: 1, timeoutMs: 10_000 });
  assert.equal(first.method, "pdf");
  assert.equal(first.title, "Tiny test document");
  assert.match(first.content, /First page/);
  assert.doesNotMatch(first.content, /Second page/);
  const both = await extractPdf(tinyPdf(), { maxPages: 2, timeoutMs: 10_000 });
  assert.match(both.content, /Second page/);
});

test("PDF worker terminates on timeout, abort and parse error", async () => {
  await assert.rejects(extractPdf(tinyPdf(), { maxPages: 1, timeoutMs: 1 }), /timed out/);
  const controller = new AbortController();
  const extraction = extractPdf(tinyPdf(), { maxPages: 1, timeoutMs: 10_000, signal: controller.signal });
  controller.abort(new Error("cancel test"));
  await assert.rejects(extraction, /cancel test/);
  await assert.rejects(extractPdf(Buffer.from("not a PDF"), { maxPages: 1, timeoutMs: 10_000 }), /PDF extraction failed/);
  await assert.rejects(extractPdf(tinyPdf(), { maxPages: 0, timeoutMs: 100 }), /maxPages/);
  await assert.rejects(extractPdf(tinyPdf(), { maxPages: 1, timeoutMs: 100, signal: controller.signal }), /cancel test/);
});

function mockRoute(method = "GET", url = "https://example.test/", headers = { Cookie: "secret", Authorization: "secret", Accept: "text/html" }) {
  const calls: { action: string; options?: any }[] = [];
  const route = {
    request: () => ({ method: () => method, url: () => url, headers: () => headers }),
    abort: async (reason: string) => { calls.push({ action: "abort", options: reason }); },
    fulfill: async (options: any) => { calls.push({ action: "fulfill", options }); },
    continue: () => { throw new Error("Native browser networking must never be used"); },
  } as unknown as Route;
  return { route, calls };
}
const response = (url = "https://example.test/", body = Buffer.from("hello")) => ({ url, status: 200, headers: { "Content-Type": "text/html", "Set-Cookie": "secret=1", "Content-Encoding": "gzip", "Content-Length": "999", "WWW-Authenticate": "Basic" }, body });

test("browser wrapper requires namespace isolation and does not disable Chromium sandbox", async () => {
  const plan = browserIsolationPlan("/usr/bin/bwrap", "/usr/lib/chromium/chromium");
  assert.match(plan, /--unshare-net/);
  assert.match(plan, /--unshare-pid/);
  assert.match(plan, /--clearenv/);
  assert.doesNotMatch(plan, /--no-sandbox|--share-net|--ro-bind' '\/' '\/'|\/run|\/home\/yoann/);
  assert.match(plan, /"\$@"/);
  assert.throws(() => browserIsolationPlan("/usr/bin/bwrap", "/home/user/chromium"), /under \/usr or \/opt/);
  const source = await readFile(new URL("../src/browser.ts", import.meta.url), "utf8");
  assert.match(source, /chromiumSandbox: true/);
  assert.match(source, /serviceWorkers: "block", acceptDownloads: false, permissions: \[\]/);
  assert.match(source, /routeWebSocket\("\*\*\/\*", \(socket\) => socket.close\(\)\)/);
  assert.match(source, /await import\("playwright-core"\)/);
  assert.doesNotMatch(source, /connectOverCDP|launchPersistentContext|remote-debugging-port/);
});

test("missing bubblewrap fails closed with installation guidance", { skip: process.platform === "linux" && (existsSync("/usr/bin/bwrap") || existsSync("/bin/bwrap")) }, async () => {
  let requested = false;
  await assert.rejects(renderPage("https://example.test/", {
    timeoutMs: 100,
    request: async () => { requested = true; return response(); },
  }), /requires Linux, bubblewrap.*--no-sandbox fallback/);
  assert.equal(requested, false);
});

test("browser routes strip credentials and response cookies, and fulfill only through parent", async () => {
  let forwarded: any;
  const errors: Error[] = [];
  const handler = createBrowserRouteHandler(async (url, options) => { forwarded = options; return response(url); }, new AbortController().signal, (error) => errors.push(error));
  const { route, calls } = mockRoute();
  await handler(route);
  assert.deepEqual(forwarded.headers, { accept: "text/html" });
  assert.equal(forwarded.body, undefined);
  assert.deepEqual(calls[0]?.options.headers, { "content-type": "text/html" });
  assert.equal(calls[0]?.action, "fulfill");
  assert.deepEqual(errors, []);
});

test("browser blocks side-effect methods and unsafe schemes before the parent request", async () => {
  let requested = 0;
  const handler = createBrowserRouteHandler(async () => { requested++; return response(); }, new AbortController().signal, () => {});
  for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
    const { route, calls } = mockRoute(method);
    await handler(route);
    assert.equal(calls[0]?.action, "abort");
  }
  for (const url of ["file:///etc/passwd", "ws://example.test", "https://user:password@example.test"]) await handler(mockRoute("GET", url).route);
  assert.equal(requested, 0);
});

test("browser caps requests and response bytes, including concurrent responses", async () => {
  const errors: Error[] = [];
  const handler = createBrowserRouteHandler(async () => response(), new AbortController().signal, (error) => errors.push(error));
  for (let i = 0; i < 101; i++) await handler(mockRoute().route);
  assert.match(errors[0]!.message, /request limit/);
  const big = createBrowserRouteHandler(async () => response(undefined, Buffer.alloc(MAX_TEXT_BYTES)), new AbortController().signal, (error) => errors.push(error));
  await Promise.all(Array.from({ length: 5 }, () => big(mockRoute().route)));
  assert.match(errors.at(-1)!.message, /byte limit/);
  const huge = createBrowserRouteHandler(async () => response(undefined, Buffer.alloc(MAX_TEXT_BYTES + 1)), new AbortController().signal, (error) => errors.push(error));
  const { route, calls } = mockRoute();
  await huge(route);
  assert.equal(calls[0]?.action, "abort");
});

test("browser aborts failed/cancelled requests and redirects followed responses to the correct origin", async () => {
  const controller = new AbortController();
  const errors: Error[] = [];
  const failed = createBrowserRouteHandler(async () => { throw new Error("safe transport denied address"); }, controller.signal, (error) => errors.push(error));
  const first = mockRoute();
  await failed(first.route);
  assert.equal(first.calls[0]?.action, "abort");
  assert.match(errors[0]!.message, /denied/);
  const redirect = createBrowserRouteHandler(async () => response("https://other.test/final"), controller.signal, (error) => errors.push(error));
  const second = mockRoute();
  await redirect(second.route);
  assert.deepEqual(second.calls[0]?.options, { status: 302, headers: { location: "https://other.test/final" }, body: "" });
  controller.abort();
  const third = mockRoute();
  await redirect(third.route);
  assert.equal(third.calls[0]?.action, "abort");
  await assert.rejects(renderPage("https://example.test", { timeoutMs: 100, signal: controller.signal, request: async () => response() }), { name: "AbortError" });
});
