import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import type { DiagramHostingSettings } from "../config.js";
import { renderPngAsync } from "../render/png.js";
import { renderSvg } from "../render/svg.js";
import type { DiagramDocument, DiagramStore } from "../store.js";
import { renderViewer } from "./viewer.js";

const VIEWER_JS = readFile(new URL("./viewer-client.js", import.meta.url), "utf8");
const VIEWER_CSS = readFile(new URL("./viewer.css", import.meta.url), "utf8");
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const IDENTITY_PATTERN = /^[^\u0000-\u001f\u007f]{1,320}$/;
const MAX_STREAMS = 32;
const MAX_STREAMS_PER_DOCUMENT = 8;
const MAX_PNG_CACHE_BYTES = 32 * 1024 * 1024;

export interface DiagramHostOptions {
  settings: DiagramHostingSettings;
  store: DiagramStore;
  externalBaseUrl?: string;
}

export class DiagramHost {
  private server: Server | undefined;
  private baseUrl: string | undefined;
  private readonly streams = new Map<string, Set<ServerResponse>>();
  private readonly svgCache = new Map<string, ReturnType<typeof renderSvg>>();
  private readonly pngCache = new Map<string, Buffer>();
  private pngCacheBytes = 0;
  private heartbeat: NodeJS.Timeout | undefined;
  private revisionPoll: NodeJS.Timeout | undefined;
  private polling = false;
  private readonly knownRevisions = new Map<string, number>();

