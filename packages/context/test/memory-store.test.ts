import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer } from "effect";
import { describe, expect, it, vi } from "vitest";

import { MEMORY_SCHEMA_VERSION } from "../src/memory/schema.js";
import { MemoryStore, memoryStoreLayer } from "../src/memory/store.js";
import { MemoryStoreService } from "../src/runtime/services.js";

function make(options?: { disableFts?: boolean }) {
  const db = new DatabaseSync(":memory:");
  return { db, store: new MemoryStore(db, options) };
}

describe("memory store", () => {
  it("creates only the fresh versioned schema", () => {
    const { db, store } = make();
    expect(store.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(
      (db.prepare("select version from schema_version").get() as any).version
    ).toBe(MEMORY_SCHEMA_VERSION);
    db.close();
  });

  it("closes the SQLite resource without changing the package directory", async () => {
    const packageDirectory = path.resolve(import.meta.dirname, "..");
    const modeBefore = (await stat(packageDirectory)).mode & 0o777;
    const contextDirectory = await mkdtemp(
      path.join(tmpdir(), "pi-context-memory-")
    );
    const databasePath = path.join(contextDirectory, "memory.db");
    const close = vi.fn();
    const db = {
      exec: vi.fn(),
      prepare: vi.fn(() => ({ get: () => ({ version: 1 }) })),
      close,
      isOpen: true,
    } as any;
    const factory = { open: () => db };

    try {
      await Effect.runPromise(
        Effect.scoped(
          Layer.build(
            memoryStoreLayer(databasePath, factory, { disableFts: true })
          )
        )
      );
      expect(close).toHaveBeenCalledOnce();
    } finally {
      await rm(contextDirectory, { recursive: true, force: true });
    }

    expect((await stat(packageDirectory)).mode & 0o777).toBe(modeBefore);
  });

  it("keeps higher-confidence facts and allows equal/higher overwrites", () => {
    const { db, store } = make();
    expect(store.setFact("Pref.Editor", "vim", 0.9, "user")).toBe(true);
    expect(store.setFact("pref.editor", "nano", 0.8)).toBe(false);
    expect(store.setFact("pref.editor", "helix", 0.9)).toBe(true);
    expect(store.getFact("PREF.EDITOR")?.value).toBe("helix");
    db.close();
  });

  it("deduplicates exact and Jaccard-similar lessons and soft deletes", () => {
    const { db, store } = make();
    const lesson = store.addLesson({
      rule: "Always run focused tests first",
      source: "user",
    });
    expect(lesson.success).toBe(true);
    expect(
      store.addLesson({ rule: "Always run focused tests first" }).reason
    ).toBe("duplicate");
    expect(
      store.addLesson({ rule: "Always run focused tests first today" }).reason
    ).toBe("duplicate");
    if (!lesson.success) throw new Error("missing lesson");
    expect(store.deleteLesson(lesson.id.slice(0, 8))).toBe(true);
    expect(store.listLessons()).toHaveLength(0);
    db.close();
  });

  it("shows global and matching project lessons only", () => {
    const { db, store } = make();
    store.addLesson({ rule: "global rule", source: "user" });
    store.addLesson({ rule: "alpha unique rule", project: "/alpha" });
    store.addLesson({ rule: "beta distinct rule", project: "/beta" });
    expect(
      store.listLessons(undefined, 20, "/alpha").map((x) => x.rule)
    ).toEqual(["global rule", "alpha unique rule"]);
    expect(
      store.searchLessons("rule", 20, "/alpha").map((x) => x.rule)
    ).toEqual(["global rule", "alpha unique rule"]);
    db.close();
  });

  it("uses real FTS and safe punctuation/operator queries", () => {
    const { db, store } = make();
    store.setFact("pref.editor", "Visual Studio Code");
    expect(store.searchFacts("studio")).toHaveLength(1);
    expect(() => store.searchFacts('studio OR " ) *')).not.toThrow();
    db.close();
  });

  it("uses parameterized LIKE fallback when FTS is unavailable", () => {
    const { db, store } = make({ disableFts: true });
    store.setFact("pref.editor", "Visual Studio Code");
    expect(store.hasFts5).toBe(false);
    expect(store.searchFacts("studio")[0]?.key).toBe("pref.editor");
    expect(() => store.searchFacts("%_' OR 1=1 --")).not.toThrow();
    db.close();
  });

  it("tracks pending/consolidated events and statistics", () => {
    const { db, store } = make();
    store.setFact("pref.editor", "vim");
    const event = store.addPendingEvent("s", "/p", "user: hello", 1);
    expect(store.stats()).toMatchObject({
      facts: 1,
      pendingEvents: 1,
      consolidatedEvents: 0,
    });
    const pending = store.pendingEvents();
    expect(pending[0]?.id).toBe(event);
    store.applyConsolidation(pending, { facts: [], lessons: [] }, "/p");
    expect(store.stats()).toMatchObject({
      pendingEvents: 0,
      consolidatedEvents: 1,
    });
    db.close();
  });
});
