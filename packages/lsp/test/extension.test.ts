import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import lspExtension from "../src/index.js";

const fakeServer = path.join(import.meta.dirname, "fixtures", "fake-lsp-server.mjs");

test("wires merged write diagnostics into model content and a post-result transcript entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-extension-"));
  await mkdir(path.join(root, ".pi"));
  await writeFile(path.join(root, ".pi", "lsp.json"), JSON.stringify({
    servers: {
      fake: {
        command: process.execPath,
        args: [fakeServer, "--name=typescript", "--token=BROKEN"],
        fileTypes: [".ts"],
        rootMarkers: ["."],
        languageId: "typescript",
        priority: 0,
      },
      biome: {
        command: process.execPath,
        args: [fakeServer, "--name=biome", "--token=BIOME"],
        fileTypes: [".ts"],
        rootMarkers: ["."],
        languageId: "typescript",
        features: { diagnostics: true, semantics: false },
        priority: 1,
      },
    },
  }));
  await writeFile(path.join(root, "index.ts"), "const alpha = BROKEN + BIOME;\n");

  const handlers = new Map<string, (...args: any[]) => any>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerTool: () => undefined,
    registerEntryRenderer: () => undefined,
    registerMessageRenderer: () => undefined,
    appendEntry: (type: string, data: unknown) => entries.push({ type, data }),
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  lspExtension(pi);

  const ctx = {
    cwd: root,
    mode: "tui",
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;

  try {
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    const patched = await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "write",
      toolCallId: "write-1",
      input: { path: "index.ts", content: "const alpha = BROKEN + BIOME;\n" },
      content: [{ type: "text", text: "Wrote index.ts" }],
      details: undefined,
      isError: false,
    }, ctx);
    assert.match(patched.content.at(-1).text, /typescript:typescript-error BROKEN is not valid/);
    assert.match(patched.content.at(-1).text, /biome:biome-error BIOME is not valid/);
    assert.equal(entries.length, 0, "card waits for the finalized tool result message");

    await handlers.get("message_end")?.({ message: { role: "toolResult", toolCallId: "write-1" } }, ctx);
    assert.equal(entries.length, 1);
    assert.equal((entries[0]?.data as { file?: string }).file, "index.ts");
  } finally {
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    await rm(root, { recursive: true, force: true });
  }
});

test("defers slow diagnostics without blocking the write result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-lsp-extension-delayed-"));
  await mkdir(path.join(root, ".pi"));
  await writeFile(path.join(root, ".pi", "lsp.json"), JSON.stringify({
    diagnostics: { inlineTimeoutMs: 50, deferredTimeoutMs: 1_000 },
    servers: {
      fake: {
        command: process.execPath,
        args: [fakeServer],
        fileTypes: [".ts"],
        rootMarkers: ["."],
        languageId: "typescript",
        priority: 0,
      },
    },
  }));
  await writeFile(path.join(root, "index.ts"), "const alpha = BROKEN;\n");

  const handlers = new Map<string, (...args: any[]) => any>();
  const messages: Array<{ content: string; details: unknown }> = [];
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerTool: () => undefined,
    registerEntryRenderer: () => undefined,
    registerMessageRenderer: () => undefined,
    appendEntry: () => undefined,
    sendMessage: (message: { content: string; details: unknown }) => messages.push(message),
  } as unknown as ExtensionAPI;
  lspExtension(pi);
  const ctx = { cwd: root, mode: "tui", isProjectTrusted: () => true } as unknown as ExtensionContext;
  const previousDelay = process.env.FAKE_LSP_DELAY_MS;
  process.env.FAKE_LSP_DELAY_MS = "150";

  try {
    await handlers.get("session_start")?.({ reason: "startup" }, ctx);
    const started = Date.now();
    const patched = await handlers.get("tool_result")?.({
      type: "tool_result",
      toolName: "write",
      toolCallId: "write-delayed",
      input: { path: "index.ts", content: "const alpha = BROKEN;\n" },
      content: [{ type: "text", text: "Wrote index.ts" }],
      details: undefined,
      isError: false,
    }, ctx);
    assert.equal(patched, undefined);
    assert.ok(Date.now() - started < 140, "write result should return before delayed diagnostics");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(messages.length, 1);
    assert.match(messages[0]?.content ?? "", /\[delayed\]/);
  } finally {
    if (previousDelay === undefined) delete process.env.FAKE_LSP_DELAY_MS;
    else process.env.FAKE_LSP_DELAY_MS = previousDelay;
    await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
    await rm(root, { recursive: true, force: true });
  }
});
