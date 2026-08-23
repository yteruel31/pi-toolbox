import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DEFAULT_KNOWLEDGE_CONFIG, type KnowledgeConfig } from "../src/config/schema.js";
import { CHUNK_OVERLAP_CHARS, chunkKnowledge } from "../src/knowledge/chunker.js";
import { discoverKnowledge } from "../src/knowledge/discovery.js";

const configured = (roots: readonly string[], overrides: Partial<KnowledgeConfig["limits"]> = {}): KnowledgeConfig => ({
  ...DEFAULT_KNOWLEDGE_CONFIG,
  roots,
  extensions: ["md", "txt"],
  excludes: ["skip"],
  limits: { ...DEFAULT_KNOWLEDGE_CONFIG.limits, ...overrides },
});

describe("knowledge discovery", () => {
  it("walks roots deterministically, excludes unsafe entries and deduplicates overlaps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-knowledge-"));
    await mkdir(path.join(root, "nested"));
    await mkdir(path.join(root, "skip"));
    await writeFile(path.join(root, "z.md"), "z");
    await writeFile(path.join(root, "nested/a.txt"), "a");
    await writeFile(path.join(root, "nested/no.json"), "{}");
    await writeFile(path.join(root, "skip/no.md"), "no");
    await writeFile(path.join(root, ".hidden.md"), "no");
    await writeFile(path.join(root, "binary.md"), Buffer.from([1, 0, 2]));
    await symlink(path.join(root, "z.md"), path.join(root, "linked.md"));
    const result = await discoverKnowledge(configured([root, path.join(root, "nested")]));
    expect(result.files.map((file) => file.path)).toEqual([...result.files.map((file) => file.path)].sort());
    expect(result.files.map((file) => path.basename(file.path))).toEqual(["a.txt", "z.md"]);
    expect(result.skipped.map((item) => item.reason)).toEqual(expect.arrayContaining(["hidden", "excluded", "extension", "binary", "symlink"]));
  });

  it("enforces depth, individual, aggregate, and file-count caps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-knowledge-caps-"));
    await mkdir(path.join(root, "deep"));
    await writeFile(path.join(root, "a.md"), "12345");
    await writeFile(path.join(root, "b.md"), "12345");
    await writeFile(path.join(root, "large.md"), "x".repeat(20));
    await writeFile(path.join(root, "deep/c.md"), "c");
    const result = await discoverKnowledge(configured([root], { maxFiles: 1, maxDepth: 1, maxFileBytes: 10, maxTotalBytes: 6 }));
    expect(result.files).toHaveLength(1);
    expect(result.skipped.map((item) => item.reason)).toEqual(expect.arrayContaining(["total_size_limit", "file_size_limit"]));
    const count = await discoverKnowledge(configured([root], { maxFiles: 1 }));
    expect(count.skipped.some((item) => item.reason === "file_limit")).toBe(true);
    const depth = await discoverKnowledge(configured([root], { maxDepth: 1 }));
    expect(depth.files.some((file) => file.relativePath === "deep/c.md")).toBe(true);
    const blocked = await discoverKnowledge(configured([root], { maxDepth: 1, maxFiles: 100, maxTotalBytes: 4 }));
    expect(blocked.skipped.some((item) => item.reason === "total_size_limit")).toBe(true);
  });

  it("rejects symlink and missing roots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "context-knowledge-root-"));
    const link = `${root}-link`;
    await symlink(root, link);
    const result = await discoverKnowledge(configured([link, `${root}-missing`]));
    expect(result.files).toEqual([]);
    expect(result.skipped.map((item) => item.reason)).toEqual(["root_symlink", "root_missing"]);
  });
});

describe("knowledge chunking", () => {
  it("preserves heading hierarchy, frontmatter, paragraphs and fenced code", () => {
    const text = `---\ntitle: safe\n---\n# Top\nIntro.\n\n## Child\nParagraph.\n\n\`\`\`js\n# not heading\nconsole.log(1)\n\`\`\``;
    const chunks = chunkKnowledge(text, "/note.md", 60, 10);
    expect(chunks.some((chunk) => chunk.text.includes("title: safe"))).toBe(true);
    expect(chunks.some((chunk) => chunk.heading === "Top > Child")).toBe(true);
    expect(chunks.some((chunk) => chunk.text.includes("# not heading"))).toBe(true);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(chunks.map((_, index) => index));
    expect(chunkKnowledge(text, "/note.md", 60, 10)).toEqual(chunks);
  });

  it("merges small blocks and hard-splits with codepoint-safe overlap", () => {
    const text = `# H\n\nsmall\n\n${"😀".repeat(80)}`;
    const chunks = chunkKnowledge(text, "unicode", 30, 12);
    expect(chunks.every((chunk) => Array.from(chunk.text).length <= 30)).toBe(true);
    expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk.text))).toBe(true);
    const emojiChunks = chunks.filter((chunk) => chunk.text.startsWith("😀"));
    expect(Array.from(emojiChunks[1]!.text).slice(0, Math.min(CHUNK_OVERLAP_CHARS, 29))).toEqual(Array.from(emojiChunks[0]!.text).slice(-29));
  });

  it("uses deterministic bounded chunks for sources over 120k", () => {
    const chunks = chunkKnowledge(`# Large\n\n${"word ".repeat(25_000)}`, "large", 1000, 100);
    expect(chunks.length).toBeGreaterThan(100);
    expect(chunks.every((chunk) => Array.from(chunk.text).length <= 1000)).toBe(true);
    expect(chunks[0]!.id).toBe(chunkKnowledge(`# Large\n\n${"word ".repeat(25_000)}`, "large", 1000, 100)[0]!.id);
  });
});
