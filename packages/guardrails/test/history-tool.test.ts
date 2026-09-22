import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HistoryStore } from "../src/history.js";
import { createHistoryTool } from "../src/history-tool.js";
import { entry } from "./helpers.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "history-tool-"));
  const historyPath = join(root, "history.sqlite");
  const history = new HistoryStore(historyPath);

  const sessionId = "test-session";
  const ctx = {
    cwd: root,
    mode: "tui",
    hasUI: true,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => sessionId, getLeafId: () => "leaf" },
    signal: new AbortController().signal,
  } as unknown as ExtensionContext;

  return { root, history, sessionId, ctx, cleanup: async () => { history.close(); await rm(root, { recursive: true, force: true }); } };
}

test("list action returns paginated entries with metadata", async () => {
  const f = await fixture();
  const e1 = f.history.put(entry({ sessionId: f.sessionId, tool: "bash", summary: "git status" }));
  const e2 = f.history.put(entry({ sessionId: f.sessionId, tool: "read", summary: "read file", at: Date.now() + 1 }));
  f.history.put(entry({ sessionId: "other-session", tool: "bash", summary: "other session" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));
  const result = await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 2);
  assert.equal(content.total, 2);
  assert.equal(content.limit, 20);
  assert.equal(content.offset, 0);
  assert.equal(content.hasMore, false);
  assert(content.warning.includes("untrusted data"));
  assert.equal(content.entries[0].id, e2.id);

  await f.cleanup();
});

test("list action defaults to current session when scope omitted", async () => {
  const f = await fixture();
  f.history.put(entry({ sessionId: f.sessionId }));
  f.history.put(entry({ sessionId: "other-session" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));
  const result = await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 1);

  await f.cleanup();
});

test("list action with global scope returns all sessions", async () => {
  const f = await fixture();
  f.history.put(entry({ sessionId: "session-1", tool: "bash" }));
  f.history.put(entry({ sessionId: "session-2", tool: "read" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));
  const result = await tool.execute("call", { action: "list", scope: "global" }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 2);
  assert.equal(content.total, 2);

  await f.cleanup();
});

test("sessionId parameter overrides scope", async () => {
  const f = await fixture();
  f.history.put(entry({ sessionId: "session-1", tool: "bash" }));
  f.history.put(entry({ sessionId: "session-2", tool: "read" }));
  f.history.put(entry({ sessionId: "session-1", tool: "write" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));
  const result = await tool.execute(
    "call",
    { action: "list", scope: "global", sessionId: "session-1" },
    f.ctx.signal,
    undefined,
    f.ctx,
  );

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 2);
  assert(content.entries.every((e: any) => e.sessionId === "session-1"));

  await f.cleanup();
});

test("list respects limit and offset pagination", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  for (let i = 0; i < 5; i++) {
    f.history.put(entry({ sessionId, at: Date.now() + i }));
  }

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute("call", { action: "list", limit: 2, offset: 1 }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 2);
  assert.equal(content.total, 5);
  assert.equal(content.offset, 1);
  assert.equal(content.limit, 2);
  assert.equal(content.hasMore, true);
  assert.equal(content.nextOffset, 3);

  await f.cleanup();
});

test("list caps at 50 entries regardless of requested limit", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  for (let i = 0; i < 100; i++) {
    f.history.put(entry({ sessionId, at: Date.now() + i }));
  }

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute("call", { action: "list", limit: 50 }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 50);
  assert.equal(content.limit, 50);
  assert.equal(content.total, 100);
  assert.equal(content.hasMore, true);

  await f.cleanup();
});

