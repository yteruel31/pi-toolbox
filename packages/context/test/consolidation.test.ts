import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
  consolidateMemory,
  filterConsolidation,
  isEphemeral,
} from "../src/memory/consolidator.js";
import { MemoryStore } from "../src/memory/store.js";
import {
  MemoryStoreService,
  PiModelBridge,
  modelWorkGateLayer,
} from "../src/runtime/services.js";

function response(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] } as any;
}

async function run(
  options: {
    pending?: number;
    force?: boolean;
    complete?: () => Effect.Effect<any, any>;
    timeoutMs?: number;
  } = {}
) {
  const db = new DatabaseSync(":memory:");
  const store = new MemoryStore(db, { disableFts: true });
  for (let index = 0; index < (options.pending ?? 0); index++) {
    store.addPendingEvent(`s${index}`, "/project", `user: message ${index}`, 1);
  }
  const bridge = {
    complete:
      options.complete ??
      (() => Effect.succeed(response('{"facts":[],"lessons":[]}'))),
  } as any;
  const layer = Layer.mergeAll(
    Layer.succeed(MemoryStoreService, store),
    Layer.succeed(PiModelBridge, bridge),
    modelWorkGateLayer
  );
  const result = await Effect.runPromise(
    consolidateMemory({
      force: options.force,
      timeoutMs: options.timeoutMs,
    }).pipe(Effect.provide(layer))
  );
  return { db, store, result };
}

describe("memory consolidation", () => {
  it("stays below threshold without invoking a model", async () => {
    const value = await run({
      pending: 2,
      complete: () => Effect.die("must not run"),
    });
    expect(value.result.status).toBe("below-threshold");
    expect(value.store.stats().pendingEvents).toBe(2);
    value.db.close();
  });

  it("reports forced empty input", async () => {
    const value = await run({ force: true });
    expect(value.result.status).toBe("empty");
    value.db.close();
  });

  it("applies valid JSON exactly once and consolidates events", async () => {
    const json = JSON.stringify({
      facts: [{ key: "pref.editor", value: "vim", confidence: 0.9 }],
      lessons: [
        {
          rule: "Ask before publishing",
          category: "workflow",
          negative: false,
          confidence: 0.9,
        },
      ],
    });
    const value = await run({
      pending: 3,
      complete: () => Effect.succeed(response(json)),
    });
    expect(value.result).toMatchObject({
      status: "success",
      facts: 1,
      lessons: 1,
      events: 3,
    });
    expect(value.store.stats()).toMatchObject({
      pendingEvents: 0,
      consolidatedEvents: 3,
    });
    expect(value.store.getFact("pref.editor")?.value).toBe("vim");
    value.db.close();
  });

  it.each([
    ["invalid JSON", "not json"],
    ["invalid schema", '{"facts":"bad","lessons":[]}'],
  ])("leaves events pending for %s", async (_name, text) => {
    const value = await run({
      pending: 3,
      complete: () => Effect.succeed(response(text)),
    });
    expect(value.result.status).toBe("failed");
    expect(value.store.stats().pendingEvents).toBe(3);
    value.db.close();
  });

  it("filters low-confidence and ephemeral model output", async () => {
    expect(isEphemeral("project.filepath", "src/index.ts")).toBe(true);
    expect(
      filterConsolidation({
        facts: [
          { key: "pref.editor", value: "vim", confidence: 0.79 },
          { key: "pref.shell", value: "fish", confidence: 0.9 },
        ],
        lessons: [
          {
            rule: "We fixed the parser",
            category: "code",
            negative: false,
            confidence: 0.9,
          },
        ],
      })
    ).toEqual({
      facts: [{ key: "pref.shell", value: "fish", confidence: 0.9 }],
      lessons: [],
    });
  });

  it("leaves events pending on model failure", async () => {
    const value = await run({
      pending: 3,
      complete: () => Effect.fail(new Error("offline")),
    });
    expect(value.result.status).toBe("failed");
    expect(value.store.stats().pendingEvents).toBe(3);
    value.db.close();
  });

  it("times out/cancels without consuming pending events", async () => {
    const value = await run({
      pending: 3,
      timeoutMs: 1,
      complete: () => Effect.never,
    });
    expect(value.result.status).toBe("failed");
    expect(value.store.stats().pendingEvents).toBe(3);
    value.db.close();
  });
});
