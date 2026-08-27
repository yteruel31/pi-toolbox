import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";

import { DEFAULT_KNOWLEDGE_CONFIG, type KnowledgeConfig } from "../src/config/schema.js";
import { KnowledgeIndex, knowledgeIndexLayer, parseKnowledgeFile } from "../src/knowledge/index.js";
import { KNOWLEDGE_SCHEMA_VERSION, type DiscoveredKnowledgeFile } from "../src/knowledge/schema.js";
import type { SqliteFactory } from "../src/storage/sqlite.js";

async function setup(options: { disableFts?: boolean; parse?: typeof parseKnowledgeFile } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "context-index-"));
  const config: KnowledgeConfig = { ...DEFAULT_KNOWLEDGE_CONFIG, roots: [root], extensions: ["md"] };
  const db = new DatabaseSync(path.join(root, "knowledge.db"), { enableForeignKeyConstraints: true });
  const index = new KnowledgeIndex(db, config, options);
  return { root, config, db, index };
}

async function discovered(file: string, root: string): Promise<DiscoveredKnowledgeFile> {
  const info = await stat(file);
  return { path: file, root, relativePath: path.relative(root, file), size: info.size, mtimeMs: info.mtimeMs };
}

describe("knowledge index", () => {
  it("creates fresh schema metadata and remains usable without FTS", async () => {
    const { db, index } = await setup({ disableFts: true });
    expect((db.prepare("SELECT version FROM schema_version").get() as any).version).toBe(KNOWLEDGE_SCHEMA_VERSION);
    expect(index.search("anything")).toMatchObject({ status: "unavailable" });
    expect(index.listFiles()).toEqual([]);
    db.close();
  });

  it("syncs add, unchanged, update, and delete while parsing changed files only", async () => {
    let parses = 0;
    const { root, db, index } = await setup({ parse: async (file, max) => { parses++; return parseKnowledgeFile(file, max); } });
    const note = path.join(root, "note.md");
    await writeFile(note, "# Alpha\n\nfirst text");
    expect(await index.sync()).toMatchObject({ added: 1 });
    expect(parses).toBe(1);
    expect(await index.sync()).toMatchObject({ unchanged: 1 });
    expect(parses).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await writeFile(note, "# Alpha\n\nupdated searchable text");
    expect(await index.sync()).toMatchObject({ updated: 1 });
    expect(parses).toBe(2);
    await writeFile(path.join(root, "other.md"), "# Other\n\nsecond");
    expect(await index.sync()).toMatchObject({ added: 1 });
    await (await import("node:fs/promises")).unlink(note);
    expect(await index.sync()).toMatchObject({ removed: 1 });
    expect(index.size()).toBe(1);
    db.close();
  });

  it("preserves rows and searchable FTS content when forced rebuild parsing fails", async () => {
    let fail = false;
    const { root, db, index } = await setup({ parse: async (file, max) => { if (fail) throw new Error("parse failed"); return parseKnowledgeFile(file, max); } });
    await writeFile(path.join(root, "note.md"), "# Stable\n\nunique preserved phrase");
    await index.sync();
    const before = index.listFiles();
    const searchBefore = index.search("preserved");
    fail = true;
    await expect(index.rebuild()).rejects.toThrow("parse failed");
    expect(index.listFiles()).toEqual(before);
    if (searchBefore.status === "available") expect(index.search("preserved")).toEqual(searchBefore);
    db.close();
  });

  it("performs safe OR/BM25 search with punctuation, stable ties, and metadata lookup", async () => {
    const { root, db, index } = await setup();
    await writeFile(path.join(root, "a.md"), "# One\n\nalpha common");
    await writeFile(path.join(root, "b.md"), "# Two\n\nbeta common");
    await index.sync();
    if (!index.hasFts5) { expect(index.search("alpha")).toMatchObject({ status: "unavailable" }); db.close(); return; }
    const result = index.search("alpha!!! beta");
    expect(result.status).toBe("available");
    if (result.status === "available") expect(result.results.map((hit) => path.basename(hit.path))).toEqual(["a.md", "b.md"]);
    const files = index.listFiles();
    expect(files[0]!.headings).toContain("One");
    expect(index.getFile(files[0]!.path)?.path).toBe(files[0]!.path);
    const chunk = index.listChunks(files[0]!.id)[0]!;
    expect(index.getChunk(chunk.id)).toEqual(chunk);
    db.close();
  });

  it("opens in package mode and closes its scoped database on runtime disposal", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-layer-"));
    await mkdir(path.join(root, "context"));
    let opened: DatabaseSync | undefined;
    const factory: SqliteFactory = { open: (file) => (opened = new DatabaseSync(file, { enableForeignKeyConstraints: true })) };
    const runtime = ManagedRuntime.make(knowledgeIndexLayer(path.join(root, "context/knowledge.db"), { ...DEFAULT_KNOWLEDGE_CONFIG, roots: [] }, factory));
    await runtime.runPromise(Effect.void);
    expect(opened?.isOpen).toBe(true);
    await runtime.dispose();
    expect(opened?.isOpen).toBe(false);
  });
});
