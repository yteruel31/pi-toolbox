import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
async function sources(directory = path.join(root, "src")): Promise<Array<[string, string]>> {
  const out: Array<[string, string]> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sources(file));
    else if (entry.name.endsWith(".ts")) out.push([file, await readFile(file, "utf8")]);
  }
  return out;
}

describe("provider-free package boundary", () => {
  it("pins Effect and limits production dependencies to the approved parser stack", async () => {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    expect(manifest.dependencies.effect).toBe("4.0.0-beta.107");
    expect(Object.keys(manifest.dependencies).sort()).toEqual([
      "effect", "remark-frontmatter", "remark-parse", "unified",
    ]);
  });

  it("contains no provider, embedding, vector, API-key, excluded command, or unstable implementation", async () => {
    const files = await sources();
    const text = files.map(([file, source]) => `// ${file}\n${source}`).join("\n");
    const imports = [...text.matchAll(/(?:from\s+|import\s*)["']([^"']+)["']/g)].map((match) => match[1]!.toLowerCase());
    for (const forbidden of ["openai", "ollama", "bedrock", "@aws-sdk", "embedding", "vector"]) {
      expect(imports.filter((value) => value.includes(forbidden)), forbidden).toEqual([]);
    }
    expect(text).not.toMatch(/effect\/unstable/);
    expect(text).not.toMatch(/process\.env|API[_-]?KEY|AWS_(?:ACCESS|SECRET|REGION)/i);
    expect(text).not.toContain("session-embeddings-setup");
    expect(text).not.toContain("knowledge-add-kb");
  });
});
