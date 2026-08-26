import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { fileToUri } from "../src/paths.js";
import { applyWorkspaceEdit, planWorkspaceEdit } from "../src/workspace-edit.js";
import type { WorkspaceEdit } from "../src/types.js";

test("previews then atomically applies a multi-file workspace edit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-edit-"));
  const first = path.join(root, "first.ts");
  const second = path.join(root, "second.ts");
  await writeFile(first, "const alpha = 1;\n");
  await writeFile(second, "alpha();\n");
  const edit: WorkspaceEdit = {
    changes: {
      [fileToUri(first)]: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "beta" }],
      [fileToUri(second)]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "beta" }],
    },
  };

  try {
    const preview = await planWorkspaceEdit(edit, root);
    assert.equal(preview.editCount, 2);
    assert.equal(await readFile(first, "utf8"), "const alpha = 1;\n");

    const applied = await applyWorkspaceEdit(edit, root);
    assert.equal(applied.files.length, 2);
    assert.equal(await readFile(first, "utf8"), "const beta = 1;\n");
    assert.equal(await readFile(second, "utf8"), "beta();\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects overlapping, snippet, resource, and out-of-workspace edits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-edit-safe-"));
  const file = path.join(root, "index.ts");
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.ts`);
  const linked = path.join(root, "linked.ts");
  const realDirectory = path.join(root, "real");
  const aliasDirectory = path.join(root, "alias");
  const realFile = path.join(realDirectory, "shared.ts");
  const aliasedFile = path.join(aliasDirectory, "shared.ts");
  await writeFile(file, "abcdef\n");
  await writeFile(outside, "abcdef\n");
  await mkdir(realDirectory);
  await writeFile(realFile, "abcdef\n");
  await symlink(outside, linked);
  await symlink(realDirectory, aliasDirectory, "dir");

  try {
    await assert.rejects(
      planWorkspaceEdit({ changes: { [fileToUri(file)]: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, newText: "x" },
        { range: { start: { line: 0, character: 2 }, end: { line: 0, character: 5 } }, newText: "y" },
      ] } }, root),
      /Overlapping/,
    );
    await assert.rejects(
      planWorkspaceEdit({ documentChanges: [{ textDocument: { uri: fileToUri(file) }, edits: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "${1:x}", insertTextFormat: 2 },
      ] }] }, root),
      /Snippet/,
    );
    await assert.rejects(
      planWorkspaceEdit({ documentChanges: [{ kind: "rename", oldUri: fileToUri(file), newUri: fileToUri(outside) }] }, root),
      /create, rename, and delete/,
    );
    await assert.rejects(
      planWorkspaceEdit({ changes: { [fileToUri(outside)]: [] } }, root),
      /outside the workspace/,
    );
    await assert.rejects(
      planWorkspaceEdit({ changes: { [fileToUri(linked)]: [
        { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
      ] } }, root),
      /symbolic links/,
    );
    await assert.rejects(
      applyWorkspaceEdit(
        { changes: { [fileToUri(file)]: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" },
        ] } },
        root,
        new Map([[file, "stale snapshot\n"]]),
      ),
      /File changed/,
    );
    await assert.rejects(
      planWorkspaceEdit({ changes: {
        [fileToUri(realFile)]: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: "x" }],
        [fileToUri(aliasedFile)]: [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, newText: "y" }],
      } }, root),
      /same file through multiple paths/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { force: true });
  }
});