test("filter by decision action (Allow/Ask/Deny)", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  f.history.put(entry({ sessionId, action: "Allow" }));
  f.history.put(entry({ sessionId, action: "Ask", state: "review" }));
  f.history.put(entry({ sessionId, action: "Deny", state: "denied" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute(
    "call",
    { action: "list", filter: { decision: "Ask" } },
    f.ctx.signal,
    undefined,
    f.ctx,
  );

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 1);
  assert.equal(content.entries[0].action, "Ask");

  await f.cleanup();
});

test("filter by origin", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  f.history.put(entry({ sessionId, origin: "policy" }));
  f.history.put(entry({ sessionId, origin: "model" }));
  f.history.put(entry({ sessionId, origin: "policy" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute(
    "call",
    { action: "list", filter: { origin: "model" } },
    f.ctx.signal,
    undefined,
    f.ctx,
  );

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 1);
  assert.equal(content.entries[0].origin, "model");

  await f.cleanup();
});

test("filter by actor", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  f.history.put(entry({ sessionId, actor: { kind: "main" } }));
  const subagentEntry = f.history.put(entry({ sessionId, actor: { kind: "subagent", runId: "run-1" } }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute(
    "call",
    { action: "list", filter: { actor: "subagent" } },
    f.ctx.signal,
    undefined,
    f.ctx,
  );

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 1);
  assert.equal(content.entries[0].id, subagentEntry.id);

  await f.cleanup();
});

test("filter by tool", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  f.history.put(entry({ sessionId, tool: "bash" }));
  f.history.put(entry({ sessionId, tool: "read" }));
  f.history.put(entry({ sessionId, tool: "bash" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute(
    "call",
    { action: "list", filter: { tool: "bash" } },
    f.ctx.signal,
    undefined,
    f.ctx,
  );

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 2);
  assert(content.entries.every((e: any) => e.tool === "bash"));

  await f.cleanup();
});

test("filter by search text", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  f.history.put(entry({ sessionId, summary: "git clone repo", operation: "clone" }));
  f.history.put(entry({ sessionId, summary: "npm install", operation: "install" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute(
    "call",
    { action: "list", filter: { search: "git" } },
    f.ctx.signal,
    undefined,
    f.ctx,
  );

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 1);

  await f.cleanup();
});

test("detail action returns full entry with all stored fields", async () => {
  const f = await fixture();
  const entryId = randomUUID();
  f.history.put(
    entry({
      id: entryId,
      tool: "bash",
      summary: "rm -rf /",
      target: "/",
      operation: "delete",
      reason: "User asked to delete everything",
      action: "Deny",
      origin: "policy",
      jev: {
        probabilities: { Allow: 0.1, Ask: 0.2, Deny: 0.7 },
        thresholds: { allow: 0.8, deny: 0.3, restrictive: 0.5 },
        restrictions: [],
        reasons: ["generic-deny"],
      },
      execution: "blocked",
      state: "denied",
    }),
  );

  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));
  const result = await tool.execute("call", { action: "detail", id: entryId }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.found, true);
  assert.equal(content.entry.id, entryId);
  assert.equal(content.entry.tool, "bash");
  assert.equal(content.entry.action, "Deny");
  assert(content.entry.jev);
  assert.equal(content.entry.jev.probabilities.Deny, 0.7);
  assert(content.warning.includes("untrusted data"));

  await f.cleanup();
});

test("detail action returns not-found for missing id", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));
  const result = await tool.execute("call", { action: "detail", id: randomUUID() }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.found, false);

  await f.cleanup();
});

test("unknown filter fields are rejected", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    await tool.execute(
      "call",
      { action: "list", filter: { decision: "Ask", unknownField: "value" } as any },
      f.ctx.signal,
      undefined,
      f.ctx,
    );
    assert.fail("Should have thrown validation error");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  await f.cleanup();
});

test("unknown top-level fields are rejected", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    await tool.execute(
      "call",
      { action: "list", unknownField: "value" } as any,
      f.ctx.signal,
      undefined,
      f.ctx,
    );
    assert.fail("Should have thrown validation error");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  await f.cleanup();
});

test("detail requires valid UUID id", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    await tool.execute("call", { action: "detail", id: "not-a-uuid" } as any, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should have thrown validation error");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  await f.cleanup();
});

test("detail action rejects list-only fields", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    const id = randomUUID();
    await tool.execute(
      "call",
      { action: "detail", id, limit: 10 } as any,
      f.ctx.signal,
      undefined,
      f.ctx,
    );
    assert.fail("Should have thrown validation error");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  await f.cleanup();
});

test("limit exceeding 50 is rejected", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    await tool.execute("call", { action: "list", limit: 51 }, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should have thrown validation error");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  await f.cleanup();
});

