import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";

import extension from "../src/index.js";
import {
  extractAgentTranscript,
  registerMemoryFeature,
} from "../src/memory/feature.js";
import { MemoryStore } from "../src/memory/store.js";
import { registerMemoryTools } from "../src/memory/tools.js";
import {
  MemoryStoreService,
  PiModelBridge,
  modelWorkGateLayer,
} from "../src/runtime/services.js";

function lifecycleHost() {
  const hooks = new Map<string, (...args: any[]) => Promise<void>>();
  const pi = {
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: (name: string, handler: (...args: any[]) => Promise<void>) =>
      hooks.set(name, handler),
    sendMessage: vi.fn(),
  } as any;
  return { pi, hooks };
}

const lifecycleContext = () =>
  ({
    cwd: "/project",
    sessionManager: {
      getBranch: () => [],
      getSessionId: () => "session",
    },
    ui: { notify: vi.fn() },
  } as any);

describe("memory extension contract", () => {
  it("registers five tools, command, and lifecycle hooks", () => {
    const tools: string[] = [],
      commands: string[] = [],
      events: string[] = [];
    extension({
      registerTool: (tool: any) => tools.push(tool.name),
      registerCommand: (name: string) => commands.push(name),
      on: (name: string) => events.push(name),
    } as any);
    expect(tools.filter((name) => name.startsWith("memory_"))).toEqual([
      "memory_search",
      "memory_remember",
      "memory_forget",
      "memory_lessons",
      "memory_stats",
    ]);
    expect(tools.filter((name) => name === "recall")).toEqual(["recall"]);
    expect(commands).toEqual(expect.arrayContaining(["memory-consolidate"]));
    expect(events).toEqual(expect.arrayContaining([
      "session_start",
      "agent_end",
      "session_before_switch",
      "session_shutdown",
    ]));
  });

  it("captures only authored text and excludes hidden/custom/tool/image/empty payloads", () => {
    const result = extractAgentTranscript({
      messages: [
        {
          role: "user",
          customType: "context.memory",
          content: [{ type: "text", text: "SECRET MEMORY" }],
        },
        {
          role: "user",
          synthetic: true,
          content: [{ type: "text", text: "synthetic" }],
        },
        {
          role: "user",
          content: [
            { type: "image", data: "secret" },
            { type: "text", text: " hello " },
          ],
        },
        {
          role: "assistant",
          content: [
            { type: "toolCall", arguments: { token: "secret" } },
            { type: "text", text: " answer " },
          ],
        },
        { role: "toolResult", content: [{ type: "text", text: "payload" }] },
        { role: "user", content: [{ type: "text", text: " " }] },
      ],
    } as any);
    expect(result).toEqual({
      transcript: "user: hello\n\nassistant: answer",
      userCount: 1,
    });
    expect(result.transcript).not.toContain("SECRET");
  });

  it("keeps the active runtime after optional injection fails", async () => {
    const { pi, hooks } = lifecycleHost();
    const handle = {
      run: vi.fn().mockRejectedValue(new Error("inject failed")),
    };
    const controller = {
      currentHandle: handle,
      start: vi.fn().mockResolvedValue(handle),
      shutdown: vi.fn(),
    } as any;
    const ctx = lifecycleContext();
    registerMemoryFeature(pi, controller);

    await hooks.get("session_start")!({}, ctx);

    expect(controller.currentHandle).toBe(handle);
    expect(controller.shutdown).not.toHaveBeenCalled();
  });

  it("always shuts down after consolidation fails", async () => {
    const { pi, hooks } = lifecycleHost();
    const controller = {
      currentHandle: {
        run: vi.fn().mockRejectedValue(new Error("model failed")),
      },
      start: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as any;
    const ctx = lifecycleContext();
    registerMemoryFeature(pi, controller);

    await hooks.get("session_shutdown")!({}, ctx);

    expect(controller.shutdown).toHaveBeenCalledOnce();
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("consolidation deferred"),
      "warning"
    );
  });

  it("serializes concurrent consolidation through the shared gate", async () => {
    const { pi, hooks } = lifecycleHost();
    const db = new DatabaseSync(":memory:");
    const store = new MemoryStore(db, { disableFts: true });
    for (let index = 0; index < 3; index++) {
      store.addPendingEvent(`s${index}`, "/project", `user: ${index}`, 1);
    }
    let active = 0;
    let maximumActive = 0;
    const bridge = {
      complete: () =>
        Effect.promise(async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await new Promise((resolve) => setTimeout(resolve, 20));
          active -= 1;
          return {
            role: "assistant",
            content: [{ type: "text", text: '{"facts":[],"lessons":[]}' }],
          } as any;
        }),
    } as any;
    const layer = Layer.mergeAll(
      Layer.succeed(MemoryStoreService, store),
      Layer.succeed(PiModelBridge, bridge),
      modelWorkGateLayer
    );
    const runtime = ManagedRuntime.make(layer);
    const handle = {
      run: (effect: any) => runtime.runPromise(effect),
    };
    const controller = {
      currentHandle: handle,
      start: vi.fn(),
      shutdown: vi.fn(),
    } as any;
    const ctx = lifecycleContext();
    registerMemoryFeature(pi, controller);

    await Promise.all([
      hooks.get("session_before_switch")!({}, ctx),
      hooks.get("session_before_switch")!({}, ctx),
    ]);

    expect(maximumActive).toBe(1);
    await runtime.dispose();
    db.close();
  });

  it("executes all five tools with validation behavior and structured details", async () => {
    const db = new DatabaseSync(":memory:");
    const store = new MemoryStore(db, { disableFts: true });
    const tools = new Map<string, any>();
    const controller = {
      currentHandle: {
        run: (effect: any) =>
          Effect.runPromise(
            Effect.provideService(effect, MemoryStoreService, store)
          ),
      },
    } as any;
    registerMemoryTools(
      { registerTool: (tool: any) => tools.set(tool.name, tool) } as any,
      controller
    );
    const ctx = { cwd: "/project" } as any;
    const run = (name: string, params: any = {}) =>
      tools.get(name).execute("id", params, undefined, undefined, ctx);

    expect(
      (
        await run("memory_remember", {
          type: '"fact"',
          key: '"pref.editor"',
          value: '"vim"',
        })
      ).details.ok
    ).toBe(true);
    expect((await run("memory_remember", { type: "fact" })).details.ok).toBe(
      false
    );
    expect(
      (
        await run("memory_remember", {
          type: "lesson",
          rule: "Use focused tests",
        })
      ).details.ok
    ).toBe(true);
    expect(
      (await run("memory_search", { query: "vim", limit: 500 })).details.limit
    ).toBe(10);
    const lessons = await run("memory_lessons", { limit: 0 });
    expect(lessons.details.limit).toBe(50);
    expect((await run("memory_stats")).details).toMatchObject({
      facts: 1,
      lessons: 1,
    });
    expect(
      (await run("memory_forget", { type: '"fact"', key: '"pref.editor"' }))
        .details.ok
    ).toBe(true);
    db.close();
  });

  it("truncates oversized tool text while retaining full structured details", async () => {
    const long = "x".repeat(13_000);
    const fake = {
      searchFacts: () => [
        { key: "k", value: long, confidence: 0.9, source: "user" },
      ],
      searchLessons: () => [],
    };
    const tools = new Map<string, any>();
    const controller = {
      currentHandle: {
        run: (effect: any) =>
          Effect.runPromise(
            Effect.provideService(effect, MemoryStoreService, fake as any)
          ),
      },
    } as any;
    registerMemoryTools(
      { registerTool: (tool: any) => tools.set(tool.name, tool) } as any,
      controller
    );
    const result = await tools
      .get("memory_search")
      .execute("id", { query: "x" }, undefined, undefined, { cwd: "/p" });
    expect(result.content[0].text).toContain("truncated");
    expect(result.details.facts[0].value).toHaveLength(13_000);
  });
});
