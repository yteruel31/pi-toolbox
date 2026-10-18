import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Never let an offline extension test write into the installed agent directory. */
export function temporaryStateDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "subagent-state-test-"));
  directories.push(directory);
  return directory;
}
