import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";

export const JEV_MAX_BYTES = 64 * 1024;
export interface JevRevision { hash: string; ino: number; dev: number; mode: number }
export class JevStorageError extends Error {
  constructor(readonly code: "read" | "unsafe" | "busy" | "changed" | "invalid" | "write" | "keyring" | "partial") {
    super({
      read: "Cannot read Jev settings. Check their JSON and permissions.",
      unsafe: "Unsafe Jev storage path. Use current-user-owned regular files and directories, no symlinks, and keep credentials outside repositories with mode 0600.",
      busy: "Jev setup is busy. Retry after the other save finishes; never remove a lock without checking its owner process.",
      changed: "Jev settings changed since setup opened. Reopen Setup and review the latest values.",
      invalid: "Invalid Jev settings or credential values.",
      write: "Could not save Jev settings. Check directory permissions and free space, then retry.",
      keyring: "Linux Secret Service failed. Install libsecret-tools, provide a session D-Bus, and unlock a Secret Service collection, or explicitly choose Private file. No insecure fallback was used.",
      partial: "Jev settings weren't saved, but the key may already be stored. Reopen Setup and review the selected storage. No insecure fallback was used.",
    }[code]);
  }
}
export function jevStorageErrorMessage(error: unknown): string {
  return error instanceof JevStorageError ? error.message : new JevStorageError("write").message;
}
function inside(root: string, value: string): boolean { const rel = relative(root, value); return rel === "" || !rel.startsWith("..") && !rel.startsWith("/"); }
async function existingAncestor(path: string): Promise<string> {
  let current = resolve(path);
  for (;;) {
    try { await lstat(current); return current; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new JevStorageError("unsafe");
      const parent = dirname(current); if (parent === current) throw new JevStorageError("unsafe"); current = parent;
    }
  }
}
export async function ensureSafePath(path: string, create = false, rejectRepository = false): Promise<void> {
  const absolute = resolve(path);
  const ancestor = await existingAncestor(create ? dirname(absolute) : absolute);
  let physical: string;
  try { physical = await realpath(ancestor); } catch { throw new JevStorageError("unsafe"); }
  if (rejectRepository) {
    let cursor = physical;
    for (;;) {
      try { const git = await lstat(join(cursor, ".git")); if (git.isDirectory() || git.isFile()) throw new JevStorageError("unsafe"); } catch (error) {
        if (error instanceof JevStorageError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw new JevStorageError("unsafe");
      }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  }
  const root = parse(absolute).root;
  let cursor = root;
  for (const part of relative(root, create ? dirname(absolute) : absolute).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    let info;
    try { info = await lstat(cursor); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" && create) break; throw new JevStorageError("unsafe"); }
    if (info.isSymbolicLink()) throw new JevStorageError("unsafe");
    if (cursor !== absolute && !info.isDirectory()) throw new JevStorageError("unsafe");
    if (info.isDirectory() && process.platform !== "win32") {
      const mode = info.mode & 0o777;
      const stickySystem = info.uid === 0 && (info.mode & 0o1000) !== 0;
      const systemAncestor = info.uid === 0 && !inside(resolve(process.env.HOME || root), cursor) && (mode & 0o022) === 0;
      const destinationDirectory = cursor === dirname(absolute);
      if (destinationDirectory && info.uid !== process.getuid?.() || info.uid !== process.getuid?.() && !stickySystem && !systemAncestor && cursor !== root || (mode & 0o022) !== 0 && !stickySystem) throw new JevStorageError("unsafe");
    }
  }
  if (rejectRepository) {
    const suffix = relative(ancestor, dirname(absolute));
    const candidate = resolve(physical, suffix);
    let cursor = candidate;
    for (;;) {
      try { const git = await lstat(join(cursor, ".git")); if (git.isDirectory() || git.isFile()) throw new JevStorageError("unsafe"); } catch (error) {
        if (error instanceof JevStorageError) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (error as NodeJS.ErrnoException).code !== "ENOTDIR") throw new JevStorageError("unsafe");
      }
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
  }
}
export async function makeSafeDirectory(directory: string, allowOwnedWritableAncestors = false): Promise<void> {
  const absolute = resolve(directory);
  if (allowOwnedWritableAncestors) await ensureOwnedDirectoryPath(absolute, true);
  else await ensureSafePath(absolute, true);
  await mkdir(absolute, { recursive: true, mode: 0o700 }).catch(() => { throw new JevStorageError("write"); });
  if (allowOwnedWritableAncestors) await ensureOwnedDirectoryPath(absolute, false);
  else await ensureSafePath(absolute);
}
export async function ensureOwnedSettingsPath(path: string, create = false): Promise<void> {
  const absolute = resolve(path);
  await ensureOwnedDirectoryPath(dirname(absolute), create);
  if (create) return;
  let info;
  try { info = await lstat(absolute); } catch { throw new JevStorageError("unsafe"); }
  if (!info.isFile() || info.isSymbolicLink() || process.platform !== "win32" && info.uid !== process.getuid?.()) throw new JevStorageError("unsafe");
}
async function ensureOwnedDirectoryPath(directory: string, create: boolean): Promise<void> {
  const absolute = resolve(directory); const root = parse(absolute).root; let cursor = root;
  for (const part of relative(root, absolute).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part); let info;
    try { info = await lstat(cursor); } catch (error) { if (create && (error as NodeJS.ErrnoException).code === "ENOENT") return; throw new JevStorageError("unsafe"); }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new JevStorageError("unsafe");
    if (process.platform !== "win32") {
      const mode = info.mode & 0o777;
      const stickySystem = info.uid === 0 && (info.mode & 0o1000) !== 0;
      const systemAncestor = info.uid === 0 && !inside(resolve(process.env.HOME || root), cursor) && (mode & 0o022) === 0;
      const ownedDirectory = info.uid === process.getuid?.() && ((mode & 0o022) === 0 || (mode & 0o002) === 0 && (mode & 0o200) !== 0);
      if (!ownedDirectory && !stickySystem && !systemAncestor && cursor !== root) throw new JevStorageError("unsafe");
    }
  }
}
export async function readSafeText(path: string, privateMode: boolean, allowMissing: boolean, rejectRepository = false, allowOwnedWritableAncestors = false): Promise<{ text?: string; revision?: JevRevision }> {
  const checkPath = allowOwnedWritableAncestors
    ? (value: string, create: boolean) => ensureOwnedSettingsPath(value, create)
    : (value: string, create: boolean) => ensureSafePath(value, create, rejectRepository);
  await checkPath(path, false).catch(async error => {
    if (allowMissing && error instanceof JevStorageError) { try { await lstat(path); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; } }
    throw error;
  });
  let before;
  try { before = await lstat(path); } catch (error) { if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw new JevStorageError("unsafe"); }
  if (!before.isFile() || before.isSymbolicLink()) throw new JevStorageError("unsafe");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => { throw new JevStorageError("unsafe"); });
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > JEV_MAX_BYTES || process.platform !== "win32" && (stat.uid !== process.getuid?.() || privateMode && (stat.mode & 0o777) !== 0o600)) throw new JevStorageError("unsafe");
    const buffer = Buffer.alloc(JEV_MAX_BYTES + 1); let size = 0;
    while (size < buffer.length) { const result = await file.read(buffer, size, buffer.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
    if (size > JEV_MAX_BYTES) throw new JevStorageError("unsafe");
    const text = buffer.subarray(0, size).toString("utf8");
    return { text, revision: { hash: createHash("sha256").update(text).digest("hex"), ino: stat.ino, dev: stat.dev, mode: stat.mode } };
  } finally { await file.close(); }
}
export function sameRevision(a?: JevRevision, b?: JevRevision): boolean { return a?.hash === b?.hash && a?.ino === b?.ino && a?.dev === b?.dev && a?.mode === b?.mode; }
export async function stagePrivate(path: string, value: string): Promise<string> {
  if (Buffer.byteLength(value) > JEV_MAX_BYTES) throw new JevStorageError("invalid");
  const temp = `${path}.${randomBytes(12).toString("hex")}.tmp`; let file;
  try { file = await open(temp, "wx", 0o600); await file.chmod(0o600); await file.writeFile(value); await file.sync(); return temp; }
  catch { await rm(temp, { force: true }).catch(() => undefined); throw new JevStorageError("write"); }
  finally { await file?.close().catch(() => undefined); }
}
export async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`; const file = await open(lockPath, "wx", 0o600).catch((error: NodeJS.ErrnoException) => { throw new JevStorageError(error.code === "EEXIST" ? "busy" : "write"); }); const identity = await file.stat();
  return async () => { await file.close(); const current = await lstat(lockPath).catch(() => undefined); if (current?.ino === identity.ino && current.dev === identity.dev) await rm(lockPath); };
}
export async function safeReplace(temp: string, target: string, expected?: JevRevision): Promise<void> {
  const current = await readSafeText(target, true, true);
  if (!sameRevision(expected, current.revision)) throw new JevStorageError("changed");
  await rename(temp, target).catch(() => { throw new JevStorageError("write"); });
}
