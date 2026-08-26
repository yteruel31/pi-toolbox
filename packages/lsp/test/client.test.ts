import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LspClient } from "../src/client.js";
import { fileToUri } from "../src/paths.js";
import type { Hover, ServerDefinition } from "../src/types.js";

const fakeServer = path.join(import.meta.dirname, "fixtures", "fake-lsp-server.mjs");

function definition(): ServerDefinition {
  return {
    name: "fake",
    command: process.execPath,
    args: [fakeServer],
    fileTypes: [".ts"],
    rootMarkers: ["."],
    languageIds: { ".ts": "typescript" },
    priority: 1,
  };
}

test("initializes, synchronizes documents, and receives fresh diagnostics", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-client-"));
  const file = path.join(root, "index.ts");
  await writeFile(file, "const alpha = BROKEN;\n");
  const server = definition();
  const client = new LspClient({ definition: server, command: process.execPath, root }, 2_000);

  try {
    await client.start();
    const first = await client.syncFile(file);
    const diagnostics = await client.waitForDiagnostics(first.uri, first.beforeDiagnosticsGeneration, first.documentVersion, 2_000);
    assert.equal(diagnostics.diagnostics.length, 1);
    assert.equal(diagnostics.diagnostics[0]?.code, "fake-error");

    const hover = await client.request<Hover>("textDocument/hover", {
      textDocument: { uri: fileToUri(file) },
      position: { line: 0, character: 6 },
    });
    assert.match(JSON.stringify(hover), /alpha: number/);

    await writeFile(file, "const alpha = 1;\n");
    const second = await client.syncFile(file);
    const cleared = await client.waitForDiagnostics(second.uri, second.beforeDiagnosticsGeneration, second.documentVersion, 2_000);
    assert.deepEqual(cleared.diagnostics, []);
  } finally {
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("does not deliver an older unversioned diagnostics publication to a newer document version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-client-order-"));
  const file = path.join(root, "index.ts");
  await writeFile(file, "const alpha = BROKEN;\n");
  const server = definition();
  const client = new LspClient({ definition: server, command: process.execPath, root }, 2_000);
  const previousDelay = process.env.FAKE_LSP_DELAY_MS;
  process.env.FAKE_LSP_DELAY_MS = "100";

  try {
    await client.start();
    const first = await client.syncFile(file);
    const firstDiagnostics = client.waitForDiagnostics(first.uri, first.beforeDiagnosticsGeneration, first.documentVersion, 2_000);

    await writeFile(file, "const alpha = 1;\n");
    const second = await client.syncFile(file);
    const secondDiagnostics = client.waitForDiagnostics(second.uri, second.beforeDiagnosticsGeneration, second.documentVersion, 2_000);

    assert.equal((await firstDiagnostics).diagnostics.length, 1);
    assert.deepEqual((await secondDiagnostics).diagnostics, []);
  } finally {
    if (previousDelay === undefined) delete process.env.FAKE_LSP_DELAY_MS;
    else process.env.FAKE_LSP_DELAY_MS = previousDelay;
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
