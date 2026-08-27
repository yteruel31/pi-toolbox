import { randomUUID } from "node:crypto";
import { Context, Effect, Layer } from "effect";

import { ContextStorageError } from "../runtime/errors.js";
import { MemoryStoreService } from "../runtime/services.js";
import type { SqliteDatabase, SqliteFactory } from "../storage/sqlite.js";
import { sqliteResource } from "../storage/sqlite.js";
import { compileFtsQuery, probeFts5 } from "../storage/fts.js";
import { immediateTransaction } from "../storage/transactions.js";
import {
  MEMORY_MAX_EVENT_CHARS,
  MEMORY_SCHEMA_VERSION,
  type ConsolidationOutput,
  type MemoryFact,
  type MemoryLesson,
  type PendingEvent,
} from "./schema.js";

export interface MemoryStats {
  readonly facts: number;
  readonly lessons: number;
  readonly pendingEvents: number;
  readonly consolidatedEvents: number;
  readonly fts5: boolean;
}
export interface AddLessonInput {
  rule: string;
  category?: string;
  negative?: boolean;
  confidence?: number;
  source?: string;
  project?: string | null;
}
export interface MemoryStoreOptions {
  readonly disableFts?: boolean;
}
const cap = (limit: number, max = 100) =>
  Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : 10;
