import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { loadContextConfig } from "../src/config/load.js";
import { contextPaths } from "../src/config/paths.js";
import { DEFAULT_CONTEXT_CONFIG } from "../src/config/schema.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-context-"));
  await mkdir(path.join(root, "context"));
  return root;
}

describe("context config", () => {
  it("uses fresh canonical paths and defaults when absent", async () => {
    const agentDir = await fixture();
    const paths = contextPaths(agentDir);
    expect(paths).toEqual({ root: path.join(agentDir, "context"), config: path.join(agentDir, "context/config.json"), memoryDb: path.join(agentDir, "context/memory.db"), sessionsDb: path.join(agentDir, "context/sessions.db"), knowledgeDb: path.join(agentDir, "context/knowledge.db") });
    await expect(Effect.runPromise(loadContextConfig(paths.config))).resolves.toEqual(DEFAULT_CONTEXT_CONFIG);
  });

  it("accepts role routes", async () => {
    const paths = contextPaths(await fixture());
    await writeFile(paths.config, JSON.stringify({ version: 1, models: { observer: { provider: "fake", model: "model", thinkingLevel: "high" } } }));
    await expect(Effect.runPromise(loadContextConfig(paths.config))).resolves.toMatchObject({ models: { observer: { provider: "fake" } } });
  });

  it.each(["{", JSON.stringify({ version: 2, models: {} }), JSON.stringify({ version: 1, models: {}, legacy: true })])("rejects malformed or unsupported config", async (contents) => {
    const paths = contextPaths(await fixture());
    await writeFile(paths.config, contents);
    await expect(Effect.runPromise(loadContextConfig(paths.config))).rejects.toMatchObject({ _tag: "ContextConfigError", path: paths.config });
  });
});
