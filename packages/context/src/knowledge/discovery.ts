import { open, lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import type { KnowledgeConfig } from "../config/schema.js";
import type { DiscoveredKnowledgeFile, DiscoveryDiagnostic, KnowledgeDiscoveryResult } from "./schema.js";

const diagnostic = (file: string, reason: DiscoveryDiagnostic["reason"]): DiscoveryDiagnostic => ({ path: file, reason });
const normalizedExtensions = (extensions: readonly string[]) => new Set(extensions.map((value) => value.toLowerCase().replace(/^\./, "")).filter(Boolean));
const excluded = (relative: string, excludes: readonly string[]) => {
  const parts = relative.split(path.sep);
  return excludes.some((value) => {
    const clean = value.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return clean !== "" && (parts.includes(clean) || relative.split(path.sep).join("/") === clean || relative.split(path.sep).join("/").startsWith(`${clean}/`));
  });
};

async function binary(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(8_192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

export async function discoverKnowledge(config: KnowledgeConfig): Promise<KnowledgeDiscoveryResult> {
  const skipped: DiscoveryDiagnostic[] = [];
  const roots: string[] = [];
  const files = new Map<string, DiscoveredKnowledgeFile>();
  const extensions = normalizedExtensions(config.extensions);
  let totalBytes = 0;

  for (const configured of config.roots.slice(0, config.limits.maxRoots)) {
    const absolute = path.resolve(configured);
    let rootStat;
    try { rootStat = await lstat(absolute); } catch { skipped.push(diagnostic(absolute, "root_missing")); continue; }
    if (rootStat.isSymbolicLink()) { skipped.push(diagnostic(absolute, "root_symlink")); continue; }
    if (!rootStat.isDirectory()) { skipped.push(diagnostic(absolute, "root_not_directory")); continue; }
    const uid = process.getuid?.();
    if (uid !== undefined && uid !== 0 && rootStat.uid !== uid) { skipped.push(diagnostic(absolute, "root_ownership")); continue; }
    const root = await realpath(absolute);
    roots.push(root);

    const walk = async (directory: string, depth: number): Promise<void> => {
      let entries;
      try { entries = await readdir(directory, { withFileTypes: true }); }
      catch { skipped.push(diagnostic(directory, "unreadable")); return; }
      entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
      for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        const relative = path.relative(root, candidate);
        if (entry.name.startsWith(".")) { skipped.push(diagnostic(candidate, "hidden")); continue; }
        if (excluded(relative, config.excludes)) { skipped.push(diagnostic(candidate, "excluded")); continue; }
        if (entry.isSymbolicLink()) { skipped.push(diagnostic(candidate, "symlink")); continue; }
        if (entry.isDirectory()) {
          if (depth >= config.limits.maxDepth) skipped.push(diagnostic(candidate, "depth_limit"));
          else await walk(candidate, depth + 1);
          continue;
        }
        if (!entry.isFile()) { skipped.push(diagnostic(candidate, "non_regular")); continue; }
        if (!extensions.has(path.extname(entry.name).slice(1).toLowerCase())) { skipped.push(diagnostic(candidate, "extension")); continue; }
        let stat;
        try { stat = await lstat(candidate); } catch { skipped.push(diagnostic(candidate, "unreadable")); continue; }
        if (!stat.isFile()) { skipped.push(diagnostic(candidate, "non_regular")); continue; }
        if (stat.size > config.limits.maxFileBytes) { skipped.push(diagnostic(candidate, "file_size_limit")); continue; }
        const canonical = await realpath(candidate);
        if (files.has(canonical)) continue;
        if (totalBytes + stat.size > config.limits.maxTotalBytes) { skipped.push(diagnostic(candidate, "total_size_limit")); continue; }
        if (files.size >= config.limits.maxFiles) { skipped.push(diagnostic(candidate, "file_limit")); continue; }
        try { if (await binary(candidate)) { skipped.push(diagnostic(candidate, "binary")); continue; } }
        catch { skipped.push(diagnostic(candidate, "unreadable")); continue; }
        files.set(canonical, { path: canonical, root, relativePath: path.relative(root, canonical), size: stat.size, mtimeMs: stat.mtimeMs });
        totalBytes += stat.size;
      }
    };
    await walk(root, 0);
  }
  return { files: [...files.values()].sort((a, b) => a.path.localeCompare(b.path, "en")), skipped, roots: [...new Set(roots)].sort(), totalBytes };
}
