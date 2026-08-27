import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import extension from "../src/index.js";
import { createContextRuntimeController } from "../src/runtime/context-runtime.js";

const ctx = { model: undefined, modelRegistry: { find: vi.fn(), complete: vi.fn() }, ui: { notify: vi.fn() } } as any;

async function controller() {
  const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-context-runtime-"));
  await mkdir(path.join(agentDir, "context"));
  return createContextRuntimeController({ agentDir });
}

describe("session runtime", () => {
  it("replaces generations, rejects stale callbacks, and shuts down twice", async () => {
    const value = await controller();
    const first = await value.start(ctx);
    const callback = vi.fn();
    const guarded = first.guard(callback);
    expect(guarded()).toBe(true);
    const second = await value.start(ctx);
    expect(first.isCurrent()).toBe(false);
    expect(guarded()).toBe(false);
    await expect(first.run(Effect.succeed(1))).rejects.toMatchObject({ _tag: "RuntimeInactiveError" });
    expect(second.isCurrent()).toBe(true);
    await value.shutdown();
    await value.shutdown();
    expect(value.activeGeneration).toBeUndefined();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("rolls back unsafe database startup and permits the next valid start", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-context-runtime-"));
    const contextDir = path.join(agentDir, "context");
    await mkdir(contextDir);
    const target = path.join(agentDir, "target.db");
    await writeFile(target, "");
    await symlink(target, path.join(contextDir, "sessions.db"));
    const value = createContextRuntimeController({ agentDir });
    await expect(value.start(ctx)).rejects.toMatchObject({ _tag: "ContextStorageError" });
    expect(value.activeGeneration).toBeUndefined();
    expect(value.currentHandle).toBeUndefined();
    await import("node:fs/promises").then(({ unlink }) => unlink(path.join(contextDir, "sessions.db")));
    const handle = await value.start(ctx);
    expect(handle.isCurrent()).toBe(true);
    await value.shutdown();
  });

  it("disposes partial resources after injected acquisition failure and permits retry", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-context-runtime-"));
    await mkdir(path.join(agentDir, "context"));
    let fail = true;
    const finalized = vi.fn();
    const value = createContextRuntimeController({
      agentDir,
      onAcquire: () => { if (fail) throw new Error("injected resource failure"); },
      onDispose: finalized,
    });
    await expect(value.start(ctx)).rejects.toMatchObject({
      _tag: "ContextStorageError",
      operation: "initialize",
      message: expect.stringContaining("generation"),
    });
    expect(value.activeGeneration).toBeUndefined();
    expect(value.currentHandle).toBeUndefined();
    fail = false;
    await expect(value.start(ctx)).resolves.toMatchObject({ generation: 2 });
    await value.shutdown();
    expect(finalized).toHaveBeenCalledOnce();
  });

  it("disposes active scoped resources on shutdown", async () => {
    const agentDir = await mkdtemp(path.join(os.tmpdir(), "pi-context-runtime-"));
    await mkdir(path.join(agentDir, "context"));
    const finalized = vi.fn();
    const value = createContextRuntimeController({ agentDir, onDispose: finalized });
    await value.start(ctx);
    expect(finalized).not.toHaveBeenCalled();
    await value.shutdown();
    expect(finalized).toHaveBeenCalledOnce();
  });

  it("registers lifecycle only and starts no work at factory load", async () => {
    const handlers = new Map<string, Function>();
    extension({ on: (event: string, handler: Function) => handlers.set(event, handler) } as any);
    expect([...handlers.keys()]).toEqual(["session_start", "session_shutdown"]);
    expect(ctx.modelRegistry.find).not.toHaveBeenCalled();
  });
});
