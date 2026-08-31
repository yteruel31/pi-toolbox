import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const repositoryRoot = path.resolve(packageRoot, "../..");

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

describe("context package manifest", () => {
  it("declares the publishable package and exact Effect version", async () => {
    const manifest = await readJson(path.join(packageRoot, "package.json"));
    const dependencies = manifest.dependencies as Record<string, string>;

    expect(manifest.name).toBe("@yteruel31/pi-context");
    expect(manifest.version).toBe("0.1.0");
    expect(manifest.type).toBe("module");
    expect(manifest.engines).toEqual({ node: ">=22.19.0" });
    expect(dependencies.effect).toBe("4.0.0-beta.107");
    expect(manifest.pi).toEqual({ extensions: ["./src/index.ts"], skills: ["./skills"] });
  });

  it("is registered by the root package with the same exact Effect pin", async () => {
    const manifest = await readJson(path.join(repositoryRoot, "package.json"));
    const pi = manifest.pi as { extensions: string[]; skills: string[] };
    const dependencies = manifest.dependencies as Record<string, string>;

    expect(pi.extensions).toContain("./packages/context/src/index.ts");
    expect(pi.skills).toContain("./packages/context/skills");
    expect(dependencies.effect).toBe("4.0.0-beta.107");
  });

  it("has no provider, vector, or embedding dependencies", async () => {
    const manifest = await readJson(path.join(packageRoot, "package.json"));
    const dependencyNames = Object.keys({
      ...(manifest.dependencies as Record<string, string>),
      ...(manifest.optionalDependencies as Record<string, string> | undefined),
    });

    expect(dependencyNames.filter((name) => /provider|vector|embed/i.test(name))).toEqual([]);
  });
});
