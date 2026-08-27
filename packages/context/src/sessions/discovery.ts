import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { DiscoveredSession } from "./schema.js";

export const SESSION_DISCOVERY_MAX_DEPTH = 8;
export const SESSION_DISCOVERY_MAX_FILES = 20_000;

async function walk(root: string, archived: boolean, maxDepth: number, maxFiles: number): Promise<DiscoveredSession[]> {
  const found: DiscoveredSession[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth || found.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(candidate, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await lstat(candidate);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          found.push({ path: await realpath(candidate), archived, size: stat.size, mtimeMs: stat.mtimeMs });
        } catch {
          // A concurrently removed or inaccessible entry is safely skipped.
        }
      }
    }
  };
  await visit(root, 0);
  return found;
}

export interface DiscoveryOptions {
  readonly maxDepth?: number;
  readonly maxFiles?: number;
}

/** Discovers active and archived Pi sessions, including nested child-run files. */
export async function discoverSessionFiles(agentDir: string, options: DiscoveryOptions = {}): Promise<DiscoveredSession[]> {
  const maxDepth = options.maxDepth ?? SESSION_DISCOVERY_MAX_DEPTH;
  const maxFiles = options.maxFiles ?? SESSION_DISCOVERY_MAX_FILES;
  const active = await walk(path.join(agentDir, "sessions"), false, maxDepth, maxFiles);
  const remaining = Math.max(0, maxFiles - active.length);
  const archived = await walk(path.join(agentDir, "sessions-archive"), true, maxDepth, remaining);
  return [...active, ...archived].sort((a, b) => Number(a.archived) - Number(b.archived) || a.path.localeCompare(b.path));
}
