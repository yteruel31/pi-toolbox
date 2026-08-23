import type { DatabaseSync } from "node:sqlite";

import { Effect, Schedule } from "effect";

export type TransactionDatabase = Pick<DatabaseSync, "exec" | "prepare">;

export function immediateTransaction<A>(db: TransactionDatabase, body: () => A): A {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = body();
    db.exec("COMMIT");
    return value;
  } catch (cause) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The original body/commit failure is authoritative.
    }
    throw cause;
  }
}

export function isSqliteBusy(error: unknown): boolean {
  const value = error as { code?: unknown; errcode?: unknown; message?: unknown };
  return value?.code === "SQLITE_BUSY" || value?.code === "SQLITE_LOCKED" ||
    value?.errcode === 5 || value?.errcode === 6 ||
    (typeof value?.message === "string" && /\b(?:SQLITE_BUSY|SQLITE_LOCKED|database is locked)\b/i.test(value.message));
}

export function transactionEffect<A>(db: TransactionDatabase, body: () => A) {
  return Effect.try({ try: () => immediateTransaction(db, body), catch: (cause) => cause }).pipe(
    Effect.retry(
      Schedule.max([
        Schedule.exponential("50 millis"),
        Schedule.recurs(3),
      ]).pipe(
        Schedule.setInputType<unknown>(),
        Schedule.while(({ input }) => isSqliteBusy(input)),
      ),
    ),
  );
}
