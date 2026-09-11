import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export function validApiKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\s\x00-\x1f\x7f-\x9f]/.test(value);
}

/** Read from the checked descriptor, never following a final symlink. */
export async function readCredentialEntries(path: string, signal?: AbortSignal, allowMissing = false): Promise<Record<string, string>> {
  signal?.throwIfAborted();
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === "ENOENT") return undefined;
    throw new Error("Cannot open web-access.credentials.json; create a private credentials file first");
  });
  if (!info) return {};
  if (info.isSymbolicLink()) throw new Error("Cannot open web-access.credentials.json; symlinks are not allowed");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: NodeJS.ErrnoException) => {
    if (allowMissing && error.code === "ENOENT") return undefined;
    throw new Error("Cannot open web-access.credentials.json; create a private credentials file first");
  });
  if (!file) return {};
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== info.ino || stat.dev !== info.dev || (process.platform !== "win32" && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()))) {
      throw new Error("web-access.credentials.json must be a regular file owned by the current user with mode 0600");
    }
    const maxBytes = 64 * 1024;
    if (stat.size > maxBytes) throw new Error("web-access.credentials.json exceeds 64 KiB");
    const buffer = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new Error("web-access.credentials.json exceeds 64 KiB");
    let value: unknown;
    try { value = JSON.parse(buffer.subarray(0, size).toString("utf8")); }
    catch { throw new Error("web-access.credentials.json is not valid JSON"); }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !["gemini", "openai", "brave"].includes(key))) {
      throw new Error("web-access.credentials.json must contain only provider API keys");
    }
    if (Object.values(value).some((key) => !validApiKey(key))) throw new Error("API key is missing or invalid in web-access.credentials.json");
    return value as Record<string, string>;
  } finally {
    await file.close();
  }
}

export async function readCredentialFile(path: string, provider: string, signal?: AbortSignal): Promise<string> {
  const entries = await readCredentialEntries(path, signal);
  if (!validApiKey(entries[provider])) throw new Error(`${provider} API key is missing or invalid in web-access.credentials.json`);
  return entries[provider]!;
}
