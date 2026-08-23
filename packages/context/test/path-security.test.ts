import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { containedRealPath } from "../src/shared/paths.js";

it("allows an existing contained file and rejects traversal, prefix collision, and symlink escape", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "context-path-"));
  const root = path.join(fixture, "root");
  const sibling = path.join(fixture, "root-other");
  await mkdir(root); await mkdir(sibling);
  const valid = path.join(root, "valid.txt");
  const outside = path.join(sibling, "outside.txt");
  await writeFile(valid, "ok"); await writeFile(outside, "no");
  await symlink(outside, path.join(root, "escape"));
  await expect(containedRealPath(root, "valid.txt")).resolves.toBe(valid);
  await expect(containedRealPath(root, "../root-other/outside.txt")).rejects.toMatchObject({ _tag: "ContextPathError" });
  await expect(containedRealPath(root, "escape")).rejects.toMatchObject({ _tag: "ContextPathError" });
  await expect(containedRealPath(root, outside)).rejects.toMatchObject({ _tag: "ContextPathError" });
});
