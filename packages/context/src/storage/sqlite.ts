import { DatabaseSync } from "node:sqlite";

import { Effect } from "effect";

import { ContextStorageError } from "../runtime/errors.js";
import { restrictDatabaseFiles, validateDatabasePath } from "./permissions.js";

export interface SqliteDatabase {
  readonly exec: DatabaseSync["exec"];
  readonly prepare: DatabaseSync["prepare"];
  readonly close: DatabaseSync["close"];
  readonly isOpen?: boolean;
}

export interface SqliteFactory {
  readonly open: (path: string) => SqliteDatabase;
}

const nativeFactory: SqliteFactory = {
  open: (path) => new DatabaseSync(path, {
    allowExtension: false,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    timeout: 5_000,
  }),
};

export function sqliteResource(dbPath: string, factory: SqliteFactory = nativeFactory) {
  const closed = new WeakSet<object>();
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        await validateDatabasePath(dbPath);
        // Validate pre-existing WAL/SHM paths before SQLite has an opportunity to open them.
        await restrictDatabaseFiles(dbPath);
        let db: SqliteDatabase | undefined;
        try {
          db = factory.open(dbPath);
          db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
          // Materialize WAL sidecars without creating application schema, then restrict them.
          db.exec("BEGIN IMMEDIATE; COMMIT;");
          await restrictDatabaseFiles(dbPath);
          return db;
        } catch (cause) {
          if (db !== undefined) try { db.close(); } catch { /* preserve acquisition error */ }
          throw cause;
        }
      },
      catch: (cause) => cause instanceof ContextStorageError ? cause : new ContextStorageError({
        path: dbPath, operation: "open", message: `Cannot securely open SQLite database at ${dbPath}`, cause,
      }),
    }),
    (db) => Effect.tryPromise({
      try: async () => {
        if (!closed.has(db)) {
          closed.add(db);
          if (db.isOpen !== false) db.close();
        }
        await restrictDatabaseFiles(dbPath);
      },
      catch: (cause) => new ContextStorageError({ path: dbPath, operation: "close", message: `Cannot close SQLite database at ${dbPath}`, cause }),
    }).pipe(Effect.orDie),
  );
}
