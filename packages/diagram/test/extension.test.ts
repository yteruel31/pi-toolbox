import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import diagramExtension from "../src/index.js";
import { DEFAULT_HOSTING_SETTINGS } from "../src/config.js";
import { DiagramRuntimeController } from "../src/runtime.js";
import { DiagramService } from "../src/service.js";
import { DiagramStore } from "../src/store.js";
import { registerDiagramTool } from "../src/tool.js";

test("registers exactly one native tool, one command, and lazy lifecycle handlers", () => {
  const tools: unknown[] = [];
  const commands: string[] = [];
  const handlers = new Map<string, unknown>();
  const pi = {
    registerTool: (tool: unknown) => tools.push(tool),
    registerCommand: (name: string) => commands.push(name),
    on: (event: string, handler: unknown) => handlers.set(event, handler),
  } as unknown as ExtensionAPI;
  diagramExtension(pi);
  assert.equal(tools.length, 1);
  assert.deepEqual(commands, ["diagram"]);
  assert.deepEqual([...handlers.keys()], ["session_start", "session_shutdown"]);
});

test("close cannot be raced by an in-flight lazy host start", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-service-race-"));
  const service = new DiagramService({
    config: { hosting: { ...DEFAULT_HOSTING_SETTINGS, mode: "local", port: 0 } },
    store: new DiagramStore(directory),
  });
  try {
    const starting = service.ensureHost();
    const closing = service.close();
    await assert.rejects(starting, /closed while the host was starting/);
    await closing;
    await assert.rejects(() => service.ensureHost(), /service is closed/);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("serializes complete configuration transactions and restores before the next candidate", async () => {
  const config = (port: number) => ({ hosting: { ...DEFAULT_HOSTING_SETTINGS, mode: "local" as const, port } });
  const runtime = new DiagramRuntimeController({ loadConfig: async () => config(19000) });
  let releaseFirst!: () => void;
  let firstStarted!: () => void;
  const started = new Promise<void>((resolve) => { firstStarted = resolve; });
  const release = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const order: string[] = [];
  const first = runtime.transactConfig(config(19001), async (candidate) => {
    order.push(`first:${candidate.settings.port}`);
    firstStarted();
    await release;
    throw new Error("candidate failed");
  });
  await started;
  const second = runtime.transactConfig(config(19002), async (candidate) => {
    order.push(`second:${candidate.settings.port}`);
    return candidate.settings.port;
  });
  releaseFirst();
  await assert.rejects(first, /candidate failed/);
  assert.equal(await second, 19002);
  assert.deepEqual(order, ["first:19001", "second:19002"]);
  assert.equal((await runtime.getService()).settings.port, 19002);
  await runtime.shutdown();
});

test("create and update return inline PNG previews and a live viewer URL", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-diagram-tool-"));
  const service = new DiagramService({
    config: { hosting: { ...DEFAULT_HOSTING_SETTINGS, mode: "local", port: 0 } },
    store: new DiagramStore(directory),
  });
  let tool: any;
  const pi = { registerTool: (value: unknown) => { tool = value; } } as unknown as ExtensionAPI;
  registerDiagramTool(pi, async () => service);
  try {
    const created = await tool.execute("call-1", {
      action: "create",
      title: "Request path",
      spec: { nodes: [{ id: "web", label: "Web" }, { id: "api", label: "API" }], edges: [{ from: "web", to: "api" }] },
    }, new AbortController().signal);
    assert.equal(created.content[1].type, "image");
    assert.equal(created.content[1].mimeType, "image/png");
    assert.match(created.content[0].text, /http:\/\/127\.0\.0\.1:/);
    assert.match(created.content[0].text, /Review:/);
    const id = created.details.id;
    const updated = await tool.execute("call-2", { action: "update", id, patch: { set_nodes: [{ id: "api", label: "Public API" }] } }, new AbortController().signal);
    assert.equal(updated.details.revision, 2);
    assert.equal((await service.store.get(id))!.spec.nodes.find((node) => node.id === "api")?.label, "Public API");
    const reviewed = await tool.execute("call-3", { action: "review", id }, new AbortController().signal);
    assert.equal(reviewed.content[1].type, "image");
    assert.equal(reviewed.content[1].mimeType, "image/png");
    assert.match(reviewed.content[0].text, /Review:/);
    assert.doesNotMatch(reviewed.content[0].text, /https?:\/\//);
    assert.equal(reviewed.details.url, undefined);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