test("limit 0 or negative is rejected", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  for (const limit of [0, -1]) {
    try {
      await tool.execute("call", { action: "list", limit }, f.ctx.signal, undefined, f.ctx);
      assert.fail(`Should have thrown validation error for limit ${limit}`);
    } catch (err) {
      assert((err as Error).message.includes("validation failed"));
    }
  }

  await f.cleanup();
});

test("offset exceeding 2000 is rejected", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    await tool.execute("call", { action: "list", offset: 2001 }, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should have thrown validation error");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  await f.cleanup();
});

test("missing runtime throws", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => undefined);

  try {
    await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should have thrown");
  } catch (err) {
    assert((err as Error).message.includes("runtime missing"));
  }

  await f.cleanup();
});

test("session mismatch throws", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: "other-session" }));

  try {
    await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should have thrown");
  } catch (err) {
    assert((err as Error).message.includes("session mismatch"));
  }

  await f.cleanup();
});

test("missing history throws", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: undefined, sessionId: f.sessionId } as any));

  try {
    await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should have thrown");
  } catch (err) {
    assert((err as Error).message.includes("unavailable"));
  }

  await f.cleanup();
});

test("closed history throws", async () => {
  const f = await fixture();
  f.history.close();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should have thrown");
  } catch (err) {
    assert((err as Error).message.includes("closed"));
  }

  await f.cleanup();
});

test("aborted signal throws", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    await tool.execute("call", { action: "list" }, controller.signal, undefined, f.ctx);
    assert.fail("Should have thrown");
  } catch (err) {
    assert((err as Error).message.includes("cancelled"));
  }

  await f.cleanup();
});

test("store.list exception is caught and rethrown as fixed error", async () => {
  const f = await fixture();
  f.history.close();
  const mockHistory = {
    isClosed: false,
    list: () => {
      throw new Error("raw database error with secrets");
    },
  } as any;
  const tool = createHistoryTool(() => ({ history: mockHistory, sessionId: f.sessionId }));

  try {
    await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should have thrown");
  } catch (err) {
    const msg = (err as Error).message;
    assert(msg.includes("query failed"));
    assert(!msg.includes("database error"));
    assert(!msg.includes("secrets"));
  }

  await f.cleanup();
});

test("output size is bounded to 32000 bytes per serialized payload", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  for (let i = 0; i < 200; i++) {
    f.history.put(entry({ sessionId, summary: "x".repeat(200), reason: "y".repeat(300), at: Date.now() + i }));
  }

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute("call", { action: "list", limit: 50 }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const serialized = result.content[0].text;
  const bytes = Buffer.byteLength(serialized, "utf8");
  assert(bytes <= 32000, `Output size ${bytes} exceeds 32000`);

  const content = JSON.parse(serialized);
  assert(content.entries.length > 0);

  await f.cleanup();
});

test("all pages cover all IDs without skips", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  const ids: string[] = [];
  for (let i = 0; i < 25; i++) {
    const e = f.history.put(entry({ sessionId, at: Date.now() + i }));
    ids.push(e.id);
  }

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const collected: string[] = [];
  let offset = 0;

  for (let page = 0; page < 10; page++) {
    const result = await tool.execute("call", { action: "list", limit: 5, offset }, f.ctx.signal, undefined, f.ctx);
    assert(result.content[0].type === "text");
    const content = JSON.parse(result.content[0].text);

    if (content.entries.length === 0) break;
    collected.push(...content.entries.map((e: any) => e.id));

    if (!content.hasMore) break;
    offset = content.nextOffset;
  }

  assert.equal(collected.length, ids.length);
  const uniqueCollected = new Set(collected);
  assert.equal(uniqueCollected.size, ids.length);

  await f.cleanup();
});

