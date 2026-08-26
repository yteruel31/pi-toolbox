import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LspRegistry } from "../src/registry.js";
import type { LspConfig } from "../src/types.js";

const fakeServer = path.join(import.meta.dirname, "fixtures", "fake-lsp-server.mjs");

function config(): LspConfig {
  return {
    servers: [{
      name: "fake",
      command: process.execPath,
      args: [fakeServer],
      fileTypes: [".ts"],
      rootMarkers: ["."],
      languageIds: { ".ts": "typescript" },
      priority: 1,
    }],
    diagnostics: { enabled: true, inlineTimeoutMs: 100, deferredTimeoutMs: 1_000, maxDiagnostics: 50 },
    idleTimeoutMs: 60_000,
    requestTimeoutMs: 2_000,
    initFailureBackoffMs: 180_000,
    warnings: [],
  };
}

test("caller cancellation does not cancel or poison shared server initialization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-registry-"));
  const file = path.join(root, "index.ts");
  await writeFile(file, "const alpha = 1;\n");
  const previousDelay = process.env.FAKE_LSP_INIT_DELAY_MS;
  process.env.FAKE_LSP_INIT_DELAY_MS = "100";
  const registry = new LspRegistry(root, config(), true);
  const controller = new AbortController();

  try {
    const cancelled = registry.clientForFile(file, controller.signal);
    setTimeout(() => controller.abort(new Error("cancelled by test")), 10);
    await assert.rejects(cancelled, /cancelled by test/);

    const client = await registry.clientForFile(file);
    assert.equal(client?.isRunning, true);
  } finally {
    if (previousDelay === undefined) delete process.env.FAKE_LSP_INIT_DELAY_MS;
    else process.env.FAKE_LSP_INIT_DELAY_MS = previousDelay;
    await registry.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});
