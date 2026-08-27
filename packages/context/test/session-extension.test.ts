import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";

import extension from "../src/index.js";
import { registerMemoryFeature } from "../src/memory/feature.js";
import {
  SessionGeneration,
  SessionIndexService,
  SessionSyncService,
} from "../src/runtime/services.js";
import { registerSessionCommands } from "../src/sessions/commands.js";
import { registerSessionFeature } from "../src/sessions/feature.js";
import { SessionIndex } from "../src/sessions/index.js";
import {
  buildSessionPrimer,
  injectSessionPrimerOnce,
} from "../src/sessions/primer.js";
import { makeSessionSyncLayer } from "../src/sessions/sync.js";
import {
  registerSessionTools,
  truncateToolText,
} from "../src/sessions/tools.js";

function host() {
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const hooks = new Map<string, any[]>();
  const pi = {
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: any) =>
      commands.set(name, command),
    on: (name: string, handler: any) =>
      hooks.set(name, [...(hooks.get(name) ?? []), handler]),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, commands, hooks };
}

function session(id: string, project: string, createdAt: string, title = id) {
  return {
    id,
    sourcePath: `/sessions/${id}.jsonl`,
    cwd: `/work/${project}`,
    project,
    title,
    summary: "",
    indexText: title,
    archived: false,
    createdAt,
    updatedAt: createdAt,
    size: 1,
    mtimeMs: 1,
  };
}

const syncResult = {
  added: 0,
  updated: 0,
  removed: 0,
  moved: 0,
  unchanged: 1,
};