test("truncated entries are marked and shortened", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  const longSummary = "操作 ".repeat(500);
  const longReason = "风险 ".repeat(600);
  const ent = entry({ sessionId, summary: longSummary, reason: longReason });
  f.history.put(ent);

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  const entry1 = content.entries[0];
  // Must be truncated since original is much longer
  assert.equal(entry1.truncated, true, "entry with 1000+ char reason and 500+ char summary must be truncated");
  assert(entry1.summary.endsWith("…"), "truncated summary must end with ellipsis");
  assert(entry1.reason.endsWith("…"), "truncated reason must end with ellipsis");
  // Summary is sliced at 400 chars + 1 ellipsis = 401 bytes (depending on chars)
  assert(entry1.summary.length <= 401, `summary length ${entry1.summary.length} must not exceed 401 (400 + ellipsis)`);
  // Reason is sliced at 500 chars + 1 ellipsis = max 501 bytes
  assert(entry1.reason.length <= 501, `reason length ${entry1.reason.length} must not exceed 501 (500 + ellipsis)`);

  await f.cleanup();
});

test("detail entry contains complete HistoryEntry fields", async () => {
  const f = await fixture();
  const entryId = randomUUID();
  const ent = entry({
    id: entryId,
    sessionId: f.sessionId,
    actor: { kind: "subagent", runId: "run-123", profile: "worker" },
    tool: "write",
    action: "Ask",
    origin: "model",
    jev: {
      probabilities: { Allow: 0.3, Ask: 0.5, Deny: 0.2 },
      thresholds: { allow: 0.8, deny: 0.3, restrictive: 0.5 },
      restrictions: [["path-sensitive", 0.6]],
      reasons: ["incomplete-input"],
    },
  });
  f.history.put(ent);

  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));
  const result = await tool.execute("call", { action: "detail", id: entryId }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  const retrievedEntry = content.entry;

  assert.equal(retrievedEntry.id, entryId);
  assert.equal(retrievedEntry.sessionId, f.sessionId);
  assert.equal(retrievedEntry.actor.kind, "subagent");
  assert.equal(retrievedEntry.actor.runId, "run-123");
  assert.equal(retrievedEntry.actor.profile, "worker");
  assert.equal(retrievedEntry.tool, "write");
  assert.equal(retrievedEntry.action, "Ask");
  assert.equal(retrievedEntry.origin, "model");
  assert(retrievedEntry.jev.restrictions.length > 0);
  assert(retrievedEntry.jev.reasons.includes("incomplete-input"));
  assert(retrievedEntry.at !== undefined);
  assert(retrievedEntry.updatedAt !== undefined);
  assert(retrievedEntry.target !== undefined);
  assert(retrievedEntry.summary !== undefined);
  assert(retrievedEntry.reason !== undefined);
  assert(retrievedEntry.operation !== undefined);
  assert(retrievedEntry.state !== undefined);
  assert(retrievedEntry.execution !== undefined);
  assert(retrievedEntry.policyIds !== undefined);
  assert(retrievedEntry.historyIds !== undefined);
  assert(retrievedEntry.project !== undefined);
  assert(retrievedEntry.cwd !== undefined);
  assert(retrievedEntry.callId !== undefined);

  await f.cleanup();
});

test("list default limit is 20", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  for (let i = 0; i < 30; i++) {
    f.history.put(entry({ sessionId, at: Date.now() + i }));
  }

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 20);
  assert.equal(content.limit, 20);
  assert.equal(content.total, 30);
  assert.equal(content.hasMore, true);

  await f.cleanup();
});

