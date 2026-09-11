import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import webAccess, { TOOL_NAMES, registerTools } from "../src/index.js";
import { parseConfig } from "../src/config.js";
import { WebService } from "../src/service.js";
import { ResearchManager } from "../src/research.js";

function harness(existing: string[] = []) {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const notifications: string[] = [];
  const pi = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler), getAllTools: () => existing.map((name) => ({ name })) } as unknown as ExtensionAPI;
  const ctx = { cwd: "/tmp", hasUI: true, scopedModels: [], ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionContext;
  return { pi, tools, handlers, notifications, ctx };
}
async function isolated(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "web-register-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = directory;
  try { await run(directory); } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(directory, { recursive: true, force: true }); }
}
test("factory is inert, then registers exactly five tools after collision inspection", () => isolated(async () => {
  const h = harness(); webAccess(h.pi);
  assert.equal(h.tools.size, 0);
  await h.handlers.get("session_start")!({}, h.ctx);
  assert.deepEqual([...h.tools.keys()], TOOL_NAMES);
  await h.handlers.get("session_shutdown")!({}, h.ctx);
}));
test("any existing tool collision disables the whole package without replacement", () => isolated(async () => {
  const h = harness(["fetch_content"]); webAccess(h.pi);
  await h.handlers.get("session_start")!({}, h.ctx);
  assert.equal(h.tools.size, 0); assert.match(h.notifications[0]!, /No tools were replaced/);
}));
test("collisions remain observable without a UI", () => isolated(async () => {
  const h = harness(["web_search"]); webAccess(h.pi);
  await assert.rejects(h.handlers.get("session_start")!({}, { ...h.ctx, hasUI: false }), /collisions/);
}));
test("explicitly disabled configuration registers nothing", () => isolated(async (directory) => {
  await writeFile(join(directory, "web-access.json"), JSON.stringify({ enabled: false }));
  const h = harness(); webAccess(h.pi);
  await h.handlers.get("session_start")!({}, h.ctx); assert.equal(h.tools.size, 0);
}));
test("registered tools revalidate mutated arguments and retrieve bounded cache content", () => isolated(async (directory) => {
  const config = parseConfig({}, directory); const service = new WebService(config);
  const research = new ResearchManager(config, join(directory, "jobs")); const h = harness();
  registerTools(h.pi, config, service, research);
  await assert.rejects(h.tools.get("web_search")!.execute("id", { provider: "unknown", query: "q" }, undefined, undefined, h.ctx), /Invalid/);
  const responseId = await service.store.put([{ title: "Document", content: "0123456789" }]);
  const result = await h.tools.get("get_search_content")!.execute("id", { responseId, offset: 2, limit: 3 }, undefined, undefined, h.ctx);
  const text = result.content.find((block) => block.type === "text")!;
  assert.equal(JSON.parse(text.text).content, "234");
  await research.stop();
}));
test("invalid synthesize arguments fail before any search request", () => isolated(async (directory) => {
  const config = parseConfig({}, directory); const service = new WebService(config); let calls = 0;
  service.search = async () => { calls++; return []; };
  const research = new ResearchManager(config, join(directory, "jobs")); const h = harness(); registerTools(h.pi, config, service, research);
  await assert.rejects(h.tools.get("web_search")!.execute("id", { query: "q", answerModel: "openai/test" }, undefined, undefined, h.ctx), /synthesize/);
  assert.equal(calls, 0); await research.stop();
}));
