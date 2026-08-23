import { statSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ensurePrivateContextRoot, validateDatabasePath, type PermissionOps } from "../src/storage/permissions.js";
import { sqliteResource } from "../src/storage/sqlite.js";
import { immediateTransaction, transactionEffect } from "../src/storage/transactions.js";

async function fixture() { return mkdtemp(path.join(os.tmpdir(), "context-sqlite-")); }

describe("private SQLite", () => {
  it("creates private files, configures pragmas, and closes on cleanup", async () => {
    const base = await fixture(); const dbPath = path.join(base, "context", "data.db");
    let db: any;
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      db = yield* sqliteResource(dbPath);
      expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
      for (const sidecar of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        expect(statSync(sidecar).mode & 0o777).toBe(0o600);
      }
    })));
    expect(db.isOpen).toBe(false);
    expect((await lstat(path.dirname(dbPath))).mode & 0o777).toBe(0o700);
    expect((await lstat(dbPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects symlinked roots, DBs, and wrong types", async () => {
    const base = await fixture(); const outside = path.join(base, "outside"); await mkdir(outside);
    await symlink(outside, path.join(base, "linked"));
    await expect(ensurePrivateContextRoot(path.join(base, "linked"))).rejects.toMatchObject({ _tag: "ContextStorageError" });
    const root = path.join(base, "root"); await mkdir(root); const target = path.join(base, "file"); await writeFile(target, "x");
    await symlink(target, path.join(root, "db"));
    await expect(validateDatabasePath(path.join(root, "db"))).rejects.toMatchObject({ _tag: "ContextStorageError" });
    await mkdir(path.join(root, "directory.db"));
    await expect(validateDatabasePath(path.join(root, "directory.db"))).rejects.toMatchObject({ _tag: "ContextStorageError" });
  });

  it("rejects a foreign-owner seam", async () => {
    const root = path.join(await fixture(), "root"); await mkdir(root);
    const ops: PermissionOps = { mkdir, chmod, lstat: (async (p: any) => {
      const stat = await lstat(p);
      return new Proxy(stat, { get: (target, key, receiver) => key === "uid" ? 99999 : Reflect.get(target, key, receiver) });
    }) as typeof lstat, uid: () => 1 };
    await expect(ensurePrivateContextRoot(root, ops)).rejects.toMatchObject({ _tag: "ContextStorageError", message: expect.stringContaining("owned") });
  });
});

describe("transactions", () => {
  it("commits and rolls back exactly", () => {
    const exec = vi.fn();
    expect(immediateTransaction({ exec, prepare: vi.fn() as any }, () => 7)).toBe(7);
    expect(exec.mock.calls.flat()).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
    exec.mockClear(); expect(() => immediateTransaction({ exec, prepare: vi.fn() as any }, () => { throw new Error("bad"); })).toThrow("bad");
    expect(exec.mock.calls.flat()).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("retries busy failures three times but not ordinary failures", async () => {
    let count = 0; const busy = Object.assign(new Error("locked"), { code: "SQLITE_BUSY" });
    const db = { exec: vi.fn((sql: string) => { if (sql === "BEGIN IMMEDIATE" && count++ < 3) throw busy; }), prepare: vi.fn() as any };
    await expect(Effect.runPromise(transactionEffect(db, () => "ok"))).resolves.toBe("ok"); expect(count).toBe(4);
    count = 0; const ordinary = { exec: vi.fn(() => { count++; throw new Error("ordinary"); }), prepare: vi.fn() as any };
    await expect(Effect.runPromise(transactionEffect(ordinary, () => "no"))).rejects.toThrow("ordinary"); expect(count).toBe(1);
  });
});
