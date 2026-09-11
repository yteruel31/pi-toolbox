import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import ipaddr from "ipaddr.js";

export type Lookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export interface HttpResult { url: string; status: number; headers: Record<string, string>; body: Buffer }
export interface RequestOptions {
  method?: string; body?: Buffer; headers?: Record<string, string>; signal?: AbortSignal;
  timeoutMs?: number; maxBytes?: number; redirects?: number; lookup?: Lookup;
  transport?: typeof httpRequest;
}
export class NetworkError extends Error {}
export function publicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) return false;
    return parsed.range() === "unicast";
  } catch { return false; }
}
export function remoteUrl(input: string): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new NetworkError("Expected an absolute HTTP(S) URL"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (input.length > 8192 || !["https:", "http:"].includes(url.protocol) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port)) || host.includes("%") ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") ||
      (!host.includes(".") && !host.includes(":")) || (ipaddr.isValid(host) && !publicAddress(host))) {
    throw new NetworkError("Blocked URL: only credential-free public HTTP(S) endpoints on ports 80/443 are allowed");
  }
  url.hash = "";
  return url;
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort: () => void = () => {};
  const interrupted = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([promise, interrupted]); } finally { signal.removeEventListener("abort", abort); }
}
export async function resolvePublic(url: URL, signal: AbortSignal, lookup: Lookup = (host) => dnsLookup(host, { all: true })): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = ipaddr.isValid(host) ? [{ address: host, family: ipaddr.parse(host).kind() === "ipv6" ? 6 : 4 }] : await abortable(lookup(host), signal);
  if (!addresses.length || addresses.some((entry) => !publicAddress(entry.address))) throw new NetworkError("Blocked destination: DNS returned private or reserved addresses");
  return addresses[0]!;
}
export async function readBounded(stream: Readable, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  const abort = () => stream.destroy(new NetworkError("Request cancelled or timed out"));
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    for await (const chunk of stream) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) { stream.destroy(); throw new NetworkError(`Response exceeds ${maxBytes} bytes`); }
      chunks.push(bytes);
    }
    return Buffer.concat(chunks);
  } finally { signal.removeEventListener("abort", abort); }
}
export async function request(input: string, options: RequestOptions = {}): Promise<HttpResult> {
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 30_000), ...(options.signal ? [options.signal] : [])]);
  let url = remoteUrl(input);
  let headers = { "user-agent": "pi-web-access/0.0", "accept-encoding": "gzip, deflate, br", ...options.headers };
  const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const maxRedirects = options.redirects ?? 5;
  for (let hop = 0; ; hop++) {
    const address = await resolvePublic(url, signal, options.lookup);
    const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const req = (options.transport ?? (url.protocol === "https:" ? httpsRequest : httpRequest))(url, {
        method: options.method ?? "GET", headers, signal, agent: false, family: address.family,
        // Pin the checked address to the connection, retaining hostname TLS verification.
        lookup: (_host, _opts, callback) => callback(null, address.address, address.family),
      }, resolve);
      req.on("error", () => reject(new NetworkError(signal.aborted ? "Request cancelled or timed out" : "HTTP connection failed")));
      req.end(options.body);
    });
    const status = response.statusCode ?? 0;
    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(response.headers)) if (value !== undefined && key !== "set-cookie") responseHeaders[key] = Array.isArray(value) ? value.join(", ") : value;
    if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
      response.destroy();
      if (hop >= maxRedirects) throw new NetworkError("Redirect limit reached; API redirects are not followed");
      if (options.method && !["GET", "HEAD"].includes(options.method)) throw new NetworkError("Redirect of a non-read request refused");
      const next = remoteUrl(new URL(response.headers.location, url).href);
      if (url.protocol === "https:" && next.protocol !== "https:") throw new NetworkError("HTTPS downgrade refused");
      if (next.origin !== url.origin) headers = { "user-agent": "pi-web-access/0.0", "accept-encoding": "gzip, deflate, br" };
      url = next; continue;
    }
    if (Number(response.headers["content-length"]) > maxBytes) { response.destroy(); throw new NetworkError(`Response exceeds ${maxBytes} bytes`); }
    const encoding = response.headers["content-encoding"];
    const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : undefined;
    if (encoding && encoding !== "identity" && !decoder) { response.destroy(); throw new NetworkError("Unsupported content encoding"); }
    // Bound both the compressed wire bytes and the decompressed payload.
    let wireBytes = 0;
    response.on("data", (chunk: Buffer) => { wireBytes += chunk.length; if (wireBytes > maxBytes) response.destroy(new NetworkError("Compressed response exceeds limit")); });
    if (decoder) response.on("error", (error) => decoder.destroy(error));
    try {
      const body = await readBounded(decoder ? response.pipe(decoder) : response, maxBytes, signal);
      delete responseHeaders["content-encoding"]; delete responseHeaders["content-length"];
      return { url: url.href, status, headers: responseHeaders, body };
    } finally { response.destroy(); decoder?.destroy(); }
  }
}
export async function apiJson(url: string, options: RequestOptions): Promise<unknown> {
  const result = await request(url, { ...options, redirects: 0 });
  if (result.status < 200 || result.status >= 300) throw new NetworkError(`Provider HTTP ${result.status}; check API credentials, quota and availability. Request was not retried.`);
  try { return JSON.parse(result.body.toString("utf8")); } catch { throw new NetworkError("Provider returned invalid JSON"); }
}
