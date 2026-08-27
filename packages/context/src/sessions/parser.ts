import { createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import {
  SESSION_MAX_BLOCK_CHARS,
  SESSION_MAX_INDEX_CHARS,
  SESSION_MAX_TITLE_CHARS,
  SESSION_PARSE_YIELD_LINES,
  type ParsedSession,
} from "./schema.js";

const bounded = (value: string, limit = SESSION_MAX_BLOCK_CHARS) =>
  Array.from(value).slice(0, limit).join("");

function textualContent(content: unknown): string {
  if (typeof content === "string") return bounded(content);
  if (!Array.isArray(content)) return "";
  return bounded(content.flatMap((block) => {
    if (typeof block !== "object" || block === null) return [];
    const value = block as Record<string, unknown>;
    return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
  }).join("\n"));
}

function validTimestamp(value: unknown, fallback: string): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

export async function readSessionId(sourcePath: string): Promise<string | undefined> {
  const input = createReadStream(sourcePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const raw of lines) {
      try {
        const value = JSON.parse(raw.replace(/^\uFEFF/, "").trim()) as Record<string, unknown>;
        return value.type === "session" && typeof value.id === "string" ? value.id : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Streams a current Pi JSONL session and retains only bounded, user-visible text. */
export async function parseSessionFile(sourcePath: string, archived = false): Promise<ParsedSession | undefined> {
  const input = createReadStream(sourcePath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let header: Record<string, unknown> | undefined;
  let title = "";
  let summary = "";
  let updatedAt = "";
  let lineCount = 0;
  let indexLength = 0;
  const indexBlocks: string[] = [];

  const add = (text: string) => {
    if (indexLength >= SESSION_MAX_INDEX_CHARS) return;
    const block = bounded(text, Math.min(SESSION_MAX_BLOCK_CHARS, SESSION_MAX_INDEX_CHARS - indexLength));
    if (!block.trim()) return;
    indexBlocks.push(block);
    indexLength += block.length + 1;
  };

  try {
    for await (const raw of lines) {
      lineCount++;
      const line = raw.replace(/^\uFEFF/, "").trim();
      if (!line) continue;
      let entry: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed !== "object" || parsed === null) continue;
        entry = parsed as Record<string, unknown>;
      } catch {
        continue; // Includes a partially-written final line.
      }
      if (entry.type === "session" && typeof entry.id === "string") {
        header ??= entry;
      } else if (entry.type === "session_info" && typeof entry.name === "string") {
        title = bounded(entry.name, SESSION_MAX_TITLE_CHARS);
      } else if (entry.type === "message") {
        const message = entry.message;
        if (typeof message === "object" && message !== null) {
          const value = message as Record<string, unknown>;
          if (value.role === "user" || value.role === "assistant") {
            const text = textualContent(value.content);
            if (value.role === "user" && !title && text.trim()) title = bounded(text.trim(), SESSION_MAX_TITLE_CHARS);
            add(text);
          }
        }
      } else if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
        const text = bounded(entry.summary);
        summary = text;
        add(text);
      }
      if (header) updatedAt = validTimestamp(entry.timestamp, updatedAt || String(header.timestamp ?? ""));
      if (lineCount % SESSION_PARSE_YIELD_LINES === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    lines.close();
    input.destroy();
  }

  if (!header || typeof header.id !== "string" || typeof header.cwd !== "string") return undefined;
  const createdAt = validTimestamp(header.timestamp, new Date(0).toISOString());
  const cwd = header.cwd;
  return {
    id: header.id,
    sourcePath: path.resolve(sourcePath),
    cwd,
    project: path.basename(path.resolve(cwd)) || cwd,
    title,
    summary,
    indexText: indexBlocks.join("\n").slice(0, SESSION_MAX_INDEX_CHARS),
    createdAt,
    updatedAt: updatedAt || createdAt,
    archived,
  };
}