describe("session extension public surface", () => {
  it("registers memory first and all session public contracts", () => {
    const names: string[] = [];
    const events: string[] = [];
    extension({
      registerTool: (tool: any) => names.push(tool.name),
      registerCommand: (name: string) => names.push(`/${name}`),
      on: (name: string) => events.push(name),
      sendMessage: vi.fn(),
    } as any);
    expect(names.slice(0, 5)).toEqual([
      "memory_search",
      "memory_remember",
      "memory_forget",
      "memory_lessons",
      "memory_stats",
    ]);
    expect(names).toEqual(
      expect.arrayContaining([
        "session_search",
        "session_list",
        "session_read",
        "/session-sync",
        "/session-reindex",
      ])
    );
    expect(events.filter((name) => name === "session_start")).toHaveLength(2);
  });

  it("builds a bounded, complete project-first/recent primer with dedup and marker", () => {
    const project = session("project", "repo", "2025-03-01T00:00:00Z");
    const recent = session("recent", "other", "2025-04-01T00:00:00Z", "🙂".repeat(200));
    const index = {
      hasFts5: true,
      isSyncing: false,
      size: () => 2,
      list: ({ project: filter }: any) =>
        filter ? [project] : [recent, project],
    } as any;
    const primer = buildSessionPrimer(index, "repo", 180);
    expect(Buffer.byteLength(primer.text, "utf8")).toBeLessThanOrEqual(180);
    expect(primer.text).toMatch(/^<recent-sessions>\n/);
    expect(primer.text).toMatch(/\n<\/recent-sessions>$/);
    expect(primer.text).toContain("project");
    expect(primer.text.match(/id: project/g)).toHaveLength(1);
    expect(primer.text).toContain("… (truncated)");
    expect(primer.truncated).toBe(true);
  });

  it("injects once without triggering a turn and intentionally skips unavailable states", () => {
    const { pi } = host();
    const indexed = {
      hasFts5: true,
      isSyncing: false,
      size: () => 1,
      list: () => [session("one", "repo", "2025-01-01T00:00:00Z")],
    } as any;
    const ctx = { cwd: "/repo", sessionManager: { getBranch: () => [] } } as any;
    expect(injectSessionPrimerOnce(pi, ctx, indexed).injected).toBe(true);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "context.session-primer" }),
      { triggerTurn: false }
    );

    const resumed = {
      ...ctx,
      sessionManager: {
        getBranch: () => [
          {
            type: "message",
            message: { role: "custom", customType: "context.session-primer" },
          },
        ],
      },
    };
    expect(injectSessionPrimerOnce(pi, resumed, indexed)).toMatchObject({
      injected: false,
      reason: "already-present",
    });
    for (const unavailable of [
      { ...indexed, hasFts5: false },
      { ...indexed, isSyncing: true },
      { ...indexed, size: () => 0 },
    ]) {
      expect(buildSessionPrimer(unavailable, "/repo").text).toBe("");
    }
  });

  it("registers and executes all tools with validation and capability diagnostics", async () => {
    const { pi, tools } = host();
    const index: any = {
      search: () => ({ status: "unavailable", diagnostic: "missing" }),
      list: () => [],
      agentDir: "/tmp",
    };
    const controller = {
      currentHandle: {
        run: (effect: any) =>
          Effect.runPromise(
            Effect.provideService(effect, SessionIndexService, index)
          ),
      },
    } as any;
    registerSessionTools(pi, controller);
    expect([...tools.keys()]).toEqual([
      "session_search",
      "session_list",
      "session_read",
    ]);
    expect(
      (await tools.get("session_search").execute("id", { query: "x" })).details
        .capability
    ).toBe("fts5");
    expect(
      (await tools.get("session_search").execute("id", { query: "x", limit: 0 }))
        .details.ok
    ).toBe(false);
    expect(
      (await tools.get("session_list").execute("id", { after: "bad" })).details
        .ok
    ).toBe(false);
  });

  it("truncates Unicode tool output on codepoint and byte boundaries", () => {
    const value = truncateToolText(`${"a".repeat(50 * 1024 - 8)}🙂🙂🙂`);
    expect(Buffer.byteLength(value, "utf8")).toBeLessThanOrEqual(50 * 1024);
    expect(value).toContain("truncated");
    expect(value).not.toContain("�");
  });

  it("executes both commands, serializes operations, clears status, and notifies", async () => {
    const { pi, commands } = host();
    let operation = Promise.resolve();
    let active = 0;
    let maximum = 0;
    const run = (fail = false) => {
      const next = operation.then(async () => {
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active--;
        if (fail) throw new Error("failed");
        return syncResult;
      });
      operation = next.then(
        () => undefined,
        () => undefined
      );
      return next;
    };
    const sync = {
      sync: () => run(),
      reindex: () => run(true),
    };
    const index = { size: () => 7 };
    const layer = Layer.merge(
      Layer.succeed(SessionSyncService, sync as any),
      Layer.succeed(SessionIndexService, index as any)
    );
    const runtime = ManagedRuntime.make(layer);
    const controller = {
      currentHandle: { run: (effect: any) => runtime.runPromise(effect) },
    } as any;
    registerSessionCommands(pi, controller);
    const ctx = {
      ui: { notify: vi.fn(), setStatus: vi.fn() },
    } as any;

    await Promise.all([
      commands.get("session-sync").handler("", ctx),
      commands.get("session-reindex").handler("", ctx),
    ]);
    expect(maximum).toBe(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Synced:"),
      "info"
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("existing session index remains available"),
      "error"
    );
    expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
      "context-sessions",
      undefined
    );
    await runtime.dispose();
  });

  it("keeps rows and FTS results unchanged when forced parsing fails", async () => {
    const db = new DatabaseSync(":memory:");
    const file = {
      path: "/managed/one.jsonl",
      archived: false,
      size: 10,
      mtimeMs: 1,
    };
    const parsed = {
      ...session("stable", "repo", "2025-01-01T00:00:00Z", "before"),
      sourcePath: file.path,
      indexText: "searchable before",
    };
    let fail = false;
    const index = new SessionIndex(db, {
      agentDir: "/managed",
      discover: async () => [file],
      identify: async () => "stable",
      parse: async () => {
        if (fail) throw new Error("parse failed");
        return parsed;
      },
    });
    await index.sync();
    const rowsBefore = db.prepare("SELECT * FROM sessions ORDER BY id").all();
    const ftsBefore = index.search("searchable");
    fail = true;
    await expect(index.rebuild()).rejects.toThrow("parse failed");
    expect(db.prepare("SELECT * FROM sessions ORDER BY id").all()).toEqual(
      rowsBefore
    );
    expect(index.search("searchable")).toEqual(ftsBefore);
    db.close();
  });

  it("runs one immediate and repeated scoped sync with ready/failed metadata", async () => {
    let calls = 0;
    const index = {
      sync: vi.fn(async () => {
        calls++;
        return syncResult;
      }),
      rebuild: vi.fn(async () => syncResult),
    };
    const base = Layer.merge(
      Layer.succeed(SessionIndexService, index as any),
      Layer.succeed(SessionGeneration, { id: 1, isCurrent: () => true })
    );
    const runtime = ManagedRuntime.make(
      makeSessionSyncLayer({
        interval: 10,
        now: () => new Date("2025-01-01T00:00:00Z"),
      }).pipe(Layer.provide(base))
    );
    const service = await runtime.runPromise(SessionSyncService);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(service.status()).toEqual({
      state: "ready",
      operation: "sync",
      completedAt: "2025-01-01T00:00:00.000Z",
    });
    await runtime.dispose();
    const disposedCalls = calls;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toBe(disposedCalls);

    const failingIndex = {
      sync: vi.fn(async () => {
        throw new Error("nope");
      }),
      rebuild: vi.fn(),
    };
    const failingBase = Layer.merge(
      Layer.succeed(SessionIndexService, failingIndex as any),
      Layer.succeed(SessionGeneration, { id: 2, isCurrent: () => true })
    );
    const failingRuntime = ManagedRuntime.make(
      makeSessionSyncLayer({ interval: 100 }).pipe(Layer.provide(failingBase))
    );
    const failingService = await failingRuntime.runPromise(SessionSyncService);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(failingService.status()).toEqual({
      state: "failed",
      operation: "sync",
      diagnostic: "Session index operation failed; retry with /session-sync.",
    });
    await failingRuntime.dispose();
  });

  it("executes combined startup handlers in order, starts once, and isolates session failure", async () => {
    const { pi, hooks } = host();
    const order: string[] = [];
    const handle = {
      run: vi.fn(async () => {
        order.push(order.length === 1 ? "memory" : "session");
        if (order.at(-1) === "session") throw new Error("optional");
      }),
    };
    const controller = {
      currentHandle: undefined as any,
      start: vi.fn(async () => {
        order.push("start");
        controller.currentHandle = handle;
        return handle;
      }),
      shutdown: vi.fn(),
    } as any;
    registerMemoryFeature(pi, controller);
    registerSessionFeature(pi, controller);
    const ctx = {
      cwd: "/repo",
      sessionManager: { getBranch: () => [], getSessionId: () => "id" },
      ui: { notify: vi.fn() },
    } as any;
    for (const handler of hooks.get("session_start") ?? []) {
      await handler({}, ctx);
    }
    expect(order).toEqual(["start", "memory", "session"]);
    expect(controller.start).toHaveBeenCalledOnce();
    expect(controller.currentHandle).toBe(handle);
    expect(hooks.get("session_shutdown")).toHaveLength(1);
  });
});
