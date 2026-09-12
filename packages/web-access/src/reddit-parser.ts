const POST_ID = /^[a-z0-9]{5,10}$/i;
const AFTER = /^t3_[a-z0-9]{5,10}$/i;
const SUBREDDIT = /^[A-Za-z0-9][A-Za-z0-9_]{1,20}$/;
const SORTS = new Set(["relevance", "hot", "top", "new", "comments"]);
const TIMES = new Set(["hour", "day", "week", "month", "year", "all"]);
const COMMENT_SORTS = new Set(["confidence", "top", "new", "controversial", "old", "qa"]);
const MAX_JSON_CHARS = 5_000_000;
const MAX_TEXT_CHARS = 40_000;
const MAX_NODES = 2_000;

export interface RedditSearchOptions { q: string; subreddit?: string; sort?: string; time?: string; limit?: number; after?: string }
export interface RedditSearchItem { id: string; title: string; url: string; excerpt: string; score: number; numComments: number }
export interface RedditSearchResult { items: RedditSearchItem[]; after?: string }
export interface RedditPostOptions { sort?: string; limit?: number; depth?: number }
export interface RedditComment { id: string; author?: string; body: string; score: number; depth: number; replies: RedditComment[] }
export interface RedditPostResult { post: RedditSearchItem & { body: string; author?: string }; comments: RedditComment[]; more: { placeholders: number; children: number }; truncated: boolean }

function integer(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be an integer between ${min} and ${max}`);
  return value as number;
}
function finite(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
function string(value: unknown, max = 10_000): string { return typeof value === "string" ? value.slice(0, max) : ""; }
function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function parseJson(text: string): unknown {
  if (typeof text !== "string" || text.length > MAX_JSON_CHARS) throw new Error("Reddit JSON response exceeds the size limit");
  try { return JSON.parse(text); } catch { throw new Error("Reddit returned invalid JSON"); }
}
function listing(value: unknown): Record<string, unknown>[] {
  const root = record(value), data = record(root?.data);
  if (root?.kind !== "Listing" || !Array.isArray(data?.children)) throw new Error("Reddit returned a non-listing response");
  return data.children.map(record).filter((v): v is Record<string, unknown> => !!v);
}
function canonicalPost(data: Record<string, unknown>): RedditSearchItem {
  const id = string(data.id, 32);
  if (!POST_ID.test(id)) throw new Error("Reddit listing contains an invalid post identifier");
  const permalink = string(data.permalink, 2048);
  if (!new RegExp(`^(?:/r/[A-Za-z0-9_]+)?/comments/${id}(?:/[A-Za-z0-9_-]*)?/?$`, "i").test(permalink)) throw new Error("Reddit listing contains an invalid post path");
  return { id: `t3_${id.toLowerCase()}`, title: string(data.title, 500), url: `https://www.reddit.com${permalink}`, excerpt: string(data.selftext, 1000), score: finite(data.score), numComments: finite(data.num_comments) };
}

export function buildRedditSearchUrl(options: RedditSearchOptions): string {
  if (typeof options.q !== "string" || !options.q.trim() || options.q.length > 500 || /[\x00-\x1f]/.test(options.q)) throw new Error("q must be 1-500 printable characters");
  if (options.subreddit !== undefined && !SUBREDDIT.test(options.subreddit)) throw new Error("Invalid subreddit");
  const sort = options.sort ?? "relevance", time = options.time ?? "all";
  if (!SORTS.has(sort) || !TIMES.has(time)) throw new Error("Invalid Reddit search sort or time");
  const limit = integer(options.limit, 10, 1, 25, "limit");
  if (options.after !== undefined && !AFTER.test(options.after)) throw new Error("after must be a valid t3_ identifier");
  const path = options.subreddit ? `/r/${options.subreddit}/search.json` : "/search.json";
  const query = new URLSearchParams({ q: options.q, sort, t: time, limit: String(limit), raw_json: "1", restrict_sr: options.subreddit ? "1" : "0" });
  if (options.after) query.set("after", options.after.toLowerCase());
  return `https://www.reddit.com${path}?${query}`;
}

export function parseRedditSearch(text: string, options: Pick<RedditSearchOptions, "limit"> = {}): RedditSearchResult {
  const limit = integer(options.limit, 10, 1, 25, "limit");
  const parsed = parseJson(text), root = record(parsed), data = record(root?.data);
  const items: RedditSearchItem[] = [];
  for (const child of listing(parsed)) {
    if (items.length >= limit) break;
    if (child.kind !== "t3") continue;
    try { items.push(canonicalPost(record(child.data) ?? {})); } catch { /* tolerate malformed entries */ }
  }
  const after = string(data?.after, 32);
  return { items, ...(AFTER.test(after) ? { after: after.toLowerCase() } : {}) };
}

