import assert from "node:assert/strict";
import test from "node:test";
import { buildRedditPostUrl, buildRedditSearchUrl, normalizeRedditPost, parseRedditPost, parseRedditSearch } from "../src/reddit-parser.js";

const post = (id = "abc123") => ({ kind: "t3", data: { id, title: "A title", permalink: `/r/typescript/comments/${id}/a_title/`, selftext: "excerpt", score: 42, num_comments: 3, author: "author" } });
const listing = (children: unknown[], after: unknown = null) => ({ kind: "Listing", data: { children, after } });

test("search URL validates all bounds and parser emits canonical bounded results", () => {
  const url = buildRedditSearchUrl({ q: "safe query", subreddit: "typescript", sort: "top", time: "week", limit: 25, after: "t3_abc123" });
  assert.match(url, /^https:\/\/www\.reddit\.com\/r\/typescript\/search\.json\?/); assert.match(url, /restrict_sr=1/);
  for (const input of [{ q: "" }, { q: "x", limit: 26 }, { q: "x", after: "abc123" }, { q: "x", subreddit: "../all" }]) assert.throws(() => buildRedditSearchUrl(input));
  const result = parseRedditSearch(JSON.stringify(listing([post(), { kind: "t3", data: { id: "bad" } }, { kind: "t1", data: {} }], "t3_def456")));
  assert.equal(result.items.length, 1); assert.equal(result.items[0]?.url, "https://www.reddit.com/r/typescript/comments/abc123/a_title/"); assert.equal(result.after, "t3_def456");
  const many = Array.from({ length: 20 }, (_, index) => post(`a${String(index).padStart(5, "0")}`));
  assert.equal(parseRedditSearch(JSON.stringify(listing(many)), { limit: 3 }).items.length, 3);
  assert.throws(() => parseRedditSearch("not json"), /invalid JSON/); assert.throws(() => parseRedditSearch("[]"), /non-listing/);
});

test("post grammar accepts only exact www/old/reddit/redd.it forms and normalizes origin", () => {
  for (const value of ["https://www.reddit.com/r/x/comments/abc123/title/", "https://old.reddit.com/r/x/comments/abc123/title", "https://reddit.com/r/x/comments/abc123/", "https://redd.it/abc123", "https://www.reddit.com/comments/abc123", "https://www.reddit.com/comments/abc123/title.json", "https://www.reddit.com/comments/abc123.json?utm_source=share"]) assert.equal(normalizeRedditPost(value).url, "https://www.reddit.com/comments/abc123.json");
  for (const value of ["http://reddit.com/r/x/comments/abc123/", "https://evil.test/r/x/comments/abc123/", "https://www.reddit.com.evil/r/x/comments/abc123/", "https://redd.it/abc123?x=1", "https://www.reddit.com/user/me", "https://www.reddit.com/comments/abc123?redirect=https://evil.test"]) assert.throws(() => normalizeRedditPost(value));
  assert.match(buildRedditPostUrl("https://redd.it/abc123", { limit: 100, depth: 10 }), /limit=100/);
  assert.throws(() => buildRedditPostUrl("https://redd.it/abc123", { limit: 101 }));
});

test("comment traversal reports more placeholders, tolerates deleted data, and enforces global caps", () => {
  const comment = { kind: "t1", data: { id: "def456", body: "hello", score: 1, author: "[deleted]", replies: listing([{ kind: "more", data: { children: ["a", "b"] } }]) } };
  const result = parseRedditPost(JSON.stringify([listing([post()]), listing([comment, { kind: "t1", data: null }])]));
  assert.equal(result.comments[0]?.body, "hello"); assert.deepEqual(result.more, { placeholders: 1, children: 2 }); assert.equal(result.truncated, true);
  assert.throws(() => parseRedditPost(JSON.stringify(listing([]))), /non-listing/);
  const huge = Array.from({ length: 2100 }, (_, i) => ({ kind: "t1", data: { id: `a${String(i).padStart(5, "0")}`, body: "x" } }));
  assert.equal(parseRedditPost(JSON.stringify([listing([post()]), listing(huge)]), { limit: 100 }).truncated, true);
  const nested = { kind: "t1", data: { id: "ghi789", body: "nested", replies: listing([{ kind: "t1", data: { id: "jkl012", body: "too deep" } }]) } };
  const bounded = parseRedditPost(JSON.stringify([listing([post()]), listing([{ ...comment, data: { ...comment.data, replies: listing([nested]) } }, comment])]), { limit: 1, depth: 1 });
  assert.equal(bounded.comments.length, 1); assert.equal(bounded.comments[0]?.replies.length, 0); assert.equal(bounded.truncated, true);
  const totalBounded = parseRedditPost(JSON.stringify([listing([post()]), listing([{ ...comment, data: { ...comment.data, replies: listing([nested]) } }, comment])]), { limit: 2, depth: 10 });
  assert.equal(totalBounded.comments.length + (totalBounded.comments[0]?.replies.length ?? 0), 2); assert.equal(totalBounded.truncated, true);
  const longText = parseRedditPost(JSON.stringify([listing([{ ...post(), data: { ...post().data, selftext: "x".repeat(50_000) } }]), listing([])]));
  assert.equal(longText.post.body.length, 40_000); assert.equal(longText.truncated, true);
});
