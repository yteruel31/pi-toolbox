/**
 * Minimal filesystem seam shared by agent discovery and the routing store.
 *
 * The production implementation delegates to node:fs/promises. Tests mostly
 * use real temp directories (symlinks and permissions are part of the SPEC
 * surface), but the seam lets edge cases (I/O errors, permission failures)
 * be injected without touching the disk.
 *
 * Everything here uses lstat semantics on purpose: discovery must never
 * follow a symlink implicitly, so the seam does not even expose stat().
 */

import * as fs from "node:fs/promises";

export interface FileStats {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  /** POSIX permission bits (mode & 0o777). */
  permissions: number;
}

export interface AgentFileSystem {
  /** lstat: never follows symlinks. Rejects when the path does not exist. */
  lstat(path: string): Promise<FileStats>;
  /** Directory entry names (no dirent types; callers lstat each entry). */
  readdir(path: string): Promise<string[]>;
  readFile(path: string): Promise<string>;
  realpath(path: string): Promise<string>;
  /** Non-recursive mkdir; rejects with EEXIST when the directory exists. */
  mkdir(path: string, mode: number): Promise<void>;
  writeFile(path: string, data: string, mode: number): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export const nodeFileSystem: AgentFileSystem = {
  async lstat(path) {
    const st = await fs.lstat(path);
    return {
      isFile: st.isFile(),
      isDirectory: st.isDirectory(),
      isSymbolicLink: st.isSymbolicLink(),
      size: st.size,
      permissions: st.mode & 0o777,
    };
  },
  readdir: (path) => fs.readdir(path),
  readFile: (path) => fs.readFile(path, "utf8"),
  realpath: (path) => fs.realpath(path),
  mkdir: async (path, mode) => {
    await fs.mkdir(path, { mode });
  },
  writeFile: (path, data, mode) => fs.writeFile(path, data, { mode }),
  chmod: (path, mode) => fs.chmod(path, mode),
  rename: (from, to) => fs.rename(from, to),
  unlink: (path) => fs.unlink(path),
};

/** True when an error is a "path does not exist" filesystem error. */
export function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** True when an error is an "already exists" filesystem error. */
export function isAlreadyExists(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === "EEXIST"
  );
}
