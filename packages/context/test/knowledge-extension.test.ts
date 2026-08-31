import { DatabaseSync } from "node:sqlite";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, expect, it, vi } from "vitest";
import extension, { registerContextFeatures } from "../src/index.js";
import {
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_KNOWLEDGE_CONFIG,
} from "../src/config/schema.js";
import { writeContextConfig } from "../src/config/write.js";
import {
  parseKnowledgeSetupArgs,
  registerKnowledgeCommands,
} from "../src/knowledge/commands.js";
import { KnowledgeIndex } from "../src/knowledge/index.js";
import {
  buildKnowledgeOverview,
  injectKnowledgeOverviewOnce,
} from "../src/knowledge/overview.js";
import { registerKnowledgeTools } from "../src/knowledge/tools.js";
import { makeKnowledgeSyncLayer } from "../src/knowledge/sync.js";
import {
  KnowledgeIndexService,
  KnowledgeSyncService,
  SessionGeneration,
} from "../src/runtime/services.js";

const host = () => {
  const tools = new Map<string, any>(),
    commands = new Map<string, any>(),
    hooks = new Map<string, any[]>();
  const pi: any = {
    registerTool: (x: any) => tools.set(x.name, x),
    registerCommand: (n: string, x: any) => commands.set(n, x),
    on: (n: string, x: any) => hooks.set(n, [...(hooks.get(n) ?? []), x]),
    sendMessage: vi.fn(),
  };
  return { pi, tools, commands, hooks };
};

