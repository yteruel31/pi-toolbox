import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebConfig } from "./config.js";
import { RedditBrowserError, requestRedditJson, type RedditBrowserDependencies } from "./reddit-browser.js";
import { RedditConfigError, redditProfileIsBusy, validateRedditConfig, type RedditProfileLock, type ValidatedRedditConfig } from "./reddit-config.js";
import { acquireQueuedRedditProfileLock, RedditQueueError, type RedditQueueOptions } from "./reddit-queue.js";
import { buildRedditPostUrl, buildRedditSearchUrl, parseRedditPost, parseRedditSearch, type RedditPostOptions, type RedditPostResult, type RedditSearchOptions, type RedditSearchResult } from "./reddit-parser.js";

export type RedditDiagnosticStatus = "not_configured" | "untested" | "ready" | "profile_busy" | "queue_full" | "queue_timeout" | "profile_unsafe" | "browser_unavailable" | "access_denied" | "authentication_required" | "not_found" | "post_unavailable" | "rate_limited" | "upstream_unavailable" | "invalid_response" | "request_failed" | "configuration_changed" | "cancelled" | "timeout";
export interface RedditDiagnostic { status: RedditDiagnosticStatus; message: string; lastValidatedAt?: string; eligible: boolean }
type StoredStatus = "ready" | "browser_unavailable" | "access_denied" | "authentication_required" | "not_found" | "post_unavailable" | "rate_limited" | "upstream_unavailable" | "invalid_response" | "configuration_changed";
interface Validation { version: 1; identity: string; status: StoredStatus; validatedAt: string }
export interface RedditServiceDependencies {
  request: typeof requestRedditJson;
  now(): Date;
  browser?: RedditBrowserDependencies;
  acquire?(config: ValidatedRedditConfig, options?: RedditQueueOptions): Promise<RedditProfileLock>;
  queue?: Omit<RedditQueueOptions, "signal">;
}
const defaults: RedditServiceDependencies = { request: requestRedditJson, now: () => new Date(), acquire: acquireQueuedRedditProfileLock };
const messages: Record<RedditDiagnosticStatus, string> = {
  not_configured: "Configure explicit absolute reddit.profileDir and reddit.executablePath values in web-access.json.",
  untested: "Configuration is locally valid but has not been tested. Run the explicit Reddit diagnostic test.",
  ready: "The latest explicit Reddit search and post JSON validation succeeded.",
  profile_busy: "The Reddit profile is currently open in Chromium. Close that browser and try again.",
  queue_full: "Too many Reddit operations are already waiting for this profile.",
  queue_timeout: "Timed out waiting for another Reddit tool operation to release this profile.",
  profile_unsafe: "The Reddit profile or state directory must be private, owned, canonical directories without symbolic links.",
  browser_unavailable: "The configured browser is unavailable or failed to launch. Check the executable, Xvfb, and native Chromium sandbox support.",
  access_denied: "Reddit returned HTTP 403 (access denied) for this resource.",
  authentication_required: "Reddit returned HTTP 401; authentication is required for this request.",
  not_found: "The requested Reddit resource was not found.",
  post_unavailable: "The requested Reddit post is unavailable.",
  rate_limited: "Reddit rate limited the request (HTTP 429).",
  upstream_unavailable: "Reddit is temporarily unavailable.",
  invalid_response: "Reddit returned malformed or unexpected JSON.",
  request_failed: "The Reddit request failed before a response was received.",
  configuration_changed: "The Reddit profile identity changed while the operation was waiting; inspect the configuration again.",
  cancelled: "Reddit browser validation was cancelled; the previous readiness result is unchanged.",
  timeout: "Reddit browser request timed out; the previous readiness result is unchanged.",
};

/** Q2/tool preflights may proceed when a transient busy observation retains cached readiness. */
export function redditDiagnosticAllowsOperation(diagnostic: RedditDiagnostic): boolean { return diagnostic.eligible; }

export class RedditService {
  constructor(readonly config: WebConfig, private readonly dependencies: RedditServiceDependencies = defaults) {}
  private async validated(createState = true): Promise<ValidatedRedditConfig> { return validateRedditConfig(this.config, { createState }); }
  private async acquire(config: ValidatedRedditConfig, signal?: AbortSignal): Promise<RedditProfileLock> {
    try {
      return await (this.dependencies.acquire ?? acquireQueuedRedditProfileLock)(config, { ...this.dependencies.queue, signal });
    } catch (error) {
      if (error instanceof RedditQueueError) throw new RedditBrowserError(error.code, "queue");
      throw error;
    }
  }
  private async withOperationLock<T>(signal: AbortSignal | undefined, operation: (config: ValidatedRedditConfig, lock: RedditProfileLock) => Promise<T>): Promise<T> {
    const original = await this.validated();
    const lock = await this.acquire(original, signal);
    try {
      const current = await this.validated();
      if (current.identity !== original.identity || current.profileDir !== original.profileDir) throw new RedditBrowserError("configuration_changed", "queue");
      return await operation(current, lock);
    } finally { await lock.release(); }
  }

