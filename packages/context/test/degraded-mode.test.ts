import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";

import { registerContextFeatures } from "../src/index.js";
import { DEFAULT_KNOWLEDGE_CONFIG } from "../src/config/schema.js";
import { KnowledgeIndex } from "../src/knowledge/index.js";
import { MemoryStore } from "../src/memory/store.js";
import { KnowledgeIndexService, MemoryStoreService, SessionIndexService } from "../src/runtime/services.js";
import { SessionIndex } from "../src/sessions/index.js";

function fixture() {
  const memoryDb = new DatabaseSync(":memory:");
  const sessionsDb = new DatabaseSync(":memory:");
  const knowledgeDb = new DatabaseSync(":memory:");
  const memory = new MemoryStore(memoryDb, { disableFts: true });
  const sessions = new SessionIndex(sessionsDb, { disableFts: true });
  const knowledge = new KnowledgeIndex(knowledgeDb, DEFAULT_KNOWLEDGE_CONFIG, { disableFts: true });
  return { memoryDb, sessionsDb, knowledgeDb, memory, sessions, knowledge };
}

describe("degraded operation without FTS or a model", () => {
  it("retains observational and metadata operations with bounded actionable diagnostics", async () => {
    const value = fixture();
    value.memory.setFact("editor", "Use Neovim");
    value.memory.addLesson({ rule: "Run focused tests", category: "testing" });
    expect(value.memory.searchFacts("Neovim")).toHaveLength(1);
    expect(value.memory.searchLessons("focused")).toHaveLength(1);

    value.sessionsDb.prepare("INSERT INTO sessions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
      "s1", "/tmp/s1.jsonl", "/repo", "repo", "A session", "summary", "text", 0,
      "2025-01-01", "2025-01-01", 1, 1,
    );
    value.knowledgeDb.prepare("INSERT INTO files(path,root,relative_path,size,mtime_ms,chunk_count) VALUES(?,?,?,?,?,?)").run("/notes/a.md", "/notes", "a.md", 10, 1, 1);
    const fileId = Number((value.knowledgeDb.prepare("SELECT id FROM files").get() as any).id);
    value.knowledgeDb.prepare("INSERT INTO chunks VALUES(?,?,?,?,?,?,?)").run("c1", fileId, 0, "Intro", "body", 1, 0);
    expect(value.sessions.list()).toHaveLength(1);
    expect(value.sessions.resolve("s1").status).toBe("found");
    expect(value.knowledge.listFiles()[0]).toMatchObject({ relativePath: "a.md", chunkCount: 1 });
    expect(value.knowledge.getChunk("c1")?.text).toBe("body");
    for (const result of [value.sessions.search("x"), value.knowledge.search("x")]) {
      expect(result).toMatchObject({ status: "unavailable", diagnostic: expect.stringMatching(/FTS5/i) });
      expect(Buffer.byteLength((result as any).diagnostic)).toBeLessThan(256);
    }

    const tools = new Map<string, any>();
    const pi: any = {
      registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: vi.fn(), on: vi.fn(),
      sendMessage: vi.fn(), appendEntry: vi.fn(),
    };
    const runtime = ManagedRuntime.make(Layer.mergeAll(
      Layer.succeed(MemoryStoreService, value.memory), Layer.succeed(SessionIndexService, value.sessions), Layer.succeed(KnowledgeIndexService, value.knowledge),
    ));
    const controller: any = { currentHandle: { run: (effect: any) => runtime.runPromise(effect) }, start: vi.fn(), shutdown: vi.fn() };
    registerContextFeatures(pi, controller);
    expect([...tools.keys()]).toHaveLength(11);
    for (const [name, input] of [["session_search", { query: "x" }], ["knowledge_search", { query: "x" }]] as const) {
      const result = await tools.get(name).execute("", input, undefined, undefined, { cwd: "/repo" });
      expect(result.details).toMatchObject({ ok: false, capability: "fts5" });
      expect(Buffer.byteLength(result.content[0].text)).toBeLessThan(1024);
      expect(result.content[0].text).toMatch(/FTS5|unavailable/i);
    }
    const recalled = await tools.get("recall").execute("", {}, undefined, undefined, { sessionManager: { getBranch: () => [] } });
    expect(recalled.details).toMatchObject({ status: "invalid_id" });
    expect(Buffer.byteLength(recalled.content[0].text)).toBeLessThan(1024);
    await runtime.dispose();
    value.memoryDb.close(); value.sessionsDb.close(); value.knowledgeDb.close();
  });
});
