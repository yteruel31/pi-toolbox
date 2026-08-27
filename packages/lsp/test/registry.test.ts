import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LspRegistry } from "../src/registry.js";
import type { LspConfig, ServerDefinition } from "../src/types.js";

const fakeServer = path.join(import.meta.dirname, "fixtures", "fake-lsp-server.mjs");

function server(
  name: string,
  args: string[] = [],
  features = { diagnostics: true, semantics: true },
  priority = 1,
): ServerDefinition {
  return {
    name,
    command: process.execPath,
    args: [fakeServer, ...args],
    fileTypes: [".ts"],
    rootMarkers: ["."],
    languageIds: { ".ts": "typescript" },
    features,
    priority,
  };
}

function config(servers: ServerDefinition[] = [server("fake")]): LspConfig {
  return {
    servers,
    diagnostics: { enabled: true, inlineTimeoutMs: 100, deferredTimeoutMs: 1_000, maxDiagnostics: 50 },
    idleTimeoutMs: 60_000,
    requestTimeoutMs: 2_000,
    initFailureBackoffMs: 180_000,
    warnings: [],
  };
}

test("aggregates the primary server with diagnostics-only sidecars", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-registry-multi-"));
  const file = path.join(root, "index.ts");
  await writeFile(file, "const value = BROKEN + BIOME + ALTERNATE;\n");
  const registry = new LspRegistry(root, config([
    server("typescript", ["--name=typescript", "--token=BROKEN"], { diagnostics: true, semantics: true }, 1),
    server("alternate", ["--name=alternate", "--token=ALTERNATE"], { diagnostics: true, semantics: true }, 2),
    server("biome", ["--name=biome", "--token=BIOME", "--omit-source"], { diagnostics: true, semantics: false }, 3),
  ]), true);

  try {
    const result = await registry.syncDiagnostics(file, 1_000);
    assert.deepEqual(result?.servers, ["typescript", "biome"]);
    assert.equal(result?.complete, true);
    assert.deepEqual(result?.diagnostics.map((diagnostic) => diagnostic.source), ["typescript", "biome"]);
    assert.deepEqual(result?.diagnostics.map((diagnostic) => diagnostic.message), ["BROKEN is not valid", "BIOME is not valid"]);
    assert.equal(result?.diagnostics.some((diagnostic) => diagnostic.message.includes("ALTERNATE")), false);

    const semanticClient = await registry.clientForFile(file);
    assert.equal(semanticClient?.name, "typescript");
  } finally {
    await registry.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates diagnostics-only initialization failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-registry-failure-"));
  const file = path.join(root, "index.ts");
  await writeFile(file, "const value = BROKEN;\n");
  const registry = new LspRegistry(root, config([
    server("typescript", ["--name=typescript", "--token=BROKEN"], { diagnostics: true, semantics: true }, 1),
    server("biome", ["--name=biome", "--init-error"], { diagnostics: true, semantics: false }, 2),
  ]), true);

  try {
    const result = await registry.syncDiagnostics(file, 1_000);
    assert.equal(result?.complete, false);
    assert.deepEqual(result?.diagnostics.map((diagnostic) => diagnostic.source), ["typescript"]);
    assert.match(result?.failures[0]?.message ?? "", /biome initialization failed/);
  } finally {
    await registry.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps successful diagnostics when a sidecar times out", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-registry-timeout-"));
  const file = path.join(root, "index.ts");
  await writeFile(file, "const value = BROKEN;\n");
  const registry = new LspRegistry(root, config([
    server("typescript", ["--name=typescript", "--token=BROKEN"], { diagnostics: true, semantics: true }, 1),
    server("biome", ["--name=biome", "--no-diagnostics"], { diagnostics: true, semantics: false }, 2),
  ]), true);

  try {
    const result = await registry.syncDiagnostics(file, 50);
    assert.equal(result?.complete, false);
    assert.deepEqual(result?.diagnostics.map((diagnostic) => diagnostic.source), ["typescript"]);
    assert.match(result?.failures[0]?.message ?? "", /timed out/);
  } finally {
    await registry.shutdownAll();
    await rm(root, { recursive: true, force: true });
  }
});

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
