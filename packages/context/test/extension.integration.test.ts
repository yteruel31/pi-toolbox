import { access, mkdir, mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import { registerContextFeatures } from "../src/index.js";
import { buildKnowledgeOverview } from "../src/knowledge/overview.js";
import { buildMemoryInjection } from "../src/memory/injector.js";
import { createContextRuntimeController } from "../src/runtime/context-runtime.js";
import { buildSessionPrimer } from "../src/sessions/primer.js";

function host() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const hooks = new Map<string, any[]>();
  const sent: any[] = [];
  const pi: any = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (name: string, handler: any) => hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    sendMessage: vi.fn((message: any, options: any) => sent.push({ message, options })),
    appendEntry: vi.fn(),
  };
  return { pi, tools, commands, hooks, sent };
}

const expectedTools = [
  "memory_search", "memory_remember", "memory_forget", "memory_lessons", "memory_stats",
  "session_search", "session_list", "session_read", "knowledge_search", "kb_read", "recall",
];
const expectedCommands = [
  "memory-consolidate", "session-sync", "session-reindex", "knowledge-search-setup",
  "knowledge-overview", "knowledge-refresh", "knowledge-reindex", "om:status", "om:view",
];

describe("final extension integration contract", () => {
  it("registers eagerly but starts exactly one fresh session runtime lazily", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "context-integration-"));
    await mkdir(path.join(agentDir, "context"));
    const real = createContextRuntimeController({ agentDir });
    const controller: any = {
      get activeGeneration() { return real.activeGeneration; },
      get currentHandle() { return real.currentHandle; },
      start: vi.fn((ctx: any) => real.start(ctx)),
      shutdown: vi.fn(() => real.shutdown()),
    };
    const { pi, tools, commands, hooks, sent } = host();
    registerContextFeatures(pi, controller);

    expect([...tools]).toEqual(expectedTools.map((name) => [name, expect.anything()]));
    expect([...commands.keys()]).toEqual(expectedCommands);
    expect(hooks.get("session_start")).toHaveLength(2);
    expect(hooks.get("session_shutdown")).toHaveLength(1);
    expect(hooks.get("session_before_compact")).toHaveLength(1);
    expect(controller.start).not.toHaveBeenCalled();
    expect(await readdir(path.join(agentDir, "context"))).toEqual([]);

    const ctx: any = {
      cwd: agentDir,
      model: undefined,
      thinkingLevel: "off",
      modelRegistry: { find: vi.fn(), complete: vi.fn() },
      sessionManager: { getBranch: () => [], getSessionId: () => "integration" },
      ui: { notify: vi.fn() },
      isIdle: () => true,
      hasPendingMessages: () => false,
      getContextUsage: () => undefined,
      compact: vi.fn(),
    };
    for (const start of hooks.get("session_start")!) await start({}, ctx);
    expect(controller.start).toHaveBeenCalledOnce();
    expect(controller.currentHandle?.isCurrent()).toBe(true);
    expect((await readdir(path.join(agentDir, "context"))).filter((name) => name.endsWith(".db")).sort()).toEqual([
      "knowledge.db", "memory.db", "sessions.db",
    ]);
    for (const old of ["memory", "sessions", "knowledge"]) await expect(access(path.join(agentDir, "context", old))).rejects.toThrow();

    expect(sent.every(({ options }) => options.triggerTurn === false)).toBe(true);
    const memory = buildMemoryInjection({
      listFacts: () => Array.from({ length: 100 }, (_, i) => ({ key: `fact.${i}`, value: "x".repeat(200) })),
      listLessons: () => [],
    } as any, agentDir).text;
    const sessions = buildSessionPrimer({
      hasFts5: true, isSyncing: false, size: () => 100,
      list: () => Array.from({ length: 100 }, (_, i) => ({ id: `session-${i}`, project: "repo", title: "x".repeat(100), createdAt: "2025-01-01" })),
    } as any, agentDir).text;
    const knowledge = buildKnowledgeOverview({
      size: () => 100,
      listFiles: () => Array.from({ length: 100 }, (_, i) => ({ relativePath: `file-${i}.md`, headings: ["x".repeat(100)] })),
    } as any).text;
    expect(Buffer.byteLength(memory)).toBeLessThanOrEqual(8 * 1024);
    expect(Buffer.byteLength(sessions)).toBeLessThanOrEqual(1536);
    expect(Buffer.byteLength(knowledge)).toBeLessThanOrEqual(6 * 1024);
    expect(Buffer.byteLength(memory) + Buffer.byteLength(sessions) + Buffer.byteLength(knowledge)).toBeLessThanOrEqual(16 * 1024);
    expect([memory, sessions, knowledge].every((text) => /^<(memory|recent-sessions|knowledge-overview)>/.test(text) && /<\/(memory|recent-sessions|knowledge-overview)>$/.test(text))).toBe(true);

    const stale = controller.currentHandle;
    await hooks.get("session_shutdown")![0]({}, ctx);
    expect(controller.shutdown).toHaveBeenCalledOnce();
    expect(controller.currentHandle).toBeUndefined();
    expect(stale.isCurrent()).toBe(false);
    await expect(tools.get("memory_stats").execute("", {}, undefined, undefined, ctx)).rejects.toThrow(/not initialized/i);
  });
});
