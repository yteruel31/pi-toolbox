export const KNOWLEDGE_SCHEMA_VERSION = 1;

export interface DiscoveredKnowledgeFile {
  readonly path: string;
  readonly root: string;
  readonly relativePath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export type DiscoverySkipReason =
  | "root_missing" | "root_not_directory" | "root_symlink" | "root_ownership"
  | "hidden" | "excluded" | "symlink" | "non_regular" | "extension"
  | "depth_limit" | "file_limit" | "file_size_limit" | "total_size_limit" | "binary" | "unreadable";

export interface DiscoveryDiagnostic {
  readonly path: string;
  readonly reason: DiscoverySkipReason;
}

export interface KnowledgeDiscoveryResult {
  readonly files: readonly DiscoveredKnowledgeFile[];
  readonly skipped: readonly DiscoveryDiagnostic[];
  readonly roots: readonly string[];
  readonly totalBytes: number;
}

export interface KnowledgeChunk {
  readonly id: string;
  readonly ordinal: number;
  readonly heading: string;
  readonly text: string;
  readonly startLine: number;
  readonly charOffset: number;
}

export interface IndexedKnowledgeFile extends DiscoveredKnowledgeFile {
  readonly id: number;
  readonly chunkCount: number;
  readonly headings: readonly string[];
}

export interface IndexedKnowledgeChunk extends KnowledgeChunk {
  readonly fileId: number;
  readonly path: string;
}

export interface KnowledgeSearchHit extends IndexedKnowledgeChunk {
  readonly rank: number;
}

export type KnowledgeSearchResult =
  | { readonly status: "available"; readonly results: readonly KnowledgeSearchHit[] }
  | { readonly status: "unavailable"; readonly diagnostic: string };

export interface KnowledgeSyncResult {
  readonly added: number;
  readonly updated: number;
  readonly removed: number;
  readonly unchanged: number;
  readonly skipped: readonly DiscoveryDiagnostic[];
}
