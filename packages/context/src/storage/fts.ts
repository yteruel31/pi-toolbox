import type { DatabaseSync } from "node:sqlite";

const PROBE_TABLE = "context_fts5_capability_probe";
const CREATE_PROBE = `CREATE VIRTUAL TABLE temp.${PROBE_TABLE} USING fts5(value)`;
const DROP_PROBE = `DROP TABLE IF EXISTS temp.${PROBE_TABLE}`;

export type Fts5Capability =
  | { readonly available: true }
  | { readonly available: false; readonly diagnostic: string; readonly cause?: unknown };

export interface FtsProbeDatabase {
  exec(sql: string): void;
}

export function probeFts5(db: FtsProbeDatabase): Fts5Capability {
  try {
    db.exec(CREATE_PROBE);
    return { available: true };
  } catch (cause) {
    return { available: false, diagnostic: `SQLite FTS5 is unavailable: ${cause instanceof Error ? cause.message : String(cause)}`, cause };
  } finally {
    try { db.exec(DROP_PROBE); } catch { /* capability result retains the primary diagnostic */ }
  }
}

export const FTS_MAX_TERMS = 16;
export const FTS_MAX_TERM_LENGTH = 64;

/** Produces only quoted literals; no caller-provided FTS syntax survives. */
export function compileFtsQuery(input: string): string | undefined {
  const terms = input.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu)?.slice(0, FTS_MAX_TERMS) ?? [];
  const bounded = terms.map((term) => Array.from(term).slice(0, FTS_MAX_TERM_LENGTH).join("")).filter(Boolean);
  return bounded.length === 0 ? undefined : bounded.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

/** Bind the compiled query as `?`; fixed identifiers keep BM25 and ties deterministic. */
export const FTS_RANKED_SELECT = "SELECT rowid, bm25(documents_fts) AS rank FROM documents_fts WHERE documents_fts MATCH ? ORDER BY rank ASC, rowid ASC";

export function prepareRankedFtsQuery(db: Pick<DatabaseSync, "prepare">) {
  return db.prepare(FTS_RANKED_SELECT);
}
