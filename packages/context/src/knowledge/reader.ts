import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import type { KnowledgeIndex } from "./index.js";
import type { IndexedKnowledgeFile } from "./schema.js";

export const DEFAULT_NOTE_BYTES = 64 * 1024;
export const MAX_NOTE_BYTES = 64 * 1024;
const MAX_CANDIDATES = 20;

export type NoteResolution =
  | { readonly status: "resolved"; readonly file: IndexedKnowledgeFile }
  | { readonly status: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly status: "not-found" };

function normalize(reference: string): string {
  let value = reference.trim();
  if (value.startsWith("[[") && value.endsWith("]]"))
    value = value.slice(2, -2);
  value = value.split("|", 1)[0]!.trim();
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function resolveIndexedNote(
  index: KnowledgeIndex,
  reference: string
): NoteResolution {
  const value = normalize(reference);
  if (!value || path.isAbsolute(value) || value.includes("\0"))
    return { status: "not-found" };
  const parts = value.split("/");
  if (parts.some((part) => part === ".." || part === ""))
    return { status: "not-found" };
  const files = index.listFiles();
  const extensions = index.config.extensions.map(
    (extension) => `.${extension.replace(/^\./, "").toLowerCase()}`
  );
  const withExtensions = (candidate: string) =>
    path.extname(candidate)
      ? [candidate]
      : [
          candidate,
          ...extensions.map((extension) => `${candidate}${extension}`),
        ];
  const targets = new Set(withExtensions(value));
  const relative = files.filter((file) =>
    targets.has(file.relativePath.split(path.sep).join("/"))
  );
  if (relative.length === 1) return { status: "resolved", file: relative[0]! };
  if (relative.length > 1)
    return {
      status: "ambiguous",
      candidates: relative
        .slice(0, MAX_CANDIDATES)
        .map((file) => file.relativePath),
    };
  const basenameTargets = new Set(
    withExtensions(path.basename(value)).map((item) => item.toLowerCase())
  );
  const basename = files.filter((file) =>
    basenameTargets.has(path.basename(file.relativePath).toLowerCase())
  );
  if (basename.length === 1) return { status: "resolved", file: basename[0]! };
  if (basename.length > 1)
    return {
      status: "ambiguous",
      candidates: basename
        .slice(0, MAX_CANDIDATES)
        .map((file) => file.relativePath),
    };
  return { status: "not-found" };
}

export interface ReadIndexedNoteResult {
  readonly path: string;
  readonly content: string;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

export async function readIndexedNote(
  file: IndexedKnowledgeFile,
  maxBytes = DEFAULT_NOTE_BYTES
): Promise<ReadIndexedNoteResult> {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_NOTE_BYTES)
    throw new Error(`max_bytes must be an integer from 1 to ${MAX_NOTE_BYTES}`);
  const canonicalRoot = await realpath(file.root);
  if (canonicalRoot !== file.root || !contained(canonicalRoot, file.path))
    throw new Error("Indexed note is outside its approved root");
  const handle = await open(
    file.path,
    constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Indexed note is not a regular file");
    if (info.size !== file.size || info.mtimeMs !== file.mtimeMs) {
      throw new Error("Indexed note changed since it was indexed");
    }
    // Verify the opened inode still names the indexed canonical path (Linux procfs closes rename/swap races).
    const openedPath = await realpath(`/proc/self/fd/${handle.fd}`);
    if (openedPath !== file.path || !contained(canonicalRoot, openedPath))
      throw new Error("Indexed note changed since it was indexed");
    const buffer = Buffer.alloc(Math.min(info.size, maxBytes + 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const sample = buffer.subarray(0, bytesRead);
    if (sample.includes(0)) throw new Error("Indexed note is binary");
    const truncated = info.size > maxBytes;
    const capped = sample.subarray(0, Math.min(maxBytes, sample.length));
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      capped.subarray(0, utf8Boundary(capped))
    );
    return { path: file.path, content, totalBytes: info.size, truncated };
  } finally {
    await handle.close();
  }
}

function utf8Boundary(buffer: Buffer): number {
  if (buffer.length === 0) return 0;

  // Find the lead byte of the final code point. This also handles a cap that
  // lands immediately after a lead byte (there are then no trailing
  // continuation bytes to walk over).
  let leadIndex = buffer.length - 1;
  while (leadIndex > 0 && (buffer[leadIndex]! & 0xc0) === 0x80) leadIndex--;

  const lead = buffer[leadIndex]!;
  const expected =
    lead <= 0x7f
      ? 1
      : lead >= 0xc2 && lead <= 0xdf
      ? 2
      : lead >= 0xe0 && lead <= 0xef
      ? 3
      : lead >= 0xf0 && lead <= 0xf4
      ? 4
      : 1;
  const available = buffer.length - leadIndex;
  return available < expected ? leadIndex : buffer.length;
}
