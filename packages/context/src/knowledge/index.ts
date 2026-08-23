import { createReadStream } from "node:fs";
import { Context, Effect, Layer } from "effect";

import type { KnowledgeConfig } from "../config/schema.js";
import { ContextStorageError } from "../runtime/errors.js";
import { KnowledgeIndexService } from "../runtime/services.js";
import { compileFtsQuery, probeFts5, type Fts5Capability } from "../storage/fts.js";
import type { SqliteDatabase, SqliteFactory } from "../storage/sqlite.js";
import { sqliteResource } from "../storage/sqlite.js";
import { immediateTransaction } from "../storage/transactions.js";
import { chunkKnowledge } from "./chunker.js";
import { discoverKnowledge } from "./discovery.js";
import { KNOWLEDGE_SCHEMA_VERSION, type DiscoveredKnowledgeFile, type IndexedKnowledgeChunk, type IndexedKnowledgeFile, type KnowledgeChunk, type KnowledgeDiscoveryResult, type KnowledgeSearchResult, type KnowledgeSyncResult } from "./schema.js";

export interface KnowledgeIndexOptions {
  readonly disableFts?: boolean;
  readonly discover?: (config: KnowledgeConfig) => Promise<KnowledgeDiscoveryResult>;
  readonly parse?: (file: DiscoveredKnowledgeFile, maximumBytes: number) => Promise<readonly KnowledgeChunk[]>;
}

async function readUtf8(file: string, maximumBytes: number): Promise<string> {
  const buffers: Buffer[] = [];
  let bytes = 0;
  for await (const part of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    const buffer = Buffer.from(part as Buffer);
    bytes += buffer.length;
    if (bytes > maximumBytes) throw new Error(`File exceeds byte limit: ${file}`);
    buffers.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(buffers));
}

export async function parseKnowledgeFile(file: DiscoveredKnowledgeFile, maximumBytes: number): Promise<readonly KnowledgeChunk[]> {
  return chunkKnowledge(await readUtf8(file.path, maximumBytes), file.path);
}

const fileColumns = "id,path,root,relative_path,size,mtime_ms,chunk_count";
function mapFile(row: any, headings: readonly string[] = []): IndexedKnowledgeFile {
  return { id: Number(row.id), path: String(row.path), root: String(row.root), relativePath: String(row.relative_path), size: Number(row.size), mtimeMs: Number(row.mtime_ms), chunkCount: Number(row.chunk_count), headings };
}
function mapChunk(row: any): IndexedKnowledgeChunk {
  return { id: String(row.id), fileId: Number(row.file_id), path: String(row.path), ordinal: Number(row.ordinal), heading: String(row.heading), text: String(row.text), startLine: Number(row.start_line), charOffset: Number(row.char_offset) };
}

export class KnowledgeIndex {
  readonly ftsCapability: Fts5Capability;
  readonly hasFts5: boolean;
  private operation = Promise.resolve();
  private readonly discoverFn;
  private readonly parseFn;

  constructor(readonly db: SqliteDatabase, readonly config: KnowledgeConfig, options: KnowledgeIndexOptions = {}) {
    this.discoverFn = options.discover ?? discoverKnowledge;
    this.parseFn = options.parse ?? parseKnowledgeFile;
    this.initializeMetadata();
    this.ftsCapability = options.disableFts ? { available: false, diagnostic: "SQLite FTS5 was disabled" } : probeFts5(db);
    this.hasFts5 = this.ftsCapability.available;
    if (this.hasFts5) this.initializeFts();
  }

