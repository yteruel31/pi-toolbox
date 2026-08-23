import { Context, Effect, Layer } from "effect";

import { ContextStorageError } from "../runtime/errors.js";
import { SessionIndexService } from "../runtime/services.js";
import { compileFtsQuery, probeFts5, type Fts5Capability } from "../storage/fts.js";
import type { SqliteDatabase, SqliteFactory } from "../storage/sqlite.js";
import { sqliteResource } from "../storage/sqlite.js";
import { immediateTransaction } from "../storage/transactions.js";
import { discoverSessionFiles } from "./discovery.js";
import { parseSessionFile, readSessionId } from "./parser.js";
import {
  SESSION_SCHEMA_VERSION,
  type DiscoveredSession,
  type IndexedSession,
  type ParsedSession,
  type SessionListFilters,
  type SessionResolution,
  type SessionSearchResult,
  type SessionSyncResult,
} from "./schema.js";

export interface SessionIndexOptions {
  readonly disableFts?: boolean;
  readonly discover?: (agentDir: string) => Promise<DiscoveredSession[]>;
  readonly parse?: (file: string, archived: boolean) => Promise<ParsedSession | undefined>;
  readonly identify?: (file: string) => Promise<string | undefined>;
}

const columns = `id,source_path,cwd,project,title,summary,index_text,archived,created_at,updated_at,size,mtime_ms`;

function mapSession(row: any): IndexedSession {
  return {
    id: String(row.id), sourcePath: String(row.source_path), cwd: String(row.cwd), project: String(row.project),
    title: String(row.title), summary: String(row.summary), indexText: String(row.index_text), archived: Boolean(row.archived),
    createdAt: String(row.created_at), updatedAt: String(row.updated_at), size: Number(row.size), mtimeMs: Number(row.mtime_ms),
  };
}

export class SessionIndex {
  readonly ftsCapability: Fts5Capability;
  readonly hasFts5: boolean;
  private operation = Promise.resolve();
  private readonly discoverFn;
  private readonly parseFn;
  private readonly identifyFn;

  constructor(readonly db: SqliteDatabase, options: SessionIndexOptions = {}) {
    this.discoverFn = options.discover ?? discoverSessionFiles;
    this.parseFn = options.parse ?? parseSessionFile;
    this.identifyFn = options.identify ?? readSessionId;
    this.initializeMetadata();
    this.ftsCapability = options.disableFts
      ? { available: false, diagnostic: "SQLite FTS5 was disabled" }
      : probeFts5(db);
    this.hasFts5 = this.ftsCapability.available;
    if (this.hasFts5) this.initializeFts();
  }

  private initializeMetadata(): void {
    immediateTransaction(this.db, () => {
      this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
      const version = this.db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
      if (version && version.version !== SESSION_SCHEMA_VERSION) {
        this.db.exec("DROP TABLE IF EXISTS sessions_fts; DROP TABLE IF EXISTS sessions; DELETE FROM schema_version");
      }
      this.db.exec(`CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, source_path TEXT NOT NULL UNIQUE, cwd TEXT NOT NULL, project TEXT NOT NULL,
        title TEXT NOT NULL, summary TEXT NOT NULL, index_text TEXT NOT NULL, archived INTEGER NOT NULL CHECK(archived IN (0,1)),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, size INTEGER NOT NULL, mtime_ms REAL NOT NULL
      ); CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project); CREATE INDEX IF NOT EXISTS sessions_created ON sessions(created_at);`);
      this.db.prepare("INSERT INTO schema_version(version) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM schema_version)").run(SESSION_SCHEMA_VERSION);
    });
  }