test("JSON content is parseable and matches details", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  f.history.put(entry({ sessionId, tool: "bash", summary: "git status" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const parsed = JSON.parse(result.content[0].text);
  assert(parsed.entries);
  assert(parsed.warning);
  assert(parsed.entries.length > 0);
  assert(parsed.total >= 1);
  assert(parsed.offset === 0);
  assert(parsed.limit === 20);

  await f.cleanup();
});

test("filter decision:Ask includes pending, human-approved, and blocked Ask states", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  f.history.put(entry({ sessionId, action: "Allow", state: "allowed" }));
  f.history.put(entry({ sessionId, action: "Ask", state: "review" }));
  f.history.put(entry({ sessionId, action: "Ask", choice: "allow-once", state: "allowed" }));
  f.history.put(entry({ sessionId, action: "Ask", state: "assessing" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute("call", { action: "list", filter: { decision: "Ask" } }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.entries.length, 3);
  assert(content.entries.every((e: any) => e.action === "Ask"));

  await f.cleanup();
});

test("detail returns normalized sanitized store entry with populated JEV risks and restrictions", async () => {
  const f = await fixture();
  const entryId = randomUUID();
  const storedEntry = entry({
    id: entryId,
    sessionId: f.sessionId,
    actor: { kind: "subagent", runId: "run-worker", profile: "worker", childSessionId: "child-123" },
    tool: "bash",
    action: "Ask",
    jev: {
      probabilities: { Allow: 0.2, Ask: 0.6, Deny: 0.2 },
      restrictions: [["high-risk", 0.8], ["external-modification", 0.5]],
      risks: [["external-modification", 0.7], ["unrecoverable-loss", 0.3]],
      thresholds: { allow: 0.8, deny: 0.3, restrictive: 0.5 },
      reasons: ["incomplete-input", "atomic-risk"],
    },
    failure: "timeout",
    model: { route: "test-model", thinking: "off", durationMs: 150 },
  });
  f.history.put(storedEntry);

  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));
  const result = await tool.execute("call", { action: "detail", id: entryId }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const content = JSON.parse(result.content[0].text);
  assert.equal(content.found, true);
  assert.deepEqual(content.entry.jev.risks, [["external-modification", 0.7], ["unrecoverable-loss", 0.3]]);
  assert.deepEqual(content.entry.jev.restrictions, [["high-risk", 0.8], ["external-modification", 0.5]]);
  assert.equal(content.entry.jev.thresholds.restrictive, 0.5);
  assert.equal(content.entry.failure, "timeout");
  assert.equal(content.entry.model.route, "test-model");
  assert.equal(content.entry.actor.childSessionId, "child-123");

  await f.cleanup();
});

test("schema export requires root and filter to have additionalProperties false", async () => {
  const { historyToolSchema } = await import("../src/history-tool.js");
  assert(historyToolSchema !== undefined, "historyToolSchema must be exported");
  // Root-level schema should have additionalProperties: false
  const schemaAsRecord = historyToolSchema as unknown as Record<string, unknown>;
  assert.equal(schemaAsRecord.additionalProperties, false, "root schema must have additionalProperties: false");
  // Filter object should have additionalProperties: false
  assert(schemaAsRecord.properties !== undefined && typeof schemaAsRecord.properties === "object", "properties must exist");
  const filterSchema = (schemaAsRecord.properties as Record<string, unknown>).filter;
  if (filterSchema && typeof filterSchema === "object" && "additionalProperties" in filterSchema) {
    assert.equal((filterSchema as unknown as Record<string, unknown>).additionalProperties, false, "filter schema must have additionalProperties: false");
  }
});

test("runtime validation rejects unknown action", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    await tool.execute("call", { action: "unknown" } as any, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should reject unknown action");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  await f.cleanup();
});

test("runtime validation rejects out-of-range fraction values", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  // Test limit exceeding max
  try {
    await tool.execute("call", { action: "list", limit: 51 } as any, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should reject limit > 50");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  // Test fractional limit (1.5)
  try {
    await tool.execute("call", { action: "list", limit: 1.5 } as any, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should reject fractional limit");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  // Test fractional offset (0.5)
  try {
    await tool.execute("call", { action: "list", offset: 0.5 } as any, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should reject fractional offset");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  await f.cleanup();
});

test("list with CJK multibyte entries stays within budget", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  const cjkText = "风险 ".repeat(300);
  for (let i = 0; i < 10; i++) {
    f.history.put(entry({ sessionId, summary: cjkText, reason: "操作 ".repeat(400), at: Date.now() + i }));
  }

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const serialized = result.content[0].text;
  const bytes = Buffer.byteLength(serialized, "utf8");
  assert(bytes <= 32000, `Multibyte result ${bytes} exceeds budget`);

  // Check FULL result including wrapper
  const fullResult = JSON.stringify(result);
  const fullBytes = Buffer.byteLength(fullResult, "utf8");
  assert(fullBytes <= 32000, `Full serialized result ${fullBytes} exceeds 32000 byte budget`);

  const content = JSON.parse(serialized);
  assert(content.entries.length > 0, "Should include at least one entry");

  await f.cleanup();
});

test("pagination offset covers all IDs exactly once without skips", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  const ids: string[] = [];
  for (let i = 0; i < 30; i++) {
    const e = f.history.put(entry({ sessionId, at: Date.now() + i }));
    ids.push(e.id);
  }

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const collected: string[] = [];
  let offset = 0;

  for (let page = 0; page < 10; page++) {
    const result = await tool.execute("call", { action: "list", limit: 10, offset }, f.ctx.signal, undefined, f.ctx);
    assert(result.content[0].type === "text");
    const content = JSON.parse(result.content[0].text);

    if (content.entries.length === 0) break;
    collected.push(...content.entries.map((e: any) => e.id));

    if (!content.hasMore) break;
    offset = content.nextOffset;
  }

  assert.equal(collected.length, 30);
  const uniqueCollected = new Set(collected);
  assert.equal(uniqueCollected.size, 30);

  await f.cleanup();
});

test("pagination offset covers IDs exactly once: limit 50 CJK entries + pagination", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  const cjkReason = "操作 ".repeat(300);
  const cjkSummary = "风险 ".repeat(200);
  const ids: string[] = [];
  for (let i = 0; i < 50; i++) {
    const e = f.history.put(entry({ sessionId, summary: cjkSummary, reason: cjkReason, at: Date.now() + i }));
    ids.push(e.id);
  }

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const collected: string[] = [];
  let offset = 0;

  // First page with limit 50
  let result = await tool.execute("call", { action: "list", limit: 50 }, f.ctx.signal, undefined, f.ctx);
  assert(result.content[0].type === "text");
  let content = JSON.parse(result.content[0].text);
  // Due to budget, should get fewer than 50 even though limit is 50
  assert(content.entries.length > 0, "First page must have at least one entry");
  assert(content.entries.length < 50, "First page should have < 50 due to CJK budget");

  const firstPageCount = content.entries.length;
  collected.push(...content.entries.map((e: any) => e.id));

  // Paginate through remaining entries
  if (content.hasMore) {
    offset = content.nextOffset;
    result = await tool.execute("call", { action: "list", limit: 50, offset }, f.ctx.signal, undefined, f.ctx);
    assert(result.content[0].type === "text");
    content = JSON.parse(result.content[0].text);
    collected.push(...content.entries.map((e: any) => e.id));
  }

  // Verify no duplicates and coverage
  const uniqueCollected = new Set(collected);
  assert.equal(uniqueCollected.size, collected.length, "No duplicate IDs across pages");
  // All collected IDs should be in original list
  for (const id of collected) {
    assert(ids.includes(id), `Collected ID ${id} must be in original list`);
  }

  await f.cleanup();
});

test("JSON.parse(content.text) equals details for list responses", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;
  f.history.put(entry({ sessionId, tool: "bash", summary: "git status", reason: "user requested" }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const parsedContent = JSON.parse(result.content[0].text);
  const details = result.details as any;
  // Deep equality: JSON.parse(content.text) must equal JSON.parse(JSON.stringify(result.details))
  assert.deepEqual(parsedContent, JSON.parse(JSON.stringify(details)), "parsed content must deeply equal details");
  assert(parsedContent.entries !== undefined);
  assert(parsedContent.warning !== undefined);
  assert.equal(parsedContent.limit, details.limit);
  assert.equal(parsedContent.total, details.total);

  await f.cleanup();
});

test("detail missing required id field throws validation error", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    await tool.execute("call", { action: "detail" } as any, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should reject missing id");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  await f.cleanup();
});

test("tool validates UUID pattern at runtime", async () => {
  const f = await fixture();
  const tool = createHistoryTool(() => ({ history: f.history, sessionId: f.sessionId }));

  try {
    await tool.execute("call", { action: "detail", id: "not-a-valid-uuid-format" } as any, f.ctx.signal, undefined, f.ctx);
    assert.fail("Should reject invalid UUID pattern");
  } catch (err) {
    assert((err as Error).message.includes("validation failed"));
  }

  await f.cleanup();
});

test("redaction and control: credential-shaped strings sanitized in list/detail outputs", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;

  // Create entries with credential-shaped strings
  const e1 = f.history.put(entry({
    sessionId,
    reason: "Bearer token sk-1234567890abcdef in response",
    summary: "password=secret123 in command",
    at: Date.now(),
  }));
  const e2 = f.history.put(entry({
    sessionId,
    reason: "API key: sk-proj-abc123xyz789",
    summary: "ESC control chars test: \x1b[31m red text",
    at: Date.now() + 1,
  }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));

  // List action: verify sanitization
  const listResult = await tool.execute("call", { action: "list" }, f.ctx.signal, undefined, f.ctx);
  assert(listResult.content[0].type === "text");
  const listContent = JSON.parse(listResult.content[0].text);
  assert(listContent.warning.includes("untrusted data"), "warning must mention untrusted data");

  const listEntries = listContent.entries;
  assert.equal(listEntries.length, 2, "both entries listed");

  // Check that serialized output lacks obvious credential markers
  const serialized = listResult.content[0].text;
  assert(!serialized.includes("sk-1234567890abcdef"), "raw token key should not appear");
  assert(!serialized.includes("sk-proj-"), "raw API key prefix should not appear");
  // ESC character should be handled (either removed or escaped in JSON)
  assert(!serialized.includes("\x1b"), "ESC control char should be removed");

  // Detail action: verify complete content preserves structure but sanitizes
  const detailResult = await tool.execute("call", { action: "detail", id: e1.id }, f.ctx.signal, undefined, f.ctx);
  assert(detailResult.content[0].type === "text");
  const detailContent = JSON.parse(detailResult.content[0].text);
  assert.equal(detailContent.found, true, "entry found");

  const detail = detailContent.entry;
  // Verify entry structure is preserved (not redacted away)
  assert(detail.reason !== undefined, "reason field present in detail");
  assert(detail.summary !== undefined, "summary field present in detail");
  assert(detail.at !== undefined, "at field present in detail");

  // Verify full result stays within budget
  const detailSerialized = detailResult.content[0].text;
  const detailBytes = Buffer.byteLength(detailSerialized, "utf8");
  assert(detailBytes <= 32000, `Detail result ${detailBytes} exceeds 32000 byte budget`);

  // Verify output doesn't contain unescaped control characters
  assert(!detailSerialized.includes("\x1b"), "ESC in detail should be handled");

  await f.cleanup();
});

test("large detail preserves content within 32KB budget", async () => {
  const f = await fixture();
  const sessionId = f.sessionId;

  // Create entry with large detail (CJK reason + summary + many restrictions)
  // Keep total size under 24KB for storage (constraint: Buffer.byteLength(JSON.stringify(safe)) > 24000 throws)
  const cjkLarge = "操作说明 ".repeat(150);
  const largeReason = cjkLarge;
  const largeSummary = "风险评估 ".repeat(100);
  const e = f.history.put(entry({
    sessionId,
    reason: largeReason,
    summary: largeSummary,
    jev: {
      probabilities: { Allow: 0.1, Ask: 0.5, Deny: 0.4 },
      restrictions: Array.from({ length: 30 }, (_, i) => [`restriction-${i}` as any, 0.5 + (i * 0.01)]),
      thresholds: { allow: 0.8, deny: 0.3, restrictive: 0.5 },
      reasons: ["incomplete-input", "atomic-risk"],
    },
    at: Date.now(),
  }));

  const tool = createHistoryTool(() => ({ history: f.history, sessionId }));
  const result = await tool.execute("call", { action: "detail", id: e.id }, f.ctx.signal, undefined, f.ctx);

  assert(result.content[0].type === "text");
  const serialized = result.content[0].text;
  const bytes = Buffer.byteLength(serialized, "utf8");
  assert(bytes <= 32000, `Large detail result ${bytes} exceeds 32KB budget`);

  const content = JSON.parse(serialized);
  assert.equal(content.found, true, "large entry found");
  assert(content.entry.jev !== undefined, "JEV data preserved");
  assert(content.entry.jev.restrictions.length > 0, "restrictions preserved");

  await f.cleanup();
});