  private initializeMetadata(): void {
    immediateTransaction(this.db, () => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, root TEXT NOT NULL, relative_path TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL, chunk_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chunks (id TEXT PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, ordinal INTEGER NOT NULL, heading TEXT NOT NULL, text TEXT NOT NULL, start_line INTEGER NOT NULL, char_offset INTEGER NOT NULL, UNIQUE(file_id,ordinal));
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id,ordinal);`);
      const version = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
      if (version && version.version !== KNOWLEDGE_SCHEMA_VERSION) throw new Error(`Unsupported knowledge schema version ${version.version}`);
      this.db.prepare("INSERT INTO schema_version(version) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM schema_version)").run(KNOWLEDGE_SCHEMA_VERSION);
    });
  }

  private initializeFts(): void {
    immediateTransaction(this.db, () => this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(heading,text,content='chunks',content_rowid='rowid',tokenize='unicode61');
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid,heading,text) VALUES(new.rowid,new.heading,new.text); END;
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,heading,text) VALUES('delete',old.rowid,old.heading,old.text); END;
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_au AFTER UPDATE OF heading,text ON chunks BEGIN INSERT INTO chunks_fts(chunks_fts,rowid,heading,text) VALUES('delete',old.rowid,old.heading,old.text); INSERT INTO chunks_fts(rowid,heading,text) VALUES(new.rowid,new.heading,new.text); END;
INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');`));
  }

  private write<A>(work: () => Promise<A>): Promise<A> {
    const result = this.operation.then(work, work);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  sync(): Promise<KnowledgeSyncResult> { return this.runSync(false); }
  rebuild(): Promise<KnowledgeSyncResult> { return this.runSync(true); }

  private runSync(force: boolean): Promise<KnowledgeSyncResult> {
    return this.write(async () => {
      const discovery = await this.discoverFn(this.config);
      const current = (this.db.prepare(`SELECT ${fileColumns} FROM files`).all() as any[]).map((row) => mapFile(row));
      const byPath = new Map(current.map((file) => [file.path, file]));
      const parsed = new Map<string, readonly KnowledgeChunk[]>();
      let unchanged = 0;
      for (const file of discovery.files) {
        const old = byPath.get(file.path);
        if (!force && old?.size === file.size && old.mtimeMs === file.mtimeMs) { unchanged++; continue; }
        parsed.set(file.path, await this.parseFn(file, this.config.limits.maxFileBytes));
      }
      let added = 0, updated = 0, removed = 0;
      immediateTransaction(this.db, () => {
        const paths = new Set(discovery.files.map((file) => file.path));
        for (const old of current) if (!paths.has(old.path)) { this.db.prepare("DELETE FROM files WHERE path=?").run(old.path); removed++; }
        for (const file of discovery.files) {
          const chunks = parsed.get(file.path);
          if (!chunks) continue;
          const old = byPath.get(file.path);
          this.db.prepare("INSERT INTO files(path,root,relative_path,size,mtime_ms,chunk_count) VALUES(?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET root=excluded.root,relative_path=excluded.relative_path,size=excluded.size,mtime_ms=excluded.mtime_ms,chunk_count=excluded.chunk_count").run(file.path, file.root, file.relativePath, file.size, file.mtimeMs, chunks.length);
          const id = Number((this.db.prepare("SELECT id FROM files WHERE path=?").get(file.path) as any).id);
          this.db.prepare("DELETE FROM chunks WHERE file_id=?").run(id);
          const insert = this.db.prepare("INSERT INTO chunks(id,file_id,ordinal,heading,text,start_line,char_offset) VALUES(?,?,?,?,?,?,?)");
          for (const chunk of chunks) insert.run(chunk.id, id, chunk.ordinal, chunk.heading, chunk.text, chunk.startLine, chunk.charOffset);
          if (old) updated++; else added++;
        }
      });
      return { added, updated, removed, unchanged, skipped: discovery.skipped };
    });
  }

  size(): number { return Number((this.db.prepare("SELECT count(*) n FROM files").get() as any).n); }
  chunkCount(): number { return Number((this.db.prepare("SELECT count(*) n FROM chunks").get() as any).n); }
  listFiles(): IndexedKnowledgeFile[] {
    const rows = this.db.prepare(`SELECT ${fileColumns} FROM files ORDER BY path`).all() as any[];
    const headingQuery = this.db.prepare("SELECT DISTINCT heading FROM chunks WHERE file_id=? AND heading<>'intro' ORDER BY ordinal");
    return rows.map((row) => mapFile(row, (headingQuery.all(row.id) as any[]).map((item) => String(item.heading))));
  }
  getFile(value: string): IndexedKnowledgeFile | undefined {
    const row = this.db.prepare(`SELECT ${fileColumns} FROM files WHERE path=? OR relative_path=? ORDER BY path LIMIT 1`).get(value, value) as any;
    return row ? mapFile(row) : undefined;
  }
  getChunk(id: string): IndexedKnowledgeChunk | undefined {
    const row = this.db.prepare("SELECT c.*,f.path FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.id=?").get(id) as any;
    return row ? mapChunk(row) : undefined;
  }
  listChunks(fileId: number): IndexedKnowledgeChunk[] {
    return (this.db.prepare("SELECT c.*,f.path FROM chunks c JOIN files f ON f.id=c.file_id WHERE c.file_id=? ORDER BY c.ordinal").all(fileId) as any[]).map(mapChunk);
  }
  search(query: string, limit = 10): KnowledgeSearchResult {
    if (!this.ftsCapability.available) return { status: "unavailable", diagnostic: this.ftsCapability.diagnostic };
    const compiled = compileFtsQuery(query);
    if (!compiled) return { status: "available", results: [] };
    const rows = this.db.prepare("SELECT c.*,f.path,bm25(chunks_fts) rank FROM chunks_fts JOIN chunks c ON c.rowid=chunks_fts.rowid JOIN files f ON f.id=c.file_id WHERE chunks_fts MATCH ? ORDER BY rank ASC,f.path ASC,c.ordinal ASC,c.id ASC LIMIT ?").all(compiled, Math.min(Math.max(limit, 1), 100)) as any[];
    return { status: "available", results: rows.map((row) => ({ ...mapChunk(row), rank: Number(row.rank) })) };
  }
}

export const knowledgeIndexLayer = (path: string, config: KnowledgeConfig, factory?: SqliteFactory, options?: KnowledgeIndexOptions) =>
  Layer.effectContext(sqliteResource(path, factory).pipe(
    Effect.map((db) => Context.make(KnowledgeIndexService, new KnowledgeIndex(db, config, options))),
    Effect.mapError((cause) => cause instanceof ContextStorageError ? cause : new ContextStorageError({ path, operation: "initialize", message: "Cannot initialize knowledge index database", cause })),
  ));
