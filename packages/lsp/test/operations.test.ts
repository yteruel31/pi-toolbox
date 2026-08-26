import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { executeLspOperation } from "../src/operations.js";
import { LspRegistry } from "../src/registry.js";
import type { LspConfig, ServerDefinition } from "../src/types.js";

const fakeServer = path.join(import.meta.dirname, "fixtures", "fake-lsp-server.mjs");

function config(): LspConfig {
  const server: ServerDefinition = {
    name: "fake",
    command: process.execPath,
    args: [fakeServer],
    fileTypes: [".ts"],
    rootMarkers: ["."],
    languageIds: { ".ts": "typescript" },
    priority: 1,
  };
  return {
    servers: [server],
    diagnostics: { enabled: true, inlineTimeoutMs: 100, deferredTimeoutMs: 2_000, maxDiagnostics: 50 },
    idleTimeoutMs: 60_000,
    requestTimeoutMs: 2_000,
    initFailureBackoffMs: 1_000,
    warnings: [],
  };
}

test("runs navigation and preview-first semantic rename operations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-operations-"));
  const file = path.join(root, "index.ts");
  await writeFile(file, "const alpha = alpha;\n");
  const registry = new LspRegistry(root, config(), true);
  const context = { cwd: root, registry, reload: async () => registry };

  try {
    const hover = await executeLspOperation(context, { action: "hover", file: "index.ts", line: 1, symbol: "alpha" });
    assert.match(hover.lines.join("\n"), /alpha: number/);

    const definition = await executeLspOperation(context, { action: "definition", file: "index.ts", line: 1, symbol: "alpha" });
    assert.match(definition.lines[0] ?? "", /index\.ts:1:7/);

    const preview = await executeLspOperation(context, { action: "rename", file: "index.ts", line: 1, symbol: "alpha", new_name: "beta" });
    assert.equal(preview.applied, false);
    assert.equal(await readFile(file, "utf8"), "const alpha = alpha;\n");

    const applied = await executeLspOperation(context, { action: "rename", file: "index.ts", line: 1, symbol: "alpha", new_name: "beta", apply: true });
    assert.equal(applied.applied, true);
    assert.equal(await readFile(file, "utf8"), "const beta = beta;\n");
  } finally {
    await registry.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a rename workspace edit with a stale document version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-operations-version-"));
  const file = path.join(root, "index.ts");
  await writeFile(file, "const alpha = alpha;\n");
  const previousVersion = process.env.FAKE_LSP_RENAME_VERSION;
  process.env.FAKE_LSP_RENAME_VERSION = "99";
  const registry = new LspRegistry(root, config(), true);
  const context = { cwd: root, registry, reload: async () => registry };

  try {
    await assert.rejects(
      executeLspOperation(context, {
        action: "rename",
        file: "index.ts",
        line: 1,
        symbol: "alpha",
        new_name: "beta",
        apply: true,
      }),
      /stale or unverifiable document version/,
    );
    assert.equal(await readFile(file, "utf8"), "const alpha = alpha;\n");
  } finally {
    if (previousVersion === undefined) delete process.env.FAKE_LSP_RENAME_VERSION;
    else process.env.FAKE_LSP_RENAME_VERSION = previousVersion;
    await registry.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});