/** Accept canonical post forms and discard only recognized, inert tracking query fields. */
export function normalizeRedditPost(value: string): { id: string; url: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Invalid Reddit post URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash || !["www.reddit.com", "old.reddit.com", "reddit.com", "redd.it"].includes(url.hostname.toLowerCase())) throw new Error("Invalid Reddit post URL");
  for (const [key, tracking] of url.searchParams) if (!/^(?:utm_[a-z_]+|ref|share_id)$/i.test(key) || tracking.length > 256) throw new Error("Invalid Reddit post URL");
  let id: string | undefined;
  if (url.hostname.toLowerCase() === "redd.it") id = /^\/([a-z0-9]{5,10})(?:\.json)?\/?$/i.exec(url.pathname)?.[1];
  else id = /^(?:\/r\/[A-Za-z0-9_]+)?\/comments\/([a-z0-9]{5,10})(?:\/[A-Za-z0-9_-]+)?(?:\.json)?\/?$/i.exec(url.pathname)?.[1];
  if (!id || !POST_ID.test(id)) throw new Error("Invalid Reddit post URL");
  id = id.toLowerCase();
  return { id: `t3_${id}`, url: `https://www.reddit.com/comments/${id}.json` };
}

export function buildRedditPostUrl(value: string, options: RedditPostOptions = {}): string {
  const normalized = normalizeRedditPost(value);
  const sort = options.sort ?? "confidence";
  if (!COMMENT_SORTS.has(sort)) throw new Error("Invalid comment sort");
  const query = new URLSearchParams({ sort, limit: String(integer(options.limit, 50, 1, 100, "limit")), depth: String(integer(options.depth, 5, 1, 10, "depth")), raw_json: "1" });
  return `${normalized.url}?${query}`;
}

export function parseRedditPost(text: string, options: RedditPostOptions = {}): RedditPostResult {
  const limit = integer(options.limit, 50, 1, 100, "limit"), maxDepth = integer(options.depth, 5, 1, 10, "depth");
  const parsed = parseJson(text);
  if (!Array.isArray(parsed) || parsed.length !== 2) throw new Error("Reddit returned a non-listing post response");
  const postChild = listing(parsed[0]).find((child) => child.kind === "t3");
  const postData = record(postChild?.data);
  if (!postData) throw new Error("Reddit post listing is empty");
  const base = canonicalPost(postData);
  let nodes = 0, comments = 0, textChars = 0, truncated = false, placeholders = 0, moreChildren = 0;
  const walk = (children: Record<string, unknown>[], depth: number): RedditComment[] => {
    const output: RedditComment[] = [];
    for (const child of children) {
      if (++nodes > MAX_NODES) { truncated = true; break; }
      if (child.kind === "more") { placeholders++; truncated = true; const ids = record(child.data)?.children; if (Array.isArray(ids)) moreChildren += ids.filter((id) => typeof id === "string").length; continue; }
      if (child.kind !== "t1") continue;
      const data = record(child.data);
      if (!data) continue; // Deleted/collapsed placeholders are valid but carry no comment.
      if (comments >= limit) { truncated = true; break; }
      const rawBody = typeof data.body === "string" ? data.body : "";
      const remaining = Math.max(0, MAX_TEXT_CHARS - textChars), body = rawBody.slice(0, remaining);
      if (body.length < rawBody.length) truncated = true;
      textChars += body.length;
      const id = string(data.id, 32);
      if (!POST_ID.test(id)) continue;
      comments++;
      const repliesValue = data.replies, replies = record(repliesValue);
      let nested: Record<string, unknown>[] = [];
      if (replies?.kind === "Listing") {
        const listed = listing(repliesValue);
        if (depth + 1 < maxDepth) nested = listed;
        else if (listed.length) truncated = true;
      }
      output.push({ id: `t1_${id.toLowerCase()}`, ...(string(data.author, 100) ? { author: string(data.author, 100) } : {}), body, score: finite(data.score), depth, replies: walk(nested, depth + 1) });
    }
    return output;
  };
  const rawPostBody = typeof postData.selftext === "string" ? postData.selftext : "", postBody = rawPostBody.slice(0, MAX_TEXT_CHARS);
  if (postBody.length < rawPostBody.length) truncated = true;
  return { post: { ...base, body: postBody, ...(string(postData.author, 100) ? { author: string(postData.author, 100) } : {}) }, comments: walk(listing(parsed[1]), 0), more: { placeholders, children: moreChildren }, truncated };
}