  private initializeFts(): void {
    immediateTransaction(this.db, () => {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(title,summary,index_text,content='sessions',content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS sessions_ai AFTER INSERT ON sessions BEGIN INSERT INTO sessions_fts(rowid,title,summary,index_text) VALUES(new.rowid,new.title,new.summary,new.index_text); END;
CREATE TRIGGER IF NOT EXISTS sessions_ad AFTER DELETE ON sessions BEGIN INSERT INTO sessions_fts(sessions_fts,rowid,title,summary,index_text) VALUES('delete',old.rowid,old.title,old.summary,old.index_text); END;
CREATE TRIGGER IF NOT EXISTS sessions_au AFTER UPDATE OF title,summary,index_text ON sessions BEGIN INSERT INTO sessions_fts(sessions_fts,rowid,title,summary,index_text) VALUES('delete',old.rowid,old.title,old.summary,old.index_text); INSERT INTO sessions_fts(rowid,title,summary,index_text) VALUES(new.rowid,new.title,new.summary,new.index_text); END;
INSERT INTO sessions_fts(sessions_fts) VALUES('rebuild');`);
    });
  }

  private write<A>(work: () => Promise<A>): Promise<A> {
    const result = this.operation.then(work, work);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async sync(agentDir: string): Promise<SessionSyncResult> {
    return this.write(async () => this.syncUnlocked(agentDir));
  }

  private async syncUnlocked(agentDir: string): Promise<SessionSyncResult> {
    const discovered = await this.discoverFn(agentDir);
    const current = (this.db.prepare(`SELECT ${columns} FROM sessions`).all() as any[]).map(mapSession);
    const byPath = new Map(current.map((session) => [session.sourcePath, session]));
    const candidates = new Map<string, DiscoveredSession>();
    for (const file of discovered) {
      const known = byPath.get(file.path);
      const id = known?.id ?? await this.identifyFn(file.path);
      if (!id) continue;
      const previous = candidates.get(id);
      if (!previous || file.mtimeMs > previous.mtimeMs || (file.mtimeMs === previous.mtimeMs && file.path < previous.path)) candidates.set(id, file);
    }

    const byId = new Map(current.map((session) => [session.id, session]));
    const parsed = new Map<string, ParsedSession>();
    let unchanged = 0;
    for (const [id, file] of candidates) {
      const old = byId.get(id);
      const sameFingerprint = old?.size === file.size && old.mtimeMs === file.mtimeMs;
      if (sameFingerprint) { unchanged++; continue; }
      const value = await this.parseFn(file.path, file.archived);
      if (value && value.id === id) parsed.set(id, value);
    }

    let added = 0, updated = 0, removed = 0, moved = 0;
    immediateTransaction(this.db, () => {
      for (const session of current) {
        if (!candidates.has(session.id)) {
          this.db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
          removed++;
        }
      }
      for (const [id, file] of candidates) {
        const old = byId.get(id);
        const value = parsed.get(id);
        if (value) {
          this.db.prepare(`INSERT INTO sessions(${columns}) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_path=excluded.source_path,cwd=excluded.cwd,project=excluded.project,title=excluded.title,summary=excluded.summary,index_text=excluded.index_text,archived=excluded.archived,created_at=excluded.created_at,updated_at=excluded.updated_at,size=excluded.size,mtime_ms=excluded.mtime_ms`)
            .run(value.id, file.path, value.cwd, value.project, value.title, value.summary, value.indexText, file.archived ? 1 : 0, value.createdAt, value.updatedAt, file.size, file.mtimeMs);
          if (old) updated++; else added++;
        } else if (old && (old.sourcePath !== file.path || old.archived !== file.archived)) {
          this.db.prepare("UPDATE sessions SET source_path=?,archived=?,size=?,mtime_ms=? WHERE id=?").run(file.path, file.archived ? 1 : 0, file.size, file.mtimeMs, id);
          moved++;
        }
      }
    });
    return { added, updated, removed, moved, unchanged };
  }

  async rebuild(agentDir: string): Promise<SessionSyncResult> {
    return this.write(async () => {
      immediateTransaction(this.db, () => this.db.exec("DELETE FROM sessions"));
      return this.syncUnlocked(agentDir);
    });
  }

  list(filters: SessionListFilters = {}): IndexedSession[] {
    const clauses: string[] = [], args: any[] = [];
    if (filters.project) { clauses.push("lower(project) LIKE lower(?)"); args.push(`%${filters.project}%`); }
    if (filters.after) { clauses.push("created_at>=?"); args.push(filters.after); }
    if (filters.before) { clauses.push("created_at<=?"); args.push(filters.before); }
    if (filters.archived !== undefined) { clauses.push("archived=?"); args.push(filters.archived ? 1 : 0); }
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 1000);
    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    return (this.db.prepare(`SELECT ${columns} FROM sessions${where} ORDER BY created_at DESC,id ASC LIMIT ?`).all(...args, limit) as any[]).map(mapSession);
  }

  resolve(value: string): SessionResolution {
    const exact = this.db.prepare(`SELECT ${columns} FROM sessions WHERE id=? OR source_path=? ORDER BY id`).all(value, value) as any[];
    if (exact.length) return { status: "found", session: mapSession(exact[0]) };
    const matches = (this.db.prepare(`SELECT ${columns} FROM sessions WHERE id LIKE ? ORDER BY id`).all(`${value}%`) as any[]).map(mapSession);
    if (matches.length === 0) return { status: "not_found" };
    return matches.length === 1 ? { status: "found", session: matches[0]! } : { status: "ambiguous", matches };
  }

  search(query: string, limit = 10): SessionSearchResult {
    if (!this.ftsCapability.available) return { status: "unavailable", diagnostic: this.ftsCapability.diagnostic };
    const compiled = compileFtsQuery(query);
    if (!compiled) return { status: "available", results: [] };
    const rows = this.db.prepare(`SELECT ${columns.split(",").map((name) => `s.${name}`).join(",")},bm25(sessions_fts) rank FROM sessions_fts JOIN sessions s ON s.rowid=sessions_fts.rowid WHERE sessions_fts MATCH ? ORDER BY rank ASC,s.updated_at DESC,s.id ASC LIMIT ?`).all(compiled, Math.min(Math.max(limit, 1), 100)) as any[];
    return { status: "available", results: rows.map((row) => ({ ...mapSession(row), rank: Number(row.rank) })) };
  }
}

export const sessionIndexLayer = (path: string, factory?: SqliteFactory, options?: SessionIndexOptions) =>
  // beta.107 has no Layer.scoped; effectContext preserves the Scope carried by sqliteResource.
  Layer.effectContext(sqliteResource(path, factory).pipe(
    Effect.map((db) => Context.make(SessionIndexService, new SessionIndex(db, options))),
    Effect.mapError((cause) => cause instanceof ContextStorageError ? cause : new ContextStorageError({ path, operation: "initialize", message: "Cannot initialize session index database", cause })),
  ));
