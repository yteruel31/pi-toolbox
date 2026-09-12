import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebConfig } from "./config.js";
import { RedditBrowserError, requestRedditJson, type RedditBrowserDependencies } from "./reddit-browser.js";
import { acquireRedditProfileLock, RedditConfigError, redditProfileIsBusy, validateRedditConfig, type ValidatedRedditConfig } from "./reddit-config.js";
import { buildRedditPostUrl, buildRedditSearchUrl, parseRedditPost, parseRedditSearch, type RedditPostOptions, type RedditPostResult, type RedditSearchOptions, type RedditSearchResult } from "./reddit-parser.js";

export type RedditDiagnosticStatus = "not_configured" | "untested" | "ready" | "profile_busy" | "profile_unsafe" | "browser_unavailable" | "access_denied" | "cancelled" | "timeout";
export interface RedditDiagnostic { status: RedditDiagnosticStatus; message: string; lastValidatedAt?: string; eligible: boolean }
interface Validation { version: 1; identity: string; status: "ready" | "browser_unavailable" | "access_denied"; validatedAt: string }
export interface RedditServiceDependencies { request: typeof requestRedditJson; now(): Date; browser?: RedditBrowserDependencies }
const defaults: RedditServiceDependencies = { request: requestRedditJson, now: () => new Date() };
const messages: Record<RedditDiagnosticStatus, string> = {
  not_configured: "Configure explicit absolute reddit.profileDir and reddit.executablePath values in web-access.json.",
  untested: "Configuration is locally valid but has not been tested. Run the explicit Reddit diagnostic test.",
  ready: "The latest explicit Reddit search and post JSON validation succeeded.",
  profile_busy: "The Reddit profile is currently locked. Close its browser; never delete a lock unless you have verified it is stale.",
  profile_unsafe: "The Reddit profile or state directory must be private, owned, canonical directories without symbolic links.",
  browser_unavailable: "The configured browser is unavailable or failed to launch. Check the executable, Xvfb, and native Chromium sandbox support.",
  access_denied: "Reddit returned HTTP 403 (access denied). Verify Reddit access directly in the configured browser profile.",
  cancelled: "Reddit browser validation was cancelled; the previous readiness result is unchanged.",
  timeout: "Reddit browser validation timed out; the previous readiness result is no longer eligible.",
};

export class RedditService {
  constructor(readonly config: WebConfig, private readonly dependencies: RedditServiceDependencies = defaults) {}
  private async validated(createState = true): Promise<ValidatedRedditConfig> { return validateRedditConfig(this.config, { createState }); }

  /** Local filesystem inspection only: no directory creation, DNS, HTTP, process, or browser launch. */
  async inspect(): Promise<RedditDiagnostic> {
    let validated: ValidatedRedditConfig;
    try { validated = await this.validated(false); }
    catch (error) {
      const status: RedditDiagnosticStatus = error instanceof RedditConfigError && error.code === "not_configured" ? "not_configured"
        : error instanceof RedditConfigError && error.code === "profile_unsafe" ? "profile_unsafe" : "browser_unavailable";
      return { status, message: messages[status], eligible: false };
    }
    if (await redditProfileIsBusy(validated)) return { status: "profile_busy", message: messages.profile_busy, eligible: false };
    const stored = await readValidation(validated);
    if (!stored || stored.identity !== validated.identity) return { status: "untested", message: messages.untested, eligible: false };
    return { status: stored.status, message: messages[stored.status], lastValidatedAt: stored.validatedAt, eligible: stored.status === "ready" };
  }