describe("knowledge extension", () => {
  it("parses only the approved setup fields", () => {
    expect(
      parseKnowledgeSetupArgs(
        "--roots ~/a,~/b --extensions md,txt --excludes .git,tmp"
      )
    ).toEqual({
      roots: ["~/a", "~/b"],
      extensions: ["md", "txt"],
      excludes: [".git", "tmp"],
    });
    expect(
      parseKnowledgeSetupArgs('{"roots":["/notes"],"extensions":["md"]}')
    ).toEqual({
      roots: ["/notes"],
      extensions: ["md"],
    });
    for (const rejected of [
      "--provider local",
      "--embedder x",
      "--vector x",
      '{"provider":"x"}',
      '{"unknown":[]}',
    ]) {
      expect(() => parseKnowledgeSetupArgs(rejected)).toThrow(
        /only roots|only the approved/i
      );
    }
  });

  it("writes private config atomically and refuses config symlinks", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "context-config-"));
    const directory = path.join(parent, "context");
    const file = path.join(directory, "config.json");
    await writeContextConfig(file, DEFAULT_CONTEXT_CONFIG);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(
      DEFAULT_CONTEXT_CONFIG
    );
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);

    const target = path.join(parent, "target.json");
    await writeFile(target, "unchanged");
    const linked = path.join(directory, "linked.json");
    await symlink(target, linked);
    await expect(
      writeContextConfig(linked, DEFAULT_CONTEXT_CONFIG)
    ).rejects.toThrow(/symbolic link/);
    expect(await readFile(target, "utf8")).toBe("unchanged");
  });
  it("registers public tools and commands after memory and sessions", () => {
    const { pi, tools, commands, hooks } = host();
    extension(pi);
    const registered = [...tools.keys()];
    const memory = registered.indexOf("memory_stats");
    const session = registered.indexOf("session_read");
    const knowledge = registered.indexOf("knowledge_search");
    const recall = registered.indexOf("recall");
    expect(registered.filter((name) => ["knowledge_search", "kb_read"].includes(name))).toEqual(["knowledge_search", "kb_read"]);
    expect(memory).toBeLessThan(session);
    expect(session).toBeLessThan(knowledge);
    expect(knowledge).toBeLessThan(recall);
    expect([...commands.keys()].filter((name) => name.startsWith("knowledge-"))).toEqual([
      "knowledge-search-setup",
      "knowledge-overview",
      "knowledge-refresh",
      "knowledge-reindex",
    ]);
    expect(hooks.get("session_start")).toHaveLength(2);
  });
  it("bounds tool validation, FTS diagnostics, output, and structured excerpts", async () => {
    const db = new DatabaseSync(":memory:");
    const index = new KnowledgeIndex(db, DEFAULT_KNOWLEDGE_CONFIG, {
      disableFts: true,
    });
    const { pi, tools } = host();
    const controller: any = {
      currentHandle: {
        run: (e: any) =>
          Effect.runPromise(
            Effect.provideService(e, KnowledgeIndexService, index)
          ),
      },
    };
    registerKnowledgeTools(pi, controller);
    expect(
      (await tools.get("knowledge_search").execute("", { query: "x" })).details
        .capability
    ).toBe("fts5");
    expect(
      (
        await tools
          .get("knowledge_search")
          .execute("", { query: "x", limit: 0 })
      ).details.ok
    ).toBe(false);
    expect(
      (await tools.get("kb_read").execute("", { name: "x", max_bytes: 0 }))
        .details.ok
    ).toBe(false);
    db.close();
  });
  it("builds deterministic complete bounded overview and injects once without a turn", () => {
    const files = Array.from({ length: 200 }, (_, i) => ({
      id: i,
      path: `/r/f${i}.md`,
      root: "/r",
      relativePath: `folder/f${i}.md`,
      size: 1,
      mtimeMs: 1,
      chunkCount: 1,
      headings: [`Alpha Topic ${i}`],
    }));
    const index: any = { size: () => files.length, listFiles: () => files };
    const built = buildKnowledgeOverview(index);
    expect(Buffer.byteLength(built.text)).toBeLessThanOrEqual(6144);
    expect(built.text).toMatch(/^<knowledge-overview>/);
    expect(built.text).toMatch(/<\/knowledge-overview>$/);
    const { pi } = host();
    const ctx: any = { sessionManager: { getBranch: () => [] } };
    expect(injectKnowledgeOverviewOnce(pi, ctx, index).injected).toBe(true);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "context.knowledge-overview" }),
      { triggerTurn: false }
    );
    expect(
      injectKnowledgeOverviewOnce(
        pi,
        {
          sessionManager: {
            getBranch: () => [{ customType: "context.knowledge-overview" }],
          },
        } as any,
        index
      ).injected
    ).toBe(false);
  });

  it("runs setup handler preserving models and limits before one terminal reload", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "knowledge-setup-"));
    const second = await mkdtemp(path.join(os.tmpdir(), "knowledge-root-"));
    const first = await mkdtemp(path.join(os.tmpdir(), "knowledge-root-"));
    const { pi, commands } = host();
    const limits = {
      maxRoots: 7,
      maxFiles: 99,
      maxDepth: 8,
      maxFileBytes: 1234,
      maxTotalBytes: 5678,
    };
    const models = {
      observer: {
        provider: "custom",
        model: "observer-x",
        thinkingLevel: "high",
      },
    };
    registerKnowledgeCommands(
      pi,
      {
        currentHandle: {
          config: {
            version: 1,
            models,
            knowledge: { ...DEFAULT_KNOWLEDGE_CONFIG, limits },
          },
        },
      } as any,
      { agentDir }
    );
    const order: string[] = [];
    const ctx: any = {
      hasUI: false,
      ui: { notify: vi.fn(() => order.push("notify")) },
      reload: vi.fn(async () => {
        order.push("reload");
      }),
    };
    await commands
      .get("knowledge-search-setup")
      .handler(
        `--roots ${second},${first} --extensions .MD,TXT --excludes tmp,.cache`,
        ctx
      );
    const file = path.join(agentDir, "context/config.json");
    const saved = JSON.parse(await readFile(file, "utf8"));
    expect(saved).toEqual({
      version: 1,
      models,
      knowledge: {
        roots: [first, second].sort((a, b) => a.localeCompare(b, "en")),
        extensions: ["md", "txt"],
        excludes: ["tmp", ".cache"],
        limits,
      },
    });
    expect((await lstat(path.dirname(file))).mode & 0o777).toBe(0o700);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(ctx.reload).toHaveBeenCalledOnce();
    expect(order).toEqual(["notify", "reload"]);
  });

  it("rejects unsafe setup inputs and interactive cancellation without writes", async () => {
    const agentDir = await mkdtemp(
      path.join(os.tmpdir(), "knowledge-invalid-")
    );
    const file = path.join(agentDir, "context/config.json");
    const regular = path.join(agentDir, "file");
    await writeFile(regular, "x");
    const directory = path.join(agentDir, "directory");
    await mkdir(directory);
    const linked = path.join(agentDir, "linked");
    await symlink(directory, linked);
    for (const args of [
      "--provider local",
      "--embedder x",
      "--vector x",
      `--roots ${path.join(agentDir, "missing")}`,
      `--roots ${regular}`,
      `--roots ${linked}`,
    ]) {
      const { pi, commands } = host();
      registerKnowledgeCommands(pi, {} as any, { agentDir });
      const ctx: any = {
        hasUI: false,
        ui: { notify: vi.fn() },
        reload: vi.fn(),
      };
      await commands.get("knowledge-search-setup").handler(args, ctx);
      expect(ctx.reload).not.toHaveBeenCalled();
    }
    const { pi, commands } = host();
    registerKnowledgeCommands(pi, {} as any, { agentDir });
    const cancelled: any = {
      hasUI: true,
      ui: { input: vi.fn(async () => undefined), notify: vi.fn() },
      reload: vi.fn(),
    };
    await commands.get("knowledge-search-setup").handler("", cancelled);
    await expect(readFile(file)).rejects.toThrow();
    expect(cancelled.reload).not.toHaveBeenCalled();
  });

  it("executes overview, refresh, and reindex commands with notifications and finally-cleared status", async () => {
    const { pi, commands } = host();
    const files = [
      {
        id: 1,
        path: "/r/a.md",
        root: "/r",
        relativePath: "a.md",
        size: 1,
        mtimeMs: 1,
        chunkCount: 1,
        headings: ["Alpha"],
      },
    ];
    let fail = false;
    const sync = {
      status: () => ({ state: "ready" }),
      sync: vi.fn(async () => ({
        added: 0,
        updated: 1,
        removed: 0,
        unchanged: 0,
        skipped: [],
      })),
      reindex: vi.fn(async () => {
        if (fail) throw new Error("fail");
        return { added: 1, updated: 0, removed: 0, unchanged: 0, skipped: [] };
      }),
    };
    const index: any = { size: () => files.length, listFiles: () => files };
    const run = (effect: any) =>
      Effect.runPromise(
        Effect.provideService(
          Effect.provideService(effect, KnowledgeIndexService, index),
          KnowledgeSyncService,
          sync as any
        )
      );
    registerKnowledgeCommands(pi, { currentHandle: { run } } as any);
    const ctx: any = { ui: { notify: vi.fn(), setStatus: vi.fn() } };
    await commands.get("knowledge-overview").handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("<knowledge-overview>"),
      "info"
    );
    files.splice(0);
    await commands.get("knowledge-overview").handler("", ctx);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("empty"),
      "warning"
    );
    await commands.get("knowledge-refresh").handler("", ctx);
    await commands.get("knowledge-reindex").handler("", ctx);
    fail = true;
    await commands.get("knowledge-reindex").handler("", ctx);
    expect(sync.sync).toHaveBeenCalledOnce();
    expect(sync.reindex).toHaveBeenCalledTimes(2);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Refreshed"),
      "info"
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Re-indexed"),
      "info"
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("failed"),
      "error"
    );
    expect(
      ctx.ui.setStatus.mock.calls.filter((call: any[]) => call[1] === undefined)
    ).toHaveLength(3);
  });

  it("serializes startup and manual sync, rejects stale work, and drains before disposal", async () => {
    let current = true;
    let starts = 0;
    let running = 0;
    let maximum = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const index: any = {
      sync: vi.fn(async () => {
        starts++;
        running++;
        maximum = Math.max(maximum, running);
        if (starts === 1) await blocked;
        running--;
        return { added: 0, updated: 0, removed: 0, unchanged: 0, skipped: [] };
      }),
      rebuild: vi.fn(async () => {
        running++;
        maximum = Math.max(maximum, running);
        running--;
        return { added: 0, updated: 0, removed: 0, unchanged: 0, skipped: [] };
      }),
    };
    const dependencies = Layer.merge(
      Layer.succeed(KnowledgeIndexService, index),
      Layer.succeed(SessionGeneration, { id: 1, isCurrent: () => current })
    );
    const runtime = ManagedRuntime.make(
      makeKnowledgeSyncLayer({
        now: () => new Date("2024-01-01T00:00:00Z"),
      }).pipe(Layer.provide(dependencies))
    );
    const service = await runtime.runPromise(KnowledgeSyncService);
    const manual = service.reindex();
    const disposal = runtime.dispose();
    await Promise.resolve();
    expect(starts).toBe(1);
    let disposed = false;
    void disposal.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    await expect(manual).rejects.toThrow(/stale/);
    await disposal;
    expect(maximum).toBe(1);
    expect(service.status()).toMatchObject({
      state: "failed",
      diagnostic: expect.any(String),
    });
    await expect(service.sync()).rejects.toThrow(/shutting down/);

    const staleDependencies = Layer.merge(
      Layer.succeed(KnowledgeIndexService, index),
      Layer.succeed(SessionGeneration, { id: 2, isCurrent: () => false })
    );
    const staleRuntime = ManagedRuntime.make(
      makeKnowledgeSyncLayer().pipe(Layer.provide(staleDependencies))
    );
    const stale = await staleRuntime.runPromise(KnowledgeSyncService);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stale.status()).toEqual({ state: "idle" });
    await expect(stale.sync()).rejects.toThrow(/stale/);
    await staleRuntime.dispose();
  });

  it("preserves indexed rows and FTS hits when a forced parse fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-preserve-"));
    const note = path.join(root, "stable.md");
    await writeFile(note, "# Stable\n\nuniquely preserved content");
    let fail = false;
    const db = new DatabaseSync(":memory:");
    const index = new KnowledgeIndex(
      db,
      { ...DEFAULT_KNOWLEDGE_CONFIG, roots: [root], extensions: ["md"] },
      {
        parse: async (file) => {
          if (fail) throw new Error("forced parse failure");
          const info = await stat(file.path);
          return [
            {
              id: "stable",
              ordinal: 0,
              heading: "Stable",
              text: "uniquely preserved content",
              startLine: 1,
              charOffset: 0,
            },
          ];
        },
      }
    );
    await index.sync();
    const rows = index.listFiles();
    const hits = index.search("uniquely");
    fail = true;
    await expect(index.rebuild()).rejects.toThrow("forced parse failure");
    expect(index.listFiles()).toEqual(rows);
    expect(index.search("uniquely")).toEqual(hits);
    db.close();
  });

  it("coordinates memory, session, and knowledge lifecycle with one shutdown owner", async () => {
    const { pi, hooks } = host();
    const handle = { run: vi.fn(async () => undefined) };
    const controller: any = {
      start: vi.fn(async () => handle),
      shutdown: vi.fn(),
      get currentHandle() {
        return handle;
      },
    };
    registerContextFeatures(pi, controller);
    const starts = hooks.get("session_start")!;
    expect(starts).toHaveLength(2);
    const ctx: any = {
      cwd: "/tmp",
      ui: { notify: vi.fn() },
      sessionManager: { getBranch: () => [], getSessionId: () => "x" },
    };
    await starts[0]({}, ctx);
    await starts[1]({}, ctx);
    expect(controller.start).toHaveBeenCalledOnce();
    expect(handle.run).toHaveBeenCalledTimes(3);
    expect(hooks.get("session_shutdown")).toHaveLength(1);
  });

  it("returns bounded UTF-8-safe search excerpts and metadata-only tool details", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "knowledge-tools-"));
    await writeFile(
      path.join(root, "note.md"),
      `# Unicode\n\n${"😀 searchable ".repeat(6000)}`
    );
    const db = new DatabaseSync(":memory:");
    const index = new KnowledgeIndex(db, {
      ...DEFAULT_KNOWLEDGE_CONFIG,
      roots: [root],
      extensions: ["md"],
    });
    await index.sync();
    const { pi, tools } = host();
    registerKnowledgeTools(pi, {
      currentHandle: {
        run: (effect: any) =>
          Effect.runPromise(
            Effect.provideService(effect, KnowledgeIndexService, index)
          ),
      },
    } as any);
    const searched = await tools
      .get("knowledge_search")
      .execute("", { query: "searchable", limit: 1 });
    expect(
      Buffer.byteLength(searched.details.results[0].excerpt)
    ).toBeLessThanOrEqual(2048);
    expect(searched.details.results[0]).not.toHaveProperty("text");
    expect(searched.details.results[0]).not.toHaveProperty("content");
    expect(Buffer.byteLength(searched.content[0].text)).toBeLessThanOrEqual(
      50 * 1024
    );
    expect(searched.content[0].text).not.toContain("�");
    const read = await tools
      .get("kb_read")
      .execute("", { name: "note.md", max_bytes: 65536 });
    expect(read.details).toEqual(
      expect.objectContaining({
        ok: true,
        path: path.join(root, "note.md"),
        truncated: true,
        totalBytes: expect.any(Number),
      })
    );
    expect(read.details).not.toHaveProperty("content");
    db.close();
  }, 20_000);
});