const mapFact = (r: any): MemoryFact => ({
  key: r.key,
  value: r.value,
  confidence: r.confidence,
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const mapLesson = (r: any): MemoryLesson => ({
  id: r.id,
  rule: r.rule,
  category: r.category,
  negative: !!r.negative,
  confidence: r.confidence,
  source: r.source,
  project: r.project,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
});
const words = (s: string) =>
  new Set(s.toLowerCase().trim().split(/\s+/).filter(Boolean));
export function jaccard(a: string, b: string): number {
  const x = words(a),
    y = words(b),
    union = new Set([...x, ...y]);
  return union.size === 0
    ? 1
    : [...x].filter((v) => y.has(v)).length / union.size;
}

export class MemoryStore {
  readonly schemaVersion = MEMORY_SCHEMA_VERSION;
  readonly hasFts5: boolean;
  constructor(readonly db: SqliteDatabase, options: MemoryStoreOptions = {}) {
    immediateTransaction(db, () => {
      db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS facts (key TEXT PRIMARY KEY, value TEXT NOT NULL, confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1), source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS lessons (id TEXT PRIMARY KEY, rule TEXT NOT NULL, category TEXT NOT NULL, negative INTEGER NOT NULL CHECK(negative IN (0,1)), confidence REAL NOT NULL CHECK(confidence BETWEEN 0 AND 1), source TEXT NOT NULL, project TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT);
CREATE TABLE IF NOT EXISTS consolidation_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, project TEXT NOT NULL, transcript TEXT NOT NULL, user_count INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','consolidated')), created_at TEXT NOT NULL, consolidated_at TEXT);
CREATE TABLE IF NOT EXISTS consolidation_checkpoints (id INTEGER PRIMARY KEY AUTOINCREMENT, event_through INTEGER NOT NULL, facts_applied INTEGER NOT NULL, lessons_applied INTEGER NOT NULL, created_at TEXT NOT NULL);
INSERT INTO schema_version(version) SELECT ${MEMORY_SCHEMA_VERSION} WHERE NOT EXISTS (SELECT 1 FROM schema_version);`);
      const version = db.prepare("SELECT version FROM schema_version").get() as
        | { version: number }
        | undefined;
      if (version?.version !== MEMORY_SCHEMA_VERSION)
        throw new Error(
          `Unsupported memory schema version ${String(version?.version)}`
        );
    });
    const capability = options.disableFts
      ? { available: false as const }
      : probeFts5(db);
    if (capability.available) {
      immediateTransaction(db, () =>
        db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(key, value, content='facts', content_rowid='rowid');
CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(rule, category, content='lessons', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN INSERT INTO facts_fts(rowid,key,value) VALUES(new.rowid,new.key,new.value); END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN INSERT INTO facts_fts(facts_fts,rowid,key,value) VALUES('delete',old.rowid,old.key,old.value); END;
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN INSERT INTO facts_fts(facts_fts,rowid,key,value) VALUES('delete',old.rowid,old.key,old.value); INSERT INTO facts_fts(rowid,key,value) VALUES(new.rowid,new.key,new.value); END;
CREATE TRIGGER IF NOT EXISTS lessons_ai AFTER INSERT ON lessons BEGIN INSERT INTO lessons_fts(rowid,rule,category) VALUES(new.rowid,new.rule,new.category); END;
CREATE TRIGGER IF NOT EXISTS lessons_ad AFTER DELETE ON lessons BEGIN INSERT INTO lessons_fts(lessons_fts,rowid,rule,category) VALUES('delete',old.rowid,old.rule,old.category); END;
CREATE TRIGGER IF NOT EXISTS lessons_au AFTER UPDATE ON lessons BEGIN INSERT INTO lessons_fts(lessons_fts,rowid,rule,category) VALUES('delete',old.rowid,old.rule,old.category); INSERT INTO lessons_fts(rowid,rule,category) VALUES(new.rowid,new.rule,new.category); END;
INSERT INTO facts_fts(facts_fts) VALUES('rebuild');
INSERT INTO lessons_fts(lessons_fts) VALUES('rebuild');`)
      );
    }
    this.hasFts5 = capability.available;
  }
  getFact(key: string) {
    const r = this.db
      .prepare("SELECT * FROM facts WHERE key=?")
      .get(key.trim().toLowerCase());
    return r ? mapFact(r) : undefined;
  }
  setFact(key: string, value: string, confidence = 0.8, source = "model") {
    const k = key.trim().toLowerCase(),
      v = value.trim();
    if (!k || !v || confidence < 0 || confidence > 1)
      throw new Error("Invalid fact");
    return immediateTransaction(this.db, () => {
      const old = this.getFact(k);
      if (old && old.confidence > confidence) return false;
      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO facts(key,value,confidence,source,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,confidence=excluded.confidence,source=excluded.source,updated_at=excluded.updated_at`
        )
        .run(k, v, confidence, source, now, now);
      return true;
    });
  }
  deleteFact(key: string) {
    return immediateTransaction(
      this.db,
      () =>
        this.db
          .prepare("DELETE FROM facts WHERE key=?")
          .run(key.trim().toLowerCase()).changes > 0
    );
  }
  listFacts(limit = 100) {
    return (
      this.db
        .prepare("SELECT * FROM facts ORDER BY key LIMIT ?")
        .all(cap(limit)) as any[]
    ).map(mapFact);
  }
  searchFacts(query: string, limit = 10) {
    const q = compileFtsQuery(query);
    if (!q) return [];
    const terms =
      query
        .normalize("NFKC")
        .match(/[\p{L}\p{N}_]+/gu)
        ?.slice(0, 16) ?? [];
    const n = cap(limit, 50);
    if (this.hasFts5)
      try {
        return (
          this.db
            .prepare(
              `SELECT f.* FROM facts f JOIN facts_fts x ON x.rowid=f.rowid WHERE facts_fts MATCH ? ORDER BY bm25(facts_fts),f.key LIMIT ?`
            )
            .all(q, n) as any[]
        ).map(mapFact);
      } catch {}
    const patterns = terms.map(
      (t) => `%${t.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
    );
    const where = patterns
      .map(() => "lower(key||' '||value) LIKE lower(?) ESCAPE '\\'")
      .join(" OR ");
    return (
      this.db
        .prepare(`SELECT * FROM facts WHERE ${where} ORDER BY key LIMIT ?`)
        .all(...patterns, n) as any[]
    ).map(mapFact);
  }
  addLesson(input: AddLessonInput) {
    const rule = input.rule.trim();
    if (!rule) return { success: false as const, reason: "empty" };
    return immediateTransaction(this.db, () => {
      const existing = (
        this.db
          .prepare(
            "SELECT id,rule,confidence FROM lessons WHERE deleted_at IS NULL"
          )
          .all() as any[]
      ).find(
        (x) =>
          x.rule.trim().toLowerCase() === rule.toLowerCase() ||
          jaccard(x.rule, rule) >= 0.7
      );
      if (existing) {
        if ((input.confidence ?? 0.8) > existing.confidence)
          this.db
            .prepare("UPDATE lessons SET confidence=?,updated_at=? WHERE id=?")
            .run(
              input.confidence ?? 0.8,
              new Date().toISOString(),
              existing.id
            );
        return {
          success: false as const,
          reason: "duplicate",
          id: existing.id,
        };
      }
      const id = randomUUID(),
        now = new Date().toISOString(),
        source = input.source ?? "model";
      this.db
        .prepare("INSERT INTO lessons VALUES(?,?,?,?,?,?,?,?,?,NULL)")
        .run(
          id,
          rule,
          (input.category ?? "general").trim().toLowerCase() || "general",
          input.negative ? 1 : 0,
          input.confidence ?? 0.8,
          source,
          source === "user" ? null : input.project ?? null,
          now,
          now
        );
      return { success: true as const, id };
    });
  }
  deleteLesson(id: string) {
    return immediateTransaction(this.db, () => {
      const matches = this.db
        .prepare(
          "SELECT id FROM lessons WHERE deleted_at IS NULL AND id LIKE ?"
        )
        .all(`${id}%`) as any[];
      if (matches.length !== 1) return false;
      return (
        this.db
          .prepare("UPDATE lessons SET deleted_at=?,updated_at=? WHERE id=?")
          .run(
            new Date().toISOString(),
            new Date().toISOString(),
            matches[0].id
          ).changes > 0
      );
    });
  }
  listLessons(category?: string, limit = 50, project?: string) {
    let sql = "SELECT * FROM lessons WHERE deleted_at IS NULL",
      args: any[] = [];
    if (category) {
      sql += " AND category=?";
      args.push(category.trim().toLowerCase());
    }
    if (project) {
      sql += " AND (project IS NULL OR project=?)";
      args.push(project);
    }
    // Semantic order is global first, then project-local; timestamps and UUIDs only break ties.
    sql +=
      " ORDER BY CASE WHEN project IS NULL THEN 0 ELSE 1 END, created_at, id LIMIT ?";
    args.push(cap(limit));
    return (this.db.prepare(sql).all(...args) as any[]).map(mapLesson);
  }
  searchLessons(query: string, limit = 20, project?: string) {
    const q = compileFtsQuery(query);
    if (!q) return [];
    const terms =
      query
        .normalize("NFKC")
        .match(/[\p{L}\p{N}_]+/gu)
        ?.slice(0, 16) ?? [];
    const n = cap(limit, 50),
      scope = project ? " AND (l.project IS NULL OR l.project=?)" : "",
      args: any[] = project ? [project] : [];
    if (this.hasFts5)
      try {
        return (
          this.db
            .prepare(
              `SELECT l.* FROM lessons l JOIN lessons_fts x ON x.rowid=l.rowid WHERE lessons_fts MATCH ? AND l.deleted_at IS NULL${scope} ORDER BY CASE WHEN l.project IS NULL THEN 0 ELSE 1 END, bm25(lessons_fts), l.created_at, l.id LIMIT ?`
            )
            .all(q, ...args, n) as any[]
        ).map(mapLesson);
      } catch {}
    const patterns = terms.map(
        (t) => `%${t.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
      ),
      where = patterns
        .map(() => "lower(l.rule||' '||l.category) LIKE lower(?) ESCAPE '\\'")
        .join(" OR ");
    return (
      this.db
        .prepare(
          `SELECT l.* FROM lessons l WHERE l.deleted_at IS NULL AND (${where})${scope} ORDER BY CASE WHEN l.project IS NULL THEN 0 ELSE 1 END, l.created_at, l.id LIMIT ?`
        )
        .all(...patterns, ...args, n) as any[]
    ).map(mapLesson);
  }
  addPendingEvent(
    sessionId: string,
    project: string,
    transcript: string,
    userCount: number
  ) {
    const text = transcript.slice(0, MEMORY_MAX_EVENT_CHARS);
    if (!text.trim() || userCount < 1) return undefined;
    return immediateTransaction(this.db, () =>
      Number(
        this.db
          .prepare(
            "INSERT INTO consolidation_events(session_id,project,transcript,user_count,status,created_at) VALUES(?,?,?,?,'pending',?)"
          )
          .run(sessionId, project, text, userCount, new Date().toISOString())
          .lastInsertRowid
      )
    );
  }
  pendingEvents(limit = 50): PendingEvent[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM consolidation_events WHERE status='pending' ORDER BY id LIMIT ?"
        )
        .all(cap(limit)) as any[]
    ).map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      project: r.project,
      transcript: r.transcript,
      userCount: r.user_count,
      status: r.status,
      createdAt: r.created_at,
      consolidatedAt: r.consolidated_at,
    }));
  }
  applyConsolidation(
    events: readonly PendingEvent[],
    out: ConsolidationOutput,
    project: string
  ) {
    return immediateTransaction(this.db, () => {
      let facts = 0,
        lessons = 0;
      const now = new Date().toISOString();
      for (const f of out.facts) {
        const key = f.key.trim().toLowerCase(),
          old = this.db
            .prepare("SELECT confidence FROM facts WHERE key=?")
            .get(key) as any;
        if (old && old.confidence > f.confidence) continue;
        this.db
          .prepare(
            `INSERT INTO facts(key,value,confidence,source,created_at,updated_at) VALUES(?,?,?,'model',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,confidence=excluded.confidence,source='model',updated_at=excluded.updated_at`
          )
          .run(key, f.value.trim(), f.confidence, now, now);
        facts++;
      }
      for (const l of out.lessons) {
        const duplicate = (
          this.db
            .prepare("SELECT id,rule FROM lessons WHERE deleted_at IS NULL")
            .all() as any[]
        ).some(
          (x) =>
            x.rule.trim().toLowerCase() === l.rule.trim().toLowerCase() ||
            jaccard(x.rule, l.rule) >= 0.7
        );
        if (duplicate) continue;
        this.db
          .prepare("INSERT INTO lessons VALUES(?,?,?,?,?,'model',?,?,?,NULL)")
          .run(
            randomUUID(),
            l.rule.trim(),
            l.category.trim().toLowerCase() || "general",
            l.negative ? 1 : 0,
            l.confidence,
            project,
            now,
            now
          );
        lessons++;
      }
      if (events.length) {
        const ids = events.map((x) => x.id);
        const marks = ids.map(() => "?").join(",");
        this.db
          .prepare(
            `UPDATE consolidation_events SET status='consolidated',consolidated_at=? WHERE status='pending' AND id IN (${marks})`
          )
          .run(now, ...ids);
        this.db
          .prepare(
            "INSERT INTO consolidation_checkpoints(event_through,facts_applied,lessons_applied,created_at) VALUES(?,?,?,?)"
          )
          .run(Math.max(...ids), facts, lessons, now);
      }
      return { facts, lessons, events: events.length };
    });
  }
  stats(): MemoryStats {
    const one = (q: string) => (this.db.prepare(q).get() as any).n as number;
    return {
      facts: one("SELECT count(*) n FROM facts"),
      lessons: one("SELECT count(*) n FROM lessons WHERE deleted_at IS NULL"),
      pendingEvents: one(
        "SELECT count(*) n FROM consolidation_events WHERE status='pending'"
      ),
      consolidatedEvents: one(
        "SELECT count(*) n FROM consolidation_events WHERE status='consolidated'"
      ),
      fts5: this.hasFts5,
    };
  }
  // Practical aliases retained by the public memory contract.
  getSemantic = this.getFact.bind(this);
  setSemantic = this.setFact.bind(this);
  deleteSemantic = this.deleteFact.bind(this);
  listSemantic = (_prefix?: string, limit = 100) => this.listFacts(limit);
  searchSemantic = this.searchFacts.bind(this);
}

export const memoryStoreLayer = (
  path: string,
  factory?: SqliteFactory,
  options?: MemoryStoreOptions
) =>
  // beta.107 has no Layer.scoped; effectContext preserves the Scope carried by sqliteResource.
  Layer.effectContext(
    sqliteResource(path, factory).pipe(
      Effect.map((db) =>
        Context.make(MemoryStoreService, new MemoryStore(db, options))
      ),
      Effect.mapError((cause) =>
        cause instanceof ContextStorageError
          ? cause
          : new ContextStorageError({
              path,
              operation: "initialize",
              message: "Cannot initialize memory database",
              cause,
            })
      )
    )
  );
