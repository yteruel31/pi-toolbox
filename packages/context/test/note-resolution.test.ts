import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_KNOWLEDGE_CONFIG } from "../src/config/schema.js";
import { KnowledgeIndex } from "../src/knowledge/index.js";
import { readIndexedNote, resolveIndexedNote } from "../src/knowledge/reader.js";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-read-"));
  await mkdir(path.join(root, "one")); await mkdir(path.join(root, "two"));
  await writeFile(path.join(root, "one", "alpha.md"), "# Alpha\n\nhello 🙂 world");
  await writeFile(path.join(root, "two", "alpha.md"), "# Other\n\nother");
  await writeFile(path.join(root, "unique.md"), "unique");
  const db = new DatabaseSync(":memory:");
  const index = new KnowledgeIndex(db, { ...DEFAULT_KNOWLEDGE_CONFIG, roots: [root], extensions: ["md"] });
  await index.sync(); return { root, db, index };
}

describe("safe indexed note resolution", () => {
  it("resolves relative, basename, and wikilink aliases without guessing ambiguity", async () => {
    const { db, index } = await fixture();
    expect(resolveIndexedNote(index, "one/alpha.md").status).toBe("resolved");
    expect(resolveIndexedNote(index, "unique").status).toBe("resolved");
    expect(resolveIndexedNote(index, "[[unique|alias]]").status).toBe("resolved");
    expect(resolveIndexedNote(index, "alpha").status).toBe("ambiguous");
    for (const unsafe of ["../unique.md", "/tmp/unique.md", "knowledge.db", "missing.md"]) expect(resolveIndexedNote(index, unsafe).status).toBe("not-found");
    db.close();
  });
  it("truncates only at complete UTF-8 code points for every byte cap", async () => {
    const { root, db, index } = await fixture();
    const file = (resolveIndexedNote(index, "unique.md") as any).file;
    const samples = ["a¢z", "a€z", "a😀z", "¢€😀"];

    for (const sample of samples) {
      await writeFile(file.path, sample);
      const current = await stat(file.path);
      const updatedFile = { ...file, size: current.size, mtimeMs: current.mtimeMs };
      for (let cap = 1; cap <= Buffer.byteLength(sample); cap++) {
        const read = await readIndexedNote(updatedFile, cap);
        expect(Buffer.byteLength(read.content)).toBeLessThanOrEqual(cap);
        expect(read.content).not.toContain("�");
        expect(sample.startsWith(read.content)).toBe(true);
      }
    }
    db.close();
  });

  it("rejects binary files, direct symlinks, and indexed path swaps", async () => {
    const { db, index } = await fixture();
    const file = (resolveIndexedNote(index, "one/alpha.md") as any).file;
    await writeFile(file.path, Buffer.from([0, 1, 2]));
    const binaryStat = await stat(file.path);
    const binaryFile = { ...file, size: binaryStat.size, mtimeMs: binaryStat.mtimeMs };
    await expect(readIndexedNote(binaryFile)).rejects.toThrow(/binary/);

    await rename(file.path, `${file.path}.old`);
    await symlink(`${file.path}.old`, file.path);
    await expect(readIndexedNote(file)).rejects.toThrow(/symbolic link|ELOOP/i);

    await rename(file.path, `${file.path}.link`);
    await writeFile(file.path, "replacement");
    await expect(readIndexedNote(file)).rejects.toThrow(/changed since it was indexed/);
    db.close();
  });
});
