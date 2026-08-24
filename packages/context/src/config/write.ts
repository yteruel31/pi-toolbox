import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import path from "node:path";

import type { ContextConfig } from "./schema.js";

/** Atomically replace the canonical context config with private permissions. */
export async function writeContextConfig(
  file: string,
  config: ContextConfig
): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("Context config directory is not a regular directory");
  }
  const uid =
    typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && directoryStat.uid !== uid) {
    throw new Error(
      "Context config directory is not owned by the current user"
    );
  }
  await chmod(directory, 0o700);

  try {
    const existing = await lstat(file);
    if (existing.isSymbolicLink())
      throw new Error("Refusing symbolic link at context config path");
    if (!existing.isFile())
      throw new Error("Context config path is not a regular file");
    if (uid !== undefined && existing.uid !== uid) {
      throw new Error("Context config is not owned by the current user");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    directory,
    `.config.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
