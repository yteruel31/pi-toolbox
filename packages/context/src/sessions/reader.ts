import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { finished } from "node:stream/promises";

import type { SessionIndex } from "./index.js";
import {
  SESSION_READ_MAX_BYTES,
  SESSION_READ_MAX_LINES,
  type SessionReadResult,
} from "./schema.js";

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const within = (file: string, root: string) =>
  file === root || file.startsWith(`${root}${path.sep}`);

function safeText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item: any) => item?.type === "text" && typeof item.text === "string")
    .map((item: any) => item.text)
    .join("\n");
}

async function openedPath(handle: FileHandle, fallback: string): Promise<string> {
  if (process.platform === "linux") {
    return realpath(`/proc/self/fd/${handle.fd}`);
  }
  return realpath(fallback);
}

async function safeFile(index: SessionIndex, value: string) {
  let candidate: string;
  const explicit =
    value.includes("/") ||
    value.includes("\\") ||
    value.endsWith(".jsonl") ||
    value.startsWith("~");
  if (!explicit) {
    const resolved = index.resolve(value);
    if (resolved.status !== "found") return resolved;
    candidate = resolved.session.sourcePath;
  } else {
    const expanded = value.startsWith("~")
      ? path.join(homedir(), value.slice(1))
      : value;
    candidate = path.resolve(expanded);
  }

  let handle: FileHandle | undefined;
  try {
    const roots = await Promise.all([
      realpath(path.join(index.agentDir, "sessions")).catch(() => ""),
      realpath(path.join(index.agentDir, "sessions-archive")).catch(() => ""),
    ]);
    handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile()) {
      await handle.close();
      return { status: "denied" as const };
    }
    const canonical = await openedPath(handle, candidate);
    if (!roots.some((root) => root && within(canonical, root))) {
      await handle.close();
      return { status: "denied" as const };
    }
    return { status: "found" as const, file: canonical, handle };
  } catch {
    await handle?.close().catch(() => undefined);
    return { status: "not_found" as const };
  }
}

function format(entry: any, includeTools: boolean): string {
  if (entry.type === "message") {
    const message = entry.message;
    if (!message || message.customType || message.hidden || message.synthetic) {
      return "";
    }
    if (message.role === "toolResult") {
      return includeTools
        ? `Tool result (${String(message.toolName ?? "tool")}):\n${safeText(message.content)}`
        : "";
    }
    if (message.role !== "user" && message.role !== "assistant") return "";
    let text = `${message.role === "user" ? "User" : "Assistant"}:\n${safeText(message.content)}`;
    if (includeTools && Array.isArray(message.content)) {
      const calls = message.content
        .filter((item: any) => item?.type === "toolCall")
        .map((item: any) => `Tool call: ${String(item.name ?? "tool")}`);
      if (calls.length) text += `\n${calls.join("\n")}`;
    }
    return text.trim();
  }
  if (
    (entry.type === "compaction" || entry.type === "branch_summary") &&
    typeof entry.summary === "string"
  ) {
    return `${entry.type}:\n${entry.summary}`;
  }
  if (entry.type === "session_info" && typeof entry.name === "string") {
    return `Session name: ${entry.name}`;
  }
  if (entry.type === "model_change") {
    return `Model changed: ${String(entry.modelId ?? "unknown")}`;
  }
  return "";
}

export async function readSession(
  index: SessionIndex,
  session: string,
  options: { offset?: number; limit?: number; includeTools?: boolean } = {}
): Promise<SessionReadResult> {
  const resolved = await safeFile(index, session);
  if (resolved.status !== "found") {
    const matches =
      resolved.status === "ambiguous"
        ? resolved.matches.map((item) => item.id).slice(0, 20)
        : undefined;
    const text =
      resolved.status === "ambiguous"
        ? "Session prefix is ambiguous."
        : resolved.status === "denied"
          ? "Access denied: session path is outside the managed session roots."
          : "Session not found.";
    return {
      status: resolved.status,
      text,
      details: { status: resolved.status, matches },
    };
  }

  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  const input = resolved.handle.createReadStream({
    autoClose: false,
    encoding: "utf8",
  });
  // Observe termination immediately so a stream error can never become unhandled.
  // The iterator still reports read errors; this promise only gates FD cleanup.
  const terminal = finished(input, { cleanup: true }).catch(() => undefined);
  const lines = createInterface({ input, crlfDelay: Infinity });
  const output: string[] = [];
  let eligible = 0;
  let malformed = 0;
  let emitted = 0;
  let bytes = 0;
  let lineCount = 0;
  let bounded = false;

  try {
    for await (const raw of lines) {
      let entry: any;
      try {
        entry = JSON.parse(raw.replace(/^\uFEFF/, "").trim());
      } catch {
        malformed++;
        continue;
      }
      if (!entry || entry.type === "session" || entry.customType) continue;
      const text = format(entry, options.includeTools ?? false);
      if (!text) continue;
      if (eligible++ < offset) continue;
      if (emitted >= limit) {
        bounded = true;
        break;
      }
      const chunk = `${output.length ? "\n\n" : ""}${text}`;
      const chunkLines =
        chunk.split("\n").length - (output.length ? 1 : 0);
      if (
        bytes + byteLength(chunk) > SESSION_READ_MAX_BYTES ||
        lineCount + chunkLines > SESSION_READ_MAX_LINES
      ) {
        bounded = true;
        break;
      }
      output.push(text);
      bytes += byteLength(chunk);
      lineCount += chunkLines;
      emitted++;
    }
  } finally {
    lines.close();
    input.destroy();
    await terminal;
    await resolved.handle.close();
  }

  const nextOffset = bounded ? offset + emitted : undefined;
  const diagnostics = malformed
    ? { malformedLines: Math.min(malformed, 1000), bounded: malformed > 1000 }
    : undefined;
  return {
    status: "ok",
    text: output.join("\n\n") || "No readable entries in this page.",
    details: {
      status: "ok",
      session: path.basename(resolved.file),
      offset,
      limit,
      emitted,
      nextOffset,
      truncated: bounded,
      bytes,
      lines: lineCount,
      diagnostics,
    },
  };
}