  /** Local filesystem inspection only: no directory creation, DNS, HTTP, process, or browser launch. */
  async inspect(): Promise<RedditDiagnostic> {
    let validated: ValidatedRedditConfig;
    try { validated = await this.validated(false); }
    catch (error) {
      const status: RedditDiagnosticStatus = error instanceof RedditConfigError && error.code === "not_configured" ? "not_configured"
        : error instanceof RedditConfigError && error.code === "profile_unsafe" ? "profile_unsafe" : "browser_unavailable";
      return { status, message: messages[status], eligible: false };
    }
    const stored = await readValidation(validated);
    if (await redditProfileIsBusy(validated)) return { status: "profile_busy", message: messages.profile_busy, lastValidatedAt: stored?.identity === validated.identity ? stored.validatedAt : undefined, eligible: stored?.identity === validated.identity && stored.status === "ready" };
    if (!stored || stored.identity !== validated.identity) return { status: "untested", message: messages.untested, eligible: false };
    return { status: stored.status, message: messages[stored.status], lastValidatedAt: stored.validatedAt, eligible: stored.status === "ready" };
  }

  async search(options: RedditSearchOptions, signal?: AbortSignal): Promise<RedditSearchResult> {
    const requestUrl = buildRedditSearchUrl(options);
    return this.withOperationLock(signal, async (config, lock) => {
      try {
        const response = await this.dependencies.request(config, requestUrl, { signal, profileLock: lock }, this.dependencies.browser);
        return parseSearch(response.body, options);
      } catch (error) { await this.invalidateRuntime(config, error); throw error; }
    });
  }
  async fetchPost(url: string, options: RedditPostOptions = {}, signal?: AbortSignal): Promise<RedditPostResult> {
    const requestUrl = buildRedditPostUrl(url, options);
    return this.withOperationLock(signal, async (config, lock) => {
      try {
        const response = await this.dependencies.request(config, requestUrl, { signal, profileLock: lock }, this.dependencies.browser);
        return parsePost(response.body, options);
      } catch (error) { await this.invalidateRuntime(config, error); throw error; }
    });
  }
  private async invalidateRuntime(config: ValidatedRedditConfig, error: unknown): Promise<void> {
    if (!(error instanceof RedditBrowserError) || error.code !== "browser_unavailable") return;
    await writeValidation(config, { version: 1, identity: config.identity, status: "browser_unavailable", validatedAt: this.dependencies.now().toISOString() });
  }

  /** Explicit validation holds one queued profile lock across its search/post pair. */
  async test(signal?: AbortSignal): Promise<RedditDiagnostic> {
    if (signal?.aborted) return { status: "cancelled", message: messages.cancelled, eligible: false };
    try {
      return await this.withOperationLock(signal, async (validated, lock) => {
        let status: StoredStatus;
        try {
          const searchResponse = await this.dependencies.request(validated, buildRedditSearchUrl({ q: "typescript", sort: "relevance", time: "all", limit: 5 }), { signal, profileLock: lock }, this.dependencies.browser);
          const search = parseSearch(searchResponse.body, { q: "typescript", sort: "relevance", time: "all", limit: 5 });
          if (!search.items[0]) throw new RedditBrowserError("invalid_response", "request");
          const postOptions = { sort: "confidence", limit: 10, depth: 2 } as const;
          const postResponse = await this.dependencies.request(validated, buildRedditPostUrl(search.items[0].url, postOptions), { signal, profileLock: lock }, this.dependencies.browser);
          parsePost(postResponse.body, postOptions); status = "ready";
        } catch (error) {
          const diagnosticStatus = statusOf(error);
          if (isTransient(diagnosticStatus)) return { status: diagnosticStatus, message: messages[diagnosticStatus], eligible: false };
          status = diagnosticStatus as StoredStatus;
        }
        const validatedAt = this.dependencies.now().toISOString();
        await writeValidation(validated, { version: 1, identity: validated.identity, status, validatedAt });
        return { status, message: messages[status], lastValidatedAt: validatedAt, eligible: status === "ready" };
      });
    } catch (error) {
      if (error instanceof RedditConfigError) return this.inspect();
      const status = statusOf(error);
      return { status, message: messages[status], eligible: false };
    }
  }
}
function parseSearch(body: string, options: RedditSearchOptions): RedditSearchResult { try { return parseRedditSearch(body, options); } catch { throw new RedditBrowserError("invalid_response", "request"); } }
function parsePost(body: string, options: RedditPostOptions): RedditPostResult { try { return parseRedditPost(body, options); } catch { throw new RedditBrowserError("invalid_response", "request"); } }
function statusOf(error: unknown): RedditDiagnosticStatus { return error instanceof RedditBrowserError ? error.code : "request_failed"; }
function isTransient(status: RedditDiagnosticStatus): boolean { return ["profile_busy", "queue_full", "queue_timeout", "not_found", "post_unavailable", "rate_limited", "upstream_unavailable", "cancelled", "timeout", "request_failed"].includes(status); }
function validationPath(config: ValidatedRedditConfig): string { return join(config.stateDir, "validation.json"); }
async function readValidation(config: ValidatedRedditConfig): Promise<Validation | undefined> {
  const path = validationPath(config);
  try {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 4096) return undefined;
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<Validation>;
    const statuses: StoredStatus[] = ["ready", "browser_unavailable", "access_denied", "authentication_required", "not_found", "post_unavailable", "rate_limited", "upstream_unavailable", "invalid_response", "configuration_changed"];
    if (value.version !== 1 || typeof value.identity !== "string" || !statuses.includes(value.status as StoredStatus) || typeof value.validatedAt !== "string" || !Number.isFinite(Date.parse(value.validatedAt))) return undefined;
    return value as Validation;
  } catch { return undefined; }
}
async function writeValidation(config: ValidatedRedditConfig, value: Validation): Promise<void> {
  const path = validationPath(config), temporary = join(config.stateDir, `.validation-${process.pid}-${Date.now()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await writeFile(handle, `${JSON.stringify(value)}\n`); await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, path);
  } catch { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw new RedditBrowserError("request_failed", "close"); }
}