  async search(options: RedditSearchOptions, signal?: AbortSignal): Promise<RedditSearchResult> {
    const requestUrl = buildRedditSearchUrl(options);
    const config = await this.validated();
    try { return parseRedditSearch((await this.dependencies.request(config, requestUrl, { signal }, this.dependencies.browser)).body, options); }
    catch (error) { await this.invalidateRuntime(config, error); throw error; }
  }
  async fetchPost(url: string, options: RedditPostOptions = {}, signal?: AbortSignal): Promise<RedditPostResult> {
    const requestUrl = buildRedditPostUrl(url, options);
    const config = await this.validated();
    try { return parseRedditPost((await this.dependencies.request(config, requestUrl, { signal }, this.dependencies.browser)).body, options); }
    catch (error) { await this.invalidateRuntime(config, error); throw error; }
  }
  private async invalidateRuntime(config: ValidatedRedditConfig, error: unknown): Promise<void> {
    if (error instanceof RedditBrowserError && (error.code === "cancelled" || error.code === "profile_busy")) return;
    const status: Validation["status"] = error instanceof RedditBrowserError && error.code === "access_denied" ? "access_denied" : "browser_unavailable";
    await writeValidation(config, { version: 1, identity: config.identity, status, validatedAt: this.dependencies.now().toISOString() });
  }

  /** Explicit validation holds one profile lock across its bounded search/post pair. */
  async test(signal?: AbortSignal): Promise<RedditDiagnostic> {
    if (signal?.aborted) return { status: "cancelled", message: messages.cancelled, eligible: false };
    let validated: ValidatedRedditConfig;
    try { validated = await this.validated(); } catch { return this.inspect(); }
    const lock = await acquireRedditProfileLock(validated);
    if (!lock) return { status: "profile_busy", message: messages.profile_busy, eligible: false };
    try {
      let status: Validation["status"];
      try {
        const searchResponse = await this.dependencies.request(validated, buildRedditSearchUrl({ q: "typescript", sort: "relevance", time: "all", limit: 5 }), { signal, profileLock: lock }, this.dependencies.browser);
        const search = parseRedditSearch(searchResponse.body, { limit: 5 });
        if (!search.items[0]) throw new RedditBrowserError("browser_unavailable");
        const postOptions = { sort: "confidence", limit: 10, depth: 2 } as const;
        const postResponse = await this.dependencies.request(validated, buildRedditPostUrl(search.items[0].url, postOptions), { signal, profileLock: lock }, this.dependencies.browser);
        parseRedditPost(postResponse.body, postOptions); status = "ready";
      } catch (error) {
        if (error instanceof RedditBrowserError && (error.code === "cancelled" || error.code === "profile_busy" || error.code === "timeout")) {
          const diagnosticStatus: RedditDiagnosticStatus = error.code;
          if (error.code === "timeout") await writeValidation(validated, { version: 1, identity: validated.identity, status: "browser_unavailable", validatedAt: this.dependencies.now().toISOString() });
          return { status: diagnosticStatus, message: messages[diagnosticStatus], eligible: false };
        }
        status = error instanceof RedditBrowserError && error.code === "access_denied" ? "access_denied" : "browser_unavailable";
      }
      const validatedAt = this.dependencies.now().toISOString();
      await writeValidation(validated, { version: 1, identity: validated.identity, status, validatedAt });
      return { status, message: messages[status], lastValidatedAt: validatedAt, eligible: status === "ready" };
    } finally { await lock.release(); }
  }
}
function validationPath(config: ValidatedRedditConfig): string { return join(config.stateDir, "validation.json"); }
async function readValidation(config: ValidatedRedditConfig): Promise<Validation | undefined> {
  const path = validationPath(config);
  try {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || info.size > 4096) return undefined;
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<Validation>;
    if (value.version !== 1 || typeof value.identity !== "string" || !["ready", "browser_unavailable", "access_denied"].includes(value.status ?? "") || typeof value.validatedAt !== "string" || !Number.isFinite(Date.parse(value.validatedAt))) return undefined;
    return value as Validation;
  } catch { return undefined; }
}
async function writeValidation(config: ValidatedRedditConfig, value: Validation): Promise<void> {
  const path = validationPath(config), temporary = join(config.stateDir, `.validation-${process.pid}-${Date.now()}`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    await writeFile(handle, `${JSON.stringify(value)}\n`); await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, path);
  } catch { await handle?.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw new RedditBrowserError("browser_unavailable"); }
}
