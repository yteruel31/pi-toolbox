import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { RetrievalError } from "./retrieval-error.js";

export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
export const MAX_RETRIEVAL_CHARS = 30_000;
export function validId(id: string): string {
  if (!/^[a-f0-9]{32,64}$/.test(id)) throw new RetrievalError("invalid-id");
  return id;
}
export function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export async function syncDirectory(path: string): Promise<void> {
  // Windows does not support opening directories for fsync (EPERM). Atomic rename/link
  // still provides publication semantics there; retain directory fsync on Unix.
  if (process.platform === "win32") return;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function safeDirectory(path: string): Promise<void> {
  const absolute = resolve(path); let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { await mkdir(current, { mode: 0o700 }); await syncDirectory(dirname(current)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Directory must not contain symlinks or non-directories");
  }
}
export async function readPrivate(path: string, maxBytes = MAX_DOCUMENT_BYTES): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Stored file is not a bounded regular file");
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, stat.size + 1));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > maxBytes || total !== stat.size) throw new Error("Stored file changed or exceeds its limit");
    return buffer.subarray(0, total).toString("utf8");
  } finally { await handle.close(); }
}
export async function atomicWrite(path: string, value: string, overwrite = false): Promise<void> {
  if (Buffer.byteLength(value) > MAX_DOCUMENT_BYTES) throw new Error("Document exceeds storage limit");
  await safeDirectory(dirname(path));
  await withFileMutationQueue(path, async () => {
    const temp = join(dirname(path), `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(value, "utf8"); await handle.sync(); } finally { await handle.close(); }
      if (overwrite) {
        try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Refusing unsafe overwrite"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        await rename(temp, path);
      } else {
        // Same-filesystem hard-link publication is atomic and never overwrites an existing target.
        await link(temp, path);
      }
      await syncDirectory(dirname(path));
    } finally { await rm(temp, { force: true }); }
  });
}
export async function withLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
  await safeDirectory(directory);
  const path = join(directory, ".lock");
  let file;
  try { file = await open(path, "wx", 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Storage is busy. If no Pi process is using it, remove stale lock: ${path}`); throw error; }
  try { await file.writeFile(String(process.pid)); return await action(); }
  finally { await file.close(); await rm(path, { force: true }); }
}
export interface Document { title: string; content: string; url?: string; query?: string; method?: string }
interface RecordEntry { version: 1; createdAt: number; documents: Document[] }
export interface CacheOptions { directory: string; maxEntries: number; maxBytes: number; ttlMs: number; inlineChars: number }
export class ContentStore {
  constructor(readonly options: CacheOptions, readonly now: () => number = Date.now) {}
  async put(documents: Document[]): Promise<string> {
    if (!documents.length || documents.length > 100) throw new Error("Content must contain 1 to 100 documents");
    const entry: RecordEntry = { version: 1, createdAt: this.now(), documents };
    const text = JSON.stringify(entry);
    if (Buffer.byteLength(text) > Math.min(this.options.maxBytes, MAX_DOCUMENT_BYTES)) throw new Error("Content exceeds cache capacity");
    return withLock(this.options.directory, async () => {
      const files = [];
      for (const name of await readdir(this.options.directory)) {
        if (!/^[a-f0-9]{32}\.json$/.test(name)) continue;
        const path = join(this.options.directory, name); const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (stat.mtimeMs + this.options.ttlMs <= this.now()) { await rm(path); continue; }
        files.push({ path, size: stat.size, modified: stat.mtimeMs });
      }
      files.sort((a, b) => a.modified - b.modified);
      let bytes = files.reduce((sum, file) => sum + file.size, 0) + Buffer.byteLength(text);
      while (files.length >= this.options.maxEntries || bytes > this.options.maxBytes) {
        const oldest = files.shift(); if (!oldest) break;
        await rm(oldest.path); bytes -= oldest.size;
      }
      const id = randomUUID().replaceAll("-", "");
      await atomicWrite(join(this.options.directory, `${id}.json`), text);
      return id;
    });
  }
  async get(id: string): Promise<Document[]> {
    const safeId = validId(id);
    let entry: RecordEntry;
    try { entry = JSON.parse(await readPrivate(join(this.options.directory, `${safeId}.json`))); }
    catch { throw new RetrievalError("cache-unavailable"); }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || entry.version !== 1 || typeof entry.createdAt !== "number" || !Number.isFinite(entry.createdAt) || entry.createdAt < 0) throw new RetrievalError("cache-unavailable");
    if (!Array.isArray(entry.documents) || !entry.documents.length || entry.documents.length > 100 || entry.documents.some((document) => !document || typeof document !== "object" || Array.isArray(document) || typeof document.content !== "string" || typeof document.title !== "string" || (document.url !== undefined && typeof document.url !== "string") || (document.query !== undefined && typeof document.query !== "string"))) throw new RetrievalError("cache-unavailable");
    const now = this.now(), expiresAt = entry.createdAt + this.options.ttlMs;
    if (entry.createdAt > now || !Number.isFinite(expiresAt)) throw new RetrievalError("cache-unavailable");
    if (expiresAt <= now) throw new RetrievalError("cache-expired");
    return entry.documents;
  }
}
export interface Retrieval { index?: number; url?: string; query?: string; offset?: number; limit?: number; findText?: string | string[]; findMode?: "exact" | "case-insensitive" }
export function retrieve(documents: Document[], input: Retrieval, maxChars: number): Record<string, unknown> {
  if ([input.index !== undefined, input.url !== undefined, input.query !== undefined].filter(Boolean).length > 1) throw new RetrievalError("conflicting-selectors");
  let index = input.index ?? 0;
  if (input.url !== undefined) index = documents.findIndex((item) => item.url === input.url);
  if (input.query !== undefined) index = documents.findIndex((item) => item.query === input.query);
  const document = documents[index];
  if (!Number.isSafeInteger(index) || index < 0 || !document) throw new RetrievalError("invalid-selector");
  const metadata = { index, title: document.title.slice(0, 512), url: document.url?.slice(0, 2048), totalChars: document.content.length, documentCount: documents.length, documents: documents.slice(0, 20).map(({ title, url, query }, index) => ({ index, title: title.slice(0, 200), url: url?.slice(0, 512), query: query?.slice(0, 200) })) };
  if (input.findText !== undefined) {
    if (input.offset !== undefined) throw new RetrievalError("find-with-offset");
    const needles = typeof input.findText === "string" ? [input.findText] : input.findText;
    if (!needles.length || needles.length > 10 || needles.some((s) => !s || s.length > 500)) throw new RetrievalError("invalid-find");
    const requested = input.limit ?? maxChars;
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > MAX_RETRIEVAL_CHARS) throw new RetrievalError("invalid-pagination");
    const matches: Array<{ term: string; offset: number; end: number; text: string; truncated?: boolean }> = []; let budget = requested;
    for (const term of needles) {
      // Literal regular expressions retain original UTF-16 offsets even when case folding changes string length.
      const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), input.findMode === "exact" ? "g" : "gi");
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(document.content)) && matches.length < 20 && budget > 0) {
        const matchEnd = match.index + match[0].length;
        let start = Math.max(0, match.index - 150); let end = Math.min(document.content.length, matchEnd + 150);
        if (end - start > budget) {
          // Keep the whole literal hit when it fits; otherwise identify the clipped excerpt.
          start = match[0].length <= budget ? Math.max(0, Math.min(match.index - Math.floor((budget - match[0].length) / 2), document.content.length - budget)) : match.index;
          end = Math.min(document.content.length, start + budget);
        }
        const truncated = start > match.index || end < matchEnd;
        matches.push({ term, offset: start, end, text: document.content.slice(start, end), ...(truncated ? { truncated: true } : {}) }); budget -= end - start;
      }
    }
    return { ...metadata, matches, bounded: matches.length >= 20 || budget <= 0 };
  }
  const offset = input.offset ?? 0; const limit = input.limit ?? maxChars;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > document.content.length || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_RETRIEVAL_CHARS) throw new RetrievalError("invalid-pagination");
  const end = Math.min(document.content.length, offset + limit);
  return { ...metadata, offset, content: document.content.slice(offset, end), nextOffset: end < document.content.length ? end : null };
}