  constructor(private readonly options: DiagramHostOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      const method = request.method ?? "GET";
      void this.route(method, request.url ?? "/", request.headers, response).catch(() => this.notFound(response, method));
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({
        port: this.options.settings.port,
        host: this.options.settings.listenAddress,
        reusePort: this.options.settings.port !== 0 && supportsReusePort(),
      }, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    const address = server.address() as AddressInfo;
    const path = this.options.settings.basePath === "/" ? "" : this.options.settings.basePath;
    this.baseUrl = this.options.externalBaseUrl ?? `http://${loopbackHost(this.options.settings.listenAddress)}:${address.port}${path}`;
    this.heartbeat = setInterval(() => {
      for (const [id, responses] of this.streams) for (const response of responses) {
        if (!response.write(": heartbeat\n\n")) this.closeStream(id, response);
      }
    }, 15_000);
    this.heartbeat.unref();
    try { await this.pollRevisions(false); }
    catch (error) { await this.close(); throw error; }
    this.revisionPoll = setInterval(() => {
      if (this.streams.size > 0) void this.pollRevisions(true).catch(() => undefined);
    }, 1_000);
    this.revisionPoll.unref();
  }

  get publicBaseUrl(): string {
    if (!this.baseUrl) throw new Error("Diagram host is not running");
    return this.baseUrl;
  }

  urlFor(document: DiagramDocument): string {
    return `${this.publicBaseUrl}/d/${document.token}/`;
  }

  async setChallenge(token: string): Promise<() => Promise<void>> {
    const path = this.challengePath(token);
    await writeFile(path, token, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return () => rm(path, { force: true });
  }

  notifyUpdated(document: DiagramDocument): void {
    this.knownRevisions.set(document.id, document.revision);
    this.emit(document.id, "updated", String(document.revision));
  }

  notifyDeleted(id: string): void {
    this.knownRevisions.delete(id);
    this.emit(id, "deleted", "deleted");
    const responses = this.streams.get(id);
    if (responses) for (const response of responses) response.end();
    this.streams.delete(id);
    for (const key of this.svgCache.keys()) if (key.startsWith(`${id}:`)) this.svgCache.delete(key);
    for (const [key, png] of this.pngCache) if (key.startsWith(`${id}:`)) {
      this.pngCache.delete(key);
      this.pngCacheBytes -= png.byteLength;
    }
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.revisionPoll) clearInterval(this.revisionPoll);
    this.heartbeat = undefined;
    this.revisionPoll = undefined;
    this.knownRevisions.clear();
    for (const responses of this.streams.values()) for (const response of responses) response.end();
    this.streams.clear();
    this.svgCache.clear();
    this.pngCache.clear();
    this.pngCacheBytes = 0;
    const server = this.server;
    this.server = undefined;
    this.baseUrl = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async route(method: string, rawUrl: string, headers: Record<string, string | string[] | undefined>, response: ServerResponse): Promise<void> {
    if (method !== "GET" && method !== "HEAD") return this.methodNotAllowed(response);
    if (this.options.settings.mode === "tailscale" && this.options.settings.requireTailscaleIdentity && !validIdentity(headers["tailscale-user-login"])) return this.notFound(response, method);
    const url = new URL(rawUrl, "http://diagram.local");
    const basePath = this.options.settings.basePath;
    if (basePath !== "/" && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) return this.notFound(response, method);
    const relative = basePath === "/" ? url.pathname : url.pathname.slice(basePath.length) || "/";

    if (relative === "/assets/viewer.js") return this.send(response, 200, "text/javascript; charset=utf-8", await VIEWER_JS, method);
    if (relative === "/assets/viewer.css") return this.send(response, 200, "text/css; charset=utf-8", await VIEWER_CSS, method);
    const challenge = /^\/_challenge\/([A-Za-z0-9_-]{32})$/.exec(relative);
    if (challenge) {
      const token = challenge[1]!;
      let stored: string;
      try { stored = await readFile(this.challengePath(token), "utf8"); }
      catch { return this.notFound(response, method); }
      if (stored !== token) return this.notFound(response, method);
      return this.send(response, 200, "text/plain; charset=utf-8", token, method);
    }

    const match = /^\/d\/([A-Za-z0-9_-]{43})(?:\/(.*))?$/.exec(relative);
    if (!match || !TOKEN_PATTERN.test(match[1]!)) return this.notFound(response, method);
    const token = match[1]!;
    const suffix = match[2];
    const document = await this.options.store.getByToken(token);
    if (!document) return this.notFound(response, method);
    if (suffix === undefined) {
      const prefix = basePath === "/" ? "" : basePath;
      response.writeHead(308, { location: `${prefix}/d/${token}/`, ...baseHeaders() });
      response.end();
      return;
    }
    if (suffix === "") {
      const page = renderViewer(document.title, basePath);
      return this.send(response, 200, "text/html; charset=utf-8", page, method, {
        "content-security-policy": "default-src 'none'; img-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      });
    }
    if (suffix === "events") {
      if (method === "HEAD") return this.methodNotAllowed(response);
      this.knownRevisions.set(document.id, document.revision);
      const streams = this.streams.get(document.id) ?? new Set<ServerResponse>();
      if (this.streamCount() >= MAX_STREAMS || streams.size >= MAX_STREAMS_PER_DOCUMENT) {
        return this.send(response, 503, "text/plain; charset=utf-8", "Live update capacity reached", method, { "retry-after": "15" });
      }
      response.writeHead(200, {
        ...baseHeaders(),
        "content-type": "text/event-stream; charset=utf-8",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      response.write(`event: updated\ndata: ${document.revision}\n\n`);
      streams.add(response);
      this.streams.set(document.id, streams);
      response.on("close", () => {
        streams.delete(response);
        if (streams.size === 0) this.streams.delete(document.id);
      });
      return;
    }

    const renderKey = `${document.id}:${document.revision}`;
    let rendered = this.svgCache.get(renderKey);
    if (!rendered) {
      rendered = renderSvg(document.title, document.spec);
      this.svgCache.set(renderKey, rendered);
      while (this.svgCache.size > 32) this.svgCache.delete(this.svgCache.keys().next().value!);
    }
    if (suffix === "image.svg" || suffix === "download.svg") {
      const attachment: Record<string, string> = suffix.startsWith("download") ? { "content-disposition": `attachment; filename="${safeFilename(document.title)}.svg"` } : {};
      return this.send(response, 200, "image/svg+xml; charset=utf-8", rendered.svg, method, {
        ...attachment,
        "content-security-policy": "default-src 'none'; script-src 'none'; style-src 'none'; frame-ancestors 'none'",
      });
    }
    if (suffix === "image.png" || suffix === "download.png") {
      const scale = numericScale(url.searchParams.get("scale"));
      if (scale === undefined) return this.send(response, 400, "text/plain; charset=utf-8", "Invalid scale", method);
      const cacheKey = `${renderKey}:${scale}`;
      let png = this.pngCache.get(cacheKey);
      if (!png) {
        png = (await renderPngAsync(rendered, scale)).png;
        this.cachePng(cacheKey, png);
      }
      const attachment: Record<string, string> = suffix.startsWith("download") ? { "content-disposition": `attachment; filename="${safeFilename(document.title)}.png"` } : {};
      return this.send(response, 200, "image/png", png, method, attachment);
    }
    return this.notFound(response, method);
  }

  private challengePath(token: string): string {
    return join(this.options.store.directory, `.challenge-${token}`);
  }

  private async pollRevisions(emitChanges: boolean): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const documents = await this.options.store.list();
      const current = new Map(documents.map((document) => [document.id, document.revision]));
      if (emitChanges) {
        for (const document of documents) {
          const previous = this.knownRevisions.get(document.id);
          if (previous !== undefined && previous !== document.revision) this.emit(document.id, "updated", String(document.revision));
        }
        for (const id of this.knownRevisions.keys()) if (!current.has(id)) {
          this.emit(id, "deleted", "deleted");
          const responses = this.streams.get(id);
          if (responses) for (const response of responses) response.end();
          this.streams.delete(id);
        }
      }
      for (const id of this.knownRevisions.keys()) if (!current.has(id)) this.knownRevisions.delete(id);
      for (const [id, revision] of current) {
        const known = this.knownRevisions.get(id);
        if (known === undefined || revision > known) this.knownRevisions.set(id, revision);
      }
    } finally {
      this.polling = false;
    }
  }

  private emit(id: string, event: string, data: string): void {
    const responses = this.streams.get(id);
    if (!responses) return;
    for (const response of responses) if (!response.write(`event: ${event}\ndata: ${data}\n\n`)) this.closeStream(id, response);
  }

  private streamCount(): number {
    let count = 0;
    for (const responses of this.streams.values()) count += responses.size;
    return count;
  }

  private closeStream(id: string, response: ServerResponse): void {
    response.end();
    const responses = this.streams.get(id);
    responses?.delete(response);
    if (responses?.size === 0) this.streams.delete(id);
  }

  private cachePng(key: string, png: Buffer): void {
    if (png.byteLength > MAX_PNG_CACHE_BYTES / 2) return;
    this.pngCache.set(key, png);
    this.pngCacheBytes += png.byteLength;
    while (this.pngCache.size > 16 || this.pngCacheBytes > MAX_PNG_CACHE_BYTES) {
      const oldest = this.pngCache.keys().next().value as string | undefined;
      if (!oldest) break;
      const removed = this.pngCache.get(oldest);
      this.pngCache.delete(oldest);
      this.pngCacheBytes -= removed?.byteLength ?? 0;
    }
  }

  private send(response: ServerResponse, status: number, contentType: string, body: string | Buffer, method: string, headers: Record<string, string> = {}): void {
    const length = Buffer.byteLength(body);
    response.writeHead(status, { ...baseHeaders(), "content-type": contentType, "content-length": length, ...headers });
    response.end(method === "HEAD" ? undefined : body);
  }

  private notFound(response: ServerResponse, method: string): void {
    if (response.headersSent) {
      response.end();
      return;
    }
    this.send(response, 404, "text/plain; charset=utf-8", "Not found", method);
  }

  private methodNotAllowed(response: ServerResponse): void {
    this.send(response, 405, "text/plain; charset=utf-8", "Method not allowed", "GET", { allow: "GET, HEAD" });
  }
}

function baseHeaders(): Record<string, string> {
  return {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
  };
}

function numericScale(value: string | null): number | undefined {
  if (value === null) return 2;
  const scale = Number(value);
  return Number.isInteger(scale) && scale >= 1 && scale <= 4 ? scale : undefined;
}

function validIdentity(value: string | string[] | undefined): boolean {
  return typeof value === "string" && IDENTITY_PATTERN.test(value);
}

export function supportsReusePort(platform = process.platform): boolean {
  return platform === "linux" || platform === "aix" || platform === "freebsd" || platform === "sunos";
}

function loopbackHost(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

function safeFilename(value: string): string {
  const slug = value.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return slug || "diagram";
}
