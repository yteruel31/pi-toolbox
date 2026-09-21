import { lstatSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, relative, resolve, sep } from "node:path";

export interface LocalTargetFacts {
  exists: boolean;
  repository?: string;
  tracked: boolean;
  modified: boolean;
  untracked: boolean;
  recoverable: boolean;
  emptyDirectory?: boolean;
  repositoryRoot?: boolean;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], {
    cwd, encoding: "utf8", timeout: 1500, maxBuffer: 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "/", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Bounded, non-mutating facts. Callers must treat every thrown error as unsafe. */
export function inspectLocalTarget(path: string): LocalTargetFacts {
  const absolute = resolve(path);
  let exists = false, directory = false;
  try { const stat = lstatSync(absolute); exists = true; directory = stat.isDirectory(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const emptyDirectory = directory ? readdirSync(absolute).length === 0 : undefined;

  let cursor = directory ? absolute : dirname(absolute);
  while (true) {
    try {
      const repository = git(cursor, ["rev-parse", "--show-toplevel"]);
      const rel = relative(repository, absolute).split(sep).join("/");
      if (!rel || rel === ".." || rel.startsWith("../")) return { exists, tracked: false, modified: false, untracked: false, recoverable: false, emptyDirectory, repositoryRoot: absolute === resolve(repository) };
      const trackedOutput = git(repository, ["ls-files", "--", rel]);
      const tracked = trackedOutput !== "";
      // A directory is recoverable only when every relevant descendant is tracked
      // and pristine. Include untracked and ignored descendants conservatively.
      const status = git(repository, ["status", "--porcelain=v1", "--ignored=matching", "--untracked-files=all", "--", rel]);
      const modified = tracked && status.split("\n").some((line) => line && !line.startsWith("?? ") && !line.startsWith("!! "));
      const untracked = exists && status.split("\n").some((line) => line.startsWith("?? ") || line.startsWith("!! "));
      return { exists, repository, tracked, modified, untracked, recoverable: !directory && tracked && !modified && !untracked, emptyDirectory, repositoryRoot: absolute === resolve(repository) };
    } catch (error) {
      const message = String((error as Error).message ?? error);
      if (!/not a git repository|did not match any file/i.test(message)) {
        try {
          const repository = git(cursor, ["rev-parse", "--show-toplevel"]);
          return { exists, repository, tracked: false, modified: false, untracked: exists, recoverable: false, emptyDirectory, repositoryRoot: absolute === resolve(repository) };
        } catch (nested) {
          if (!/not a git repository/i.test(String((nested as Error).message ?? nested))) throw nested;
        }
      }
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return { exists, tracked: false, modified: false, untracked: exists, recoverable: false, emptyDirectory, repositoryRoot: false };
}
