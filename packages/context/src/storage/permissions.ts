import { chmod, lstat, mkdir } from "node:fs/promises";
import path from "node:path";

import { ContextStorageError } from "../runtime/errors.js";

export interface PermissionOps {
  readonly mkdir: typeof mkdir;
  readonly lstat: typeof lstat;
  readonly chmod: typeof chmod;
  readonly uid: () => number | undefined;
}

const defaultOps: PermissionOps = {
  mkdir,
  lstat,
  chmod,
  uid: () => typeof process.getuid === "function" ? process.getuid() : undefined,
};

function error(target: string, operation: string, message: string, cause?: unknown): ContextStorageError {
  return new ContextStorageError({ path: target, operation, message, ...(cause === undefined ? {} : { cause }) });
}

async function validateOwned(target: string, kind: "directory" | "file", ops: PermissionOps): Promise<void> {
  let stat;
  try {
    stat = await ops.lstat(target);
  } catch (cause) {
    throw error(target, "inspect", `Cannot inspect context ${kind} at ${target}`, cause);
  }
  if (stat.isSymbolicLink()) throw error(target, "validate", `Refusing symbolic link at context ${kind} path ${target}`);
  if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw error(target, "validate", `Context ${kind} path has the wrong file type: ${target}`);
  }
  const uid = ops.uid();
  if (uid !== undefined && stat.uid !== uid) throw error(target, "validate", `Context ${kind} is not owned by the current user: ${target}`);
}

export async function ensurePrivateContextRoot(root: string, ops: PermissionOps = defaultOps): Promise<void> {
  try {
    await ops.mkdir(root, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw error(root, "create", `Cannot create private context directory at ${root}`, cause);
  }
  await validateOwned(root, "directory", ops);
  try {
    await ops.chmod(root, 0o700);
  } catch (cause) {
    throw error(root, "chmod", `Cannot restrict context directory permissions at ${root}`, cause);
  }
}

export async function validateDatabasePath(dbPath: string, ops: PermissionOps = defaultOps): Promise<void> {
  await ensurePrivateContextRoot(path.dirname(dbPath), ops);
  try {
    await validateOwned(dbPath, "file", ops);
  } catch (cause) {
    if (cause instanceof ContextStorageError && (cause.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return;
    throw cause;
  }
}

export async function restrictDatabaseFiles(dbPath: string, ops: PermissionOps = defaultOps): Promise<void> {
  for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      await validateOwned(target, "file", ops);
      await ops.chmod(target, 0o600);
    } catch (cause) {
      if (cause instanceof ContextStorageError && (cause.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") continue;
      throw cause;
    }
  }
}
