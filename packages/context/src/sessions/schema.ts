export const SESSION_SCHEMA_VERSION = 1;

export const SESSION_MAX_BLOCK_CHARS = 16_000;
export const SESSION_MAX_INDEX_CHARS = 120_000;
export const SESSION_MAX_TITLE_CHARS = 500;
export const SESSION_PARSE_YIELD_LINES = 500;
export const SESSION_READ_MAX_BYTES = 50 * 1024;
export const SESSION_READ_MAX_LINES = 2_000;
export const SESSION_PRIMER_MAX_BYTES = 1_536;
export const SESSION_PRIMER_CUSTOM_TYPE = "context.session-primer";

export interface ParsedSession {
  readonly id: string;
  readonly sourcePath: string;
  readonly cwd: string;
  readonly project: string;
  readonly title: string;
  readonly summary: string;
  readonly indexText: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archived: boolean;
}

export interface DiscoveredSession {
  readonly path: string;
  readonly archived: boolean;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface IndexedSession extends ParsedSession {
  readonly size: number;
  readonly mtimeMs: number;
}

export interface SessionListFilters {
  readonly project?: string;
  readonly after?: string;
  readonly before?: string;
  readonly archived?: boolean;
  readonly limit?: number;
}

export type SessionResolution =
  | { readonly status: "found"; readonly session: IndexedSession }
  | { readonly status: "not_found" }
  | { readonly status: "ambiguous"; readonly matches: readonly IndexedSession[] };

export type SessionSearchResult =
  | { readonly status: "available"; readonly results: readonly (IndexedSession & { readonly rank: number })[] }
  | { readonly status: "unavailable"; readonly diagnostic: string };

export interface SessionReadResult {
  readonly status: "ok" | "not_found" | "ambiguous" | "denied" | "invalid" | "error";
  readonly text: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export interface SessionSyncResult {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly moved: number;
  readonly unchanged: number;
}
