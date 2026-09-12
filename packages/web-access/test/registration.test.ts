import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, defineTool, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import webAccess, { CORE_TOOL_NAMES, registerTools } from "../src/index.js";
import { parseConfig } from "../src/config.js";
import { WebService } from "../src/service.js";
import { ResearchManager } from "../src/research.js";
import { validateRedditConfig } from "../src/reddit-config.js";

function harness(existing: string[] = []) {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => Promise<void>>();
  const notifications: string[] = [];
  const pi = { registerCommand: () => {}, registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), on: (name: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void>) => handlers.set(name, handler), getAllTools: () => existing.map((name) => ({ name, sourceInfo: { source: "sdk" } })) } as unknown as ExtensionAPI;
  const ctx = { cwd: "/tmp", hasUI: true, scopedModels: [], ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionContext;
  return { pi, tools, handlers, notifications, ctx };
}
async function isolated(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "web-register-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = directory;
  try { await run(directory); } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(directory, { recursive: true, force: true }); }
}
test("factory is inert, then registers core tools and the always-visible diagnostic", () => isolated(async () => {
  const h = harness(); webAccess(h.pi);
  assert.equal(h.tools.size, 0);
  await h.handlers.get("session_start")!({}, h.ctx);
  assert.deepEqual([...h.tools.keys()], [...CORE_TOOL_NAMES, "reddit_profile_diagnostic"]);
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

test("actual SDK preserves customTools ownership when a startup collision is detected", () => isolated(async (directory) => {
  const previousOffline = process.env.PI_OFFLINE; process.env.PI_OFFLINE = "1";
  try {
    const collision = defineTool({ name: "reddit_profile_diagnostic", label: "SDK diagnostic", description: "SDK-owned collision", parameters: Type.Object({}), async execute() { return { content: [{ type: "text" as const, text: "sdk" }], details: {} }; } });
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(), extensionFactories: [{ name: "web-access-test", factory: webAccess }], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), settingsManager: SettingsManager.inMemory(), customTools: [collision], noTools: "builtin" });
    await session.bindExtensions({ mode: "print" });
    const tools = session.getAllTools();
    assert.equal(tools.find((tool) => tool.name === "reddit_profile_diagnostic")?.sourceInfo.source, "sdk");
    assert.equal(tools.some((tool) => tool.name === "web_search"), false);
    session.dispose();
  } finally { if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline; }
}));

test("actual SDK recreates startup registration from persisted readiness, including transient busy, on reload", () => isolated(async (directory) => {
  const previousOffline = process.env.PI_OFFLINE; process.env.PI_OFFLINE = "1";
  try {
    const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager: SettingsManager.inMemory(), extensionFactories: [{ name: "web-access-test", factory: webAccess }], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await loader.reload();
    const { session } = await createAgentSession({ cwd: directory, agentDir: directory, resourceLoader: loader, sessionManager: SessionManager.inMemory(directory), settingsManager: SettingsManager.inMemory(), noTools: "builtin" });
    const extensionErrors: string[] = [];
    await session.bindExtensions({ mode: "print", onError: (error) => extensionErrors.push(error.error) });
    assert.deepEqual(session.getAllTools().filter((tool) => tool.sourceInfo.source !== "builtin").map((tool) => tool.name), [...CORE_TOOL_NAMES, "reddit_profile_diagnostic"]);
    const profile = join(directory, "reddit-profile"); await mkdir(profile, { mode: 0o700 });
    await writeFile(join(directory, "web-access.json"), JSON.stringify({ reddit: { profileDir: profile, executablePath: "/bin/true" } }));
    const config = parseConfig({ reddit: { profileDir: profile, executablePath: "/bin/true" } }, directory);
    const validated = await validateRedditConfig(config);
    await writeFile(join(validated.stateDir, "validation.json"), JSON.stringify({ version: 1, identity: validated.identity, status: "ready", validatedAt: new Date(0).toISOString() }), { mode: 0o600 });
    // A tool session may already hold the profile when another session starts.
    // Cached readiness still permits registration; runtime calls join the queue.
    await writeFile(join(profile, ".pi-web-access-reddit.lock"), "busy\n", { mode: 0o600 });
    await session.reload();
    assert.deepEqual(extensionErrors, []);
    const tools = session.getAllTools().filter((tool) => tool.sourceInfo.source !== "builtin");
    assert.deepEqual(tools.map((tool) => tool.name), [...CORE_TOOL_NAMES, "reddit_profile_diagnostic", "reddit_search", "reddit_fetch_content"]);
    assert.ok(tools.every((tool) => tool.sourceInfo.source !== "sdk"));
    session.dispose();
  } finally { if (previousOffline === undefined) delete process.env.PI_OFFLINE; else process.env.PI_OFFLINE = previousOffline; }
}));
